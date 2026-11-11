import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseJunitText, scanRuns, wilsonLowerBound } from '../lib/flakes.mjs';

const RUN_1 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="CheckoutTest">
    <testcase classname="CheckoutTest" name="appliesCoupon">
      <flakyFailure message="expected 10% discount, got 0"/>
    </testcase>
    <testcase classname="LoginTest" name="rejectsExpiredToken">
      <failure message="expected 401, got 200"/>
    </testcase>
    <testcase classname="SearchTest" name="filtersByPrice"/>
  </testsuite>
</testsuites>`;

const RUN_2 = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="CheckoutTest">
    <testcase classname="CheckoutTest" name="appliesCoupon"/>
    <testcase classname="LoginTest" name="rejectsExpiredToken">
      <failure message="expected 401, got 200"/>
    </testcase>
    <testcase classname="SearchTest" name="filtersByPrice"/>
  </testsuite>
</testsuites>`;

function writeRuns(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-runs-'));
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

test('parseJunitText: flakyFailure means passed-on-retry, failure means failed', () => {
  const tests = parseJunitText(RUN_1);
  const byId = new Map(tests.map((t) => [t.id, t]));
  assert.equal(byId.get('CheckoutTest::appliesCoupon').status, 'passed-on-retry');
  assert.equal(byId.get('LoginTest::rejectsExpiredToken').status, 'failed');
  assert.equal(byId.get('SearchTest::filtersByPrice').status, 'passed');
});

test('parseJunitText: CRLF input parses exactly like LF input', () => {
  const crlf = RUN_1.replace(/\n/g, '\r\n');
  const a = parseJunitText(RUN_1);
  const b = parseJunitText(crlf);
  assert.deepEqual(b, a);
});

test('parseJunitText: a retry attribute marks passed-on-retry', () => {
  const xml = `<testsuites><testsuite><testcase classname="T" name="t" retry="1"/></testsuite></testsuites>`;
  const [testCase] = parseJunitText(xml);
  assert.equal(testCase.status, 'passed-on-retry');
});

test('parseJunitText: broken XML is an error with a location', () => {
  assert.throws(() => parseJunitText('<testsuites><testcase>'), /unclosed tag/);
});

test('wilsonLowerBound: more evidence means a higher lower bound', () => {
  assert.equal(wilsonLowerBound(0, 0), 0);
  assert.ok(wilsonLowerBound(2, 2) > wilsonLowerBound(1, 2));
  assert.ok(wilsonLowerBound(1, 2) > wilsonLowerBound(0, 2));
});

test('scanRuns: ranks always-failing above passed-on-retry, and classifies both', () => {
  const root = writeRuns({ 'run-01/results.xml': RUN_1, 'run-02/results.xml': RUN_2 });
  const result = scanRuns(root);
  assert.equal(result.totals.runs, 2);
  assert.equal(result.totals.tests, 3);
  const byId = new Map(result.tests.map((t) => [t.id, t]));
  assert.equal(byId.get('LoginTest::rejectsExpiredToken').classification, 'always-failing');
  assert.equal(byId.get('CheckoutTest::appliesCoupon').classification, 'passed-on-retry');
  assert.equal(byId.get('SearchTest::filtersByPrice').classification, 'stable');
  // Always-failing (2/2 unstable) ranks above passed-on-retry (1/2).
  assert.equal(result.tests[0].id, 'LoginTest::rejectsExpiredToken');
  assert.equal(result.tests[1].id, 'CheckoutTest::appliesCoupon');
});

test('scanRuns: a directory with no XML is an error', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-diagnosis-runs-'));
  assert.throws(() => scanRuns(root), /no JUnit XML files found/);
});

test('scanRuns: loose XML files directly under the dir are runs of their own', () => {
  const root = writeRuns({ 'a.xml': RUN_1, 'b.xml': RUN_2 });
  const result = scanRuns(root);
  assert.equal(result.totals.runs, 2);
});

test('scanRuns: a broken XML file is a warning, not a silent skip', () => {
  const broken = '<testsuites><testsuite><testcase classname="T" name="t"><failure/></testcase></testsuite>';
  const root = writeRuns({ 'run-01/broken.xml': broken, 'run-02/results.xml': RUN_2 });
  const result = scanRuns(root);
  assert.equal(result.totals.runs, 2);
  assert.equal(result.totals.tests, 3);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /broken\.xml/);
  assert.match(result.warnings[0], /unclosed tag/);
  // The file path appears once: the XML error already carries it.
  assert.equal(result.warnings[0].match(/broken\.xml/g).length, 1);
});

test('scanRuns: a run whose only file is broken still counts, with a warning', () => {
  const root = writeRuns({ 'run-01/broken.xml': '<testsuites><testcase>' });
  const result = scanRuns(root);
  assert.equal(result.totals.runs, 1);
  assert.equal(result.totals.tests, 0);
  assert.equal(result.warnings.length, 1);
});
