# dev-diagnosis

[![npm version](https://img.shields.io/npm/v/dev-diagnosis-cli.svg)](https://www.npmjs.com/package/dev-diagnosis-cli)
[![CI](https://github.com/WJDdidi-1/dev-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/WJDdidi-1/dev-doctor/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/WJDdidi-1/dev-doctor.svg)](https://github.com/WJDdidi-1/dev-doctor/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/dev-diagnosis-cli.svg)](https://www.npmjs.com/package/dev-diagnosis-cli)

One command that diagnoses your repo, your commands, your cache and your tests. It runs four checks that used to be four separate tools — whether an AI coding agent would read files it should not (`context`), why a CLI command is missing (`path`), whether a build cache actually pays (`cache`), and which tests are flaky (`flakes`) — and prints one report with a verdict per check. It is offline, has no runtime dependencies (Node.js standard library only), and works on Linux, macOS and Windows.

## Install and run

```sh
npx dev-diagnosis-cli
```

Or install it once and use it anywhere:

```sh
npm install -g dev-diagnosis-cli
dev-diagnosis all
```

`dev-diagnosis` with no arguments is the same as `dev-diagnosis all` on the current directory. Each check is also available on its own:

```sh
dev-diagnosis context [path]                        # files an AI agent should not read
dev-diagnosis path <command>                        # why a CLI command is missing
dev-diagnosis cache -- <build-command...>           # cold vs warm timing for a build cache
dev-diagnosis flakes <junit-dir>                    # flaky tests from JUnit XML across runs
dev-diagnosis all [path] --command <name> --flakes <dir> -- <build-command...>
```

`all` always runs `context` on `[path]` (default: the current directory) and runs `path`, `flakes` and `cache` when their input is given. Checks without their input are listed as skipped, with the command that would run them, instead of silently pretending they ran. A build command on a repo with no cache directory to measure is also listed as skipped rather than failing: nothing to measure is not a problem. `--json` gives machine-readable output for `context`, `path`, `flakes` and `all`. Add `--fix` to `context` (or `all`) to write the suggestions into `<path>/.aiignore` instead of only printing them: entries already there are left alone, nothing else in the file is touched, and a later scan skips everything `.aiignore` lists — so `context --fix` followed by `context` comes back clean.

Exit codes: `0` every check that ran passed; `1` a check found something to fix or could not run; `2` usage error.

## Example

The repo ships a small demo project in `examples/demo-repo` (a build output, a log, a lockfile and a 1.7 MB data dump) and two JUnit runs in `examples/runs`. `npm run example` runs `dev-diagnosis all` on it. This is its real output, copied verbatim (paths and cache timings vary by machine):

```
$ dev-diagnosis all examples/demo-repo --command node --flakes examples/runs -- node build.mjs
dev-diagnosis — /home/hatch/workspace/dev-doctor-build/dev-doctor/examples/demo-repo

== context ==
Repo: /home/hatch/workspace/dev-doctor-build/dev-doctor/examples/demo-repo
Files: 9  Size: 1.68 MB  Score: 75/100 — Some context noise found
  build output: 98 B (0%) — lost 0 of 40
  large files: 1.68 MB (99.9%) — lost 25 of 25
  lockfiles: 95 B (0%) — lost 0 of 20
  logs: 79 B (0%) — lost 0 of 15
Noise to keep away from an AI agent:
  data/export.json — large file (1.68 MB)
  dist/ — generated build output (98 B)
  logs/dev.log — local log file (79 B)
  package-lock.json — lockfile (95 B)
Worth a look before sharing:
  .env.example — environment template (usually safe to share)
Fix: add these to .aiignore (or the agent's ignore list):
  *.log
  data/export.json
  dist/
  package-lock.json
FAIL  some context noise found (score 75/100)

== path ==
current      /usr/bin/node
login        /usr/bin/node
non-login    /usr/bin/node
daemon-like  /usr/bin/node
PASS  node resolves to /usr/bin/node

== flakes ==
runs: 2  tests: 5  flaky: 1  always-failing: 1
test                                           unstable  runs    trend  classification
com.example.LoginTest::rejectsExpiredToken          2/2     2  chronic  always-failing
com.example.CheckoutTest::appliesCoupon             1/2     2      new  passed-on-retry
FAIL  1 flaky, 1 always-failing across 2 runs

== cache ==
Cache dir: /home/hatch/workspace/dev-doctor-build/dev-doctor/examples/demo-repo/.cache
Command: node build.mjs
Cold: 491 ms  Warm: 90 ms  Saved: 401 ms (82%)
Verdict: cache pays — warm run is 401 ms (82%) faster than cold
PASS  cache pays: cold 491 ms, warm 90 ms (warm run is 401 ms (82%) faster than cold)

Overall: FAIL — see the checks above
```

The demo repo is intentionally noisy, so `all` exits 1: the context and flakes checks fail while path and cache pass. That is the point of the fixture.

## What each check does

### `context` — what an AI agent should not read

Walks the repo (skipping `.git`, `node_modules` and other hidden directories) and classifies every file: build output, large files over 1 MB, lockfiles, logs, binary payloads, secret-like files and environment templates. It prints a 0–100 score, the bytes lost per category, the noisy files, the files worth a look before sharing, and the `.aiignore` entries that would fix it. Build-output directories are reported by their full path from the repo root (`packages/foo/dist/`, not a bare `dist/`) and rolled up into one row per directory, so the entry `--fix` writes matches nested build output too. A large file is fixed by its exact path from the repo root — no glob can single one file out — so `--fix` followed by a re-scan comes back clean even when the noise is a single oversized file. Files the repo's `.aiignore` already lists are excluded from the scan entirely — they are what the agent will not be handed, so they are not noise any more. `context --fix` writes the suggestions into `.aiignore` for you; `--json` includes the fix outcome in the output.

The score is the *noise-only* part of ai-context-doctor's score: 100 minus the category-weighted share of noise bytes (build 40, large 25, lockfile 20, log 15). The full ai-context-doctor score also weighs context volume, one file dominating, file sprawl and binary payloads, so its composite number reads lower on the same repo. The file classification itself is the same.

### `path` — why a command is missing

Runs the lookup in four shell contexts — current, login, non-login and daemon-like (a minimal `PATH`) — and reports one row per context, plus shadowed copies (other copies of the same command that lose to the winner) and toolchain installs (npm, cargo, bun, volta, go, pip, brew). Two PATH entries that point at the same file, for example `/bin/node` and `/usr/bin/node` where `/bin` is a symlink to `/usr/bin`, count as one copy, not a shadow. The fix is copy-pasteable: the install command for the detected toolchain, or the `export PATH=…` line for a command that exists but is not on `PATH`.

### `cache` — does the cache pay

Runs the build command twice: cold, with the cache directory moved aside, and warm, with it present, then reports both timings and the saving. The original cache is restored to its original state afterwards, and anything the cold run produced is thrown away. A cache directory that is the project root, contains it, or lies outside it is refused rather than moved. No network is involved; the check only runs your own build command.

### `flakes` — which tests are flaky

Reads JUnit XML across CI runs — each subdirectory of `<junit-dir>` is one run, and each `*.xml` file directly under it is a run of its own — and ranks tests by instability, using a Wilson 95% lower bound so a test that failed twice in two runs outranks one that failed twice in twenty. It distinguishes *passed-on-retry* (failed then passed in the same run, the classic flake signature) from *always-failing* and plain cross-run flakes, and labels each test `new`, `chronic` or `recovered` from its history. CRLF line endings are normalised before parsing, so Windows-produced XML parses the same as Unix-produced XML. A file that cannot be parsed — broken XML, or a file with no root element at all (empty, whitespace-only, a lone declaration) — is printed as a warning and fails the check, so the verdict is never based on half-read data; a genuinely empty report (`<testsuites></testsuites>`) still counts as zero tests.

## Development

```sh
npm test            # node:test, no extra dependencies — 62 tests
npm run example     # run the CLI against the demo fixture
```

There is nothing to install: the CLI has no runtime dependencies, so
`npm test` works straight after cloning. Run the checkout as
`node bin/dev-diagnosis.js …` — see Troubleshooting if you reach for
`npx` inside the checkout.

Requires Node.js 18 or later. CI runs the tests and the demo on Node 18, 20, 22 and 24 across Ubuntu, macOS and Windows, and smoke-tests the packed tarball by installing it in a clean directory. Windows is covered by CI only — the Windows-only code paths (the `cmd.exe` retry for `.cmd`/`.bat` shims, `PATHEXT` lookup) have not been run on a real Windows machine.

## Troubleshooting

**`npx dev-diagnosis-cli` inside a checkout of this repo fails with
`dev-diagnosis: not found`.** npx sees the checkout's own `package.json`
— same name, same version — and tries to run the local bin, which only
exists once the bin is linked. `npm install` does not link it: with no
dependencies to install, npm creates no `node_modules` at all. Run the
checkout directly instead — `node bin/dev-diagnosis.js …` — or `npm link`
to get a `dev-diagnosis` command, or run `npx` from any other directory.

## Credits

dev-diagnosis merges four tools by the same author, each of which keeps working on its own:

- [ai-context-doctor](https://github.com/WJDdidi-1/ai-context-doctor) — the context classification, the category weights and the score; the `.aiignore` fix.
- [cli-path-doctor](https://github.com/WJDdidi-1/cli-path-doctor) — the four shell contexts, `PATHEXT` lookup, shadowed copies and the toolchain search.
- [cache-verdict](https://github.com/WJDdidi-1/cache-verdict) — cold vs warm timing and the stash-and-restore safety rules.
- [flake-ledger](https://github.com/WJDdidi-1/flake-ledger) — the JUnit parsing, passed-on-retry detection and the Wilson lower-bound ranking.

The XML parser, the command runner and the report format were rewritten for the unified CLI; the rest is ported logic, adapted to a shared output format. See `CHANGELOG.md` for what changed per release.

## License

Apache-2.0. See [LICENSE](LICENSE).
