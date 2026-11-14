# Changelog

## 0.2.3 — 2026-11-14

- New: the MCP server now serves a prompt, `diagnose_repo`
  (`prompts/list` / `prompts/get`, advertised in `initialize`): the
  one-shot "diagnose this repo" workflow as a user-invoked template —
  call `diagnose_all`, report the score and noise, preview the
  `.aiignore` fix with `dryRun`, and ask before writing anything.
  Tools are what the model calls on its own; a prompt is what the
  user picks from a menu in clients that surface prompts (Claude
  Desktop, Cursor, MCP Inspector), and our server previously offered
  nothing to pick. Wire-tested: list returns the one prompt, get
  renders the path into the message, an unknown name is a -32602
  protocol error. The method is FastMCP's — prompts are the third MCP
  primitive next to tools and resources, and FastMCP (the framework
  behind ~70% of MCP servers) treats them as a first-class surface.
  Honest limit: whether clients actually surface the prompt, and
  whether users click it, is only measurable in a real client
  session — the local proof is that the listing parses, the template
  renders, and the wire answers.

- New: the skill is now installable as a Claude Code plugin — this repo
  is a plugin marketplace (`.claude-plugin/marketplace.json`, one plugin,
  `strict: false`) shipping the skill at `skills/dev-diagnosis/SKILL.md`.
  Claude Code users run `/plugin marketplace add WJDdidi-1/dev-doctor`
  then `/plugin install dev-diagnosis@dev-diagnosis`, with no CLI install
  needed first (the skill falls back to npx). The repo copy is pinned
  byte-identical to the `--skill-generate` template by tests, so the two
  can never drift, and the marketplace version is pinned to the package
  version, like server.json. The method is anthropics/skills'
  marketplace distribution — one more discovery channel while
  distribution is the bottleneck (14 days, 3 unique visitors). Honest
  limit: marketplace installs have no public count, so the local proof
  is that the listing parses, the skill path exists, and the copy
  matches the template; a real install still needs a Claude Code check.
- New: all five MCP tool descriptions now say what the tool does, when
  to call it, and what it matches on ("Use when …" + "Keywords: …").
  The descriptions used to say only what the tool does, so an agent
  had no trigger condition to decide on — the same spec rule our
  SKILL.md descriptions already follow. Tests pin every description
  carries both a when-clause and keywords; no parameters or behaviour
  changed. The method is anthropics/skills' description rule
  (agentskills.io/specification) + mcp-builder's discoverability.
- New: the generated SKILL.md now has an Examples section — two real
  runs against the demo repo (a noisy `all` at 75/100 with the 439k-token
  `data/export.json`, and the `context --fix` that re-scans to 94/100) —
  and every Rule now states its why instead of a bare command
  (re-running `all` is "the only proof the fix worked"). The example
  lines are pinned by tests that run the documented commands against
  the live CLI, so a future output-format change fails the suite until
  the skill is updated — the same drift guard as the demo tape. The
  method is anthropics/skills' skill-creator: give examples and explain
  why, never a bare ALWAYS/NEVER. 3 new tests.
- New: `doctor` now validates an installed SKILL.md's frontmatter
  against the Agent Skills spec (agentskills.io/specification) —
  name kebab-case and matching the skill directory, description
  1–1024 chars with no angle brackets, only known keys,
  compatibility at most 500 chars, non-empty body — instead of only
  checking the file exists. A broken frontmatter makes the skill
  silently never trigger, and `doctor` used to report it as
  installed and fine (demonstrated live: `name: Dev-Diagnosis`
  with `<broken>` in the description passed the old check). A broken
  skill now warns, names the first problem (+N more), and prints the
  fix; it never fails the run, since the skill is advisory. Pure
  function `validateSkillMd` in `lib/skill.mjs`, no new dependency;
  15 new tests (14 validator, 1 doctor). The method is
  anthropics/skills' `quick_validate.py` — validate the skill you
  ship, don't just check it exists.
