---
name: verify-umbraco-pr
description: Verify an Umbraco CMS pull request on this load-balanced test rig. Packs the PR from a CMS checkout, runs the same multi-node load scenario on the released baseline and on the PR build, and writes a side-by-side comparison report. Use this whenever the user wants to test, verify, benchmark, load-test or reproduce something for an Umbraco PR or branch on the rig ("verify PR 24034", "does this fix hold up under load", "run the rig against my branch", "compare 17.7.0 with the PR build", "re-run the PR side"), even if they don't say "skill" or name every step.
---

# Verify an Umbraco PR on the load-balanced rig

The rig (this repo) runs three Umbraco nodes behind a round-robin gateway, plus SQL Server, Redis and k6, all from
one AppHost. `README.md` explains the pieces and `CLAUDE.md` the architecture; read them if something below is
unclear. This skill runs the full comparison: the **baseline** (the release the PR targets) and the **PR build**
get the same scenario, and the differences go into a report.

The rig's results only mean something if both sides really ran the intended CMS version under the same conditions.
Most of the steps below exist to guarantee that, so don't skip them to save time.

## Inputs to settle first

Ask only for what you can't work out yourself:

- **PR**: a number or a branch name. Get the essentials with
  `gh pr view <n> --repo umbraco/Umbraco-CMS --json number,title,headRefName,headRefOid,baseRefName`. Read the body
  and file list (`--json body,files --jq '.body, .files[].path'`) when choosing the scenario.
- **CMS checkout**: a local clone of Umbraco-CMS. Ask the user if you don't know it; check it with
  `git -C <path> remote -v`.
