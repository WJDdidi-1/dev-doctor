# Changelog

## 0.2.2 — 2026-11-13

- New: the MCP server is now listed in the official MCP registry
  (`io.github.WJDdidi-1/dev-diagnosis`). A release-triggered workflow
  publishes the listing via GitHub OIDC, so agents can find and
  install the server from the registry. `server.json` carries the
  registry metadata, `scripts/check-registry-release.mjs` waits for
  the new npm version to be live before the listing is published, and
  `test/registry.test.mjs` keeps the metadata in sync with the
  package version.
- New: `llms.txt` at the repo root — a short machine-readable summary
  for AI search and retrieval, pointing agents at the install and
  usage commands.
- New: `package.json` carries `mcpName` and expanded keywords
  (`ai-agent`, `mcp`, `model-context-protocol`, `claude`,
  `context-window`, `agent-skills`, `token-optimization`) so the
  package is discoverable by agents searching npm.
- Verified: local tests 127/127.

## 0.2.1 — 2026-11-12

- Fix: `dev-diagnosis setup` and `--skill-generate --global` wrote MCP
  configs and skills to the wrong home directory on macOS and Windows
  (they ignored `$HOME`). They now honour `$HOME` on all platforms.
  v0.2.0 shipped with this bug on macOS/Windows; CI caught it after
  the release (8 of 12 matrix jobs red) and this patch is the fix.
- Fix: test fixtures and tests are now CRLF-safe, so the suite passes
  on Windows checkouts as well as macOS and Linux.
- Verified: CI 12/12 green (Ubuntu/macOS/Windows × Node 18/20/22/24).

## 0.2.0 — 2026-11-12

- New: `dev-diagnosis --mcp` serves the four checks as an MCP server
  on stdio (pure Node.js standard library, no new dependencies): five
  tools (`diagnose_context`, `diagnose_path`, `diagnose_cache`,
  `diagnose_flakes`, `diagnose_all`), each returning the same JSON the
  CLI's `--json` produces. `initialize` (protocol 2024-11-05),
  `tools/list`, `tools/call` and `ping` are supported. `--sandbox
  <dir>` (alias `--root`) restricts every path the tools touch to that
  directory and rejects anything outside it with a plain error.
- New: `dev-diagnosis --skill-generate` writes a Claude Agent Skills
  SKILL.md (`.claude/skills/dev-diagnosis/SKILL.md`, or
  `~/.claude/skills/dev-diagnosis/SKILL.md` with `--global`) telling an
  agent to run `dev-diagnosis all` when it starts work in a repo, fix
  what FAILs, and re-run to confirm. It refuses to overwrite an
  existing SKILL.md.
- New: `context` reports what the listed noise costs in tokens —
  `≈ 439k tokens (estimate, ~4 bytes per token)` next to the noise
  list, and `estimatedTokens` (number, or null when there is no noise)
  in the JSON output. The score is unchanged.
- New: `all` ends with a one-line summary — passed/failed/skipped
  counts, context noise bytes, and the cache saving when the cache
  check ran — in text output and as a `summary` object in `--json`.
- New: `dev-diagnosis setup` wires the MCP server into the agents on
  your machine (Claude Code, Codex CLI, Cursor, VS Code) in one
  command. It prints a preview of exactly what will be written before
  writing anything: a config that already mentions dev-diagnosis is
  left alone, one that exists without it is merged (other entries
  kept), a missing one is created, and a config it cannot parse is
  left alone and reported. `--dry-run` previews without writing;
  `--check` reports which agents are wired (exit 0 when all are).
- New: a GitHub Action (`action.yml` at the repo root) runs
  `dev-diagnosis all` in one CI step and fails the job when a check
  fails. It runs the published package, so it stays current. It lives
  at the repo root because the GitHub App cannot push
  `.github/workflows/*`.
- Fix: `context --fix` (and `all --fix`, and the MCP tools with
  `fix: true`) used to report the pre-fix verdict — exit 1 and FAIL —
  even though the fix had landed and a re-run scores clean. A fix
  command now re-scans after writing `.aiignore` and reports the repo
  as it stands after the fix: the new score, the verdict and the exit
  code all follow the post-fix scan, and `--json` carries the fix
  outcome on the post-fix result. The fix still does not mask other
  failures: `all --fix` exits 1 when flakes, path or cache still fail.
  (Tests 124.)
- Fix: the test suite now runs serially (`node --test
  --test-concurrency=1`): the cache check times real builds, so test
  files running in parallel skewed its cold-vs-warm timings and
  flipped the verdict on a loaded machine. (122 tests.)
