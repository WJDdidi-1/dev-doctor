/**
 * Native-binary checkup: hardening + entropy for the largest native
 * binaries in a repo (REA's no-engine probes, re-implemented with the
 * Node standard library — no REA dependency, no engine, no network).
 *
 * This is a checkup, not a security audit: it reports what the file
 * headers say (PIE, NX, RELRO, stripped, entropy) and never assesses
 * whether any of it is exploitable. A value it cannot determine is
 * reported as 'unknown', with a note saying why — never guessed.
 * The check always passes: a binary with PIE disabled is a fact to
 * know about, not a failure of the repo.
 *
 * Method notes, so the table can be checked against REA's ground
 * truth (REA's names in brackets):
 * - PIE [pie]: ELF e_type ET_DYN; PE DllCharacteristics DYNAMIC_BASE;
 *   Mach-O MH_PIE (a dylib/bundle is PIC by construction).
 * - NX [nx]: ELF PT_GNU_STACK without PF_X; PE NX_COMPAT; Mach-O
 *   MH_NO_HEAP_EXECUTION.
 * - RELRO [relro]: ELF PT_GNU_RELRO present. Not a thing on PE or
 *   Mach-O ('not_applicable').
 * - Stripped [stripped]: ELF has section headers but no SHT_SYMTAB;
 *   PE has an empty debug data directory; Mach-O has no LC_SYMTAB.
 * - Stack protector [stack_protector]: the dynamic string table
 *   contains '__stack_chk_fail'. No dynamic symbol table means
 *   'unknown' — a static binary cannot be told from its headers.
 * - Fortify [fortify]: the dynamic string table contains a '__*_chk'
 *   symbol. Same 'unknown' rule as the stack protector.
 * - CET [cet_ibt_shstk]: the x86 GNU_PROPERTY_X86_FEATURE_1_USED
 *   note with the IBT or SHSTK bit. Absent on x86 means disabled;
 *   on any other arch it is 'not_applicable'.
 * - BTI/PAC [aarch64_bti_pac]: the AArch64
 *   GNU_PROPERTY_AARCH64_FEATURE_1_USED note with the BTI or PAC
 *   bit. Absent on AArch64 means disabled; elsewhere
 *   'not_applicable'.
 * - RPATH / RUNPATH [rpath / runpath]: ELF DT_RPATH / DT_RUNPATH
 *   present. Mach-O LC_RPATH is its RPATH; PE has neither.
 * - Entropy [file_entropy]: whole-file Shannon entropy, 2 decimals.
 *   Over 7.2 is high — often packed or encrypted — and is noted as
 *   such, not scored.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TOP_BINARIES = 5;
export const MIN_BINARY_BYTES = 16 * 1024;
export const HIGH_ENTROPY = 7.2;
const MAX_STR_TAB_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules']);

const UNKNOWN = 'unknown';
const NOT_APPLICABLE = 'not_applicable';

function unknownHardening() {
  return {
    pie: UNKNOWN, nx: UNKNOWN, relro: UNKNOWN,
    stackProtector: UNKNOWN, fortify: UNKNOWN,
    cet: UNKNOWN, btiPac: UNKNOWN,
    rpath: UNKNOWN, runpath: UNKNOWN, stripped: UNKNOWN,
  };
}

/** Whole-file Shannon entropy, streamed in 64 KB chunks. */
export function shannonEntropyOfFile(absolute) {
  const counts = new Array(256).fill(0);
  let total = 0;
  const fd = fs.openSync(absolute, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let read;
    do {
      read = fs.readSync(fd, buf, 0, buf.length, null);
      for (let i = 0; i < read; i += 1) counts[buf[i]] += 1;
      total += read;
    } while (read > 0);
  } finally {
    fs.closeSync(fd);
  }
  if (total === 0) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return Math.round(entropy * 100) / 100;
}

/** 'elf' | 'pe' | 'mach-o' | 'mach-o-fat' | null, from the first 4 bytes. */
export function detectFormat(header) {
  if (header.length < 4) return null;
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) return 'elf';
  if (header[0] === 0x4d && header[1] === 0x5a) return 'pe';
  const magic = header.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf) return 'mach-o';
  if (magic === 0xcefaedfe || magic === 0xcffaedfe) return 'mach-o';
  if (magic === 0xcafebabe || magic === 0xbebafeca) return 'mach-o-fat';
  return null;
}

