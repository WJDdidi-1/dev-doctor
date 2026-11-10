# Changelog

## 0.1.1 — 2026-11-11

- Docs: README now has npm version, CI, license and Node badges, and the
  example output is regenerated verbatim — its paths match the repo layout.
- No code changes; the CLI is unchanged from 0.1.0.

## 0.1.0 — 2026-11-10

- First release: one CLI combining the four diagnostic checks.
- `context` — context-noise scan (from ai-context-doctor).
- `path` — missing-command diagnosis across shells and toolchains
  (from cli-path-doctor).
- `cache` — cold vs warm build timing (from cache-verdict).
- `flakes` — flaky-test ranking from JUnit XML (from flake-ledger).
- `all` — all four checks in one unified report.
