// The customer-mix scenario through the real Management API with OAuth client credentials, instead of the rig's
// direct /umbraco/lb endpoints. Each VU authenticates as the "k6" API user (created by POST /umbraco/lb/api-user
// in setup, secret from the AppHost parameter apiuser-client-secret), then runs one scenario per iteration drawn by
// probability (create / create+edit / create+publish / site create / site edit), with a random 1-5 s delay
// before and 1 s after, every request through the round-robin gateway.
//
// Knobs (k6 env): VUS (150), ITERATIONS (1000), MAX_DURATION (60m), BRANCHES / PER_BRANCH (seed shape),
// ARTICLES_BRANCH / SITES_BRANCH (indexes of the seeded branches to create under; pick unused ones for a fresh, small sibling set).
// Lock timeouts cannot be told apart from other failures on the API (a failed save is a 500 ProblemDetails);
// count them from the node logs ("Content save operation failed" + "Failed to acquire ... lock").
import exec from 'k6/execution';
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
if (NODES.length < 1) throw new Error('management-api-mix.js needs at least one node');

const API = `${GATEWAY}/umbraco/management/api/v1`;
// The update-validate endpoint only exists in API version 1.1.
const API_V1_1 = `${GATEWAY}/umbraco/management/api/v1.1`;
const CLIENT_ID = __ENV.K6_CLIENT_ID || 'umbraco-back-office-k6';
const CLIENT_SECRET = __ENV.K6_CLIENT_SECRET;
if (!CLIENT_SECRET) throw new Error('K6_CLIENT_SECRET is not set; run through the AppHost');

const VUS = parseInt(__ENV.VUS || '150', 10);
const ITERATIONS = parseInt(__ENV.ITERATIONS || '1000', 10);
const MAX_DURATION = __ENV.MAX_DURATION || '60m';
const BRANCHES = parseInt(__ENV.BRANCHES || '200', 10);
const PER_BRANCH = parseInt(__ENV.PER_BRANCH || '10', 10);
const ARTICLES_BRANCH = parseInt(__ENV.ARTICLES_BRANCH || '0', 10);
const SITES_BRANCH = parseInt(__ENV.SITES_BRANCH || '1', 10);
// Two-phase mode (WARMUP_DURATION + STEADY_DURATION set): full load for WARMUP_DURATION, then the measured
// 'steady' scenario for STEADY_DURATION on its own branches, starting while the warm-up VUs are still running so
// the thread pool never idles. Steady metrics are exposed through the {scenario:steady} thresholds below.
const WARMUP_DURATION = __ENV.WARMUP_DURATION || '';
const STEADY_DURATION = __ENV.STEADY_DURATION || '';
const TWO_PHASE = WARMUP_DURATION !== '' && STEADY_DURATION !== '';
const STEADY_ARTICLES_BRANCH = parseInt(__ENV.STEADY_ARTICLES_BRANCH || `${ARTICLES_BRANCH}`, 10);
const STEADY_SITES_BRANCH = parseInt(__ENV.STEADY_SITES_BRANCH || `${SITES_BRANCH}`, 10);
// TREE_READS=1 adds the tree reads of the customer's mix to every iteration: the document tree root and the
// children of the parent the scenario writes under. A branch index of -1 creates a fresh published branch for
// the run instead of using a seeded one.
const TREE_READS = parseInt(__ENV.TREE_READS || '0', 10);

const saveFailed = new Counter('save_failed_500');
const conflict = new Counter('conflict_409');
const tokenRefreshes = new Counter('token_refreshes');
const scenarioDuration = new Trend('scenario_duration', true);

export const options = {
  setupTimeout: '15m',
  scenarios: TWO_PHASE
    ? {
        warmup: { executor: 'constant-vus', vus: VUS, duration: WARMUP_DURATION, gracefulStop: '30s' },
        steady: { executor: 'constant-vus', vus: VUS, duration: STEADY_DURATION, startTime: WARMUP_DURATION, gracefulStop: '30s' },
      }
    : {
        default: {
          executor: 'shared-iterations',
          vus: VUS,
          iterations: ITERATIONS,
          maxDuration: MAX_DURATION,
        },
      },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    save_failed_500: ['count<1'],
    conflict_409: ['count<1'],
    ...(TWO_PHASE
      ? {
          'http_reqs{scenario:steady}': ['count>=0'],
          'iterations{scenario:steady}': ['count>=0'],
          'http_req_duration{scenario:steady}': ['p(95)>=0'],
          'http_req_failed{scenario:steady}': ['rate<=1'],
          'scenario_duration{scenario:steady}': ['p(95)>=0'],
          'save_failed_500{scenario:steady}': ['count>=0'],
        }
      : {}),
  },
};