/** Endianness-aware reader over one open file descriptor. */
class Reader {
  constructor(fd, littleEndian) {
    this.fd = fd;
    this.le = littleEndian;
  }

  bytesAt(position, length) {
    const buf = Buffer.alloc(length);
    const read = fs.readSync(this.fd, buf, 0, length, position);
    // A short read means the file is truncated: the field cannot be
    // determined, so the parse fails loudly instead of reading zeros
    // as if they were header values.
    if (read !== length) throw new Error('unexpected end of file');
    return buf;
  }

  u16(buf, off) { return this.le ? buf.readUInt16LE(off) : buf.readUInt16BE(off); }
  u32(buf, off) { return this.le ? buf.readUInt32LE(off) : buf.readUInt32BE(off); }
  i32(buf, off) { return this.le ? buf.readInt32LE(off) : buf.readInt32BE(off); }
  u64(buf, off) { return Number(this.le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off)); }
  i64(buf, off) { return Number(this.le ? buf.readBigInt64LE(off) : buf.readBigInt64BE(off)); }
}

function elfArch(machine) {
  switch (machine) {
    case 3: return 'i386';
    case 62: return 'x86-64';
    case 183: return 'arm64';
    case 40: return 'arm';
    case 8: return 'mips';
    case 20: return 'ppc';
    case 21: return 'ppc64';
    case 43: return 'riscv';
    default: return 'unknown';
  }
}

const FORTIFY_SYMBOLS = ['__memcpy_chk', '__memmove_chk', '__strcpy_chk', '__strncpy_chk', '__strcat_chk', '__strncat_chk', '__sprintf_chk', '__snprintf_chk', '__printf_chk', '__fprintf_chk', '__read_chk', '__pread_chk', '__recv_chk', '__gets_chk', '__realpath_chk', '__ptsname_r_chk'];

