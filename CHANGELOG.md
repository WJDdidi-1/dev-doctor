# Changelog

## 0.1.4 — unreleased

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
