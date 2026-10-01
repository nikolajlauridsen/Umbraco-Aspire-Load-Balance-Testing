// PR 24034 scenario: many editors each saving and publishing single documents, through the gateway
// without affinity, so a save and its publish usually land on different nodes. That exercises the
// inline isolated-cache sync (a node reading an entity type another node has just written) while
// every node's instruction job is busy with the other nodes' instructions.
//
// A small "bulk" editor publishes one short branch at a time. Its branches are reserved, so it
// never touches an editor's pages, and each editor owns a disjoint slice of pages. With no two
// writers on the same document, a "stale-version" (409) means a node used an outdated cached copy.
//
// Knobs (k6 env): BRANCHES, PER_BRANCH (seed shape), EDITORS, EDITOR_TARGET (gateway|pinned),
// THINK (seconds between an editor's actions), BULK_VUS, BULK_BRANCHES (reserved branches), DURATION.
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

function url(resource) {
  const v = __ENV[`services__${resource}__http__0`];
  if (!v) throw new Error(`missing env services__${resource}__http__0`);
  return v.replace(/\/$/, '');
}

const GATEWAY = url('gateway');
const NODES = Object.keys(__ENV)
  .map((k) => /^services__(umb-\d+)__http__0$/.exec(k))
  .filter(Boolean)
  .map((m) => m[1])
  .sort()
  .map(url);
if (NODES.length < 2) throw new Error('cache-sync-lock.js needs at least two nodes');

const BRANCHES = parseInt(__ENV.BRANCHES || '200', 10);
const PER_BRANCH = parseInt(__ENV.PER_BRANCH || '10', 10);
const EDITORS = parseInt(__ENV.EDITORS || '100', 10);
const EDITOR_TARGET = __ENV.EDITOR_TARGET || 'gateway';
const THINK = parseFloat(__ENV.THINK || '1');
const BULK_VUS = parseInt(__ENV.BULK_VUS || '1', 10);
const BULK_BRANCHES = parseInt(__ENV.BULK_BRANCHES || '20', 10);
const DURATION = __ENV.DURATION || '2m';

const staleVersion = new Counter('stale_version');
const readLockTimeout = new Counter('read_lock_timeout');
const writeLockTimeout = new Counter('write_lock_timeout');
const crossNodePairs = new Counter('cross_node_pairs');
const sameNodePairs = new Counter('same_node_pairs');

const scenarios = {
  editors: {
    executor: 'constant-vus',
    vus: EDITORS,
    duration: DURATION,
    exec: 'editor',
  },
};
if (BULK_VUS > 0) {
  scenarios.bulk = {
    executor: 'constant-vus',
    vus: BULK_VUS,
    duration: DURATION,
    exec: 'bulk',
  };
}

export const options = {
  setupTimeout: '15m',
  scenarios,
  thresholds: {
    'http_req_duration{scenario:editors}': ['p(95)<2000', 'max<4500'],
    'http_req_failed{scenario:editors}': ['rate<0.01'],
    stale_version: ['count<1'],
    read_lock_timeout: ['count<1'],
    write_lock_timeout: ['count<1'],
  },
};

export function setup() {
  const seed = http.post(`${NODES[0]}/lb/seed?branches=${BRANCHES}&perBranch=${PER_BRANCH}`, null, { timeout: '15m' });
  if (seed.status !== 200) throw new Error(`seed failed: ${seed.status} ${seed.body}`);
  const tree = http.get(`${NODES[0]}/lb/tree`);
  if (tree.status !== 200) throw new Error(`tree failed: ${tree.status} ${tree.body}`);

  const branches = tree.json().branches;
  if (branches.length <= BULK_BRANCHES) throw new Error(`need more than ${BULK_BRANCHES} branches, got ${branches.length}`);

  const bulkBranches = branches.slice(0, BULK_BRANCHES).map((b) => b.id);
  const editorPages = branches.slice(BULK_BRANCHES).flatMap((b) => b.pages);
  console.log(`seed: ${seed.body}; ${editorPages.length} editor pages over ${EDITORS} editors, ${bulkBranches.length} bulk branches of ~${PER_BRANCH}`);
  return { bulkBranches, editorPages };
}

// Every VU in the test owns one slot, so editors never share a page.
function ownPages(data) {
  const slots = EDITORS + BULK_VUS;
  const slot = (exec.vu.idInTest - 1) % slots;
  return data.editorPages.filter((_, i) => i % slots === slot);
}

function target() {
  if (EDITOR_TARGET === 'pinned') return NODES[exec.vu.idInTest % NODES.length];
  return GATEWAY;
}

function record(res) {
  if (res.status === 409) staleVersion.add(1);
  if (res.status === 503) {
    const error = res.json('error');
    if (error === 'read-lock-timeout') readLockTimeout.add(1);
    if (error === 'write-lock-timeout') writeLockTimeout.add(1);
  }
}

function think() {
  sleep(THINK * (0.5 + Math.random()));
}

export function editor(data) {
  const pages = ownPages(data);
  if (pages.length === 0) throw new Error('no pages for this editor; lower EDITORS or seed more');
  const id = pages[Math.floor(Math.random() * pages.length)];
  const base = target();

  const save = http.post(`${base}/lb/save/${id}`, null, { tags: { action: 'save' } });
  record(save);
  check(save, { 'save 200': (r) => r.status === 200 });

  think();

  const publish = http.post(`${base}/lb/publish/${id}`, null, { tags: { action: 'publish' } });
  record(publish);
  check(publish, { 'publish 200': (r) => r.status === 200 });

  const saveNode = save.headers['X-Umb-Node'];
  const publishNode = publish.headers['X-Umb-Node'];
  if (saveNode && publishNode) {
    (saveNode === publishNode ? sameNodePairs : crossNodePairs).add(1);
  }

  think();
}

export function bulk(data) {
  const branch = data.bulkBranches[Math.floor(Math.random() * data.bulkBranches.length)];
  const res = http.post(`${GATEWAY}/lb/publish-branch/${branch}`, null, { timeout: '5m', tags: { action: 'publish-branch' } });
  record(res);
  check(res, { 'publish-branch 200': (r) => r.status === 200 });
  sleep(1);
}