- New: the README screencast (`docs/demo.gif`) is now rendered from
  a declarative tape, `docs/demo.tape` — run it with `npm run demo`
  (needs python3 + ffmpeg), verify it with `npm run demo:check`. Each
  scene runs a real command against the live CLI on a staged copy of
  the demo fixture, and each `Show` line pins a substring that must
  appear in that scene's output, in order; the full matched line is
  what the GIF shows. The old GIF was stale: rendered 2026-11-12, it
  showed the noise row without its per-item token count and the clean
  re-run without the top-directories block, both added since. The
  re-rendered GIF (v0.2.3 label) shows the current output, and the
  check is now part of `npm test`, so the next output-format change
  fails the suite until the tape is updated and the GIF re-rendered.
  The method is VHS's: the demo is code, re-runnable, and CI keeps
  it up to date. Cache timings are pinned by prefix only — the
  numbers vary run to run.
- New: `context --changed` (also on `all`, `--report`, `--json`, and as
  `changedRef` on the MCP `diagnose_context` / `diagnose_all` tools)
  scopes the scan to the files git lists as changed vs a ref (default
  `HEAD`; `--changed=<ref>` for another, e.g. `origin/main`): tracked
  files that differ plus untracked files git does not ignore. The
  score, the noise list and the totals are then the change's, not the
  repo's — a fixture with a committed 1.2 MB log and an uncommitted
  1.2 MB log lists both without the flag and only the new one with
  it, so a repo with pre-existing noise can still answer whether your
  change added any, and a CI check on `all --changed origin/main`
  fails only on new noise. `--fix` with `--changed` only fixes the
  change. Outside a git repo it exits 1 with a plain error instead
  of silently scanning the whole repo. The method is bat's: a tool
  that reads files should know what changed.
- New: `context` (and `all`, `--report`, `--json`, and the MCP
  `diagnose_context` / `diagnose_all` tools) prints the top
  directories by noise tokens next to the per-file list, so you can
  see whether one directory is most of the job: five 20k-token logs
  in `logs/` read as five small rows, but `logs/` as a group is
  100k tokens (90.9% of the noise) — and the fix is usually one
  `.aiignore` pattern per directory. The rollup is the same listed
  noise grouped by top-level directory (root-level files under
  `(root)`), capped at 3, with each share estimated from summed
  bytes so it can never pass 100%; a scan whose noise spans fewer
  than two directories prints nothing, since it would just repeat
  the file list. The method is dust's: show where the waste lives,
  not just a flat list. `--json` carries it as `topDirectories`.
- New: `cache --runs N` (also on `all`, and as `runs` on the MCP
  `diagnose_cache` / `diagnose_all` tools) times the build N times
  cold and N times warm (default 1, at most 10) and judges the verdict
  on the medians, with the min–max spread shown next to them; `--json`
  also carries the `runs`, `coldRuns` and `warmRuns` arrays. One
  timing sample is noise: on a jittery fixture (the cache genuinely
  skips ~150 ms of a ~500 ms build, ±200 ms jitter per run), 8
  identical single runs gave 6 "cache pays" and 2 "inconclusive",
  while `--runs 5` gave "cache pays" 3 times out of 3 (median saved
  144–190 ms, 21–28%). The method is hyperfine's: several timed runs
  and a median, not one sample. Default 1 changes nothing for
  existing users.
- New: `all --report <file>` writes the run as a Markdown report —
  the same score, noise list with token costs, suggestions and
  verdicts, in prose you can paste to an agent or attach to a PR
  instead of copying terminal output by hand. It works with `--json`
  (the JSON on stdout stays parseable) and with `--fix` (the report
  reflects the post-fix re-scan). The noise table caps at 20 items
  like the terminal report, with an "and N more" line; the full
  lists are in `--json`.
- New: `all` on an interactive terminal ends with a one-line ask to
  star the project. It never reaches `--json` output or a pipe, so
  parsers and report files stay clean.
- Docs: README first screen rewritten with real measured data from
  10 famous JS/TS repos; `docs/measurements.md` carries the table
  and findings.
