// Round-robin smoke test: every node must answer through the gateway.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

function url(resource) {
  const v = __ENV[`services__${resource}__http__0`];
  if (!v) throw new Error(`missing env services__${resource}__http__0`);
  return v.replace(/\/$/, '');
}

// Node names come from the injected service variables, so any Rig:NodeCount works.
const NODE_NAMES = Object.keys(__ENV)
  .map((k) => /^services__(umb-\d+)__http__0$/.exec(k))
  .filter(Boolean)
  .map((m) => m[1])
  .sort();
const GATEWAY = url('gateway');

const hits = new Counter('node_hits');

const thresholds = { http_req_failed: ['rate<0.01'] };
for (const n of NODE_NAMES) {
  thresholds[`node_hits{node:${n}}`] = ['count>0'];
}

export const options = {
  vus: 5,
  duration: '20s',
  thresholds,
};

export default function () {
  const res = http.get(`${GATEWAY}/umbraco/lb/status`);
  check(res, { 'status 200': (r) => r.status === 200 });
  const node = res.headers['X-Umb-Node'];
  if (node) {
    hits.add(1, { node });
  }
}
