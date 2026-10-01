# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A test rig, not a product: an Aspire 13.6 AppHost that runs N Umbraco 17 nodes as host processes behind
a YARP gateway (plain round-robin, no session affinity), with SQL Server and Redis containers and a k6
container. It exists to verify Umbraco CMS load-balancing fixes (first target: PR 24034, cache-sync lock
ordering) by running the same scenario against a released CMS and a locally packed PR build.

## Commands

```bash
dotnet build AspireLoadbalanced.sln                     # build (default CMS 17.7.0)
UmbracoVersion=<v> dotnet build AspireLoadbalanced.sln  # build against another CMS package version

aspire run --launch-profile http                        # start everything (from repo root; aspire.config.json points at AppHost)
aspire run --detach --non-interactive --launch-profile http
aspire stop
aspire describe                                         # resource states/health
aspire wait umb-1                                       # block until healthy (gateway: --status up)
aspire logs umb-2                                       # node console logs (Serilog console sink)
aspire resource k6 start                                # k6 is WithExplicitStart
aspire resource umb-2 restart

scripts/pack-cms.sh /path/to/Umbraco-CMS                # pack a CMS checkout into ./packages, prints the version to use
```

There is no test project. Verification is the k6 scripts in `k6/` plus the `/umbraco/lb` endpoints;
`scripts/repro-sync-gap.sh` probes the window between a save's cache-version bump and its cache instruction. Pick the
script at AppHost start with `Rig__K6Script=/scripts/cache-sync-lock.js`; pass script knobs as
`Rig__K6Env__<NAME>=<value>` (forwarded to the k6 container as env vars, read via `__ENV`).

Rig knobs (AppHost config, overridable as env vars `Rig__...`): `NodeCount` (3), `GatewayPort` (8080),
`FirstNodePort` (5001, node i gets 5000+i), `UseRedisDistributedCache` (true), `K6Script`, `K6Env:*`.

## Architecture (the parts that span files)

- **CMS version selection.** `Umbraco.LbSite.csproj` references `Umbraco.Cms` at `$(UmbracoVersion)`.
  `Directory.Build.props` only supplies a fallback (17.7.0) when the property is empty; MSBuild reads
  the `UmbracoVersion` environment variable, so the version is decided per build, not stored. `nuget.config`
  adds `./packages` as a feed with no source mapping, so packed prerelease versions resolve locally. Always
  confirm the running version with `GET /umbraco/lb/status` (`version` field) rather than trusting the props file.
- **pack-cms.sh version.** Use msbuild `PackageVersion` (e.g. `17.8.0--rc.preview.102.g6117125`), not
  `NuGetPackageVersion`; the build adds a prerelease suffix on top of Nerdbank.GitVersioning.
- **Same-host multi-node identity.** All nodes share one content root, so `AppHost/Program.cs` gives each
  node distinct `Hosting:SiteName` (with `LocalTempStorageLocation=EnvironmentTemp`, separates temp/Examine
  folders), `Hosting:MachineIdentifier` (cache-sync checkpoint row in `umbracoLastSynced`), and
  `Global:MainDomKeyDiscriminator` (otherwise a second process steals MainDom). Media and temp uploads
  point at the shared `shared/` folder.
- **Load-balanced backoffice without sticky sessions.** Every node is `SchedulingPublisher` (via
  `Rig/EnvironmentServerRoleAccessor.cs` and `SetServerRegistrar`) and calls `LoadBalanceIsolatedCaches()`
  (the code path PR 24034 changes; there is no appsettings switch for it). `SignalR:ClientShouldSkipNegotiation=true`
  makes hubs WebSocket-only, and the Redis SignalR backplane in `Umbraco.LbSite/Program.cs` delivers cross-node
  events. Redis also holds Data Protection keys and, unless disabled, the HybridCache L2.
  With explicit roles `umbracoServer` stays empty; that is expected.
- **Startup ordering.** Node 1 performs the unattended install; nodes 2..N `WaitFor(node 1)` healthy via
  the `/umbraco/lb/status` health check. The gateway `WithReference`s every node because YARP's
  `AddCluster(name, object[])` emits `http://umb-N` service-discovery destinations without adding the
  references that resolve them (symptom: 502, `umb-1:80`).
- **Backoffice requests only.** `RepositoryCacheVersionAccessor` treats every non-backoffice request as synced, so
  the inline isolated-cache sync only runs for backoffice requests. `Program.cs` registers `/umbraco/lb/` through
  `UmbracoRequestPathsOptions.IsBackOfficeRequest`; without it the path counts as a front-end plugin route and no
  test exercises the inline sync. Keep any new rig endpoint under that prefix.
- **`/umbraco/lb` endpoints** (`Rig/LbController.cs`, anonymous): `status`, `seed`, `ids`, `tree`, `get/{id}`, `save/{id}?delayMs=`,
  `publish/{id}`, `publish-branch/{id}`, `delete/{id}`. They call `IContentService` directly, which takes the
  same `ContentTree` locks as the Management API. `Rig/RigExceptionFilter.cs` maps "Cannot save a non-current
  version" to 409 and distributed lock timeouts to 503 so k6 can count them separately (`stale_version`,
  `read_lock_timeout`, `write_lock_timeout`); other operation failures return 422. `seed` is idempotent while
  an untrashed `LB Root` exists; trash it (`delete/<rootId>`) to seed a different shape.
- **k6 scenario design** (`k6/cache-sync-lock.js`). Models many editors each saving then publishing one
  document through the gateway, with disjoint page slices per VU, so a 409 means a stale cached copy, not a
  writer collision. A small bulk VU publishes reserved 10-page branches. Avoid publishing large branches in
  this scenario: one big `PublishBranch` holds the `ContentTree` write lock past the lowered 5 s read-lock
  timeout and makes every version fail, which hides the signal.
- **Timing.** `InstructionProcessJob` starts 60 s after boot, then every 5 s. Start load at least ~70 s
  after boot when comparing versions, or the background sync is not yet running.

## Operating notes

- Redis (Aspire 13.6) is password-protected, TLS on 6379, plain on 6380 inside the container:
  `docker exec -e REDISCLI_AUTH=<Parameters:redis-password> <redis-container> redis-cli -p 6380`.
- SQL: `docker exec -e SQLCMDPASSWORD=<Parameters:sql-password> <sql-container> /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -C -d UmbracoLb`.
  Passwords are in the AppHost user secrets (`dotnet user-secrets list` in `AppHost/`); don't print them.
- SQL and Redis containers are persistent (`umbraco-lb-sql` volume). Switching to a CMS version with new
  migrations upgrades the schema; going back then needs the volume deleted. Check
  `git diff release-<old> <commit> -- src/Umbraco.Infrastructure/Migrations/` in the CMS checkout first.
- `docs/` is git-ignored local working notes (plans, results); keep run results there, not in the repo.