- New: mistyped commands and options get a `Did you mean ...?`
  suggestion instead of a bare `unknown command` / `unknown option` —
  `dev-diagnosis al` suggests `all`, `cntext` suggests `context`,
  `context --fx` suggests `--fix`. Levenshtein distance ≤ 2, the
  method git, gh (via Cobra) and cargo use; far-off typos still get
  no suggestion, and valid input is untouched.
- New: `context --fix --dry-run` (and `all --fix --dry-run`) previews
  the fix instead of writing it: the exact `.aiignore` entries that
  would be added, diff-style, including the header a new file would
  get — and nothing is written. The preview and the fix share one
  computation, so the preview can never drift from what `--fix`
  would write. In `--json` the preview is the `fix` object with
  `dryRun: true`; the exit code follows the repo as it stands. The
  method is Ruff's `--diff`: show what a fix would change before it
  lands, because `--fix` used to mutate `.aiignore` with no chance
  to inspect it first.
- New: the MCP tools `diagnose_context` and `diagnose_all` take
  `dryRun: true` with `fix: true` — the CLI's `--fix --dry-run`
  preview, over the wire: the result is the repo as it stands, with
  the `.aiignore` plan in the `fix` object marked `dryRun: true`,
  and nothing is written. `dryRun` without `fix` is an error, like
  `--dry-run` without `--fix` on the CLI. The preview and the fix
  share one computation, so an agent that previews and then fixes
  gets exactly what it was shown.
- New: `completion <bash|zsh|fish>` prints a shell completion script,
  generated from the same command and option lists the parser uses —
  so it can never suggest a flag the CLI rejects. The spec is the
  single source of truth (the bin derives its suggestion lists from
  it), and a test checks it against `--help` in both directions.
  Per-command options only: `context --` offers `--fix` and
  `--dry-run` but not `--top`; value-taking options fall back to
  filename completion. The method is ripgrep's `complete/` scripts,
  without the static copy to go stale. Verified live: bash completes
  `context --f` to `--fix`, zsh registers the file via compinit.
- New: every MCP tool now declares its annotations on `tools/list`,
  so a client can decide whether to ask before calling it: the two
  pure reads (`diagnose_path`, `diagnose_flakes`) are read-only and
  idempotent; `diagnose_context` can write `.aiignore` when `fix`
  is set, so it is destructive but idempotent (a second fix adds
  nothing already present); `diagnose_cache` runs a build command
  and its timings vary, so it is neither read-only nor idempotent;
  `diagnose_all` is the superset of both. The method is Codex's
  two-dial model — the sandbox says what a tool may touch, the
  approval policy says when to ask — and the annotations are the
  MCP form of the first dial. No fix/no-fix tool split: annotations
  describe what a tool *may* do, so worst-case values are the honest
  ones, and a split would add API surface no client has asked for.
- New: `doctor` checks the installation itself — Node version,
  `dev-diagnosis` on PATH, the home directory setup and
  `--skill-generate` write into, installed skills, MCP wiring and
  `.aiignore`. Read-only: it changes nothing, so it works even when
  the rest of the tool is misbehaving, and every failure comes with
  a copy-paste fix. Warnings are for optional wiring only; only
  failures exit 1. `--json` gives the same checklist as data. The
  method is Claude Code's `claude doctor`: one command that answers
  "is my install healthy?" instead of debugging each piece by hand.
  The checks are the failure modes from our own history — the 0.2.0
  wrong-HOME bug is now a named home check, and running npx inside
  the source repo gets its own fix (`node bin/dev-diagnosis.js`).
  No update check: the tool is offline by design, so it never makes
  the network call a newer-version check would need.
- Fix: the "Top 3 noise items" share once printed 101.5% — the
  per-item rounded token counts summed past the total. It now
  estimates from the summed bytes, so the share can never pass 100%
  (same fix in the terminal report and the `--report` Markdown).
- Verified: local tests 183/183 (12 new doctor tests: node floor, HOME
  mismatch, PATH resolution incl. the source-repo fix, project/global
  skill, MCP wiring, .aiignore, --json shape, read-only, option
  rejection).

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
