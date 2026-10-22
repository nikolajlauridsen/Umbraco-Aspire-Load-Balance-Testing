// Approximation of a customer's backoffice stress test: N users, a fixed number of shared iterations, each
// iteration one scenario drawn by probability (create / create+edit / create+publish / site create / site edit)
// with a random 1-5 s delay before it and 1 s after. Everything goes through the round-robin gateway, so the
// create, the read-back and the edit/publish of one document usually land on different nodes.
//
// Knobs (k6 env): VUS (150), ITERATIONS (1000), MAX_DURATION (60m), BRANCHES / PER_BRANCH (seed shape).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

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
if (NODES.length < 1) throw new Error('client-mix.js needs at least one node');

const VUS = parseInt(__ENV.VUS || '150', 10);
const ITERATIONS = parseInt(__ENV.ITERATIONS || '1000', 10);
const MAX_DURATION = __ENV.MAX_DURATION || '60m';
const BRANCHES = parseInt(__ENV.BRANCHES || '200', 10);
const PER_BRANCH = parseInt(__ENV.PER_BRANCH || '10', 10);

const staleVersion = new Counter('stale_version');
const readLockTimeout = new Counter('read_lock_timeout');
const writeLockTimeout = new Counter('write_lock_timeout');
const scenarioDuration = new Trend('scenario_duration', true);

export const options = {
  setupTimeout: '15m',
  scenarios: {
    default: {
      executor: 'shared-iterations',
      vus: VUS,
      iterations: ITERATIONS,
      maxDuration: MAX_DURATION,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    stale_version: ['count<1'],
    read_lock_timeout: ['count<1'],
    write_lock_timeout: ['count<1'],
  },
};

export function setup() {
  const seed = http.post(`${NODES[0]}/umbraco/lb/seed?branches=${BRANCHES}&perBranch=${PER_BRANCH}`, null, { timeout: '15m' });
  if (seed.status !== 200) throw new Error(`seed failed: ${seed.status} ${seed.body}`);
  const tree = http.get(`${NODES[0]}/umbraco/lb/tree`);
  if (tree.status !== 200) throw new Error(`tree failed: ${tree.status} ${tree.body}`);
  const branches = tree.json().branches;
  if (branches.length < 2) throw new Error('need at least two branches');
  // Articles all go under one parent, sites under another, as in the customer's tree.
  return { articlesParent: branches[0].id, sitesParent: branches[1].id };
}

const probabilities = { createArticle: 20, editArticle: 50, publishArticle: 20, editSite: 5, createSite: 5 };

function pickScenario() {
  const total = Object.values(probabilities).reduce((a, b) => a + b, 0);
  const r = Math.random();
  let cumulative = 0;
  for (const [name, p] of Object.entries(probabilities)) {
    cumulative += p / total;
    if (r < cumulative) return name;
  }
  return 'createArticle';
}

function record(res) {
  if (res.status === 409) staleVersion.add(1);
  if (res.status === 503) {
    let error = '';
    try { error = res.json('error'); } catch (_) { /* not json */ }
    if (error === 'read-lock-timeout') readLockTimeout.add(1);
    if (error === 'write-lock-timeout') writeLockTimeout.add(1);
  }
}

function create(parentId, action) {
  const res = http.post(`${GATEWAY}/umbraco/lb/create/${parentId}`, null, { tags: { action } });
  record(res);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
  if (res.status !== 200) return null;
  return res.json('id');
}

function read(id, action) {
  const res = http.get(`${GATEWAY}/umbraco/lb/get/${id}`, { tags: { action } });
  record(res);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
}

function save(id, action) {
  const res = http.post(`${GATEWAY}/umbraco/lb/save/${id}`, null, { tags: { action } });
  record(res);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
}

function publish(id, action) {
  const res = http.post(`${GATEWAY}/umbraco/lb/publish/${id}`, null, { tags: { action } });
  record(res);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
}

export default function (data) {
  sleep(Math.floor(Math.random() * 5) + 1);
  const scenario = pickScenario();
  const started = Date.now();

  switch (scenario) {
    case 'createArticle': {
      read(data.articlesParent, 'read-parent');
      create(data.articlesParent, 'create-article');
      break;
    }
    case 'editArticle': {
      read(data.articlesParent, 'read-parent');
      const id = create(data.articlesParent, 'create-article');
      if (id) { read(id, 'read-article'); save(id, 'edit-article'); }
      break;
    }
    case 'publishArticle': {
      read(data.articlesParent, 'read-parent');
      const id = create(data.articlesParent, 'create-article');
      if (id) { read(id, 'read-article'); publish(id, 'publish-article'); }
      break;
    }
    case 'createSite': {
      read(data.sitesParent, 'read-parent');
      create(data.sitesParent, 'create-site');
      break;
    }
    case 'editSite': {
      read(data.sitesParent, 'read-parent');
      const id = create(data.sitesParent, 'create-site');
      if (id) { read(id, 'read-site'); save(id, 'edit-site'); }
      break;
    }
    default:
      break;
  }

  scenarioDuration.add(Date.now() - started, { scenario });
  sleep(1);
}
