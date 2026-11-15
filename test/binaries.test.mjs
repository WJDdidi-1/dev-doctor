import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../scripts/support.mjs';
import {
  DEFAULT_TOP_BINARIES, MIN_BINARY_BYTES, analyzeFile, detectFormat,
  scanBinaries, shannonEntropyOfFile,
} from '../lib/binaries.mjs';
import { UsageError, runAll, runBinariesCheck, selectChecks } from '../lib/checks.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'dev-diagnosis.js');
const demoRepo = path.join(root, 'examples', 'demo-repo');
// REA's ground-truth binary: esbuild 0.25.0, the file the REA study
// probed (native-probes.json). Present in this workspace, absent on CI
// — the ground-truth test skips there.
const esbuildPath = '/home/hatch/workspace/.scratch/rea-study/targets/node_modules/@esbuild/linux-x64/bin/esbuild';
const esbuildSha256 = '98f635ee88526a7d9dd7a82c8a79f341c0247de8aa56d38158c0963892957829';

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v), 0); return b; };
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); return b; };

/**
 * Minimal ELF64, laid out as header + program headers + dynamic
 * section + string table + section headers. PT_LOAD maps the file
 * 1:1 (vaddr == file offset), so DT_STRTAB is the string table's
 * file offset. Options flip one hardening input at a time.
 */
function buildElf64(options = {}) {
  const {
    type = 3, machine = 62,
    gnuStackFlags = 6, withRelro = false, withSymtab = false,
    withDynamic = true, withDynsym = false,
    dynstr = '', rpath = false, runpath = false,
    gnuProperty = null,
  } = options;
  const chunks = [];
  let offset = 0;
  const place = (buf) => { const off = offset; chunks.push(buf); offset += buf.length; return off; };
  place(Buffer.alloc(64));
  const phCount = 2 + (withDynamic ? 1 : 0) + (withRelro ? 1 : 0) + (gnuProperty ? 1 : 0);
  const phOff = place(Buffer.alloc(phCount * 56));
  let dynOff = 0;
  let dynSize = 0;
  const dynEntries = [];
  if (withDynamic) {
    dynEntries.push([5, 0], [10, 0]);
    if (withDynsym) dynEntries.push([6, 0x1000]);
    if (rpath) dynEntries.push([15, 0]);
    if (runpath) dynEntries.push([29, 0]);
    dynEntries.push([0, 0]);
    dynOff = offset;
    for (const [tag, val] of dynEntries) { place(i64(tag)); place(u64(val)); }
    dynSize = dynEntries.length * 16;
  }
  const strtab = Buffer.from(`\0${dynstr}`, 'latin1');
  const strOff = place(strtab);
  let propOff = 0;
  let propSize = 0;
  if (gnuProperty) { propOff = place(gnuProperty); propSize = gnuProperty.length; }
  const shOff = offset;
  const shCount = withSymtab ? 3 : 2;
  place(Buffer.alloc(shCount * 64));
  const totalSize = offset;

  const file = Buffer.concat(chunks);
  file.writeUInt8(0x7f, 0);
  file.write('ELF', 1, 'latin1');
  file.writeUInt8(2, 4);
  file.writeUInt8(1, 5);
  file.writeUInt8(1, 6);
  file.writeUInt16LE(type, 16);
  file.writeUInt16LE(machine, 18);
  file.writeUInt32LE(1, 20);
  file.writeBigUInt64LE(64n, 32);
  file.writeBigUInt64LE(BigInt(shOff), 40);
  file.writeUInt16LE(64, 52);
  file.writeUInt16LE(56, 54);
  file.writeUInt16LE(phCount, 56);
  file.writeUInt16LE(64, 58);
  file.writeUInt16LE(shCount, 60);
  let p = phOff;
  const writePhdr = (pType, pFlags, pOffset, pFilesz) => {
    file.writeUInt32LE(pType, p);
    file.writeUInt32LE(pFlags, p + 4);
    file.writeBigUInt64LE(BigInt(pOffset), p + 8);
    file.writeBigUInt64LE(0n, p + 16);
    file.writeBigUInt64LE(0n, p + 24);
    file.writeBigUInt64LE(BigInt(pFilesz), p + 32);
    file.writeBigUInt64LE(BigInt(pFilesz), p + 40);
    file.writeBigUInt64LE(0x1000n, p + 48);
    p += 56;
  };
  writePhdr(1, 5, 0, totalSize);
  if (withDynamic) writePhdr(2, 6, dynOff, dynSize);
  writePhdr(0x6474e551, gnuStackFlags, 0, 0);
  if (withRelro) writePhdr(0x6474e552, 4, strOff, strtab.length);
  if (gnuProperty) writePhdr(0x6474e553, 4, propOff, propSize);
  if (withDynamic) {
    let d = dynOff;
    for (const [tag] of dynEntries) {
      if (tag === 5) file.writeBigUInt64LE(BigInt(strOff), d + 8);
      else if (tag === 10) file.writeBigUInt64LE(BigInt(strtab.length), d + 8);
      d += 16;
    }
  }
  let s = shOff + 64;
  file.writeUInt32LE(3, s + 4);
  file.writeBigUInt64LE(BigInt(strOff), s + 24);
  file.writeBigUInt64LE(BigInt(strtab.length), s + 32);
  if (withSymtab) {
    s += 64;
    file.writeUInt32LE(2, s + 4);
    file.writeBigUInt64LE(BigInt(dynOff), s + 24);
    file.writeBigUInt64LE(BigInt(dynSize), s + 32);
  }
  return file;
}

