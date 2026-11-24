// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write (sections 1 to 4, 9 and 10),
// and line matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7) and
// V4A patches (section 8). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.br) + (st.final ? st.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** One body line of a hunk or chunk: context, old, new, or a backslash line. */
interface Op {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  /** True when a context line came from a patch line that was empty. */
  empty?: boolean;
}

function tierEqual(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Positions at or after `from` where O matches the file's lines at a tier. */
function occurrences(file: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!tierEqual(file[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) with an occurrence, or null. */
function firstTier(file: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const positions = occurrences(file, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor at the first tier with one, or null. */
function firstTierSingle(file: string[], anchor: string, strict: boolean, from: number): number | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    for (let i = Math.max(0, from); i < file.length; i += 1) {
      if (tierEqual(file[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

/** The new lines for a matched O: context lines are the file's own, `+` lines are re-indented at tier 2. */
function buildNew(file: string[], pos: number, ops: Op[], tier: number): string[] {
  const out: string[] = [];
  let mi = 0;
  let first: Op | null = null;
  for (const op of ops) {
    if (op.kind !== 'add') {
      first = op;
      break;
    }
  }
  const f = leadingWs(file[pos] ?? '');
  const p = first === null ? '' : leadingWs(first.text);
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[pos + mi]!);
      mi += 1;
    } else if (op.kind === 'del') {
      mi += 1;
    } else if (op.kind === 'add') {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** One body line of a hunk or chunk, from its patch line. */
function bodyOp(line: string): Op {
  if (line === '') return { kind: 'ctx', text: '', empty: true };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'del', text: line.slice(1) };
  if (c === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'bs', text: line.slice(1) };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified-diff hunk: its old start line and its body lines. */
interface Hunk {
  a: number;
  body: Op[];
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, trimmed, a/ or b/ removed, /dev/null is no file. */
function diffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p === '/dev/null' ? null : p;
}

/** Whether a `\` line follows the hunk's last context or `+` line, or its last `+` line. */
function hunkNoEol(body: Op[], lastKind: 'ctxAdd' | 'add'): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j += 1) {
    const k = body[j]!.kind;
    if (lastKind === 'ctxAdd' ? k === 'ctx' || k === 'add' : k === 'add') last = j;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === 'bs';
}

/** Apply one section's hunks, in order, to a file's state; throws Fail on the first failing hunk. */
function applyHunks(st: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let lines = [...st.lines];
  let final = st.final;
  let d = 0;
  for (const h of hunks) {
    const ops = h.body.filter((o) => o.kind !== 'bs');
    const o = ops.filter((x) => x.kind !== 'add').map((x) => x.text);
    if (o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const wasEnd = at === lines.length;
      const n = buildNew(lines, at, ops, 0);
      lines = [...lines.slice(0, at), ...n, ...lines.slice(at)];
      if (wasEnd) final = !hunkNoEol(h.body, 'ctxAdd');
      d += n.length;
      continue;
    }
    const found = firstTier(lines, o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = found.positions[0]!;
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const n = buildNew(lines, pos, ops, found.tier);
    const matchedToEnd = pos + o.length === lines.length;
    lines = [...lines.slice(0, pos), ...n, ...lines.slice(pos + o.length)];
    if (matchedToEnd) final = !hunkNoEol(h.body, 'ctxAdd');
    d += n.length - o.length;
  }
  return { lines, br: st.br, final };
}

/** The edits of a unified diff (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  let inBody = false;
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === 'ctx' && last.empty === true) hunk.body.pop();
        else break;
      }
    }
    hunk = null;
    inBody = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        endBody();
        continue;
      }
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        hunk!.body.push(bodyOp(line));
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { diffOld: m[1]!, diffNew: m[2]!, oldPath: null, newPath: null, hasPair: false, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && !sec.hasPair && sec.hunks.length === 0) {
        sec.oldPath = diffPath(line.slice(4));
        sec.newPath = diffPath(lines[i + 1]!.slice(4));
        sec.hasPair = true;
      } else {
        sec = { diffOld: null, diffNew: null, oldPath: diffPath(line.slice(4)), newPath: diffPath(lines[i + 1]!.slice(4)), hasPair: true, renameFrom: null, renameTo: null, isCreate: false, isDelete: false, hunks: [] };
        sections.push(sec);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && sec !== null && sec.hunks.length === 0) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/.exec(line);
      if (m === null || sec === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      inBody = true;
      i += 1;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.isCreate = true;
      else if (line.startsWith('deleted file mode')) sec.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  if (inBody) endBody();
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.hasPair ? s.oldPath : (s.renameFrom ?? (s.diffOld === '/dev/null' ? null : s.diffOld));
    const newPath = s.hasPair ? s.newPath : (s.renameTo ?? (s.diffNew === '/dev/null' ? null : s.diffNew));
    const isCreate = s.isCreate || oldPath === null;
    const isDelete = !isCreate && (s.isDelete || newPath === null);
    const isMove = !isCreate && !isDelete && oldPath !== newPath;
    const hunks = s.hunks;
    if (isCreate) {
      const dest = newPath;
      edits.push((tree) => {
        if (dest === null) throw new Fail('unsafe', '/dev/null');
        if (!safe(dest)) throw new Fail('unsafe', dest);
        if (tree.get(dest) !== null) throw new Fail('exists', dest);
        const plus: string[] = [];
        for (const h of hunks) for (const op of h.body) if (op.kind === 'add') plus.push(op.text);
        let noEol = false;
        for (const h of hunks) {
          for (let j = 0; j < h.body.length; j += 1) {
            if (h.body[j]!.kind === 'add') noEol = h.body[j + 1] !== undefined && h.body[j + 1]!.kind === 'bs';
          }
        }
        tree.now.set(dest, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      });
    } else if (isDelete) {
      const src = oldPath!;
      edits.push((tree) => {
        if (!safe(src)) throw new Fail('unsafe', src);
        if (tree.get(src) === null) throw new Fail('missing', src);
        tree.now.set(src, null);
      });
    } else if (isMove) {
      const src = oldPath!;
      const dest = newPath!;
      edits.push((tree) => {
        if (!safe(src)) throw new Fail('unsafe', src);
        if (!safe(dest)) throw new Fail('unsafe', dest);
        const before = tree.get(src);
        if (before === null) throw new Fail('missing', src);
        if (tree.get(dest) !== null) throw new Fail('exists', dest);
        const st = applyHunks(splitFile(before), hunks, strict, src);
        tree.now.set(src, null);
        tree.now.set(dest, joinFile(st));
        moves.push([src, dest]);
      });
    } else {
      const src = oldPath!;
      edits.push((tree) => {
        if (!safe(src)) throw new Fail('unsafe', src);
        const before = tree.get(src);
        if (before === null) throw new Fail('missing', src);
        const st = applyHunks(splitFile(before), hunks, strict, src);
        tree.now.set(src, joinFile(st));
      });
    }
  }
  return edits;
}

/** The edits of SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean, _moves: [string, string][]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const st = splitFile(before);
      const found = firstTier(st.lines, oldLines, strict, 0);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const ops: Op[] = [
        ...oldLines.map((t): Op => ({ kind: 'del', text: t })),
        ...newLines.map((t): Op => ({ kind: 'add', text: t })),
      ];
      const n = buildNew(st.lines, pos, ops, found.tier);
      const out = [...st.lines.slice(0, pos), ...n, ...st.lines.slice(pos + oldLines.length)];
      tree.now.set(p, joinFile({ lines: out, br: st.br, final: st.final }));
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor, its body lines, and whether it is anchored to the end of the file. */
interface Chunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

/** The edits of a V4A patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const secLines: { text: string; idx: number }[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      secLines.push({ text: l, idx: j });
      j += 1;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, idx } of secLines) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.idx + 1}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (secLines.length > 0 && secLines[0]!.text.startsWith('*** Move to: ')) {
        moveTo = secLines[0]!.text.slice(13).trim();
        k = 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (; k < secLines.length; k += 1) {
        const { text, idx } = secLines[k]!;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, ops: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, ops: [], eof: false };
            chunks.push(cur);
          }
          cur.ops.push(bodyOp(text));
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      const p = path;
      const dest = moveTo;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (dest !== null && !safe(dest)) throw new Fail('unsafe', dest);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (dest !== null && tree.get(dest) !== null) throw new Fail('exists', dest);
        let st = splitFile(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const at = firstTierSingle(st.lines, chunk.anchor, strict, cursor);
            if (at === null) throw new Fail('no-match', p);
            cursor = at + 1;
          }
          const ops = chunk.ops.filter((o) => o.kind !== 'bs');
          const o = ops.filter((x) => x.kind !== 'add').map((x) => x.text);
          if (o.length === 0) {
            const at = chunk.eof ? st.lines.length : cursor;
            const n = buildNew(st.lines, at, ops, 0);
            st = { lines: [...st.lines.slice(0, at), ...n, ...st.lines.slice(at)], br: st.br, final: st.final };
            cursor = at + n.length;
            continue;
          }
          const found = firstTier(st.lines, o, strict, cursor);
          if (found === null) throw new Fail('no-match', p);
          let pos: number | undefined = found.positions[0];
          if (chunk.eof) {
            pos = found.positions.find((q) => q + o.length === st.lines.length);
            if (pos === undefined) throw new Fail('no-match', p);
          }
          const n = buildNew(st.lines, pos, ops, found.tier);
          st = { lines: [...st.lines.slice(0, pos), ...n, ...st.lines.slice(pos + o.length)], br: st.br, final: st.final };
          cursor = pos + n.length;
        }
        const out = joinFile(st);
        if (dest !== null) {
          tree.now.set(p, null);
          tree.now.set(dest, out);
          moves.push([p, dest]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict, moves)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict, moves)
            : v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const sorted = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const movedTo = new Map<string, string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      movedTo.set(newP, oldP);
    }
  }
  const movedFrom = new Set(movedTo.values());
  const rows: string[] = [];
  const rowKeys: string[] = [];
  for (const p of sorted) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null && movedTo.has(p)) continue;
    if (now === null && movedFrom.has(p)) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    rowKeys.push(p);
  }
  for (const [newP, oldP] of movedTo) {
    rows.push(`R ${oldP} -> ${newP}`);
    rowKeys.push(newP);
  }
  const order = rows.map((_, ix) => ix).sort((a, b) => Buffer.compare(Buffer.from(rowKeys[a]!), Buffer.from(rowKeys[b]!)));
  const orderedRows = order.map((ix) => rows[ix]!);
  for (const p of sorted) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...orderedRows, `ok: ${orderedRows.length} ${orderedRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