- Fix: `context --fix` also wrote review suggestions into `.aiignore`
  — a secret-like file costs no score points, so the entry fixed
  nothing, and a basename pattern like `secret.js` hid every
  same-named file in the repo, including harmless test fixtures.
  Review suggestions are now advisory only (`reviewSuggestions` in
  `--json`, printed as such) and `--fix` writes only the entries that
  improve the score; a re-scan after `--fix` still lists the review
  items instead of silently hiding them.
- Docs: the README now opens with a 22 s terminal screencast
  (`docs/demo.gif`, 92 KB): `all` on the demo repo finds ≈439k tokens
  of noise, `--fix` writes one `.aiignore` entry, a re-run comes back
  94/100 PASS. Every line is verbatim CLI output captured 2026-11-12;
  the render script is not in the repo (it lives with the run logs).
- Fix: the suite leaked every temp dir it created (~100 MB per run) —
  after a few runs /tmp filled up and unrelated tests started failing
  on file creation. Temp dirs are now removed after the test that
  created them (`scripts/support.mjs`); the suite passes repeatedly
  with /tmp staying clean.
- Fix: `context` listed noise that cost no points and told the user to
  fix it — on a 100/100 repo it still printed "Noise to keep away"
  and a `.aiignore` fix for the lockfile, contradicting its own PASS
  verdict. Only noise in a category that actually lost points is now
  listed or suggested (a 95 B lockfile in a 1.7 MB repo loses 0
  points, so it is not something to fix); the score itself is
  unchanged, and the README example now shows the shorter noise list.
- Fix: the `path` verdict said "missing in the current shell" even
  when the command missed in all four shell contexts — which sounded
  like it might exist somewhere else — and never said where it did
  resolve when another context had it. It now says "not found in any
  shell context" when nothing has it, and "missing in the current
  shell, but resolves in login" (naming the contexts) when another one
  does.
- Internals: the four checks moved into `lib/checks.mjs`, the one
  place their logic lives — the CLI renders it, the MCP server serves
  it, neither re-implements a verdict. (120 tests.)
- Docs: the README top is rewritten from the user's side — what the
  noise costs in tokens, the three-step fix, one line per scenario, a
  capability matrix that says what each check cannot find, and
  copy-paste MCP configs for Claude Code and Codex.

## 0.1.8 — 2026-11-12

- Fix: `all --json` embedded the build's full stdout (`coldStdout` /
  `warmStdout`) in the cache check, while standalone `cache --json`
  already left it out — a chatty build bloated the machine-readable
  output. Both shapes are now the same: timings and verdict only. The
  `--json` option also now documents `cache` (the usage line and help
  text listed only `context`, `path`, `flakes` and `all`, although
  standalone `cache --json` already worked).
- New: `context` now also honours `.gitignore` — files and directories
  it lists are excluded from the scan, at the repo root and in nested
  `.gitignore` files alike, so a repo whose build output, logs or data
  dumps are already git-ignored no longer gets flagged for them, and
  `--fix` no longer duplicates those entries into `.aiignore`. The
  common pattern forms work (`*`, `?`, `[...]`, `**`, `/`-anchored
  paths, directory-only `dir/`, `!` negation with last-match-wins);
  `.git/info/exclude` and the global gitignore are not read. (82 tests.)
- Dogfood: the repo now ships a `.aiignore` excluding the demo fixture
  (`examples/demo-repo/`), so `dev-diagnosis all` on a checkout passes
  its own `context` check (was 77/100 FAIL, now 100/100 PASS). The
  fixture is intentionally noisy test data and stays noisy when scanned
  directly — `npm run example` output is unchanged.

## 0.1.7 — 2026-11-12

- Fix: `dev-diagnosis <path>` no longer errors with "unknown command" —
  the usage line promises `[all] [path]`, but a bare path was treated as a
  command name. A bare positional that is an existing directory now means
  `all` on that path (options like `--command` still apply); a word that
  is neither a known command nor a directory is still a usage error, so a
  typo stays a typo. The help text and README say so.
- Fix: `--top N` was silently ignored in `--json` output — `flakes
  <dir> --json --top 1` returned all five demo tests instead of one.
  The JSON `tests` array is now limited to the N highest-ranked tests,
  in standalone `flakes` and in `all --json` alike; `totals` still
  describes the whole run set, the same split the text table makes.
- Fix: `all --json` dropped the reason a check could not run — a missing
  runs directory or a failing build came out as `"flakes": null` /
  `"cache": null` next to `overall: FAIL`, with nothing saying why.
  A check with no result now reports `{ "error": "<reason>" }` instead,
  so a script consuming the JSON can tell which check failed and why.