/** One GNU property note (64-bit alignment): x86 feature 1, value `features`. */
function gnuPropertyNoteX86(features) {
  return Buffer.concat([
    u32(4), u32(12), u32(5),
    Buffer.from('GNU\0', 'latin1'), Buffer.alloc(4),
    u32(0xc0000002), u32(4), u32(features), Buffer.alloc(4),
  ]);
}

/** Minimal 32-bit ET_EXEC: header + one PT_LOAD, nothing else. */
function buildElf32Exec() {
  const file = Buffer.alloc(84);
  file.writeUInt8(0x7f, 0);
  file.write('ELF', 1, 'latin1');
  file.writeUInt8(1, 4);
  file.writeUInt8(1, 5);
  file.writeUInt8(1, 6);
  file.writeUInt16LE(2, 16);
  file.writeUInt16LE(3, 18);
  file.writeUInt32LE(1, 20);
  file.writeUInt32LE(52, 28);
  file.writeUInt32LE(0, 32);
  file.writeUInt16LE(52, 40);
  file.writeUInt16LE(32, 42);
  file.writeUInt16LE(1, 44);
  file.writeUInt16LE(40, 46);
  file.writeUInt16LE(0, 48);
  file.writeUInt32LE(1, 52);
  file.writeUInt32LE(0, 56);
  file.writeUInt32LE(0, 60);
  file.writeUInt32LE(0, 64);
  file.writeUInt32LE(84, 68);
  file.writeUInt32LE(84, 72);
  file.writeUInt32LE(5, 76);
  file.writeUInt32LE(0x1000, 80);
  return file;
}

function buildPe64({ dynamicBase = true, nxCompat = true, withDebug = false } = {}) {
  const file = Buffer.alloc(512);
  file.write('MZ', 0, 'latin1');
  file.writeUInt32LE(64, 0x3c);
  file.write('PE\0\0', 64, 'latin1');
  file.writeUInt16LE(0x8664, 68);
  file.writeUInt16LE(1, 70);
  file.writeUInt16LE(0x20b, 88);
  let dllChar = 0;
  if (dynamicBase) dllChar |= 0x40;
  if (nxCompat) dllChar |= 0x100;
  file.writeUInt16LE(dllChar, 88 + 70);
  file.writeUInt32LE(16, 88 + 108);
  file.writeUInt32LE(0, 88 + 112 + 48);
  file.writeUInt32LE(withDebug ? 100 : 0, 88 + 112 + 52);
  return file;
}

function buildMachO64({ pie = true, nx = true, withSymtab = false, withRpath = false } = {}) {
  const cmds = [];
  if (withSymtab) {
    const b = Buffer.alloc(24);
    b.writeUInt32LE(0x2, 0);
    b.writeUInt32LE(24, 4);
    cmds.push(b);
  }
  if (withRpath) {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(0x8000001c, 0);
    b.writeUInt32LE(16, 4);
    cmds.push(b);
  }
  const file = Buffer.alloc(32 + cmds.reduce((sum, c) => sum + c.length, 0));
  // The magic number, stored little-endian: bytes CF FA ED FE.
  file.writeUInt32LE(0xfeedfacf, 0);
  file.writeInt32LE(0x01000007, 4);
  file.writeUInt32LE(0, 8);
  file.writeUInt32LE(2, 12);
  file.writeUInt32LE(cmds.length, 16);
  file.writeUInt32LE(cmds.reduce((sum, c) => sum + c.length, 0), 20);
  let flags = 0;
  if (pie) flags |= 0x200000;
  if (nx) flags |= 0x1000000;
  file.writeUInt32LE(flags, 24);
  file.writeUInt32LE(0, 28);
  let off = 32;
  for (const cmd of cmds) { cmd.copy(file, off); off += cmd.length; }
  return file;
}

