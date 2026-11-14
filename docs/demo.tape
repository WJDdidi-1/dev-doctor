# dev-diagnosis README demo — a declarative recording, VHS-style.
# The GIF (docs/demo.gif) is rendered from this tape, never hand-edited:
#   node scripts/render-demo.mjs          # re-render docs/demo.gif
#   node scripts/render-demo.mjs --check  # capture + verify only, no render
# Each `Show` line is a substring that must appear in the scene's live
# output, in order; the full matched line is what the GIF shows. That is
# the drift guard: when the CLI's output format changes, --check fails
# until the tape is updated and the GIF re-rendered. Lines with timings
# (cache) are pinned by prefix only — the numbers vary run to run.
# `Run` is the command typed and run: a `dev-diagnosis` shim on PATH
# points at this checkout's bin, so the typed command is the real one.
# `Cwd` is relative to the staged copy of examples/ (default: stage root).
# Scenes run in order against one staged fixture, so the fix in scene 2
# is what scene 3 re-runs against. The method is VHS's (charmbracelet/vhs):
# the demo is code, re-runnable, and CI keeps it up to date.

Label v0.2.3
Output docs/demo.gif

Title "Your AI agent just read" "≈ 439k tokens of garbage." "one command finds it — one fix clears it"

Scene diagnosis
Run dev-diagnosis all examples/demo-repo --command node --flakes examples/runs -- node build.mjs
Show == context ==
Show Files: 9  Size: 1.68 MB  Score: 75/100
Show data/export.json — large file (1.68 MB, ≈ 439k tokens)
Show Estimated tokens wasted on this noise: ≈ 439k tokens
Show == flakes ==
Show runs: 2  tests: 5  flaky: 1  always-failing: 1
Show == cache ==
Show Cold:
Show Overall: FAIL
Show Summary: 4 checks — 2 passed, 2 failed, 0 skipped; context noise 1.68 MB; cache saved

Scene fix
Run dev-diagnosis context examples/demo-repo --fix
Show Files: 9  Size: 1.68 MB  Score: 75/100
Show Fix: add these to .aiignore (or the agent's ignore list):
Show   data/export.json
Show Created .aiignore with 1 entry: data/export.json
Show Re-scanned after fix: Score: 94/100
Show PASS  context is clean

Scene clean
Run dev-diagnosis all
Cwd examples/demo-repo
Show Files: 8  Size: 1.14 KB  Score: 94/100
Show Estimated tokens wasted on this noise: ≈ 68 tokens
Show Overall: PASS
Show Summary: 4 checks — 1 passed, 0 failed, 3 skipped; context noise 272 B

End "npx dev-diagnosis-cli" "github.com/WJDdidi-1/dev-doctor"
