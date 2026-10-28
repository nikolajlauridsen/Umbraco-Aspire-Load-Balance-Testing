// Read-heavy backoffice mix: READERS VUs browse the seeded tree back to back (the children of a random branch, one
// of those documents, the document type) with no think time by default, like a backoffice under heavy editor
// traffic, while WRITERS VUs run the create / edit / publish mix with the usual 1-5 s think time on one branch.
// Everything goes through the round-robin gateway, so every write bumps the repository cache version on its node
// and the readers on the other nodes resync on their next request.
//
// Knobs (k6 env): READERS (150), WRITERS (10), DURATION (6m), READ_THINK_MS (0), WRITE_BRANCH (index of the seeded
// branch the writers create under, default: a fresh branch per run), READ_BRANCHES (how many seeded branches the readers browse, default all),
// BRANCHES / PER_BRANCH (seed shape).
import http from 'k6/http';
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
if (NODES.length < 1) throw new Error('editor-read-mix.js needs at least one node');

const API = `${GATEWAY}/umbraco/management/api/v1`;
const API_V1_1 = `${GATEWAY}/umbraco/management/api/v1.1`;
const CLIENT_ID = __ENV.K6_CLIENT_ID || 'umbraco-back-office-k6';
const CLIENT_SECRET = __ENV.K6_CLIENT_SECRET;
if (!CLIENT_SECRET) throw new Error('K6_CLIENT_SECRET is not set; run through the AppHost');

const READERS = parseInt(__ENV.READERS || '150', 10);
const WRITERS = parseInt(__ENV.WRITERS || '10', 10);
const DURATION = __ENV.DURATION || '6m';
const READ_THINK_MS = parseInt(__ENV.READ_THINK_MS || '0', 10);
// WRITE_BRANCH < 0 (the default) creates a fresh branch under the root for the writers, so every run starts
// from the same small sibling set.
const WRITE_BRANCH = parseInt(__ENV.WRITE_BRANCH || '-1', 10);
const READ_BRANCHES = parseInt(__ENV.READ_BRANCHES || '0', 10);
const BRANCHES = parseInt(__ENV.BRANCHES || '200', 10);
const PER_BRANCH = parseInt(__ENV.PER_BRANCH || '10', 10);

const saveFailed = new Counter('save_failed_500');
const conflict = new Counter('conflict_409');
const tokenRefreshes = new Counter('token_refreshes');

const perScenario = (metric, expr) =>
  Object.fromEntries(['readers', 'writers'].map((s) => [`${metric}{scenario:${s}}`, [expr]]));