function writeTempFile(name, contents) {
  const dir = tempDir('dev-diagnosis-binaries-');
  const full = path.join(dir, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  return { dir, full };
}

function padTo(contents, size) {
  if (contents.length >= size) return contents;
  return Buffer.concat([contents, Buffer.alloc(size - contents.length)]);
}

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
}

test('binaries: detectFormat reads the magic bytes', () => {
  assert.equal(detectFormat(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'elf');
  assert.equal(detectFormat(Buffer.from([0x4d, 0x5a, 0x90, 0x00])), 'pe');
  assert.equal(detectFormat(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])), 'mach-o');
  assert.equal(detectFormat(Buffer.from([0xce, 0xfa, 0xed, 0xfe])), 'mach-o');
  assert.equal(detectFormat(Buffer.from([0xca, 0xfe, 0xba, 0xbe])), 'mach-o-fat');
  assert.equal(detectFormat(Buffer.from('hello')), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
  assert.equal(detectFormat(Buffer.from([0x7f, 0x45])), null);
});

test('binaries: whole-file entropy is 0 for uniform bytes and 1 for a fair coin', () => {
  const { full: zeros } = writeTempFile('zeros.bin', Buffer.alloc(1024, 0));
  assert.equal(shannonEntropyOfFile(zeros), 0);
  const halves = Buffer.concat([Buffer.alloc(512, 0), Buffer.alloc(512, 0xff)]);
  const { full: coin } = writeTempFile('coin.bin', halves);
  assert.equal(shannonEntropyOfFile(coin), 1);
  const { full: random } = writeTempFile('random.bin', randomBytes(64 * 1024));
  // 64 KB of random bytes: the plug-in estimator's downward bias is
  // ~0.003 at this size, so 7.9 is far below the ~8.0 mean — with
  // only 2 KB the bias is ~0.09 and the same assertion flakes.
  assert.ok(shannonEntropyOfFile(random) > 7.9);
});

test('binaries: a PIE ELF64 with no dynamic symbols reports what the headers say', () => {
  const { full } = writeTempFile('pie', buildElf64());
  const result = analyzeFile(full, 'pie', fs.statSync(full).size);
  assert.equal(result.format, 'elf');
  assert.equal(result.arch, 'x86-64');
  assert.equal(result.hardening.pie, 'enabled');
  assert.equal(result.hardening.nx, 'enabled');
  assert.equal(result.hardening.relro, 'disabled');
  assert.equal(result.hardening.stripped, 'enabled');
  assert.equal(result.hardening.rpath, 'disabled');
  assert.equal(result.hardening.runpath, 'disabled');
  assert.equal(result.hardening.cet, 'disabled');
  assert.equal(result.hardening.btiPac, 'not_applicable');
  // No DT_SYMTAB: the protector and fortify cannot be told from headers.
  assert.equal(result.hardening.stackProtector, 'unknown');
  assert.equal(result.hardening.fortify, 'unknown');
  assert.match(result.notes.join(' '), /no dynamic symbol table/);
});

test('binaries: an ET_EXEC with an executable stack reports PIE and NX disabled', () => {
  const { full } = writeTempFile('exec', buildElf64({ type: 2, gnuStackFlags: 7 }));
  const result = analyzeFile(full, 'exec', fs.statSync(full).size);
  assert.equal(result.hardening.pie, 'disabled');
  assert.equal(result.hardening.nx, 'disabled');
});

test('binaries: RELRO, symtab, RPATH and RUNPATH are each read from their own place', () => {
  const { full } = writeTempFile('full', buildElf64({ withRelro: true, withSymtab: true, rpath: true, runpath: true }));
  const result = analyzeFile(full, 'full', fs.statSync(full).size);
  assert.equal(result.hardening.relro, 'enabled');
  assert.equal(result.hardening.stripped, 'disabled');
  assert.equal(result.hardening.rpath, 'enabled');
  assert.equal(result.hardening.runpath, 'enabled');
});

