#!/usr/bin/env node
// Render the README demo GIF (docs/demo.gif) from docs/demo.tape.
//
// The tape is the demo, VHS-style: each scene runs a real command
// against the live CLI on a staged copy of examples/demo-repo, and
// each `Show` line pins a substring that must appear in that scene's
// output, in order. The full matched line is what the GIF shows, so
// the GIF can only ever show real current output — and `--check`
// (what `npm test` runs) fails as soon as the output format drifts,
// until the tape is updated and the GIF re-rendered.
//
//   node scripts/render-demo.mjs          # re-render docs/demo.gif
//   node scripts/render-demo.mjs --check  # capture + verify only
//   node scripts/render-demo.mjs --tape <file> --out <gif>
//
// The render itself is scripts/render-demo.py (PIL frames + ffmpeg
// palette GIF, the same visuals as the previous hand-rendered GIF).
// Only --check runs in CI: the full render needs python3 and ffmpeg.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TAPE = path.join(repoRoot, 'docs', 'demo.tape');
const RENDERER = path.join(repoRoot, 'scripts', 'render-demo.py');

// Scene holds in seconds, as in the previous hand-rendered GIF.
const SCENE_HOLDS = { diagnosis: 2.5, fix: 1.5, clean: 2.5 };
const DEFAULT_HOLD = 2.0;
// Typed commands wrap at this column (including the "$ " prefix),
// matching the previous GIF's two-line command.
const WRAP_COL = 60;

function splitQuoted(text) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) { parts.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (quote) throw new Error(`unterminated quote in: ${text}`);
  if (current) parts.push(current);
  return parts;
}

// Parse a tape file. Throws with a line number on malformed input.
export function parseTape(text) {
  const tape = { label: null, output: null, title: null, scenes: [], end: null };
  let scene = null;
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) return;
    const lineno = i + 1;
    const fail = (msg) => { throw new Error(`demo.tape:${lineno}: ${msg}`); };
    if (line.startsWith('Label ')) {
      tape.label = line.slice(6).trim();
    } else if (line.startsWith('Output ')) {
      tape.output = line.slice(7).trim();
    } else if (line.startsWith('Title ')) {
      const parts = splitQuoted(line.slice(6));
      if (parts.length !== 3) fail('Title needs exactly 3 quoted strings: line, line, sub');
      tape.title = { lines: parts.slice(0, 2), sub: parts[2] };
    } else if (line === 'Scene' || line.startsWith('Scene ')) {
      scene = { name: line.slice(6).trim(), run: null, cwd: null, show: [] };
      if (!scene.name) fail('Scene needs a name');
      tape.scenes.push(scene);
    } else if (line.startsWith('Run ')) {
      if (!scene) fail('Run outside a Scene');
      scene.run = line.slice(4).trim();
    } else if (line.startsWith('Cwd ')) {
      if (!scene) fail('Cwd outside a Scene');
      scene.cwd = line.slice(4).trim();
    } else if (line.startsWith('Show ')) {
      if (!scene) fail('Show outside a Scene');
      scene.show.push(line.slice(5));
    } else if (line.startsWith('End ')) {
      const parts = splitQuoted(line.slice(4));
      if (parts.length !== 2) fail('End needs exactly 2 quoted strings: line, line');
      tape.end = { lines: parts, sub: `v${tape.label ? tape.label.replace(/^v/, '') : ''} — your agent’s check-up, before it starts work` };
    } else {
      fail(`unknown directive: ${line}`);
    }
  });
  if (!tape.label) throw new Error('demo.tape: missing Label');
  if (!tape.output) throw new Error('demo.tape: missing Output');
  if (!tape.title) throw new Error('demo.tape: missing Title');
  if (!tape.end) throw new Error('demo.tape: missing End');
  if (tape.scenes.length === 0) throw new Error('demo.tape: no Scene');
  for (const s of tape.scenes) {
    if (!s.run) throw new Error(`demo.tape: scene ${s.name} has no Run`);
    if (s.show.length === 0) throw new Error(`demo.tape: scene ${s.name} has no Show lines`);
  }
  return tape;
}

function colorFor(line) {
  if (line.startsWith('== ') && line.endsWith(' ==')) return 'BLUE';
  if (line.startsWith('Estimated tokens wasted')) return 'AMBER';
  if (line.startsWith('Overall: FAIL')) return 'RED';
  return 'WHITE';
}

// Wrap a typed command for display the way the previous GIF did:
// break at the last space at or before WRAP_COL, continuation lines
// start with "> ".
function wrapCommand(command) {
  const lines = [];
  let rest = command;
  let prefix = '$ ';
  while (prefix.length + rest.length > WRAP_COL) {
    const limit = WRAP_COL - prefix.length;
    const cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) break;
    lines.push({ prefix, text: `${rest.slice(0, cut)} \\` });
    rest = rest.slice(cut + 1);
    prefix = '> ';
  }
  lines.push({ prefix, text: rest });
  return lines;
}

