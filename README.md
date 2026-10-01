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
requests, and front-end requests rely on the background job alone.

| Route | Does |
|---|---|
| `GET /umbraco/lb/status` | node, role, runtime level, **CMS version**; 503 until the node is running (Aspire health check) |
| `POST /umbraco/lb/seed?branches=&perBranch=` | creates the `lbPage` type and an `LB Root` tree, publishes it; idempotent |
| `GET /umbraco/lb/tree`, `GET /umbraco/lb/ids?count=` | seeded ids for k6 |
| `GET /umbraco/lb/get/{id}` | the document as this node's repository cache returns it (version ids, title) |
| `POST /umbraco/lb/save/{id}`, `/umbraco/lb/publish/{id}`, `/umbraco/lb/publish-branch/{id}`, `/umbraco/lb/delete/{id}` | content operations via `IContentService` |

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

The steps below explain what those scripts do.

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
needs clearing between PR iterations. The first pack of a checkout takes several minutes.

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

## Configuration

AppHost settings (`AppHost/appsettings.json`, or env vars `Rig__<Name>`):

| Setting | Default |
|---|---|
| `NodeCount` | 3 |
| `GatewayPort` | 8080 |
| `FirstNodePort` | 5001 |
| `UseRedisDistributedCache` | true (makes Redis the HybridCache L2; `false` to see each node's own cache only) |
| `K6Script` | `/scripts/smoke.js` |

## Reset

```bash
aspire stop
docker volume rm umbraco-lb-sql      # deletes the rig database
rm -r shared logs                    # shared media/uploads and per-node log files
```