test('binaries: dynamic symbols decide the stack protector and fortify', () => {
  const guarded = writeTempFile('guarded', buildElf64({ withDynsym: true, dynstr: '__stack_chk_fail\0' }));
  const result = analyzeFile(guarded.full, 'guarded', fs.statSync(guarded.full).size);
  assert.equal(result.hardening.stackProtector, 'enabled');
  assert.equal(result.hardening.fortify, 'disabled');
  const fortified = writeTempFile('fortified', buildElf64({ withDynsym: true, dynstr: '__memcpy_chk\0' }));
  const result2 = analyzeFile(fortified.full, 'fortified', fs.statSync(fortified.full).size);
  assert.equal(result2.hardening.stackProtector, 'disabled');
  assert.equal(result2.hardening.fortify, 'enabled');
});

test('binaries: a static ELF has no RPATH and no dynamic symbol table', () => {
  const { full } = writeTempFile('static', buildElf64({ withDynamic: false }));
  const result = analyzeFile(full, 'static', fs.statSync(full).size);
  assert.equal(result.hardening.rpath, 'disabled');
  assert.equal(result.hardening.runpath, 'disabled');
  assert.equal(result.hardening.stackProtector, 'unknown');
  assert.equal(result.hardening.fortify, 'unknown');
});

test('binaries: the x86 CET property note is read, bit by bit', () => {
  const withCet = writeTempFile('cet', buildElf64({ gnuProperty: gnuPropertyNoteX86(0x3) }));
  const result = analyzeFile(withCet.full, 'cet', fs.statSync(withCet.full).size);
  assert.equal(result.hardening.cet, 'enabled');
  const withoutCet = writeTempFile('nocet', buildElf64({ gnuProperty: gnuPropertyNoteX86(0x0) }));
  const result2 = analyzeFile(withoutCet.full, 'nocet', fs.statSync(withoutCet.full).size);
  assert.equal(result2.hardening.cet, 'disabled');
});

test('binaries: a 32-bit ET_EXEC parses through the 32-bit offsets', () => {
  const { full } = writeTempFile('elf32', buildElf32Exec());
  const result = analyzeFile(full, 'elf32', fs.statSync(full).size);
  assert.equal(result.format, 'elf');
  assert.equal(result.arch, 'i386');
  assert.equal(result.hardening.pie, 'disabled');
  assert.equal(result.hardening.nx, 'unknown');
  assert.equal(result.hardening.relro, 'disabled');
  assert.equal(result.hardening.stripped, 'unknown');
  assert.equal(result.hardening.stackProtector, 'unknown');
});

test('binaries: a PE64 reads DllCharacteristics and the debug directory', () => {
  const { full } = writeTempFile('pe.exe', buildPe64());
  const result = analyzeFile(full, 'pe.exe', fs.statSync(full).size);
  assert.equal(result.format, 'pe');
  assert.equal(result.arch, 'x86-64');
  assert.equal(result.hardening.pie, 'enabled');
  assert.equal(result.hardening.nx, 'enabled');
  assert.equal(result.hardening.relro, 'not_applicable');
  assert.equal(result.hardening.rpath, 'not_applicable');
  assert.equal(result.hardening.stripped, 'enabled');
  assert.equal(result.hardening.stackProtector, 'unknown');
  assert.equal(result.hardening.fortify, 'not_applicable');
  const debugged = writeTempFile('pe-dbg.exe', buildPe64({ withDebug: true }));
  assert.equal(analyzeFile(debugged.full, 'pe-dbg.exe', fs.statSync(debugged.full).size).hardening.stripped, 'disabled');
  const plain = writeTempFile('pe-plain.exe', buildPe64({ dynamicBase: false, nxCompat: false }));
  const result2 = analyzeFile(plain.full, 'pe-plain.exe', fs.statSync(plain.full).size);
  assert.equal(result2.hardening.pie, 'disabled');
  assert.equal(result2.hardening.nx, 'disabled');
});