// Stage a fresh copy of the demo fixture plus a `dev-diagnosis` shim
// that runs this checkout's bin. Returns the stage dir.
function stageFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-demo-'));
  const examples = path.join(dir, 'examples');
  fs.mkdirSync(examples);
  for (const name of ['demo-repo', 'runs']) {
    fs.cpSync(path.join(repoRoot, 'examples', name), path.join(examples, name), { recursive: true });
  }
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const bin = path.join(repoRoot, 'bin', 'dev-diagnosis.js');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'dev-diagnosis.cmd'), `@echo off\r\nnode "${bin}" %*\r\n`);
  } else {
    const shim = path.join(binDir, 'dev-diagnosis');
    fs.writeFileSync(shim, `#!/bin/sh\nexec node "${bin}" "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return dir;
}

function runScene(stage, scene) {
  const tokens = splitQuoted(scene.run);
  const shim = path.join(stage, 'bin', process.platform === 'win32' ? 'dev-diagnosis.cmd' : 'dev-diagnosis');
  const result = spawnSync(shim, tokens.slice(1), {
    cwd: scene.cwd ? path.join(stage, scene.cwd) : stage,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(stage, 'bin')}${path.delimiter}${process.env.PATH}` },
  });
  if (result.error) throw new Error(`scene ${scene.name}: failed to run ${scene.run}: ${result.error.message}`);
  return (result.stdout || '') + (result.stderr || '');
}

// Find each Show substring in the captured lines, in order, and
// return the full matched lines. Throws naming the missing line.
function selectLines(sceneName, captured, show) {
  const lines = captured.split(/\r?\n/);
  const selected = [];
  let at = 0;
  for (const needle of show) {
    let found = -1;
    for (let i = at; i < lines.length; i++) {
      if (lines[i].includes(needle)) { found = i; break; }
    }
    if (found === -1) {
      throw new Error(`scene ${sceneName}: live output has no line containing ${JSON.stringify(needle)}`);
    }
    selected.push(lines[found]);
    at = found + 1;
  }
  return selected;
}

function buildFrames(tape, stage) {
  const scenes = [];
  let totalShown = 0;
  for (const scene of tape.scenes) {
    const captured = runScene(stage, scene);
    const shown = selectLines(scene.name, captured, scene.show);
    totalShown += shown.length;
    scenes.push({
      name: scene.name,
      cmdLines: wrapCommand(scene.run),
      outLines: shown.map((text) => ({ text, color: colorFor(text) })),
      hold: SCENE_HOLDS[scene.name] ?? DEFAULT_HOLD,
    });
  }
  return {
    label: tape.label.startsWith('v') ? tape.label : `v${tape.label}`,
    title: {
      lines: [
        { text: tape.title.lines[0], color: 'WHITE' },
        { text: tape.title.lines[1], color: 'AMBER' },
      ],
      sub: tape.title.sub,
    },
    scenes,
    end: {
      lines: [
        { text: tape.end.lines[0], color: 'WHITE' },
        { text: tape.end.lines[1], color: 'BLUE' },
      ],
      sub: tape.end.sub,
    },
    totalShown,
  };
}

function findPython() {
  for (const name of ['python3', 'python']) {
    if (spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0) return name;
  }
  return null;
}

export function main(argv) {
  const args = argv.slice(2);
  const checkOnly = args.includes('--check');
  const tapeArg = args.includes('--tape') ? args[args.indexOf('--tape') + 1] : null;
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  if (tapeArg === undefined || outArg === undefined) {
    console.error('render-demo: --tape / --out need a value');
    return 2;
  }
  const tapePath = tapeArg ? path.resolve(tapeArg) : DEFAULT_TAPE;
  const tape = parseTape(fs.readFileSync(tapePath, 'utf8'));
  const stage = stageFixture();
  try {
    const frames = buildFrames(tape, stage);
    const out = outArg ? path.resolve(outArg) : path.join(repoRoot, tape.output);
    if (checkOnly) {
      console.log(`demo tape OK: ${tape.scenes.length} scenes, ${frames.totalShown} lines verified against live output`);
      return 0;
    }
    const python = findPython();
    if (!python) {
      console.error('render-demo: no python3 (or python) on PATH — needed to render the GIF; --check works without it');
      return 1;
    }
    if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
      console.error('render-demo: no ffmpeg on PATH — needed to assemble the GIF; --check works without it');
      return 1;
    }
    const framesFile = path.join(stage, 'demo-frames.json');
    fs.writeFileSync(framesFile, JSON.stringify(frames, null, 2));
    const rendered = spawnSync(python, [RENDERER, '--frames', framesFile, '--out', out], { encoding: 'utf8' });
    process.stdout.write(rendered.stdout || '');
    process.stderr.write(rendered.stderr || '');
    if (rendered.status !== 0) return rendered.status ?? 1;
    console.log(`demo GIF written: ${path.relative(repoRoot, out)}`);
    return 0;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
