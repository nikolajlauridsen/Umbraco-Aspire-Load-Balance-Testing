#!/usr/bin/env python3
"""Compares rig runs collected by scripts/run-scenario.sh and prints a markdown report.

Usage: scripts/compare-runs.py [--cms <umbraco-cms-checkout>] <label>=<run-dir> [<label>=<run-dir> ...]

--cms resolves distributed lock ids to names from src/Umbraco.Core/Persistence/Constants-Locks.cs.
"""
import argparse
import collections
import pathlib
import re
import sys

KNOWN_LOCKS = {-333: "ContentTree", -334: "MediaTree", -346: "CacheVersion", -348: "DocumentUrlAliases"}

# k6 summary metrics worth a row, in display order: (label, regex on the summary line, group to show)
METRICS = [
    ("editor requests failed", r"^\s*\{ scenario:editors \}\.+:\s+([\d.]+%)\s+(\d+ out of \d+)", "{0} ({1})"),
    ("stale versions (409)", r"^\s*stale_version\.+:\s+(\d+)", "{0}"),
    ("read-lock timeouts (503)", r"^\s*read_lock_timeout\.+:\s+(\d+)", "{0}"),
    ("write-lock timeouts (503)", r"^\s*write_lock_timeout\.+:\s+(\d+)", "{0}"),
    ("save/publish on different nodes", r"^\s*cross_node_pairs\.+:\s+(\d+)", "{0}"),
    ("iterations", r"^\s*iterations\.+:\s+(\d+)", "{0}"),
]
DURATION = re.compile(r"^\s*\{ scenario:editors \}\.+:\s+avg=(\S+)\s+min=\S+\s+med=(\S+)\s+max=(\S+)\s+p\(90\)=\S+\s+p\(95\)=(\S+)")
THRESHOLD = re.compile(r"^\s*([✓✗]) '([^']+)' (.*)$")
CHECK = re.compile(r"^\s*([✓✗]) ([a-z][\w -]+)$")
CHECK_RATE = re.compile(r"^\s*↳\s+(\d+)% — ✓ (\d+) / ✗ (\d+)")
LOCK = re.compile(r"Failed to acquire (read|write) lock for id: (-\d+)")
RIG = re.compile(r"Rig request \S+ failed with ([a-z-]+)")
EXC = re.compile(r"((?:Umbraco|Microsoft|System)[\w.]*Exception)(?:: (.{0,80}))?")
PROBE = re.compile(r"^(control|probe) id=\d+ (fresh|STALE)")


def lock_names(cms):
    names = dict(KNOWN_LOCKS)
    if cms:
        path = pathlib.Path(cms) / "src/Umbraco.Core/Persistence/Constants-Locks.cs"
        if path.exists():
            for name, value in re.findall(r"public const int (\w+) = (-\d+);", path.read_text()):
                names[int(value)] = name
    return names


def k6_summary(text):
    lines = [re.sub(r"^\[k6\] ?", "", l) for l in text.splitlines()]
    out = {"thresholds": [], "checks": [], "metrics": {}}
    threshold_metric = None
    in_thresholds = False
    for i, line in enumerate(lines):
        if "THRESHOLDS" in line:
            in_thresholds = True
            continue
        if "TOTAL RESULTS" in line:
            in_thresholds = False
        if in_thresholds:
            m = THRESHOLD.match(line)
            if m:
                out["thresholds"].append((threshold_metric, m.group(1), m.group(2), m.group(3)))
            elif line.strip():
                threshold_metric = line.strip()
            continue
        m = CHECK.match(line)
        if m and i + 1 < len(lines) and CHECK_RATE.match(lines[i + 1]):
            r = CHECK_RATE.match(lines[i + 1])
            out["checks"].append((m.group(2), f"{r.group(1)} % ({r.group(2)} ok / {r.group(3)} failed)"))
        elif m:
            out["checks"].append((m.group(2), "100 %" if m.group(1) == "✓" else "failed"))
        for label, pattern, fmt in METRICS:
            mm = re.match(pattern, line)
            if mm and label not in out["metrics"]:
                out["metrics"][label] = fmt.format(*mm.groups())
        d = DURATION.match(line)
        if d and "duration" not in out["metrics"]:
            out["metrics"]["duration"] = f"p95 {d.group(4)}, max {d.group(3)}, median {d.group(2)}"
    return out