test('binaries: a Mach-O 64 reads MH_PIE, the heap flag, LC_SYMTAB and LC_RPATH', () => {
  const { full } = writeTempFile('macho', buildMachO64({ withSymtab: true, withRpath: true }));
  const result = analyzeFile(full, 'macho', fs.statSync(full).size);
  assert.equal(result.format, 'mach-o');
  assert.equal(result.arch, 'x86-64');
  assert.equal(result.hardening.pie, 'enabled');
  assert.equal(result.hardening.nx, 'enabled');
  assert.equal(result.hardening.relro, 'not_applicable');
  assert.equal(result.hardening.rpath, 'enabled');
  assert.equal(result.hardening.stripped, 'disabled');
  const plain = writeTempFile('macho-plain', buildMachO64({ pie: false, nx: false }));
  const result2 = analyzeFile(plain.full, 'macho-plain', fs.statSync(plain.full).size);
  assert.equal(result2.hardening.pie, 'disabled');
  assert.equal(result2.hardening.nx, 'disabled');
  assert.equal(result2.hardening.stripped, 'enabled');
});

test('binaries: a file that is not a native binary is not one', () => {
  const { full } = writeTempFile('text.txt', Buffer.from('hello world\n'.repeat(2000)));
  assert.equal(analyzeFile(full, 'text.txt', fs.statSync(full).size), null);
});

test('binaries: a corrupt ELF reports itself as unparsable, not as clean', () => {
  const broken = Buffer.alloc(64);
  broken.writeUInt8(0x7f, 0);
  broken.write('ELF', 1, 'latin1');
  broken.writeUInt8(9, 4); // no such ELF class
  const { full } = writeTempFile('broken', broken);
  const result = analyzeFile(full, 'broken', fs.statSync(full).size);
  assert.equal(result.format, 'elf');
  assert.equal(result.arch, 'unknown');
  assert.deepEqual(Object.values(result.hardening), Array(10).fill('unknown'));
  assert.match(result.notes.join(' '), /could not be parsed/);
});

test('binaries: high entropy is noted, not scored', () => {
  const contents = Buffer.concat([buildElf64(), randomBytes(20 * 1024)]);
  const { full } = writeTempFile('packed', contents);
  const result = analyzeFile(full, 'packed', fs.statSync(full).size);
  assert.ok(result.entropy > 7.2);
  assert.match(result.notes.join(' '), /high entropy/);
});

test('binaries: esbuild matches REA ground truth field by field', (t) => {
  // The REA study's native-probes.json, for esbuild 0.25.0
  // (10,244,248 bytes): pie disabled, nx enabled, relro disabled,
  // stack protector unknown, fortify unknown, cet disabled,
  // aarch64_bti_pac not_applicable, rpath/runpath disabled,
  // stripped enabled, file entropy 6.1813.
  if (!fs.existsSync(esbuildPath)) {
    t.skip('esbuild ground-truth binary is not in this workspace');
    return;
  }
  const bytes = fs.readFileSync(esbuildPath);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), esbuildSha256, 'ground-truth binary changed — update the expectations, do not delete the test');
  const result = analyzeFile(esbuildPath, 'bin/esbuild', bytes.length);
  assert.equal(result.format, 'elf');
  assert.equal(result.arch, 'x86-64');
  assert.equal(result.entropy, 6.18);
  assert.deepEqual(result.hardening, {
    pie: 'disabled',
    nx: 'enabled',
    relro: 'disabled',
    stackProtector: 'unknown',
    fortify: 'unknown',
    cet: 'disabled',
    btiPac: 'not_applicable',
    rpath: 'disabled',
    runpath: 'disabled',
    stripped: 'enabled',
  });
});

test('binaries: scanBinaries finds the largest native binaries and skips the rest', () => {
  const dir = tempDir('dev-diagnosis-binaries-scan-');
  fs.writeFileSync(path.join(dir, 'small-elf'), padTo(buildElf64({ type: 2 }), 10 * 1024));
  fs.writeFileSync(path.join(dir, 'big-pe.exe'), padTo(buildPe64(), 30 * 1024));
  fs.writeFileSync(path.join(dir, 'mid-macho'), padTo(buildMachO64(), 25 * 1024));
  fs.writeFileSync(path.join(dir, 'big-text.txt'), Buffer.alloc(40 * 1024, 'a'));
  fs.writeFileSync(path.join(dir, 'tiny.js'), 'console.log(1)\n');
  const result = scanBinaries(dir);
  assert.equal(result.top, DEFAULT_TOP_BINARIES);
  assert.equal(result.totalBinaries, 2);
  // The 10 KB ELF is under the 16 KB floor, so only three files get
  // their magic bytes read: the PE, the Mach-O and the 40 KB text file.
  assert.equal(result.checkedFiles, 3);
  assert.equal(result.files, 5);
  assert.deepEqual(result.binaries.map((b) => b.file), ['big-pe.exe', 'mid-macho']);
  // The 10 KB ELF is under the 16 KB floor, so it is never a candidate.
  assert.ok(!result.binaries.some((b) => b.file === 'small-elf'));
  assert.equal(result.binaries[0].bytes, 30 * 1024);
  assert.equal(result.binaries[1].bytes, 25 * 1024);
  const top1 = scanBinaries(dir, { top: 1 });
  assert.equal(top1.binaries.length, 1);
  assert.equal(top1.totalBinaries, 2);
  assert.equal(top1.binaries[0].file, 'big-pe.exe');
});