function analyzeElf(fd, base) {
  const notes = [];
  const hardening = unknownHardening();
  const eident = new Reader(fd, true).bytesAt(base, 16);
  const is64 = eident[4] === 2;
  if (eident[4] !== 1 && eident[4] !== 2) throw new Error('unknown ELF class');
  const le = eident[5] !== 2;
  const r = new Reader(fd, le);
  const ehsize = is64 ? 64 : 52;
  const eh = r.bytesAt(base, ehsize);
  const eType = r.u16(eh, 16);
  const eMachine = r.u16(eh, 18);
  const ePhoff = is64 ? r.u64(eh, 32) : r.u32(eh, 28);
  const eShoff = is64 ? r.u64(eh, 40) : r.u32(eh, 32);
  const ePhentsize = r.u16(eh, is64 ? 54 : 42);
  let ePhnum = r.u16(eh, is64 ? 56 : 44);
  const eShentsize = r.u16(eh, is64 ? 58 : 46);
  let eShnum = r.u16(eh, is64 ? 60 : 48);
  const arch = elfArch(eMachine);
  const phdrSize = is64 ? 56 : 32;
  const shdrSize = is64 ? 64 : 40;

  // Extended numbering: the real counts live in section header 0 when
  // the 16-bit fields overflow (0xffff sections or program headers).
  if ((ePhnum === 0xffff || eShnum === 0) && eShoff > 0) {
    const sh0 = r.bytesAt(base + eShoff, shdrSize);
    if (ePhnum === 0xffff) ePhnum = r.u32(sh0, is64 ? 44 : 28);
    if (eShnum === 0) eShnum = r.u32(sh0, is64 ? 32 : 20);
  }
  // Unresolvable extended numbering (no section headers to read the
  // real count from): treat as no program/section headers rather than
  // looping over garbage.
  if (ePhnum === 0xffff) ePhnum = 0;
  // Header counts are bounded in real binaries (dozens of sections,
  // a handful of program headers): an absurd count is a malformed
  // file, and looping over it would hang the check.
  if (ePhnum > 1024) throw new Error('implausible program header count');
  if (eShnum > 10000) throw new Error('implausible section header count');

  if (eType === 3) hardening.pie = 'enabled';
  else if (eType === 2) hardening.pie = 'disabled';
  else if (eType === 1) hardening.pie = NOT_APPLICABLE;

  // Program headers: PT_LOAD segments (for vaddr translation), the
  // dynamic segment, GNU_STACK, GNU_RELRO and GNU_PROPERTY.
  const loads = [];
  let dynamic = null;
  let gnuProperty = null;
  let hasGnuStack = false;
  for (let i = 0; i < ePhnum; i += 1) {
    const ph = r.bytesAt(base + ePhoff + i * ePhentsize, phdrSize);
    const pType = r.u32(ph, 0);
    const pFlags = is64 ? r.u32(ph, 4) : r.u32(ph, 24);
    const pOffset = is64 ? r.u64(ph, 8) : r.u32(ph, 4);
    const pVaddr = is64 ? r.u64(ph, 16) : r.u32(ph, 8);
    const pFilesz = is64 ? r.u64(ph, 32) : r.u32(ph, 16);
    if (pType === 1) loads.push({ vaddr: pVaddr, offset: pOffset, filesz: pFilesz });
    else if (pType === 2) dynamic = { offset: pOffset, filesz: pFilesz };
    else if (pType === 0x6474e551) {
      hasGnuStack = true;
      hardening.nx = (pFlags & 1) !== 0 ? 'disabled' : 'enabled';
    } else if (pType === 0x6474e552) {
      hardening.relro = 'enabled';
    } else if (pType === 0x6474e553) {
      gnuProperty = { offset: pOffset, filesz: pFilesz };
    }
  }
  if (!hasGnuStack) {
    notes.push('nx: no PT_GNU_STACK segment — the kernel default applies, this table cannot tell');
  }
  if (hardening.relro === UNKNOWN) hardening.relro = 'disabled';

  // Dynamic section: RPATH/RUNPATH, and the string table for the
  // stack-protector and fortify symbol checks. DT_STRTAB is a virtual
  // address, translated back to a file offset through PT_LOAD.
  let strtab = null;
  let hasDynsym = false;
  if (dynamic) {
    if (dynamic.filesz > 64 * 1024) throw new Error('implausible dynamic section size');
    const entSize = is64 ? 16 : 8;
    const count = Math.floor(dynamic.filesz / entSize);
    const dyn = r.bytesAt(base + dynamic.offset, dynamic.filesz);
    let strtabAddr = null;
    let strsz = null;
    let symtabAddr = null;
    for (let i = 0; i < count; i += 1) {
      const tag = is64 ? r.i64(dyn, i * entSize) : r.i32(dyn, i * entSize);
      const val = is64 ? r.u64(dyn, i * entSize + 8) : r.u32(dyn, i * entSize + 4);
      if (tag === 0) break;
      if (tag === 15) hardening.rpath = 'enabled';
      else if (tag === 29) hardening.runpath = 'enabled';
      else if (tag === 5) strtabAddr = val;
      else if (tag === 10) strsz = val;
      else if (tag === 6) symtabAddr = val;
    }
    if (hardening.rpath === UNKNOWN) hardening.rpath = 'disabled';
    if (hardening.runpath === UNKNOWN) hardening.runpath = 'disabled';
    hasDynsym = symtabAddr != null;
    if (strtabAddr != null && strsz != null && strsz > 0) {
      const load = loads.find((seg) => strtabAddr >= seg.vaddr && strtabAddr < seg.vaddr + seg.filesz);
      if (load) {
        const fileOff = load.offset + (strtabAddr - load.vaddr);
        strtab = r.bytesAt(base + fileOff, Math.min(strsz, MAX_STR_TAB_BYTES));
      }
    }
  } else {
    // A static binary has no dynamic entries at all: no RPATH, no
    // RUNPATH, and no dynamic symbol table to check the protector by.
    hardening.rpath = 'disabled';
    hardening.runpath = 'disabled';
  }

  if (!hasDynsym) {
    notes.push('stack protector: no dynamic symbol table — cannot tell from headers');
    notes.push('fortify: no dynamic symbol table — cannot tell from headers');
  } else if (strtab) {
    hardening.stackProtector = strtab.includes('__stack_chk_fail') ? 'enabled' : 'disabled';
    hardening.fortify = FORTIFY_SYMBOLS.some((name) => strtab.includes(name)) ? 'enabled' : 'disabled';
  } else {
    notes.push('stack protector: dynamic string table could not be read — cannot tell');
    notes.push('fortify: dynamic string table could not be read — cannot tell');
  }

  // GNU property notes: CET on x86, BTI/PAC on AArch64. The note
  // entries are 4-byte aligned on 32-bit objects, 8-byte on 64-bit.
  if (gnuProperty) {
    try {
      const align = is64 ? 8 : 4;
      const prop = r.bytesAt(base + gnuProperty.offset, Math.min(gnuProperty.filesz, 64 * 1024));
      let off = 0;
      while (off + 12 <= prop.length) {
        const namesz = r.u32(prop, off);
        const descsz = r.u32(prop, off + 4);
        const type = r.u32(prop, off + 8);
        const nameStart = off + 12;
        const descStart = nameStart + Math.ceil(namesz / align) * align;
        if (type === 5 && prop.subarray(nameStart, nameStart + 4).toString('latin1') === 'GNU\0') {
          let p = descStart;
          const descEnd = Math.min(descStart + descsz, prop.length);
          while (p + 8 <= descEnd) {
            const prType = r.u32(prop, p);
            const prDatasz = r.u32(prop, p + 4);
            if (p + 8 + prDatasz <= descEnd) {
              if (prType === 0xc0000002) {
                const val = r.u32(prop, p + 8);
                hardening.cet = (val & 0x3) !== 0 ? 'enabled' : 'disabled';
              } else if (prType === 0xc0000000) {
                const val = r.u32(prop, p + 8);
                hardening.btiPac = (val & 0x3) !== 0 ? 'enabled' : 'disabled';
              }
            }
            p += 8 + Math.ceil(prDatasz / 4) * 4;
          }
        }
        off = descStart + Math.ceil(descsz / align) * align;
      }
    } catch {
      // A malformed property note must not take the whole table down:
      // the two fields fall back to their defaults below, and the
      // note says the parse failed.
      notes.push('cet/bti-pac: GNU property note could not be parsed — cannot tell');
    }
  }
  if (arch === 'x86-64' || arch === 'i386') {
    if (hardening.cet === UNKNOWN) hardening.cet = 'disabled';
    hardening.btiPac = NOT_APPLICABLE;
  } else if (arch === 'arm64' || arch === 'arm') {
    if (hardening.btiPac === UNKNOWN) hardening.btiPac = 'disabled';
    hardening.cet = NOT_APPLICABLE;
  }

  // Stripped: section headers present, but no SHT_SYMTAB among them.
  if (eShoff > 0 && eShnum > 0) {
    let hasSymtab = false;
    for (let i = 0; i < eShnum; i += 1) {
      const sh = r.bytesAt(base + eShoff + i * eShentsize, shdrSize);
      if (r.u32(sh, 4) === 2) { hasSymtab = true; break; }
    }
    hardening.stripped = hasSymtab ? 'disabled' : 'enabled';
  } else {
    notes.push('stripped: no section headers — cannot tell');
  }

  return { format: 'elf', arch, hardening, notes };
}