export function setup() {
  const seed = http.post(`${NODES[0]}/umbraco/lb/seed?branches=${BRANCHES}&perBranch=${PER_BRANCH}`, null, { timeout: '15m' });
  if (seed.status !== 200) throw new Error(`seed failed: ${seed.status} ${seed.body}`);
  const apiUser = http.post(`${NODES[0]}/umbraco/lb/api-user`);
  if (apiUser.status !== 200) throw new Error(`api-user failed: ${apiUser.status} ${apiUser.body}`);
  const tree = http.get(`${NODES[0]}/umbraco/lb/tree`);
  if (tree.status !== 200) throw new Error(`tree failed: ${tree.status} ${tree.body}`);
  let body = tree.json();
  const needed = Math.max(ARTICLES_BRANCH, SITES_BRANCH, STEADY_ARTICLES_BRANCH, STEADY_SITES_BRANCH) + 1;
  if (!body.documentTypeKey || body.branches.length < needed) throw new Error(`tree has no document type key or fewer than ${needed} branches`);
  function resolveBranch(index, label) {
    if (index >= 0) return body.branches[index].key;
    const created = http.post(`${NODES[0]}/umbraco/lb/create/${body.rootId}`);
    if (created.status !== 200) throw new Error(`create branch failed: ${created.status} ${created.body}`);
    const createdId = created.json('id');
    const published = http.post(`${NODES[0]}/umbraco/lb/publish/${createdId}`);
    if (published.status !== 200) throw new Error(`publish branch failed: ${published.status} ${published.body}`);
    const refreshed = http.get(`${NODES[0]}/umbraco/lb/tree`);
    if (refreshed.status !== 200) throw new Error(`tree failed: ${refreshed.status} ${refreshed.body}`);
    body = refreshed.json();
    const branch = body.branches.find((b) => b.id === createdId);
    if (!branch) throw new Error(`created branch ${createdId} not found in the tree`);
    console.log(`${label}: fresh branch ${createdId} (${branch.key})`);
    return branch.key;
  }
  // Articles all go under one parent, sites under another, as in the customer's tree.
  const articlesParent = resolveBranch(ARTICLES_BRANCH, 'articles');
  const sitesParent = resolveBranch(SITES_BRANCH, 'sites');
  return {
    articlesParent,
    sitesParent,
    steadyArticlesParent: TWO_PHASE ? resolveBranch(STEADY_ARTICLES_BRANCH, 'steady articles') : articlesParent,
    steadySitesParent: TWO_PHASE ? resolveBranch(STEADY_SITES_BRANCH, 'steady sites') : sitesParent,
    documentType: body.documentTypeKey,
  };
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

export default function (data) {
  const steady = exec.scenario.name === 'steady';
  const articlesParent = steady ? data.steadyArticlesParent : data.articlesParent;
  const sitesParent = steady ? data.steadySitesParent : data.sitesParent;
  sleep(Math.floor(Math.random() * 5) + 1);
  const scenario = pickScenario();
  const started = Date.now();

  if (TREE_READS > 0) {
    const parent = scenario === 'createSite' || scenario === 'editSite' ? sitesParent : articlesParent;
    const root = api('GET', '/tree/document/root?skip=0&take=100', null, 'tree-root');
    check(root, { 'tree-root 200': (r) => r.status === 200 });
    const children = api('GET', `/tree/document/children?parentId=${parent}&skip=0&take=100`, null, 'tree-children');
    check(children, { 'tree-children 200': (r) => r.status === 200 });
  }

  switch (scenario) {
    case 'createArticle': {
      getDocument(articlesParent, 'read-parent');
      createDocument(articlesParent, data, 'create-article');
      break;
    }
    case 'editArticle': {
      getDocument(articlesParent, 'read-parent');
      const id = createDocument(articlesParent, data, 'create-article');
      if (id) {
        const doc = getDocument(id, 'read-article');
        if (doc) updateDocument(id, doc, 'edit-article');
      }
      break;
    }
    case 'publishArticle': {
      getDocument(articlesParent, 'read-parent');
      const id = createDocument(articlesParent, data, 'create-article');
      if (id) {
        const doc = getDocument(id, 'read-article');
        if (doc) publishDocument(id, doc, 'publish-article');
      }
      break;
    }
    case 'createSite': {
      getDocument(sitesParent, 'read-parent');
      createDocument(sitesParent, data, 'create-site');
      break;
    }
    case 'editSite': {
      getDocument(sitesParent, 'read-parent');
      const id = createDocument(sitesParent, data, 'create-site');
      if (id) {
        const doc = getDocument(id, 'read-site');
        if (doc) updateDocument(id, doc, 'edit-site');
      }
      break;
    }
    default:
      break;
  }

  scenarioDuration.add(Date.now() - started, { scenario });
  sleep(1);
}