test('binaries: scanBinaries validates --top and requires a directory', () => {
  const dir = tempDir('dev-diagnosis-binaries-top-');
  assert.throws(() => scanBinaries(dir, { top: 0 }), /from 1 to 20/);
  assert.throws(() => scanBinaries(dir, { top: 21 }), /from 1 to 20/);
  assert.throws(() => scanBinaries(dir, { top: 2.5 }), /from 1 to 20/);
  assert.throws(() => scanBinaries(path.join(dir, 'missing')), /no such file/);
});

test('binaries: the check always passes and names its verdict honestly', () => {
  const empty = runBinariesCheck(tempDir('dev-diagnosis-binaries-empty-'));
  assert.equal(empty.passed, true);
  assert.equal(empty.verdict, 'no native binaries found');
  const dir = tempDir('dev-diagnosis-binaries-one-');
  fs.writeFileSync(path.join(dir, 'tool'), padTo(buildElf64({ type: 2 }), 20 * 1024));
  const one = runBinariesCheck(dir);
  assert.equal(one.passed, true);
  assert.equal(one.verdict, '1 native binary checked — see the hardening table');
  assert.throws(() => runBinariesCheck(dir, { top: 21 }), UsageError);
  assert.throws(() => runBinariesCheck(dir, { top: 21 }), /from 1 to 20/);
});

test('binaries: all runs it like any other check, and --only/--skip select it', () => {
  const run = runAll({ root: demoRepo });
  assert.ok(run.checks.binaries, 'binaries runs in all with no input of its own');
  assert.equal(run.checks.binaries.passed, true);
  assert.equal(run.checks.binaries.result.totalBinaries, 0);
  assert.equal(run.checks.binaries.verdict, 'no native binaries found');
  const only = runAll({ root: demoRepo, only: ['binaries'] });
  assert.deepEqual(Object.keys(only.checks), ['binaries']);
  const skipped = runAll({ root: demoRepo, skip: ['binaries'] });
  assert.equal(skipped.checks.binaries, undefined);
  assert.ok(skipped.skipped.some((line) => line.startsWith('binaries — skipped by --skip')));
  assert.throws(() => selectChecks({ skip: ['context', 'binaries', 'path', 'flakes', 'cache'] }), /at least one of context, binaries, path, flakes, cache must run/);
});

test('binaries: the CLI prints the table and exits 0 even with binaries present', () => {
  const dir = tempDir('dev-diagnosis-binaries-cli-');
  fs.writeFileSync(path.join(dir, 'tool'), padTo(buildElf64({ type: 2 }), 20 * 1024));
  const result = run(['binaries', dir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /1 native binary/);
  assert.match(result.stdout, /checked 1 file 16\.0 KB or larger out of 1/);
  assert.match(result.stdout, /tool — 20\.0 KB, elf x86-64, entropy/);
  assert.match(result.stdout, /pie: disabled  nx: enabled  relro: disabled  stripped: enabled/);
  assert.match(result.stdout, /PASS  1 native binary checked/);
  const json = run(['binaries', dir, '--json']);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.totalBinaries, 1);
  assert.equal(parsed.binaries[0].hardening.pie, 'disabled');
  const none = run(['binaries', demoRepo]);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /No native binaries found/);
  assert.match(none.stdout, /PASS  no native binaries found/);
  const badTop = run(['binaries', dir, '--top', '21']);
  assert.equal(badTop.status, 2);
  assert.match(badTop.stderr, /--top needs a whole number from 1 to 20/);
});

test('binaries: the 16 KB floor is the documented constant', () => {
  assert.equal(MIN_BINARY_BYTES, 16 * 1024);
});