function machArch(cputype) {
  switch (cputype) {
    case 0x01000007: return 'x86-64';
    case 7: return 'i386';
    case 0x0100000c: return 'arm64';
    case 12: return 'arm';
    default: return 'unknown';
  }
}

function analyzeMachO(fd, base) {
  const notes = [];
  const hardening = unknownHardening();
  const head = new Reader(fd, true).bytesAt(base, 32);
  const magic = head.readUInt32BE(0);
  if (magic === 0xfeedface || magic === 0xfeedfacf) {
    // Big-endian Mach-O (PowerPC era): the header is readable, the
    // load commands are not attempted — everything stays unknown.
    notes.push('big-endian Mach-O: load commands not parsed — cannot tell');
    return { format: 'mach-o', arch: 'unknown', hardening, notes };
  }
  const is64 = magic === 0xcffaedfe;
  if (!is64 && magic !== 0xcefaedfe) throw new Error('unrecognized Mach-O magic');
  const cputype = head.readInt32LE(4);
  const filetype = head.readUInt32LE(12);
  const ncmds = head.readUInt32LE(16);
  const flags = head.readUInt32LE(24);
  const arch = machArch(cputype);
  // A dylib or bundle is position-independent by construction.
  if (filetype === 6 || filetype === 8) hardening.pie = 'enabled';
  else if (filetype === 1) hardening.pie = NOT_APPLICABLE;
  else hardening.pie = (flags & 0x200000) !== 0 ? 'enabled' : 'disabled';
  hardening.nx = (flags & 0x1000000) !== 0 ? 'enabled' : 'disabled';
  hardening.relro = NOT_APPLICABLE;
  hardening.rpath = 'disabled';
  hardening.runpath = NOT_APPLICABLE;
  hardening.cet = NOT_APPLICABLE;
  hardening.stackProtector = UNKNOWN;
  hardening.fortify = NOT_APPLICABLE;
  notes.push('stack protector: Mach-O import check not implemented — cannot tell from headers');
  let offset = base + (is64 ? 32 : 28);
  let hasSymtab = false;
  const reader = new Reader(fd, true);
  if (ncmds > 1024) throw new Error('implausible Mach-O load command count');
  for (let i = 0; i < ncmds; i += 1) {
    const cmdHead = reader.bytesAt(offset, 8);
    const cmd = cmdHead.readUInt32LE(0);
    const cmdsize = cmdHead.readUInt32LE(4);
    if (cmdsize < 8) break;
    if (cmd === 0x2) hasSymtab = true;
    else if (cmd === 0x8000001c) hardening.rpath = 'enabled';
    offset += cmdsize;
  }
  hardening.stripped = hasSymtab ? 'disabled' : 'enabled';
  return { format: 'mach-o', arch, hardening, notes };
}