- Fix: a run directory with no JUnit XML files was silently dropped —
  `flakes` on two run directories, one of them empty, reported
  "runs: 1" with no mention of the second run. An empty run directory
  is now named in the output (and in `--json` under `skippedRuns`) and
  fails the check: a CI run that produced no reports is a broken upload,
  not a run with zero tests.
  (72 tests.)

## 0.1.6 — 2026-11-12

- Fix: an empty JUnit file (0 bytes, whitespace only, or a declaration/comment
  and nothing else) no longer parses as a clean run of zero tests — the XML
  reader now requires a root element, so the file is reported as
  "no root element", listed in the warnings, and the `flakes` check fails
  instead of silently reporting on half-read data. A genuinely empty report
  (`<testsuites></testsuites>`) still parses to zero tests. (62 tests.)
- Docs: the 0.1.5 entry below is now dated — it went live on npm on
  2026-11-11 but the entry still said "unreleased".

## 0.1.5 — 2026-11-11

- Fix: a JUnit file that cannot be parsed no longer passes silently —
  `flakes` used to collect the parse error into a warnings list nothing
  ever printed, so a run set of only corrupt XML reported "no flaky
  tests" and exited 0. The warning is now printed with the file and the
  parse position, and the check fails with how many files could not be
  parsed, so the verdict is never based on half-read data. (58 tests.)
- Docs: a Troubleshooting note for running `npx` inside a checkout of
  this repo — npx prefers the checkout's own package.json and fails
  with `dev-diagnosis: not found`; `npm install` does not fix it (no
  dependencies, so no `node_modules` is created). Run
  `node bin/dev-diagnosis.js` directly, `npm link`, or run `npx` from
  another directory.

## 0.1.4 — 2026-11-11

- Fix: a large file now carries a suggestion — its exact path from the
  repo root — so `context --fix` writes it into `.aiignore` and a
  re-scan comes back clean. Large files used to carry no suggestion, so
  on any repo with one oversized file the fix wrote everything else and
  the next scan still failed on the same file, including this project's
  own demo fixture (its 1.7 MB `data/export.json`). The documented
  "`--fix` followed by a re-scan comes back clean" promise now holds
  for every kind of noise. (54 tests.)
- Docs: the 0.1.3 entry below is now dated — it went live on npm on
  2026-11-11 but the entry still said "unreleased".

## 0.1.3 — 2026-11-11

- Fix: nested build-output directories are reported by their full path
  from the repo root (`packages/foo/dist/`) instead of a bare `dist/` —
  the bare entry only matches top-level output, so `--fix` on a repo
  whose build output lives in a subdirectory wrote an `.aiignore`
  entry the next scan ignored, and the scan kept failing after the
  fix. Files under one build directory are also rolled up into a
  single row instead of one row per file. (53 tests.)

## 0.1.2 — 2026-11-11

- New: `context --fix` (and `all --fix`) writes the `.aiignore`
  suggestions into `<path>/.aiignore` instead of only printing them —
  entries already there are left alone, nothing else in the file is
  touched, and no file is created when there is nothing to add. The fix
  outcome is included in `--json` output.
- Fix: the context scan now honours the repo's `.aiignore` — files it
  lists are excluded from the scan entirely, so applying the fix and
  re-scanning comes back clean instead of failing on the same noise
  forever. (50 tests.)

## 0.1.1 — 2026-11-11

- Docs: README now has npm version, CI, license and Node badges, and the
  example output is regenerated verbatim — its paths match the repo layout.
- Fix: the demo build and the cache test fixture now simulate 400 ms of
  work (was 150 ms), so the cache check's verdict stays decisive even on
  loaded CI machines — 0.1.1's first CI run failed one job (macOS, Node 22)
  because a 41 ms saving fell under the 50 ms "cache pays" threshold.
- Fix: `all` on a repo with no build cache no longer ends in FAIL — a
  build command with no cache directory to measure is listed as skipped,
  with the `--cache-dir` hint, instead of a failed cache check. (41 tests.)

## 0.1.0 — 2026-11-10

- First release: one CLI combining the four diagnostic checks.
- `context` — context-noise scan (from ai-context-doctor).
- `path` — missing-command diagnosis across shells and toolchains
  (from cli-path-doctor).
- `cache` — cold vs warm build timing (from cache-verdict).
- `flakes` — flaky-test ranking from JUnit XML (from flake-ledger).
- `all` — all four checks in one unified report.
