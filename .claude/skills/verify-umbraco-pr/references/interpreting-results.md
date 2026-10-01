# Interpreting rig results

## Contents

1. What the default scenario does
2. Metrics
3. Known pitfalls
4. Known findings (as of 01-10-2026)
5. Adapting the scenario

## 1. What the default scenario does

`k6/cache-sync-lock.js`:

- **Editors:** 100 VUs, each owning a disjoint slice of pages. Each loop saves a page, thinks 0.5-1.5 s, then
  publishes it. All requests go through the round-robin gateway, so about two thirds of save/publish pairs land on
  different nodes. That is the inline isolated-cache sync path: a node reading an entity type another node has
  just written.
- **Bulk:** one VU publishes reserved 10-page branches, kept apart from the editors' pages.
- **Lock timeout:** `DistributedLockingReadLockDefaultTimeout` is lowered to 5 s on every node, so a stalled
  request shows up as a timeout instead of a 60 s hang.

Because no two writers share a page, a 409 (`stale_version`) means a node used an outdated cached copy, not a
write collision.

The `/umbraco/lb` endpoints are registered as **backoffice** requests (`Umbraco.LbSite/Program.cs`). This matters:
Umbraco only runs the inline sync for backoffice requests and treats front-end requests as always synced. If a run
shows no `Checking if cache for ... is synced` activity at all (Debug logging, see `CLAUDE.md`), check that
registration first.

## 2. Metrics

| Metric | Meaning |
|---|---|
| editor requests failed | share of editor HTTP requests that were not 200, for any reason |
| editor request duration | p95/max/median. A max near or above 5 s usually means a lock timeout |
| stale versions (409) | `Cannot save a non-current version`: a stale cached document |
| read/write-lock timeouts (503) | distributed lock timeouts the rig mapped, including ones wrapped in `AggregateException` |
| save/publish on different nodes | how often the scenario actually crossed nodes; should be about 2/3 of pairs |
| iterations | completed editor loops in the run; a throughput signal when both runs had the same duration |
| failures in node logs | every failure from all node logs, by kind. `rig ...` were returned as 409/503 and k6 counted them. `unmapped ...` returned 500; read the stack in the node log. `(db log) SQL lock request timeout` duplicates the lock timeouts and is not a separate failure |
| sync-gap probe | `scripts/repro-sync-gap.sh`: save on umb-1 with the request end delayed by `delay`, then read the document on umb-2. See below |

**Probe rounds.** Each round saves a document on umb-1, holding its request open for `delay` after the save
commits (cache instructions are written at request end), then reads it on umb-2:

- **control:** umb-2 does nothing else in the window. It still goes stale if umb-2's background job (every 5 s)
  happens to run inside the window: the job adopts the new version without finding the instruction. So with
  `delay 3000 ms`, expect roughly 3-5 of 5 stale while the gap is open; the count depends on timing.
- **probe:** umb-2 reads an unrelated document inside the window, forcing an inline sync there. Expect 5/5
  stale while the gap is open.
- **delay 0 ms:** the window is the normal commit-to-request-end time. Expect all fresh, but an occasional stale
  round right after k6 (the instruction backlog is still being worked through; one round took 87 s to converge)
  is not significant.

A closed gap shows as `delay 3000 ms` rounds coming back fresh.

k6's `/s` rates include setup time (the seed on a first run), so compare totals, not rates.

## 3. Known pitfalls

- **Large branch publishes:** a single `PublishBranch` of thousands of nodes holds the `ContentTree` write lock
  for longer than the 5 s lock timeout and makes every version fail. Keep bulk publishes small (the default is 10 pages).
- **Starting too early:** `InstructionProcessJob` starts 60 s after boot. `run-scenario.sh` waits 70 s; a
  hand-run test must wait too.
- **Wrong version:** `UmbracoVersion` only applies to the build it was set for. `run-scenario.sh` checks
  `/umbraco/lb/status` on every node; when running by hand, check it yourself.
- **Single runs:** timing varies between runs. Differences of a few percent are noise; repeat before
  concluding anything from them.
- **Schema:** after a PR with migrations, the baseline can't boot on the upgraded database. The fix is
  deleting the `umbraco-lb-sql` volume, after asking.

## 4. Known findings (as of 01-10-2026)

These were found while verifying PR 24034 (cache-sync lock ordering), with 17.7.0 as the baseline.

Two runs each so far, so treat these as ranges, not exact values.

- **17.7.0 under the default scenario:** 88-96 % of editor requests fail, almost all on `ContentTree` lock
  timeouts. p95 is 9-16 s, and max reaches 55-60 s (60 s is k6's request timeout, so it's a ceiling). This is the
  deadlock PR 24034 targets. The nodes stay stuck for up to about a minute after k6 ends.
- **PR 24034 at `6117125`:** 7-10 % fail, with no `ContentTree` read-lock timeouts. The largest group is `unmapped write-lock timeout on
  DocumentUrlAliases`. A save's scope-exit handler (`DocumentUrlAliasService.CreateOrUpdateAliasesAsync`) holds
  that global write lock while `GetById` runs the inline sync. Unwrapped mapping was added afterwards, so newer
  runs count these as `rig write-lock-timeout`.
- **Version-bump/instruction gap (pre-existing, also in 17.7.0):** the cache-version bump commits with the save,
  but the cache instruction is written at request end. A sync on another node in between adopts the version
  without the instruction and serves stale data for up to about 10 s. The probe's `delay 3000 ms` rounds are
  stale on both versions until this is fixed.
- A handover with the details and fix options exists locally in `docs/05-handover-pr24034-cache-sync.md`
  (git-ignored, so it may be missing on other machines).

When a run on a newer commit moves a result outside these ranges, or a failure kind appears or disappears, say
so in the report; that is usually the headline. Movement within the ranges on the same commit is variance.

## 5. Adapting the scenario

The default scenario targets load-balanced editing and cache sync. For a PR about something else:

- First, try knobs: `EDITORS`, `THINK`, `EDITOR_TARGET=pinned` (each editor fixed to one node), `BULK_VUS`,
  `BRANCHES`/`PER_BRANCH` (a different seed shape needs the old root trashed first:
  `POST /umbraco/lb/delete/<rootId>`).
- If the PR needs other operations (media, members, data types, domains), add an action to
  `Umbraco.LbSite/Rig/LbController.cs` under `/umbraco/lb` and a script in `k6/`. Start from `cache-sync-lock.js`'s
  `url()` helper and node discovery. Map new failure types in `Rig/RigExceptionFilter.cs` if k6 should count them.
  These are rig changes; tell the user, and leave committing to them.
- If nothing in the rig exercises the PR's change, say so plainly rather than reporting a meaningless "no difference".