function analyzeMachOFat(fd, base, size) {
  const head = new Reader(fd, false).bytesAt(base, 8);
  const nfatArch = head.readUInt32BE(4);
  if (nfatArch < 1 || nfatArch > 1024) throw new Error('implausible fat binary slice count');
  const first = new Reader(fd, false).bytesAt(base + 8, 20);
  const sliceOffset = first.readUInt32BE(8);
  const sliceSize = first.readUInt32BE(12);
  if (sliceOffset + sliceSize > size) throw new Error('fat binary slice out of range');
  const analyzed = analyzeMachO(fd, base + sliceOffset);
  analyzed.format = 'mach-o-fat';
  analyzed.notes.unshift(`fat binary with ${nfatArch} slice${nfatArch === 1 ? '' : 's'}; this table is the first slice (${analyzed.arch})`);
  return analyzed;
}

function peArch(machine) {
  switch (machine) {
    case 0x8664: return 'x86-64';
    case 0x14c: return 'i386';
    case 0xaa64: return 'arm64';
    case 0x1c0: return 'arm';
    default: return 'unknown';
  }
}

function analyzePe(fd, base) {
  const notes = [];
  const hardening = unknownHardening();
  const reader = new Reader(fd, true);
  const dos = reader.bytesAt(base, 64);
  const peOff = base + dos.readUInt32LE(0x3c);
  const sig = reader.bytesAt(peOff, 4);
  if (sig.toString('latin1') !== 'PE\0\0') throw new Error('missing PE signature');
  const coff = reader.bytesAt(peOff + 4, 20);
  const machine = coff.readUInt16LE(0);
  const characteristics = coff.readUInt16LE(18);
  const optOff = peOff + 24;
  const optMagic = reader.bytesAt(optOff, 2).readUInt16LE(0);
  const isPlus = optMagic === 0x20b;
  if (!isPlus && optMagic !== 0x10b) throw new Error('unknown PE optional header magic');
  const dllChar = reader.bytesAt(optOff + 70, 2).readUInt16LE(0);
  const arch = peArch(machine);
  hardening.pie = (dllChar & 0x40) !== 0 ? 'enabled' : 'disabled';
  hardening.nx = (dllChar & 0x100) !== 0 ? 'enabled' : 'disabled';
  hardening.relro = NOT_APPLICABLE;
  hardening.rpath = NOT_APPLICABLE;
  hardening.runpath = NOT_APPLICABLE;
  hardening.cet = UNKNOWN;
  hardening.btiPac = NOT_APPLICABLE;
  hardening.stackProtector = UNKNOWN;
  hardening.fortify = NOT_APPLICABLE;
  notes.push('stack protector: PE import-table check not implemented — cannot tell from headers');
  const numDirs = reader.bytesAt(optOff + (isPlus ? 108 : 92), 4).readUInt32LE(0);
  if (numDirs > 6) {
    const dirsOff = optOff + (isPlus ? 112 : 96);
    const debugDir = reader.bytesAt(dirsOff + 6 * 8, 8);
    hardening.stripped = debugDir.readUInt32LE(4) === 0 ? 'enabled' : 'disabled';
  } else if ((characteristics & 0x200) !== 0) {
    hardening.stripped = 'enabled';
  } else {
    notes.push('stripped: no debug data directory in the optional header — cannot tell');
  }
  return { format: 'pe', arch, hardening, notes };
}

