# dev-diagnosis measurements: 10 famous JS/TS repos

Measured 2026-11-13 with the published tool (`npx -y dev-diagnosis-cli@0.2.2 all --json`).
Each repo was shallow-cloned (`git clone --depth 1`) and scanned once, unmodified.
The tool's `context` check scores a repo 0–100, lists the files an AI coding agent
should not read ("noise": build output, lockfiles, logs, oversized files), and
estimates the tokens that noise costs per agent turn ("Estimated tokens wasted on
this noise … estimate, ~4 bytes per token" — the tool's own label). Score =
100 − weighted noise share ("lost"). All numbers below are the tool's own output;
nothing was estimated by hand.

## Results

| Repo | Stars (GitHub) | Context score | Tokens wasted / turn | Noise bytes | Top finding |
|---|---|---|---|---|---|
| nodejs/node | 123,693 | 91 | ~24,838,851 | 99.4 MB | An 11.3 MB ICU data blob (`deps/icu-small/.../icudt78l.dat.bz2`) plus dozens of generated OpenSSL asm files |
| vercel/next.js | 143,505 | 91 | ~7,362,478 | 29.4 MB | A 3.4 MB dev-overlay PNG, a 2.7 MB GIF in examples, a 2.6 MB compiled webpack bundle |
| denoland/deno | 108,871 | 92 | ~6,900,126 | 27.6 MB | One 10.4 MB test fixture (`tests/registry/npm/@types/node/registry.json`) ≈ 2.6M tokens by itself |
| microsoft/TypeScript | 111,798 | 95 | ~2,999,188 | 12.0 MB | A 4.0 MB Go test file (`.../codeFixClassImplementInterfaceNoTruncation_test.go`) sitting in a TypeScript repo |
| react/react | 252,576 | 96 | ~2,141,395 | 8.6 MB | 46 `yarn.lock` files (6.4 MB, 15.7% of the repo's bytes) + a 1.9 MB test video |
| vitejs/vite | 83,906 | 93 | ~1,285,977 | 5.1 MB | Docs OG images: 1.76 + 1.56 + 1.35 MB of `.webp` announcement art |
| vuejs/vue | 212,527 | 98 | ~58,911 | 0.24 MB | A single `pnpm-lock.yaml` (236 KB) is 9.3% of the whole repo's bytes |
| tailwindlabs/tailwindcss | 98,594 | 99 | ~55,944 | 0.22 MB | `pnpm-lock.yaml` (196 KB) + a 28 KB generated build dir |
| sveltejs/svelte | 88,755 | 100 | ~37,493 | 0.15 MB | A single `pnpm-lock.yaml` (150 KB) — the only noise in the repo |
| expressjs/express | 69,679 | 100 | 0 | 0 | Nothing to flag: 216 files, zero noise — the cleanest repo measured |

- Star counts: GitHub API, 2026-11-13. The React repo now lives at react/react (facebook/react redirects to it); its count was fetched 2026-11-13 23:24 CST.

**Totals:** across the 10 repos, ~**45.7M tokens wasted per full read**
(24.8M + 7.4M + 6.9M + 3.0M + 2.1M + 1.3M + 59k + 56k + 37k + 0).
Median score 95.5. No repo failed the check — the tool's status for all ten was
"Looks clean for an AI coding agent" (its PASS band is ≥ 85).

## Most surprising findings

1. **Node.js wastes ~25M tokens a turn — and that's a lower bound.** The scan
   caps at 10,000 files, and Node has far more than that, so the true number is
   bigger. The waste is almost entirely vendored deps an agent never needs to
   read: an 11 MB ICU data file and generated OpenSSL assembly. Nobody wrote
   that code, nobody reviews it, but every agent session pays for it.
2. **React's problem is 46 copies of the same file.** The repo carries a
   `yarn.lock` in nearly every fixture directory — 6.4 MB, 15.7% of the repo's
   bytes. One 3-line `.aiignore` (see the fix demo below) removes all of them:
   re-running the tool after the fix scores React **96 → 100** and the wasted
   tokens drop **~2.14M → 0**. The fix is trivial; the waste is structural.
3. **The single biggest items are test fixtures, not source.** Deno's top item
   is a 10.4 MB `registry.json` test fixture (~2.6M tokens); TypeScript's is a
   4 MB Go test file; Next.js's is a dev-overlay PNG. Agents don't need any of
   these to fix a bug, but a naive "read the repo" prompt feeds them all in.

## Fix demo (measured, not claimed)

On a disposable copy of the React clone, `dev-diagnosis all --fix` wrote 3 lines
to `.aiignore` (`fixtures/dom/public/test.mp4`, `package-lock.json`, `yarn.lock`)
and re-scanned:

| | Before | After |
|---|---|---|
| Score | 96 | **100** |
| Tokens wasted / turn | ~2,141,395 | **0** |
| Noise items | 48 | **0** |
| Bytes visible to the agent | 40.5 MB | **32.0 MB** (−21%) |

## Method and caveats

- Note (2026-11-14): this run used the 0.2.2 default scan cap of
  10,000 files, so the four biggest repos' numbers are lower bounds.
  From 0.2.3 the default cap is 100,000 files — a re-run would report
  higher, exact numbers (nodejs/node: ~47.5M tokens, score 93).
- Command: `npx -y dev-diagnosis-cli@0.2.2 all --json` in each repo root.
  The `all` run only executed the `context` check (the `path`/`flakes`/`cache`
  checks list themselves as skipped without their inputs). Every run exited 0
  and took 2–12 seconds.
- **10,000-file cap:** the tool stops scanning after 10,000 files
  (`truncated: true`) for nodejs/node, vercel/next.js, denoland/deno and
  microsoft/TypeScript. Their scores and token numbers cover only the first
  10,000 files, so the true waste is higher than reported here.
- **Token estimate:** noise bytes ÷ 4, the tool's own estimate. It counts bytes
  the agent would be fed, not tokens a specific model would actually consume
  (tokenizers differ; minified/bundled files tokenize differently). Treat the
  numbers as comparable within this table, not as exact billing.
- **"Noise" is the tool's judgement, not gospel.** A lockfile is noise for an
  agent writing code; a bundled `.d.ts` might be something a human wants to
  inspect. The tool flags by size and category — a human decides what to
  exclude. The `.aiignore` suggestions are advisory until you apply them.
- **No failures:** all 10 runs completed; nothing hung or errored.
  Express's token estimate is `null` in the tool output (zero noise → nothing
  to estimate), reported here as 0.
- Star counts: GitHub API, 2026-11-13 (facebook/react unchecked, see above).
- Raw tool output (JSON, one file per repo plus the React fix demo) is in
  `measurements-raw/` next to this file.