- **Baseline version**: default to the latest stable release of the major the PR targets (a base branch like
  `v17/dev` or `main` → read the major from the checkout's `version.json`). List released versions with
  `curl -s https://api.nuget.org/v3-flatcontainer/umbraco.cms/index.json` and pick the highest version without
  a `-` suffix. Say which one you picked.
- **Scenario**: default `/scripts/cache-sync-lock.js` (many editors saving and publishing single documents across
  nodes, plus the sync-gap probe). Read the PR's description and changed files. If the PR is not about
  load-balanced editing or cache sync, the default may show nothing; tell the user, and see "Adapting the
  scenario" in `references/interpreting-results.md` before running.

## Steps

### 1. Preflight

- `docker ps` works without sudo, `aspire --version` is 13.x (the CLI lives in `~/.aspire/bin`; add it to `PATH`),
  `dotnet --list-sdks` has 10.x, and `node --version` works (only needed for packing).
- `aspire describe --non-interactive --format Json` in this repo shows whether the rig is running. Each run stops
  and restarts it, so mention that if it's up.

### 2. Get the PR's code into the checkout

The checkout may be in use by the user or another agent, so treat it as shared:

- If `git -C <checkout> rev-parse HEAD` already equals the PR's `headRefOid`, use it as it is.
- Otherwise, **ask before switching branches.** Check `git -C <checkout> status --porcelain --untracked-files=no`
  is empty; never stash, reset or discard changes to make it so. Note the current branch so you can offer to
  switch back afterwards, then `gh pr checkout <n>` in the checkout.
- Uncommitted changes on top of the PR are not packed under a version of their own (the version comes from the
  commit), so the result would be ambiguous. Ask the user to commit them, or pack HEAD and say so.
- Untracked files matter too: the SDK compiles every file in a project folder, so an untracked `.cs` file under
  `src/` ends up in the packages. `pack-cms.sh` lists any it finds. Untracked files in `src/Umbraco.Web.UI/` (the
  dev site) are not packed and can be ignored.

### 3. Check for migrations

The question is whether the PR build's schema differs from the baseline's. The plan file is the signal:

```bash
git -C <checkout> diff release-<baseline> HEAD -- src/Umbraco.Infrastructure/Migrations/Upgrade/UmbracoPlan.cs \
  src/Umbraco.Infrastructure/Migrations/Upgrade/UmbracoPremigrationPlan.cs
```

(The tag is `release-<version>`, e.g. `release-17.7.0`.) New `To<...>` steps there mean new migrations. Other changes
under `Migrations/` (helpers, base classes) don't change the schema. This diff covers everything merged to the
base branch since the release, not only the PR, and that is what matters for the database.

The database lives in the persistent `umbraco-lb-sql` volume. If the PR adds migrations, the PR run upgrades the
schema, so **run the baseline first**. Afterwards, going back to the baseline needs the volume deleted, which wipes
the rig database; ask before running `docker volume rm umbraco-lb-sql`. Without migrations, the order doesn't matter.

### 4. Pack the PR

`scripts/pack-cms.sh <checkout>`. The last output line is `VERSION=<version>`; that's the PR version. Packing skips
the build if this version is already in `packages/`. A first pack of a checkout builds the backoffice client with
npm and takes several minutes, so run it in the background. The baseline needs no packing; it comes from nuget.org.

### 5. Run both sides

Use one results folder per verification: `results/pr-<n>-<DD-MM-YYYY>/` (git-ignored). For each side:

```bash
scripts/run-scenario.sh results/pr-<n>-<date>/baseline <baseline-version> /scripts/cache-sync-lock.js --probe
scripts/run-scenario.sh results/pr-<n>-<date>/pr <pr-version> /scripts/cache-sync-lock.js --probe
```

Each takes 10 to 15 minutes: boot, a check that every node reports the requested version, a 70 s wait for the
background instruction job, 2 minutes of k6, log collection, a wait for the nodes to recover, then the probe (which
alone can take 5+ minutes). Run them one after the other with the shell's background mode and wait for the
completion notice, not a foreground call that times out. They share ports and Docker, so never run two at once.

Exit codes: 2 the rig didn't come up, 3 a node runs another version, 4 the probe failed. For 2 and 3, read
`run.log` and the `node-*.log` files, fix the cause, and re-run that side; don't compare a half-finished run. For 4,
the k6 results are still valid: re-run only the probe with `scripts/run-probe.sh <run-dir>` once the nodes answer
again (`curl -s localhost:5001/umbraco/lb/status`).

The first run on an empty database seeds the content tree; later runs reuse it. k6 knobs (editor count, think
time and so on, listed in `README.md`) go in as exported `Rig__K6Env__<NAME>=<value>`; use the same knobs on both
sides.

### 6. Compare and write the report

```bash
scripts/compare-runs.py --cms <checkout> baseline=results/pr-<n>-<date>/baseline pr=results/pr-<n>-<date>/pr
```

It prints markdown tables (k6 metrics, thresholds, checks, failures by kind from the node logs, probe results).
Write `results/pr-<n>-<date>/report.md` (when running as a subagent that may not write report files, return the
report text instead and say where it belongs) with:

1. A header: PR number and title, the PR's head commit, both CMS versions as the nodes reported them, the
   date (DD-MM-YYYY), the scenario and any non-default knobs.
2. The tables from `compare-runs.py`. Scan them for empty cells or a `probe errors` row first; either means a
   parse or run problem to fix, not a result.
3. Your reading of them. Before writing it, read `references/interpreting-results.md`: it explains each metric,
   what is known noise, and which findings are already known and pre-existing.
4. Caveats: one run per side, anything unusual in `run.log`, and failure kinds you couldn't explain.

### 7. Report back

In chat, give the user the verdict (improves, regresses, or no measurable difference for this scenario), the
handful of numbers behind it, the caveats, and the report path. Name new failure kinds that appear only on the PR
side; they are often the most useful finding. If the difference is marginal, offer to run each side again before
drawing conclusions. Compare against the ranges in the reference's known findings, not single earlier numbers;
differences within those ranges are run-to-run variance, not news.

Results and drafted replies go to the user; never post to the PR on GitHub yourself. A comment there is public.

### 8. Leave things tidy

The rig is left running on the PR version, so the user can poke at it (`http://localhost:8080/umbraco`,
`admin@lb.local` / `LoadBalance-Admin-1234!`); `aspire stop` stops it. If you switched the checkout's branch,
offer to switch it back.

## Partial runs

Users often want only part of this: "re-run just the PR side", "pack the latest commit and compare again", "run
the probe only". Reuse what's already in the results folder, run only the missing side into a new subfolder (for
example `pr-2`), and compare against the existing baseline as long as the knobs and seed match. Say which runs the
comparison mixes.