/**
 * Analyze one file that already passed the magic-byte check: format,
 * arch, entropy and the hardening table, or — when the headers cannot
 * be parsed — the same shape with everything unknown and a note
 * saying why. Returns null when the file is not a native binary.
 */
export function analyzeFile(absolute, relative, size) {
  let head;
  try {
    const fd = fs.openSync(absolute, 'r');
    try {
      head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const format = detectFormat(head);
  if (!format) return null;
  let entropy = null;
  try {
    entropy = shannonEntropyOfFile(absolute);
  } catch {
    // The file vanished mid-scan: entropy stays null, the table below
    // still says what the headers said.
  }
  const highEntropyNote = entropy != null && entropy > HIGH_ENTROPY
    ? 'high entropy — often packed or encrypted, worth a look'
    : null;
  let analyzed;
  try {
    const fd = fs.openSync(absolute, 'r');
    try {
      if (format === 'elf') analyzed = analyzeElf(fd, 0);
      else if (format === 'pe') analyzed = analyzePe(fd, 0);
      else if (format === 'mach-o') analyzed = analyzeMachO(fd, 0);
      else analyzed = analyzeMachOFat(fd, 0, size);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    const notes = [`headers could not be parsed: ${error.message}`];
    if (highEntropyNote) notes.push(highEntropyNote);
    return { file: relative, bytes: size, format, arch: 'unknown', entropy, hardening: unknownHardening(), notes };
  }
  const notes = [...analyzed.notes];
  if (highEntropyNote) notes.push(highEntropyNote);
  return { file: relative, bytes: size, format: analyzed.format, arch: analyzed.arch, entropy, hardening: analyzed.hardening, notes };
}

function walkBinaries(root, dir, state) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory is the context scan's business; this
    // check skips it rather than failing the whole run.
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      walkBinaries(root, full, state);
      continue;
    }
    let stat;
    if (entry.isSymbolicLink()) {
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
    } else if (entry.isFile()) {
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
    } else {
      continue;
    }
    state.files += 1;
    // Only files large enough to plausibly be a native binary get
    // their magic bytes read: a real binary is larger than 16 KB,
    // and reading the first bytes of every small file would slow the
    // check on big repos for nothing.
    if (stat.size < MIN_BINARY_BYTES) continue;
    state.checkedFiles += 1;
    const found = analyzeFile(full, rel, stat.size);
    if (found) state.binaries.push(found);
  }
}

/**
 * Scan a repo for native binaries and return the largest `top` of
 * them with their hardening tables. The walk skips `.git`,
 * `node_modules` and hidden directories, like the context scan; it
 * does not apply `.aiignore` or `.gitignore` — a vendored binary is
 * worth a checkup whether or not an agent would be handed it.
 */
export function scanBinaries(target, options = {}) {
  const root = path.resolve(target || process.cwd());
  const rootStat = fs.statSync(root);
  if (!rootStat.isDirectory()) throw new Error(`not a directory: ${target}`);
  const top = options.top != null ? options.top : DEFAULT_TOP_BINARIES;
  if (!Number.isInteger(top) || top < 1 || top > 20) {
    throw new Error('--top must be a whole number from 1 to 20');
  }
  const state = { files: 0, checkedFiles: 0, binaries: [] };
  walkBinaries(root, root, state);
  state.binaries.sort((a, b) => b.bytes - a.bytes);
  const totalBinaries = state.binaries.length;
  return {
    root,
    top,
    files: state.files,
    checkedFiles: state.checkedFiles,
    totalBinaries,
    binaries: state.binaries.slice(0, top),
  };
}
