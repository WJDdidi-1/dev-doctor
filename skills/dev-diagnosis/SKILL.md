---
name: dev-diagnosis
description: Diagnose a repo before working in it — context noise that wastes tokens, native-binary hardening, missing commands, build-cache value, flaky tests. Run when starting work in a repository, after a build or test failure, or when an agent session feels slow.
---

# dev-diagnosis

Run this before reading a repo, and again after fixing what it finds.

## When to use it

- Starting work in a repository you have not diagnosed yet.
- An agent session feels slow, or the context looks full of files it should not be reading.
- A build is slow, a command is missing, or tests keep failing on retry.
- A repo vendors native binaries, or you are about to ship one — run `dev-diagnosis binaries`; it gives each of the largest binaries a hardening table (PIE, NX, RELRO, stripped, entropy). It always passes: it is a checkup, not a verdict.
- A single file needs checking before sharing it — a commit message, a pasted config — run `dev-diagnosis secrets <file>`; it reports the file, rule and line of any possible secret, never the value.
- The build is slow and you only want the cheap checks: `dev-diagnosis all --skip cache` — the cache check runs the build twice, so skipping it is the fast path when the build itself is not under suspicion.
- Re-scanning a large repo you already scanned: `dev-diagnosis context --cache` reuses the scan cache for unchanged files (size + mtime), so the second scan takes seconds instead of a minute. Opt-in; the cache file is `.dev-diagnosis-cache.json` at the repo root — add it to .gitignore, it is machine-local.
- A change touches a file that was already noisy at HEAD — a lockfile bump, a generated file — and you only want to know what the change itself added: `dev-diagnosis context --new-from-rev` (implies --changed) counts only noise that is new since the ref; a file that was already noisy counts only its growth. Renamed files count as new.
- A strict team wants a higher bar than the default 85, or an old repo wants to start low and raise it as it cleans up: `dev-diagnosis context --min-score 95` (or `--min-score 70`) — the verdict, the exit code and the report all follow the bar you set, and the result carries it as `minScore`.

## Run it

```sh
dev-diagnosis all
```

If the command is not installed, use `npx dev-diagnosis-cli` instead. Run it in the repo directory; pass a path to diagnose another one (`dev-diagnosis all ./other-repo`).

## Read the verdicts

- **context FAIL** — the repo has noise an AI agent should not read (build output, lockfiles, logs, oversized files). The report lists the files and the token estimate. Fix it with `dev-diagnosis context --fix`, which writes the suggestions into `.aiignore`, then re-run `dev-diagnosis all` to confirm the score is 100/100.
- **binaries** — always passes: the report lists the largest native binaries with a hardening table each (PIE, NX, RELRO, stripped, stack protector, entropy). Read it before shipping a vendored binary; an `unknown` value means the headers could not tell — read the note next to it, do not read it as safe.
- **path FAIL** — a command is missing in the current shell. The report says which shell contexts have it and prints a copy-paste fix; apply the fix, then re-run.
- **flakes FAIL** — the report ranks the flaky tests. Look at the top-ranked test first; a test marked `new` broke recently, `chronic` has been unstable for a while.
- **cache FAIL** — the verdict says whether the build cache pays. If it costs more than it saves, the cache setup is the problem, not the build.

Skipped checks are not failures: they just need their input
(`--command <name>` for path, `--flakes <runs-dir>` for flakes,
`-- <build-command>` for cache).

## Examples

Real runs against the demo repo in this project
(`examples/demo-repo`), so the numbers are reproducible — run them
from the repo root:

**1. A noisy repo — diagnose first, then fix.**

```sh
$ dev-diagnosis all examples/demo-repo --command node --flakes examples/runs -- node build.mjs
...
data/export.json — large file (1.68 MB, ≈ 439k tokens)
Estimated tokens wasted on this noise: ≈ 439k tokens
...
Overall: FAIL
```

Next step: `dev-diagnosis context examples/demo-repo --fix`, then
re-run `dev-diagnosis all` to confirm.

**2. The fix, and the re-run that proves it.**

```sh
$ dev-diagnosis context examples/demo-repo --fix
...
Created .aiignore with 1 entry: data/export.json
Re-scanned after fix: Score: 94/100
PASS  context is clean
```

Next step: re-run `dev-diagnosis all` — the clean repo scores 94/100,
and the remaining points are the small files the agent still reads.

## Rules

- Fix what FAILs before starting the real work; a 75/100 repo costs real tokens on every turn.
- Always re-run `dev-diagnosis all` after a fix and confirm it passes — the re-run is the only proof the fix worked; a fix that does not move the score did not fix the problem.
- Never edit `.aiignore` by hand to hide a failure you have not read — the file is the record of what the agent agreed not to read.