def node_errors(run, names):
    """Counts failures per kind across all node logs, unwrapping AggregateExceptions to the innermost cause."""
    counts = collections.Counter()
    for log in sorted(run.glob("node-umb-*.log")):
        lines = log.read_text(errors="replace").splitlines()
        for i, line in enumerate(lines):
            m = RIG.search(line)
            if m:
                counts[f"rig {m.group(1)}"] += 1
                continue
            if " ERR] " not in line:
                continue
            block = "\n".join(lines[i : i + 8])
            if "Rig request" in block:
                continue
            if "Lock request time out period exceeded" in block and "Failed to acquire" not in block:
                # The database layer logs the SQL timeout behind each distributed lock timeout separately.
                counts["(db log) SQL lock request timeout, same failures as the lock timeouts"] += 1
                continue
            lock = LOCK.search(block)
            if lock:
                lid = int(lock.group(2))
                counts[f"unmapped {lock.group(1)}-lock timeout on {names.get(lid, lid)}"] += 1
                continue
            exc = [e for e in EXC.findall(block) if e[0] != "System.AggregateException"]
            if exc:
                counts[f"unmapped {exc[0][0]}: {re.sub(r'[0-9]+', 'N', exc[0][1])}".rstrip(": ")] += 1
            else:
                counts["unmapped " + re.sub(r"[0-9]+", "N", line.split("] ", 2)[-1])[:80]] += 1
    return counts


def probe_summary(run):
    path = run / "probe.txt"
    if not path.exists():
        return {}
    result = collections.defaultdict(collections.Counter)
    delay = "?"
    for line in path.read_text().splitlines():
        if line.startswith("## delayMs="):
            delay = line.split("=", 1)[1]
        m = PROBE.match(line)
        if m:
            result[f"delay {delay} ms, {m.group(1)}"][m.group(2)] += 1
    summary = {k: f"{v['STALE']} stale / {v['STALE'] + v['fresh']}" for k, v in result.items()}
    if "Traceback" in path.read_text() or "ERROR" in path.read_text():
        summary["probe errors (see probe.txt)"] = "yes"
    return summary


def versions(run):
    found = set()
    for status in run.glob("status-umb-*.json"):
        m = re.search(r'"version":"([^"]+)"', status.read_text())
        if m:
            found.add(m.group(1))
    return ", ".join(sorted(found)) or "unknown"


def table(header, rows, labels):
    print("| " + " | ".join([header, *labels]) + " |")
    print("|" + "---|" * (len(labels) + 1))
    for key, values in rows:
        print("| " + " | ".join([key, *[values.get(l, "") for l in labels]]) + " |")
    print()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cms")
    parser.add_argument("runs", nargs="+", metavar="label=dir")
    args = parser.parse_args()

    names = lock_names(args.cms)
    labels, data = [], {}
    for spec in args.runs:
        label, _, directory = spec.partition("=")
        run = pathlib.Path(directory)
        if not (run / "k6.txt").exists():
            sys.exit(f"{run}/k6.txt not found; was run-scenario.sh run for {label}?")
        labels.append(label)
        data[label] = {
            "version": versions(run),
            "k6": k6_summary((run / "k6.txt").read_text(errors="replace")),
            "errors": node_errors(run, names),
            "probe": probe_summary(run),
        }

    rows = [("CMS version (from /umbraco/lb/status)", {l: data[l]["version"] for l in labels})]
    for label, *_ in METRICS[:1]:
        rows.append((label, {l: data[l]["k6"]["metrics"].get(label, "") for l in labels}))
    rows.append(("editor request duration", {l: data[l]["k6"]["metrics"].get("duration", "") for l in labels}))
    for label, *_ in METRICS[1:]:
        rows.append((label, {l: data[l]["k6"]["metrics"].get(label, "") for l in labels}))
    print("## Load test (k6)\n")
    table("", rows, labels)

    print("## Thresholds\n")
    keys = []
    for l in labels:
        for metric, _, cond, _ in data[l]["k6"]["thresholds"]:
            if (metric, cond) not in keys:
                keys.append((metric, cond))
    rows = []
    for metric, cond in keys:
        values = {}
        for l in labels:
            for m, mark, c, actual in data[l]["k6"]["thresholds"]:
                if (m, c) == (metric, cond):
                    values[l] = f"{'pass' if mark == '✓' else 'FAIL'} ({actual})"
        rows.append((f"`{metric}` {cond}", values))
    table("threshold", rows, labels)

    print("## Checks\n")
    keys = []
    for l in labels:
        keys += [c for c, _ in data[l]["k6"]["checks"] if c not in keys]
    table("check", [(k, {l: dict(data[l]["k6"]["checks"]).get(k, "") for l in labels}) for k in keys], labels)

    print("## Failures in node logs (all nodes)\n")
    print("`rig ...` are failures the rig mapped to 409/503 and k6 counted. `unmapped ...` returned 500 to k6.\n")
    keys = sorted({k for l in labels for k in data[l]["errors"]}, key=lambda k: -max(data[l]["errors"][k] for l in labels))
    table("kind", [(k, {l: str(data[l]["errors"].get(k, 0)) for l in labels}) for k in keys], labels)

    if any(data[l]["probe"] for l in labels):
        print("## Sync-gap probe (scripts/repro-sync-gap.sh)\n")
        keys = sorted({k for l in labels for k in data[l]["probe"]})
        table("round", [(k, {l: data[l]["probe"].get(k, "") for l in labels}) for k in keys], labels)


if __name__ == "__main__":
    main()
