# Umbraco Aspire load-balance testing

A local rig for verifying Umbraco CMS load-balancing fixes. One `aspire run` starts:

- SQL Server (shared database) and Redis (Data Protection keys, distributed cache, SignalR backplane),
- N Umbraco 17 nodes (default 3), all backoffice-capable `SchedulingPublisher` nodes with
  `LoadBalanceIsolatedCaches()`, each also reachable on its own port,
- a YARP gateway doing plain round-robin with **no sticky sessions**,
- a k6 container with load scripts, started on demand.

The CMS comes from a NuGet package chosen by one MSBuild property, `UmbracoVersion`. The same rig can run
a nuget.org release and a locally packed PR build, so a fix can be compared against the release it targets.

## Prerequisites

| | Check |
|---|---|
| Docker usable without `sudo` | `docker ps` |
| .NET 10 SDK | `dotnet --list-sdks` |
| Aspire CLI 13.6 | `aspire --version` (install: `curl -sSL https://aspire.dev/install.sh \| bash`) |
| Node.js + npm | only for packing a CMS checkout (the backoffice client is built during the pack) |
| Python 3 | `python3 --version` (used by `scripts/run-scenario.sh` and `scripts/compare-runs.py`) |
| A clone of [Umbraco-CMS](https://github.com/umbraco/Umbraco-CMS) | only for testing an unreleased PR |

## Endpoints

| What | URL |
|---|---|
| Aspire dashboard | printed by `aspire run` (`http://localhost:15165` with the `http` profile) |
| Backoffice through the gateway | http://localhost:8080/umbraco |
| Node *i* directly | http://localhost:500*i* (e.g. `umb-2` on 5002) |
| Backoffice login | `admin@lb.local` / `LoadBalance-Admin-1234!` (local throwaway dev credential) |

Every response carries an `X-Umb-Node` header naming the node that served it.

The anonymous `/umbraco/lb` endpoints on every node stand in for an editor's Management API calls, so k6 does
not need backoffice auth. They are registered as backoffice requests (`UmbracoRequestPathsOptions` in
`Umbraco.LbSite/Program.cs`). That matters: Umbraco only runs the inline isolated-cache sync for backoffice
requests, and front-end requests rely on the background job alone. Two scenarios (`management-api-mix.js`,
`editor-read-mix.js`) go through the real Management API instead, as the `k6` API user that `api-user` creates.

| Route | Does |
|---|---|
| `GET /umbraco/lb/status` | node, role, runtime level, **CMS version**, thread-pool counters, `isolatedCaches`; 503 until the node is running (Aspire health check) |
| `POST /umbraco/lb/seed?branches=&perBranch=` | creates the `lbPage` type and an `LB Root` tree, publishes it; idempotent |
| `GET /umbraco/lb/tree`, `GET /umbraco/lb/ids?count=` | seeded ids for k6 (`tree` also returns the root id and the document type key) |
| `GET /umbraco/lb/get/{id}` | the document as this node's repository cache returns it (version ids, title) |
| `POST /umbraco/lb/create/{parentId}` | creates and saves a new page under a parent, as a backoffice "create" does; returns its id |
| `POST /umbraco/lb/save/{id}[?delayMs=]`, `/umbraco/lb/publish/{id}`, `/umbraco/lb/publish-branch/{id}`, `/umbraco/lb/delete/{id}` | content operations via `IContentService` (`delayMs` holds the save's request open after the commit, see step 5) |
| `POST /umbraco/lb/api-user` | creates the `k6` API user in the admin group and links client id `umbraco-back-office-k6` to the AppHost's generated `apiuser-client-secret` parameter; idempotent |

Save and publish return **409** for a stale cached version ("Cannot save a non-current version") and **503**
for a distributed lock timeout, so the two symptoms can be counted separately.

## Verifying a PR

The workflow is: get a baseline on the release the PR targets, pack the PR, run the same scenario on the
PR build, and compare.

**With Claude Code**, the `verify-umbraco-pr` skill in `.claude/skills/` does all of it. Ask "verify PR 24034,
the CMS checkout is at ~/github/Umbraco-CMS" from this folder. It writes a report to
`results/pr-<n>-<date>/report.md` (git-ignored).

**By hand**, the scripts it uses:

```bash
scripts/pack-cms.sh <cms-checkout>                                   # prints VERSION=<pr-version>
scripts/run-scenario.sh results/pr-123/baseline 17.7.0 --probe        # one side: boot, version check, k6, logs, probe
scripts/run-scenario.sh results/pr-123/pr <pr-version> --probe
scripts/compare-runs.py --cms <cms-checkout> baseline=results/pr-123/baseline pr=results/pr-123/pr
```

`run-scenario.sh <out-dir> <version> [k6-script] [--probe]` takes the script as a path inside the k6 container
(default `/scripts/cache-sync-lock.js`) and scenario knobs as exported `Rig__K6Env__<NAME>` variables. It leaves
`run.log`, `status-umb-N.json`, `k6.txt`, `node-umb-N.log` and, with `--probe`, `probe.txt` in the folder;
`SAMPLE_THREADPOOL=1` also samples every node's thread-pool counters (from `/umbraco/lb/status`) into
`threadpool.jsonl` every 2 s while k6 runs. `scripts/run-probe.sh <run-dir>` re-runs only the probe against the
running rig. The steps below explain what the scripts do.

### 1. Baseline on the released version

```bash
aspire run --launch-profile http            # uses UmbracoVersion=17.7.0 from Directory.Build.props
```

On first start `umb-1` performs an unattended install; the other nodes wait until it is healthy. Then check
the rig itself:

```bash
curl -s http://localhost:5001/umbraco/lb/status     # "version" shows the CMS actually running
for i in $(seq 1 6); do curl -s -o /dev/null -D - http://localhost:8080/umbraco/lb/status | grep -i x-umb-node; done
```

The second command should rotate `umb-1 umb-2 umb-3`. Start the `k6` resource (dashboard, or
`aspire resource k6 start`) to run `k6/smoke.js`: every node must be hit and no request may fail.

### 2. Pack the PR

```bash
cd /path/to/Umbraco-CMS && gh pr checkout <number>      # or git checkout <branch>
cd -
scripts/pack-cms.sh /path/to/Umbraco-CMS
```

The script builds `Umbraco.Cms` and all its dependency packages into `./packages` and prints the version to
use, for example `17.8.0--rc.preview.102.g6117125`. Every commit packs to a distinct version, so nothing
needs clearing between PR iterations; the script skips the build when that version is already in `./packages`
(`--force` rebuilds). The version comes from the commit, so commit before packing: an uncommitted change packs
under HEAD's version, and NuGet keeps serving the copy it has cached for it. The first pack of a checkout takes
several minutes.

Before switching, check whether the PR adds migrations:

```bash
git -C /path/to/Umbraco-CMS diff release-17.7.0 HEAD --stat -- src/Umbraco.Infrastructure/Migrations/
```

The database lives in a persistent volume. If the PR has migrations, running it upgrades the schema, and
going back to the release afterwards means deleting the `umbraco-lb-sql` volume. Without migrations you can
switch back and forth freely.

### 3. Run the scenario on both versions

```bash
aspire stop
Rig__K6Script=/scripts/cache-sync-lock.js aspire run --launch-profile http
# wait ~70 s after the nodes are healthy, then:
aspire resource k6 start

aspire stop
UmbracoVersion=<packed version> Rig__K6Script=/scripts/cache-sync-lock.js aspire run --launch-profile http
curl -s http://localhost:5001/umbraco/lb/status     # confirm "version" is the packed build
# wait ~70 s, then:
aspire resource k6 start
```

Wait about 70 seconds after boot before starting k6. Umbraco's background instruction job starts 60
seconds after boot, and without it the cross-node sync under test is not running.

`UmbracoVersion` only applies to builds made while the variable is set. A plain `aspire run` afterwards goes
back to 17.7.0, so always confirm with `/umbraco/lb/status`.

### 4. Compare

`k6/cache-sync-lock.js` models many editors working at once on load-balanced backoffices:

- 100 editors, each owning a disjoint set of pages, save a page, pause, then publish it. All requests go
  through the gateway, so a save and its publish usually land on different nodes. That is the inline
  cache-sync path.
- One bulk editor publishes small (10-page) branches that no editor touches.

Read the k6 summary in the `k6` resource logs:

| Metric | Meaning |
|---|---|
| `stale_version` | a node saved or published from an outdated cached copy. Editors never share pages, so this is not a write collision |
| `read_lock_timeout`, `write_lock_timeout` | requests that waited the full distributed-lock timeout (lowered to 5 s in the rig so stalls show quickly) |
| `http_req_duration{scenario:editors}` | p95 under 2 s, max under 4.5 s; a stuck request shows up as a 5 s+ outlier |
| `cross_node_pairs` / `same_node_pairs` | how often a save and its publish hit different nodes |

A fix shows up as these counts dropping between the baseline and the PR build. Node logs
(`aspire logs umb-2`) log each 409/503 with the stack trace (`Rig request ... failed with ...`).

Knobs, passed as `Rig__K6Env__<NAME>=<value>` when starting the AppHost:

| Name | Default | |
|---|---|---|
| `EDITORS` | 100 | editor VUs |
| `THINK` | 1 | seconds between an editor's actions (randomised 0.5x to 1.5x) |
| `EDITOR_TARGET` | `gateway` | `pinned` fixes each editor to one node |
| `BULK_VUS` | 1 | 0 disables bulk publishing |
| `BRANCHES`, `PER_BRANCH` | 200, 10 | seed shape |
| `BULK_BRANCHES` | 20 | branches reserved for bulk publishing |
| `DURATION` | 2m | |

The seed only runs while no `LB Root` exists. To change the tree shape, trash the old root first:
`curl -X POST http://localhost:5001/umbraco/lb/delete/<rootId>`.

Keep bulk publishes small. A single publish of a large branch holds the content-tree write lock for longer
than the lowered lock timeout. Every version then times out, which hides the difference you are looking for.

### 5. Sync-gap probe

`scripts/repro-sync-gap.sh [rounds] [delayMs]` checks whether a node can serve a stale cached document after
another node's save. It saves on `umb-1` with the end of the request delayed by `delayMs`. Cache instructions are
written at request end, so the delay widens the window between the cache version bump (committed with the save)
and the instruction. Then it reads the document on `umb-2`. A `probe` round also reads an unrelated document on
`umb-2` inside that window to force an inline sync there. Each round reports `fresh`, or `STALE` and how long
`umb-2` took to catch up. With `delayMs=0` every round should be fresh.

### 6. Manual checks

Use the direct node ports to control which node serves each step. Each check is "do X on node A, then
within 5 s do Y on node B":

- save a document on `umb-1`, publish it on `umb-2`: the published value is the new one;
- trash a document on `umb-1`, pick or link it on `umb-2`: it no longer resolves;
- change a data type configuration on `umb-1`, save content using it on `umb-2`: the new configuration applies;
- create a parent on `umb-1`, create a child under it on `umb-2`: tree and URL are correct;
- through the gateway, keep a document open in the backoffice and save it via `umb-2` directly
  (`curl -X POST http://localhost:5002/umbraco/lb/save/<id>`): the "updated by another user" notification arrives,
  whichever node the browser's WebSocket is on.

Useful database views while testing: `umbracoLastSynced` has one row per node, and each node's synced id
must never go backwards. `umbracoCacheInstruction` shows instructions and the process they came from.
Passwords for SQL and Redis are in the AppHost user secrets (`dotnet user-secrets list` in `AppHost/`).

## k6 scenarios

Pick the script with `Rig__K6Script=/scripts/<name>.js` when starting the AppHost and pass its knobs as
`Rig__K6Env__<NAME>=<value>` (k6 reads them from `__ENV`). Every scenario except the smoke test seeds the tree in
`setup()` (idempotent; `BRANCHES`=200 branches of `PER_BRANCH`=10 pages) and sends its load through the gateway.

| Script | Models | Knobs (default) |
|---|---|---|
| `smoke.js` | 5 VUs hit `/umbraco/lb/status` for 20 s; every node must answer | none |
| `cache-sync-lock.js` | editors saving then publishing disjoint pages across nodes, plus a bulk publisher (step 4) | `EDITORS`, `THINK`, `EDITOR_TARGET`, `BULK_VUS`, `BULK_BRANCHES`, `DURATION` (step 4) |
| `client-mix.js` | a customer's backoffice stress test against the `/umbraco/lb` endpoints: a fixed number of shared iterations, each one scenario drawn by probability (create / create+edit / create+publish / site create / site edit) with a 1-5 s think time | `VUS` (150), `ITERATIONS` (1000), `MAX_DURATION` (60m) |
| `management-api-mix.js` | the same mix through the real Management API (document create, update, validate and publish) with OAuth client credentials | `VUS` (150), `ITERATIONS` (1000), `MAX_DURATION` (60m), `ARTICLES_BRANCH` (0), `SITES_BRANCH` (1), `TREE_READS` (0), `WARMUP_DURATION` + `STEADY_DURATION` (unset), `STEADY_ARTICLES_BRANCH`, `STEADY_SITES_BRANCH` |
| `editor-read-mix.js` | a read-heavy backoffice: `READERS` VUs browse the seeded tree back to back (the children of a random branch, one of those documents, the document type) while `WRITERS` VUs run the create / edit / publish mix with a 1-5 s think time on one branch | `READERS` (150), `WRITERS` (10), `DURATION` (6m), `READ_THINK_MS` (0), `WRITE_BRANCH` (-1), `READ_BRANCHES` (all) |

Prefer `management-api-mix.js` or `editor-read-mix.js` for anything meant to resemble editors: the `/umbraco/lb`
endpoints skip validation, property editors and OAuth. Both need the AppHost (the client secret comes from the
`apiuser-client-secret` parameter), and on the Management API a failed save is a 500 ProblemDetails
(`save_failed_500`) that cannot be told from a lock timeout, so count lock timeouts from the node logs
("Content save operation failed" + "Failed to acquire ... lock"); 409s are `conflict_409`.

`management-api-mix.js` knobs:

- `ARTICLES_BRANCH` / `SITES_BRANCH` index the seeded branches the articles and sites are created under. `-1`
  creates a fresh, published branch under the seeded root for the run (through `/umbraco/lb/create` and
  `/umbraco/lb/publish`), so every run starts from the same small sibling set.
- `TREE_READS=1` adds a GET of the document tree root and of the children of the parent being written under to
  every iteration, as in the customer's mix.
- With both `WARMUP_DURATION` and `STEADY_DURATION` set, the run has two phases: a `warmup` scenario at full load
  for `WARMUP_DURATION`, then the measured `steady` scenario for `STEADY_DURATION` on its own branches
  (`STEADY_ARTICLES_BRANCH` / `STEADY_SITES_BRANCH`, default the warm-up's), started while the warm-up VUs finish
  so the thread pool never idles. Read the `{scenario:steady}` rows of the k6 summary. Without them the run is
  one shared-iterations scenario of `ITERATIONS` iterations, capped at `MAX_DURATION`.

`editor-read-mix.js` knobs: `WRITE_BRANCH=-1` (the default) gives the writers a fresh published branch per run,
any other value a seeded branch index; `READ_BRANCHES` limits the readers to the first N seeded branches;
`READ_THINK_MS` adds a think time between reader iterations (randomised 0.5x to 1.5x). The summary has
`readers` and `writers` sub-metrics.

`scripts/compare-runs.py` reads the thresholds, checks, node-log failures and probe of any run, but its metric
rows (`editor requests failed`, `stale versions`, lock timeouts, `cross_node_pairs`, duration) come from
`cache-sync-lock.js`'s metrics; for the Management API scenarios only `iterations` fills in.

## Configuration

AppHost settings (`AppHost/appsettings.json`, or env vars `Rig__<Name>`):

| Setting | Default | |
|---|---|---|
| `NodeCount` | 3 | |
| `GatewayPort` | 8080 | |
| `FirstNodePort` | 5001 | node *i* listens on `FirstNodePort + i - 1` |
| `UseRedisDistributedCache` | true | makes Redis the HybridCache L2; `false` to see each node's own cache only |
| `LoadBalanceIsolatedCaches` | true | `false` skips `LoadBalanceIsolatedCaches()`, so every node runs as a single, non-load-balanced server would (`isolatedCaches` in `/umbraco/lb/status`) |
| `ThreadPoolMinThreads` | unset | applies `ThreadPool.SetMinThreads` on every node, like the `ThreadPoolMinThreads` runtimeconfig knob a site can set; `/umbraco/lb/status` shows the pool's counters |
| `K6Script` | `/scripts/smoke.js` | path inside the k6 container |
| `K6Env:<NAME>` | | environment for the k6 container, i.e. the scenario knobs (`Rig__K6Env__EDITORS=200`) |
| `NodeEnv:<NAME>` | | extra environment for every Umbraco node, `:` written as `__`; a key set here overrides the AppHost's own defaults |

`NodeEnv` passes any setting through to the nodes, so a production setting the AppHost does not know about can be
copied in. Two uses so far, both to mimic a customer's pods:

```bash
Rig__NodeEnv__DOTNET_PROCESSOR_COUNT=2 \
Rig__NodeEnv__Umbraco__CMS__Global__DistributedLockingReadLockDefaultTimeout=00:01:00 \
Rig__NodeEnv__Umbraco__CMS__Global__DistributedLockingWriteLockDefaultTimeout=00:01:00 \
Rig__K6Script=/scripts/management-api-mix.js aspire run --launch-profile http
```

The first gives each node two processors (2 vCPU pods; `threadPool.processors` in `/umbraco/lb/status` confirms
it). The other two set 60 s lock timeouts: by default the rig lowers the read-lock timeout from the CMS default
of 60 s to 5 s so stalls show quickly, and the write-lock timeout is the CMS default of 5 s. With a minute for
both, a lock wait under a minute shows up as a slow request instead of a timeout failure.

## Reset

```bash
aspire stop
docker volume rm umbraco-lb-sql      # deletes the rig database
rm -r shared logs                    # shared media/uploads and per-node log files
```