export const options = {
  setupTimeout: '15m',
  scenarios: {
    readers: { executor: 'constant-vus', vus: READERS, duration: DURATION, gracefulStop: '30s', exec: 'reader' },
    writers: { executor: 'constant-vus', vus: WRITERS, duration: DURATION, gracefulStop: '30s', exec: 'writer' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    save_failed_500: ['count<1'],
    conflict_409: ['count<1'],
    ...perScenario('http_reqs', 'count>=0'),
    ...perScenario('iterations', 'count>=0'),
    ...perScenario('http_req_duration', 'p(95)>=0'),
    ...perScenario('http_req_failed', 'rate<=1'),
    ...perScenario('token_refreshes', 'count>=0'),
    ...perScenario('save_failed_500', 'count>=0'),
  },
};

export function setup() {
  const seed = http.post(`${NODES[0]}/umbraco/lb/seed?branches=${BRANCHES}&perBranch=${PER_BRANCH}`, null, { timeout: '15m' });
  if (seed.status !== 200) throw new Error(`seed failed: ${seed.status} ${seed.body}`);
  const apiUser = http.post(`${NODES[0]}/umbraco/lb/api-user`);
  if (apiUser.status !== 200) throw new Error(`api-user failed: ${apiUser.status} ${apiUser.body}`);
  let tree = http.get(`${NODES[0]}/umbraco/lb/tree`);
  if (tree.status !== 200) throw new Error(`tree failed: ${tree.status} ${tree.body}`);
  let body = tree.json();
  if (!body.documentTypeKey || body.branches.length <= WRITE_BRANCH) throw new Error(`tree has no document type key or fewer than ${WRITE_BRANCH + 1} branches`);
  // The seeded branches only; a branch created for an earlier run's writers is not browsed.
  const readBranches = body.branches.slice(0, READ_BRANCHES > 0 ? READ_BRANCHES : BRANCHES);
  let writeParent;
  if (WRITE_BRANCH >= 0) {
    writeParent = body.branches[WRITE_BRANCH].key;
  } else {
    const created = http.post(`${NODES[0]}/umbraco/lb/create/${body.rootId}`);
    if (created.status !== 200) throw new Error(`create branch failed: ${created.status} ${created.body}`);
    const createdId = created.json('id');
    // Published, so the writers' publishes under it succeed, as under the seeded branches.
    const published = http.post(`${NODES[0]}/umbraco/lb/publish/${createdId}`);
    if (published.status !== 200) throw new Error(`publish branch failed: ${published.status} ${published.body}`);
    tree = http.get(`${NODES[0]}/umbraco/lb/tree`);
    if (tree.status !== 200) throw new Error(`tree failed: ${tree.status} ${tree.body}`);
    body = tree.json();
    const branch = body.branches.find((b) => b.id === createdId);
    if (!branch) throw new Error(`created branch ${createdId} not found in the tree`);
    writeParent = branch.key;
    console.log(`writers use fresh branch ${createdId} (${writeParent})`);
  }
  return {
    writeParent,
    readBranches: readBranches.map((b) => b.key),
    documentType: body.documentTypeKey,
  };
}

// One token per VU, like one logged-in user; refreshed once on a 401.
let token = null;

function getToken() {
  const res = http.post(
    `${API}/security/back-office/token`,
    { grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET },
    { tags: { action: 'token' } },
  );
  check(res, { 'token 200': (r) => r.status === 200 });
  token = res.status === 200 ? res.json('access_token') : null;
  return token;
}

function api(method, path, body, action, base = API) {
  if (!token) getToken();
  const params = {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    tags: { action },
  };
  let res = http.request(method, `${base}${path}`, body ? JSON.stringify(body) : null, params);
  if (res.status === 401) {
    tokenRefreshes.add(1);
    getToken();
    params.headers.Authorization = `Bearer ${token}`;
    res = http.request(method, `${base}${path}`, body ? JSON.stringify(body) : null, params);
  }
  if (res.status === 500) saveFailed.add(1);
  if (res.status === 409) conflict.add(1);
  return res;
}

function createDocument(parentKey, data, action) {
  const id = crypto.randomUUID();
  const name = `[PERF.TEST] ${action} ${new Date().toISOString()}`;
  const res = api('POST', '/document', {
    id,
    documentType: { id: data.documentType },
    parent: { id: parentKey },
    values: [{ alias: 'title', value: name }],
    variants: [{ name }],
    template: null,
  }, action);
  check(res, { [`${action} 201`]: (r) => r.status === 201 });
  return res.status === 201 ? id : null;
}

function getDocument(id, action) {
  const res = api('GET', `/document/${id}`, null, action);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
  return res.status === 200 ? res.json() : null;
}

function editBody(doc, suffix) {
  return {
    values: doc.values.map((v) => ({
      alias: v.alias,
      culture: v.culture,
      segment: v.segment,
      value: v.alias === 'title' ? `${v.value} ${suffix}` : v.value,
    })),
    variants: doc.variants.map((v) => ({ culture: v.culture, segment: v.segment, name: v.name })),
    template: doc.template,
  };
}

function updateDocument(id, doc, action) {
  const res = api('PUT', `/document/${id}`, editBody(doc, '(edited)'), action);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
}

function publishDocument(id, doc, action) {
  const validate = api('PUT', `/document/${id}/validate`, editBody(doc, ''), `${action}-validate`, API_V1_1);
  check(validate, { [`${action}-validate 200`]: (r) => r.status === 200 });
  const res = api('PUT', `/document/${id}/publish`, { publishSchedules: [{ culture: null }] }, action);
  check(res, { [`${action} 200`]: (r) => r.status === 200 });
}

export function reader(data) {
  const branch = data.readBranches[Math.floor(Math.random() * data.readBranches.length)];
  const children = api('GET', `/tree/document/children?parentId=${branch}&skip=0&take=100`, null, 'read-children');
  check(children, { 'read-children 200': (r) => r.status === 200 });
  const items = children.status === 200 ? children.json('items') : null;
  if (items && items.length > 0) {
    const item = items[Math.floor(Math.random() * items.length)];
    getDocument(item.id, 'read-document');
  }
  const docType = api('GET', `/document-type/${data.documentType}`, null, 'read-document-type');
  check(docType, { 'read-document-type 200': (r) => r.status === 200 });
  if (READ_THINK_MS > 0) sleep((READ_THINK_MS / 1000) * (0.5 + Math.random()));
}

const probabilities = { createArticle: 20, editArticle: 50, publishArticle: 30 };

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

export function writer(data) {
  sleep(Math.floor(Math.random() * 5) + 1);
  const scenario = pickScenario();
  const parent = data.writeParent;
  getDocument(parent, 'read-parent');
  const id = createDocument(parent, data, 'create-article');
  if (id && scenario !== 'createArticle') {
    const doc = getDocument(id, 'read-article');
    if (doc && scenario === 'editArticle') updateDocument(id, doc, 'edit-article');
    if (doc && scenario === 'publishArticle') publishDocument(id, doc, 'publish-article');
  }
  sleep(1);
}
