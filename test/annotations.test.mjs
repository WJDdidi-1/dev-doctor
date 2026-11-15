import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
  formatContextAnnotations,
} from '../lib/annotations.mjs';

function item(overrides = {}) {
  return {
    label: 'data/export.json',
    reason: 'large file',
    bytes: 2048,
    path: 'data/export.json',
    tokens: 512,
    ...overrides,
  };
}

test('annotations: a clean scan emits nothing', () => {
  assert.equal(formatContextAnnotations({ score: 100, noise: [] }), '');
  assert.equal(formatContextAnnotations({ score: 100 }), '');
});

test('annotations: one noise file is one warning line', () => {
  const text = formatContextAnnotations({ score: 93, noise: [item()] });
  assert.equal(
    text,
    '::warning file=data/export.json,title=dev-diagnosis — context noise #1 · large file::data/export.json — large file (2.00 KB, ≈ 512 tokens). Add it to .aiignore to keep it out of agent context.',
  );
});

test('annotations: a failing score adds one run-level error line first', () => {
  const text = formatContextAnnotations({ score: 75, noise: [item()] });
  const lines = text.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    '::error title=dev-diagnosis — context score below threshold::context score 75/100 is below the 85 threshold — the noise below is why.',
  );
  assert.match(lines[1], /^::warning file=data\/export\.json/);
});

test('annotations: score 85 passes without an error line, 84 fails with one', () => {
  assert.doesNotMatch(formatContextAnnotations({ score: 85, noise: [item()] }), /^::error/m);
  assert.match(formatContextAnnotations({ score: 84, noise: [item()] }), /^::error/m);
});

test('annotations: directory rollups are skipped — an annotation needs a file', () => {
  const text = formatContextAnnotations({
    score: 93,
    noise: [
      item({ label: 'dist/', reason: 'build output', bytes: 999999, path: 'dist/', tokens: 250000 }),
      item({ label: 'data/export.json', reason: 'large file', bytes: 2048, path: 'data/export.json', tokens: 512 }),
    ],
  });
  assert.doesNotMatch(text, /dist\//);
  assert.match(text, /context noise #1 · large file/);
});

test('annotations: at most 10 items — the platform cap', () => {
  const noise = Array.from({ length: 12 }, (_, i) => item({
    label: `file-${i}.log`,
    reason: 'local log file',
    bytes: 100 + i,
    path: `file-${i}.log`,
    tokens: 25,
  }));
  const lines = formatContextAnnotations({ score: 93, noise }).split('\n');
  assert.equal(lines.length, 10);
  assert.doesNotMatch(lines.join('\n'), /file-10\.log|file-11\.log/);
});

test('annotations: workflow-command escaping', () => {
  assert.equal(escapeAnnotationData('100% sure\nnext line\rhere'), '100%25 sure%0Anext line%0Dhere');
  assert.equal(escapeAnnotationProperty('a,b:c%d'), 'a%2Cb%3Ac%25d');
  const text = formatContextAnnotations({
    score: 93,
    noise: [item({ label: 'a%b\nc.json', path: 'x,y:z.json' })],
  });
  assert.match(text, /file=x%2Cy%3Az\.json/);
  assert.match(text, /a%25b%0Ac\.json/);
});

test('annotations: a long message is capped at 1500 characters', () => {
  const text = formatContextAnnotations({
    score: 93,
    noise: [item({ label: 'x'.repeat(2000) })],
  });
  const message = text.split('::').at(-1);
  assert.equal(message.length, 1500);
  assert.ok(message.endsWith('…'));
});

test('annotations: the error line follows the run bar — a 90 at a 95 bar errors, at a 90 bar it does not', () => {
  const strict = formatContextAnnotations({ score: 90, minScore: 95, noise: [item()] });
  assert.match(strict, /^::error title=dev-diagnosis — context score below threshold::context score 90\/100 is below the 95 threshold — the noise below is why\./m);
  assert.doesNotMatch(formatContextAnnotations({ score: 90, minScore: 90, noise: [item()] }), /^::error/m);
  // A result without minScore keeps the old 85 line.
  assert.match(
    formatContextAnnotations({ score: 84, noise: [item()] }),
    /is below the 85 threshold/,
  );
});
