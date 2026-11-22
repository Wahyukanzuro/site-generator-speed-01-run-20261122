// solve.js — a faster drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Pure Node 22, stdlib only, no WebAssembly, no native addon, no prebuilt binary.
// Reimplements vendor/makefun-site/ (index.js + lib/*.js) exactly: where the README and the
// reference code differ, the code wins. Output is 100% identical as a JSON value and
// deterministic byte-for-byte across runs. All caches are created fresh inside run()
// (a local Map) and discarded when it returns — nothing is memoized across run() calls.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
export const REPORT_FILE = 'build-report.txt';

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- fast HTML escape (hotspot #1) ----
// Reference: text.replace(/[&<>"']/g, c => ESCAPES[c]).
// Fast path: a linear charCodeAt scan; if the string holds none of & < > " ' it is
// returned unchanged with ZERO allocation. Otherwise the result is built with slice()
// between special characters (not per-character concat).
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(text) {
  let i = 0;
  const n = text.length;
  // Fast scan for the first special char.
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  // Build with slices between specials.
  let out = text.slice(0, i);
  for (; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else {
      // Copy the run up to the next special char in one slice.
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
        j++;
      }
      out += text.slice(i, j);
      i = j - 1;
    }
  }
  return out;
}

// ---- slugify (reference: text.js) ----
// Reference: NFKD, drop combining marks (\p{M}), A-Z lowered, each run of chars other
// than a-z/0-9 one '-', none at either end, cut to 64 chars (a '-' left at the cut
// dropped), 'untitled' when nothing is left.
// Fast path: when every code unit is < 128 (pure ASCII), NFKD and the \p{M} strip are
// no-ops, so we run the char loop directly. Otherwise the full path is used.
const SLUG_MAX = 64;
function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
function slugifyFast(text) {
  // ASCII fast path (all code units < 128). Returns null when a non-ASCII unit is met.
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return null;
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32; // A-Z -> a-z
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
// Per-run memoized slugify. `memo` is a Map created fresh inside run() — never shared.
function slugifyMemo(text, memo) {
  let v = memo.get(text);
  if (v !== undefined) return v;
  v = slugifyFast(text);
  if (v === null) v = slugifySlow(text);
  memo.set(text, v);
  return v;
}

/** `slug` made unique against `taken` (and added to it): first of slug, slug-2, slug-3... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---- whitespace test matching JS /\s/ (for wordsOf) ----
// JS \s = [\f\n\r\t\v\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]
function isSpace(code) {
  return (
    code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 160 || code === 5760 || (code >= 8192 && code <= 8202) ||
    code === 8239 || code === 8287 || code === 12288 || code === 8232 || code === 8233 || code === 65279
  );
}

/** The words of a body: its runs of characters other than whitespace (reference wordsOf). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// ---- front matter (reference: lib/frontmatter.js) ----
// Zero-regex, zero-split reimplementation. Scans lines with indexOf('\n') so the
// body is never split; the body is the substring after the closing '---' line.

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isLowerAlnumHyphen(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    // Quoted.
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        const n = raw.charCodeAt(i + 1);
        if ((n !== 34 && n !== 92) || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += String.fromCharCode(n);
        i++;
      } else if (c === 34) return { error: 'a quoted string holds a stray quote' };
      else out += raw[i];
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
      }
    }
    const y = ok ? Number(raw.slice(0, 4)) : 0;
    const mo = ok ? Number(raw.slice(5, 7)) : 0;
    const d = ok ? Number(raw.slice(8, 10)) : 0;
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const parts = inner.split(',');
    const tags = new Array(parts.length);
    for (let k = 0; k < parts.length; k++) {
      const t = parts[k].trim();
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let j = 0; j < t.length; j++) {
        const c = t.charCodeAt(j);
        if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      tags[k] = t;
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    for (let i = 0; i < raw.length; i++) {
      if (!isLowerAlnumHyphen(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
    }
    return { value: raw };
  }
  if (key === 'slug') {
    // /^[a-z0-9]+(?:-[a-z0-9]+)*$/ and length <= 64.
    if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
    let prevHyphen = true; // start counts as "after a hyphen" so a leading '-' fails
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c === 45) {
        if (prevHyphen) return { error: 'key "slug": not a slug' };
        prevHyphen = true;
      } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
        prevHyphen = false;
      } else return { error: 'key "slug": not a slug' };
    }
    if (prevHyphen) return { error: 'key "slug": not a slug' };
    return { value: raw };
  }
  return { error: `unknown key "${key}"` };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  // First line must be exactly '---'.
  const firstNl = text.indexOf('\n');
  const firstLineEnd = firstNl === -1 ? text.length : firstNl;
  if (firstLineEnd !== 3 || text.charCodeAt(0) !== 45 || text.charCodeAt(1) !== 45 || text.charCodeAt(2) !== 45) {
    return { error: 'no front matter' };
  }
  // Find the closing '---' line.
  let close = -1;
  let lineStart = firstNl === -1 ? text.length : firstNl + 1;
  let lineNo = 1; // 0-based index of the line after the opening '---' is 1
  let closeLineStart = -1;
  let closeLineEnd = -1;
  while (lineStart <= text.length) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const len = lineEnd - lineStart;
    if (len === 3 && text.charCodeAt(lineStart) === 45 && text.charCodeAt(lineStart + 1) === 45 && text.charCodeAt(lineStart + 2) === 45) {
      close = lineNo;
      closeLineStart = lineStart;
      closeLineEnd = lineEnd;
      break;
    }
    if (nl === -1) break;
    lineStart = nl + 1;
    lineNo++;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Parse lines 1..close-1 (0-based line indices). Line numbers are 1-based from the opening '---'.
  lineStart = firstNl === -1 ? text.length : firstNl + 1;
  for (let i = 1; i < close; i++) {
    const nl = text.indexOf('\n', lineStart);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(lineStart, lineEnd);
    // Blank (spaces/tabs only) or comment (opens on '#') -> skip.
    let p = 0;
    while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
    if (p === line.length || line.charCodeAt(p) === 35) {
      lineStart = nl === -1 ? text.length : nl + 1;
      continue;
    }
    // Parse "key: value": key of [a-z_]+, ':', then either end-of-line or ' ' + rest.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    // Trim trailing spaces/tabs from raw.
    let rlen = raw.length;
    while (rlen > 0) {
      const c = raw.charCodeAt(rlen - 1);
      if (c === 32 || c === 9) rlen--;
      else break;
    }
    if (rlen !== raw.length) raw = raw.slice(0, rlen);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    lineStart = nl === -1 ? text.length : nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  // Body = text after the closing '---' line's newline (or '' if it is the last line).
  const bodyStart = closeLineEnd === text.length ? text.length : closeLineEnd + 1;
  return { data, body: text.slice(bodyStart) };
}

// ---- Markdown (reference: lib/markdown.js) ----
// Single-pass code-unit scanner: no body.split('\n'), no regex per line. Lines are
// located with indexOf('\n') and classified with charCodeAt. The word count
// (reading_minutes) is a single linear char scan over the body (replacing the
// reference's /\S+/g wordsOf pass); excerpt (first paragraph) and toc (h2/h3) are
// collected during the same render.

// Backslash-escapable characters: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE = new Uint8Array(128);
for (const ch of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[ch] = 1;

/** Count \S+ runs in src (whole body) with one linear char scan. */
/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href.
 * indexOf variant: the next special char (\, `, *, [) is found with native C++ SIMD
 * `indexOf` (memchr) instead of a per-character JS scan, so long plain runs are
 * skipped in one big slice. A special that does not form a valid construct is left
 * as a plain char (start is rewound to it) and scanning resumes after it.
 */
/** One module-level RegExp matching every char that needs special handling in inline
 * text: the Markdown construct starters (\, `, *, [) and the HTML specials (&, <, >,
 * ", '). V8's Irregexp finds the next one in a single pass, so plain text between
 * specials is pushed as-is (no escapeHtml call — it is guaranteed clean). The `g`
 * flag + explicit lastIndex make exec() re-entrant-safe across recursive inlineTo
 * calls, as long as lastIndex is set before every exec. */
const RE_INLINE = /[\\`*\[&<>"']/g;

function inlineTo(s, env, out) {
  const n = s.length;
  let pos = 0; // start of the unprocessed remainder
  while (pos < n) {
    RE_INLINE.lastIndex = pos;
    const m = RE_INLINE.exec(s);
    if (m === null) {
      // No more specials: the rest is plain (no HTML/Markdown specials), push as-is.
      out.push(pos === 0 ? s : s.slice(pos));
      break;
    }
    const idx = m.index;
    if (idx > pos) out.push(s.slice(pos, idx));
    const c = s.charCodeAt(idx);
    if (c === 38) { out.push('&amp;'); pos = idx + 1; continue; } // &
    if (c === 60) { out.push('&lt;'); pos = idx + 1; continue; } // <
    if (c === 62) { out.push('&gt;'); pos = idx + 1; continue; } // >
    if (c === 34) { out.push('&quot;'); pos = idx + 1; continue; } // "
    if (c === 39) { out.push('&#39;'); pos = idx + 1; continue; } // '
    if (c === 92) {
      // Backslash.
      if (idx + 1 < n && ESCAPABLE[s.charCodeAt(idx + 1)] === 1) {
        const ec = s.charCodeAt(idx + 1);
        if (ec === 38) out.push('&amp;');
        else if (ec === 60) out.push('&lt;');
        else if (ec === 62) out.push('&gt;');
        else if (ec === 34) out.push('&quot;');
        else if (ec === 39) out.push('&#39;');
        else out.push(s[idx + 1]);
        pos = idx + 2;
      } else {
        // Not a valid escape: the backslash is a plain char. Push it and continue.
        out.push('\\');
        pos = idx + 1;
      }
      continue;
    }
    if (c === 96) {
      // Backtick: code span.
      const k = s.indexOf('`', idx + 1);
      if (k > idx + 1) {
        out.push('<code>', escapeHtml(s.slice(idx + 1, k)), '</code>');
        pos = k + 1;
      } else {
        out.push('`');
        pos = idx + 1;
      }
      continue;
    }
    if (c === 42) {
      // Asterisk: strong or em.
      if (s.charCodeAt(idx + 1) === 42) {
        const k = findUnescaped(s, '**', idx + 2);
        if (k > idx + 2) {
          out.push('<strong>'); inlineTo(s.slice(idx + 2, k), env, out); out.push('</strong>');
          pos = k + 2;
        } else {
          out.push('**');
          pos = idx + 2;
        }
      } else {
        const k = findSingleStar(s, idx + 1);
        if (k > idx + 1) {
          out.push('<em>'); inlineTo(s.slice(idx + 1, k), env, out); out.push('</em>');
          pos = k + 1;
        } else {
          out.push('*');
          pos = idx + 1;
        }
      }
      continue;
    }
    // c === 91: '[' link.
    const k = findUnescaped(s, ']', idx + 1);
    const m2 = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m2 === -1 ? '' : s.slice(k + 2, m2);
    let hasWs = false;
    if (target !== '') {
      for (let t2 = 0; t2 < target.length; t2++) {
        if (isSpace(target.charCodeAt(t2))) { hasWs = true; break; }
      }
    }
    if (target !== '' && !hasWs) {
      out.push('<a href="', escapeHtml(env.link(target)), '">'); inlineTo(s.slice(idx + 1, k), env, out); out.push('</a>');
      pos = m2 + 1;
    } else {
      out.push('[');
      pos = idx + 1;
    }
  }
}

// ---- line classification helpers (operate on index ranges, no substrings) ----
function isBlankLine(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Fence open: "```" + lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null.
function fenceOpenLang(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let i = s + 3;
  while (i < e) {
    const c = src.charCodeAt(i);
    const ok = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
    if (!ok) break;
    i++;
  }
  const lang = src.slice(s + 3, i);
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}
function isFenceClose(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Heading: 1-6 '#', >=1 space/tab, then text (trailing spaces/tabs dropped). Null when no text.
function headingOfLine(src, s, e) {
  let depth = 0;
  while (depth < 6 && s + depth < e && src.charCodeAt(s + depth) === 35) depth++;
  if (depth === 0) return null;
  let i = s + depth;
  if (i >= e || (src.charCodeAt(i) !== 32 && src.charCodeAt(i) !== 9)) return null;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  let textEnd = e;
  while (textEnd > i && (src.charCodeAt(textEnd - 1) === 32 || src.charCodeAt(textEnd - 1) === 9)) textEnd--;
  if (textEnd === i) return null;
  return { depth, text: src.slice(i, textEnd) };
}
function isHRLine(src, s, e) {
  if (e - s < 3) return false;
  const c0 = src.charCodeAt(s);
  const c1 = src.charCodeAt(s + 1);
  const c2 = src.charCodeAt(s + 2);
  const dash = c0 === 45 && c1 === 45 && c2 === 45;
  const star = c0 === 42 && c1 === 42 && c2 === 42;
  if (!dash && !star) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}
// Whether `line` ends a paragraph: blank, fence open, heading, or thematic break.
function endsParagraph(src, s, e) {
  return isBlankLine(src, s, e) || fenceOpenLang(src, s, e) !== null || headingOfLine(src, s, e) !== null || isHRLine(src, s, e);
}
// Trim spaces/tabs at both ends of [s, e); returns the trimmed string.
function trimSlice(src, s, e) {
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return src.slice(s, e);
}

/**
 * `src` rendered: HTML (each block on its own lines, a "\n" after the last), table of
 * contents (level 2/3 headings), excerpt (first paragraph's inline HTML, or ""),
 * and word count (for reading_minutes). `ctx` carries the per-run slug memo and the
 * link resolver env.
 */
/** One output array reused across every Markdown body render in a case.
 * renderMarkdown resets it, pushes block HTML directly into it (inline content via
 * inlineTo), joins it once, then resets it. No per-body `blocks` array. */
const MD_OUT = [];

function renderMarkdown(src, env, ctx) {
  MD_OUT.length = 0;
  const toc = [];
  let excerpt = null;
  let words = 0; // counted inline as lines are consumed (no separate pass)
  const ids = new Set();
  const n = src.length;
  let pos = 0;
  const lineEnd = (from) => {
    const nl = src.indexOf('\n', from);
    return nl === -1 ? n : nl;
  };
  // Count \S+ runs in src[s..e). One closure (JIT-inlined); called per consumed line.
  // ASCII fast path: a plain letter/digit (33..126) is never whitespace.
  const cw = (a, b) => {
    let inW = false;
    for (let i = a; i < b; i++) {
      const c = src.charCodeAt(i);
      if (c > 32 && c < 127) { if (!inW) { inW = true; words++; } }
      else if (isSpace(c)) inW = false;
      else if (!inW) { inW = true; words++; }
    }
  };
  while (pos < n) {
    const s = pos;
    const e = lineEnd(pos);
    const next = e === n ? n : e + 1;
    cw(s, e);
    if (isBlankLine(src, s, e)) {
      pos = next;
      continue;
    }
    const fenceLang = fenceOpenLang(src, s, e);
    if (fenceLang !== null) {
      const bodyLines = [];
      pos = next;
      while (pos < n) {
        const ls = pos;
        const le = lineEnd(pos);
        const ln = le === n ? n : le + 1;
        cw(ls, le);
        if (isFenceClose(src, ls, le)) {
          pos = ln;
          break;
        }
        bodyLines.push(src.slice(ls, le));
        pos = ln;
      }
      const cls = fenceLang === '' ? '' : ` class="language-${escapeHtml(fenceLang)}"`;
      MD_OUT.push(`<pre><code${cls}>`);
      for (let k = 0; k < bodyLines.length; k++) { MD_OUT.push(escapeHtml(bodyLines[k]), '\n'); }
      MD_OUT.push('</code></pre>', '\n');
      continue;
    }
    const heading = headingOfLine(src, s, e);
    if (heading !== null) {
      const id = uniqueSlug(slugifyMemo(heading.text, ctx.slugMemo), ids);
      MD_OUT.push(`<h${heading.depth} id="${id}">`);
      const hs = MD_OUT.length;
      inlineTo(heading.text, env, MD_OUT);
      const he = MD_OUT.length;
      MD_OUT.push(`</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: MD_OUT.slice(hs, he).join('') });
      pos = next;
      continue;
    }
    if (isHRLine(src, s, e)) {
      MD_OUT.push('<hr>', '\n');
      pos = next;
      continue;
    }
    if (src.charCodeAt(s) === 62) {
      // Blockquote: lines opening on '>', each with '>' and one space dropped, trimmed, empties dropped.
      const qlines = [];
      pos = next;
      // First line.
      let q = s + 1;
      if (q < e && src.charCodeAt(q) === 32) q++;
      const first = trimSlice(src, q, e);
      if (first !== '') qlines.push(first);
      while (pos < n && src.charCodeAt(pos) === 62) {
        const ls = pos;
        const le = lineEnd(pos);
        const ln = le === n ? n : le + 1;
        cw(ls, le);
        let qq = ls + 1;
        if (qq < le && src.charCodeAt(qq) === 32) qq++;
        const t = trimSlice(src, qq, le);
        if (t !== '') qlines.push(t);
        pos = ln;
      }
      if (qlines.length === 0) {
        MD_OUT.push('<blockquote>\n</blockquote>', '\n');
      } else {
        MD_OUT.push('<blockquote>\n<p>');
        inlineTo(qlines.join('\n'), env, MD_OUT);
        MD_OUT.push('</p>\n</blockquote>', '\n');
      }
      continue;
    }
    // List: '- ' / '* ' bullet, or digits + '. ' ordered.
    const c0 = src.charCodeAt(s);
    const c1 = e > s + 1 ? src.charCodeAt(s + 1) : -1;
    let isBullet = false;
    let isOrdered = false;
    let ordNum = 0;
    if ((c0 === 45 || c0 === 42) && c1 === 32) isBullet = true;
    else if (c0 >= 48 && c0 <= 57) {
      let i = s;
      let num = 0;
      let digits = 0;
      while (i < e && digits < 9 && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) {
        num = num * 10 + (src.charCodeAt(i) - 48);
        digits++;
        i++;
      }
      if (digits >= 1 && digits <= 9 && i + 1 < e && src.charCodeAt(i) === 46 && src.charCodeAt(i + 1) === 32) {
        // Must be exactly the digits then '. ' — but if there are MORE digits (>=10), the
        // reference's \d{1,9} matches 9 then needs '.'; a 10th digit breaks it. Our loop
        // stops at 9 digits; if the 10th char is a digit, this is NOT an ordered item.
        if (i < e && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) {
          // 10th digit present — the reference would fail to match (needs '.' after 9 digits).
          // Fall through to paragraph.
        } else {
          isOrdered = true;
          ordNum = num;
        }
      }
    }
    if (isBullet || isOrdered) {
      const items = [];
      let cur = null; // current item's parts array
      let startNum = 0;
      let first = true;
      while (pos < n) {
        const ls = pos;
        const le = lineEnd(pos);
        const ln = le === n ? n : le + 1;
        // Try the same marker.
        let mText = null;
        if (isBullet) {
          const d0 = src.charCodeAt(ls);
          const d1 = le > ls + 1 ? src.charCodeAt(ls + 1) : -1;
          if ((d0 === 45 || d0 === 42) && d1 === 32) mText = trimSlice(src, ls + 2, le);
        } else {
          let i = ls;
          let num = 0;
          let digits = 0;
          while (i < le && digits < 9 && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) {
            num = num * 10 + (src.charCodeAt(i) - 48);
            digits++;
            i++;
          }
          if (digits >= 1 && digits <= 9 && i + 1 < le && src.charCodeAt(i) === 46 && src.charCodeAt(i + 1) === 32) {
            if (!(i < le && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57)) {
              mText = trimSlice(src, i + 2, le);
              if (first) startNum = num;
            }
          }
        }
        if (mText !== null) {
          cur = [mText];
          items.push(cur);
          first = false;
          if (ls !== s) cw(ls, le);
          pos = ln;
          continue;
        }
        // Continuation: 2+ spaces then a non-space.
        if (cur !== null && le - ls >= 3 && src.charCodeAt(ls) === 32 && src.charCodeAt(ls + 1) === 32) {
          let q = ls + 2;
          while (q < le && src.charCodeAt(q) === 32) q++;
          if (q < le) {
            cur.push(trimSlice(src, ls, le));
            if (ls !== s) cw(ls, le);
            pos = ln;
            continue;
          }
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      MD_OUT.push(open, '\n');
      for (let k = 0; k < items.length; k++) {
        MD_OUT.push('<li>');
        inlineTo(items[k].join('\n'), env, MD_OUT);
        MD_OUT.push('</li>', '\n');
      }
      MD_OUT.push(`</${tag}>`, '\n');
      continue;
    }
    // Paragraph: this line and following lines until a paragraph-ending line.
    // Clean fast path: if every line is clean (no leading/trailing space/tab), the
    // whole paragraph is one contiguous range [paraStart, paraEnd) in the body — a
    // single body.slice(paraStart, paraEnd) goes to inlineTo (no per-line slice, no
    // plines array). Only dirty paragraphs fall back to the plines path.
    const paraStart = s;
    let paraEnd = e;
    let clean = !(src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9 || src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9);
    let p0 = clean ? null : trimSlice(src, s, e);
    let plines = null; // only allocated when a line needs trimming
    pos = next;
    while (pos < n) {
      const ls = pos;
      const le = lineEnd(pos);
      const ln = le === n ? n : le + 1;
      if (endsParagraph(src, ls, le)) break;
      if (clean && (src.charCodeAt(ls) === 32 || src.charCodeAt(ls) === 9 || src.charCodeAt(le - 1) === 32 || src.charCodeAt(le - 1) === 9)) {
        // First dirty line: materialise plines from the clean prefix.
        clean = false;
        plines = [];
        let q = paraStart;
        while (q < paraEnd) {
          const qe = lineEnd(q);
          plines.push(src.slice(q, qe));
          q = qe === n ? n : qe + 1;
        }
        plines.push(trimSlice(src, ls, le));
      } else if (clean) {
        paraEnd = le;
      } else {
        if (plines === null) plines = [p0];
        plines.push(trimSlice(src, ls, le));
      }
      cw(ls, le);
      pos = ln;
    }
    MD_OUT.push('<p>');
    const exStart = MD_OUT.length;
    if (clean) inlineTo(src.slice(paraStart, paraEnd), env, MD_OUT);
    else inlineTo(plines === null ? p0 : plines.join('\n'), env, MD_OUT);
    const exEnd = MD_OUT.length;
    MD_OUT.push('</p>', '\n');
    if (excerpt === null) excerpt = MD_OUT.slice(exStart, exEnd).join('');
  }
  const html = MD_OUT.join('');
  MD_OUT.length = 0;
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---- Templates (reference: lib/template.js) ----
// The dialect: {{ path }} (escaped), {{{ path }}} (raw), {% for x in path %}…{% endfor %},
// {% if path %} / {% if not path %} with optional {% else %}, {% include "name" %}.
// A {% %} tag alone on its line takes its whole line, newline included. Includes nest at
// most 8 deep. Parsed once per run into a tree, then COMPILED to a JS function via
// new Function (JIT): the dispatch is resolved at compile time, the output is built in
// an array joined once, escapeHtml/textOf are inlined via the helpers object H, and a
// for loop mutates ONE scope object (save/restore) instead of allocating a scope per
// element. All template semantics (lookup, textOf, truthy, include depth) match the
// reference exactly.

export const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  // /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
  if (text === '') throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  const parts = text.split('.');
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p === '') throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    const c0 = p.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    for (let i = 1; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
    }
  }
  return parts;
}

function isSpaceOrTabOnly(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaceOrTabOnly(src, lineStart, open) && isSpaceOrTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Match a FOR tag: "for <name> in <path>" (name [A-Za-z_][A-Za-z0-9_]*, path one \S+ token).
function matchFor(tag) {
  if (!tag.startsWith('for ')) return null;
  let i = 4;
  const c0 = tag.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  let j = i + 1;
  while (j < tag.length) {
    const c = tag.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  const name = tag.slice(i, j);
  if (!tag.startsWith(' in ', j)) return null;
  const path = tag.slice(j + 4);
  if (path === '') return null;
  for (let k = 0; k < path.length; k++) {
    if (isSpace(path.charCodeAt(k))) return null;
  }
  return { name, path };
}
// Match an IF tag: "if [not ]<path>" (path one \S+ token).
function matchIf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  if (rest === '') return null;
  for (let k = 0; k < rest.length; k++) {
    if (isSpace(rest.charCodeAt(k))) return null;
  }
  return { not, path: rest };
}
// Match an INCLUDE tag: 'include "<name>"' (name [a-z0-9-]+).
function matchInclude(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return { name };
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = matchFor(tag)) !== null) {
        const node = { kind: 'for', name: m.name, path: pathOf(name, m.path), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = matchIf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.path), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = matchInclude(tag)) !== null) body.push({ kind: 'include', name: m.name });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in a flat scope object S (its first name an own property, then own properties). */
function lookupFlat(S, path) {
  if (!Object.hasOwn(S, path[0])) return undefined;
  let v = S[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Helpers the compiled template functions call (passed as H).
const TEMPLATE_HELPERS = { esc: escapeHtml, textOf, truthy, lookup: lookupFlat };

/** JS expression for a template path (array of identifiers): direct property access
 * with null-safe chaining, e.g. ["page","title"] -> "S.page?.title". Replaces the
 * runtime H.lookup(S, path) call (path split + hasOwn per segment). Segments are
 * validated identifiers (pathOf), so dot notation is safe. */
function pathExpr(path) {
  let e = 'S';
  for (let k = 0; k < path.length; k++) e += (k === 0 ? '.' : '?.') + path[k];
  return e;
}

/** Fields that carry a pre-escaped `_esc` sibling on site/page/tag/card/item/link. */
const ESC_FIELDS = { title: 1, name: 1, url: 1, summary: 1, base_url: 1 };

/** JS expression for an ESCAPED `{{ path }}`: if path is [obj, field] with field in
 * ESC_FIELDS, emit the pre-escaped sibling (no H.esc call); else the normal escaped
 * access. Returns the full `H.textOf(...)` / `H.esc(H.textOf(...))` expression. */
function escVarExpr(path) {
  if (path.length === 2 && ESC_FIELDS[path[1]] === 1) {
    return `H.textOf(S.${path[0]}?.${path[1]}_esc)`;
  }
  return `H.esc(H.textOf(${pathExpr(path)}))`;
}

/** JS code for `nodes` (a node array), appended to `out`. `ctr` yields unique ids.
 * The compiled function pushes into the SHARED output array `O` (a parameter, not
 * a per-call local), so `{% include %}` passes the same `O` down instead of
 * allocating a fresh array + join per include. Consecutive push arguments are
 * batched into one multi-argument `O.push(a, b, c)` call. */
function genNodes(nodes, ctr, out) {
  let pend = []; // pending push arguments, flushed as one O.push(a, b, c)
  const flush = () => {
    if (pend.length > 0) {
      out.push(`O.push(${pend.join(',')});`);
      pend = [];
    }
  };
  for (const n of nodes) {
    if (n.kind === 'text') {
      pend.push(JSON.stringify(n.text));
    } else if (n.kind === 'var') {
      pend.push(escVarExpr(n.path));
    } else if (n.kind === 'raw') {
      pend.push(`H.textOf(${pathExpr(n.path)})`);
    } else if (n.kind === 'if') {
      flush();
      out.push(`if(H.truthy(${pathExpr(n.path)})!==${n.not}){`);
      genNodes(n.then, ctr, out);
      if (n.else !== null) {
        out.push('}else{');
        genNodes(n.else, ctr, out);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      flush();
      const k = ctr.next++;
      const nm = JSON.stringify(n.name);
      out.push(`{const A${k}=${pathExpr(n.path)};if(Array.isArray(A${k})){`);
      out.push(`const _ox${k}=S[${nm}];const _hx${k}=Object.hasOwn(S,${nm});const _ol${k}=S["loop"];const _hl${k}=Object.hasOwn(S,"loop");`);
      out.push(`const _L${k}={index:0,first:false,last:false,length:A${k}.length};`);
      out.push(`for(let _i${k}=0;_i${k}<A${k}.length;_i${k}++){S[${nm}]=A${k}[_i${k}];S["loop"]=_L${k};_L${k}.index=_i${k}+1;_L${k}.first=_i${k}===0;_L${k}.last=_i${k}===A${k}.length-1;`);
      genNodes(n.body, ctr, out);
      out.push('}');
      out.push(`if(_hx${k})S[${nm}]=_ox${k};else delete S[${nm}];if(_hl${k})S["loop"]=_ol${k};else delete S["loop"];}}`);
    } else if (n.kind === 'include') {
      flush();
      const k = ctr.next++;
      out.push(`if(D<${INCLUDE_DEPTH}){const _f${k}=T.get(${JSON.stringify(n.name)});if(_f${k})_f${k}(S,T,D+1,H,O);}`);
    }
  }
  flush();
}

/** Stage A — compile-time include expansion. Returns a new node array with every
 * `{% include "name" %}` replaced by the named template's body (recursively expanded).
 * `asts` maps template name -> parsed node array. `depth` is the depth of the template
 * these nodes belong to (the layout is depth 0); an include at depth d expands iff
 * d < INCLUDE_DEPTH, and its inlined nodes live at depth d+1. A missing template or
 * an over-deep include expands to nothing — exactly like the runtime guard. */
function expandAst(nodes, asts, depth) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'include') {
      if (depth >= INCLUDE_DEPTH) continue;
      const t = asts.get(n.name);
      if (t === undefined) continue;
      const inner = expandAst(t, asts, depth + 1);
      for (let i = 0; i < inner.length; i++) out.push(inner[i]);
    } else if (n.kind === 'if') {
      out.push({ kind: 'if', not: n.not, path: n.path, then: expandAst(n.then, asts, depth), else: n.else === null ? null : expandAst(n.else, asts, depth) });
    } else if (n.kind === 'for') {
      out.push({ kind: 'for', name: n.name, path: n.path, body: expandAst(n.body, asts, depth) });
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Top-level scope variables that are identical on every page of a case. */
const INVARIANT_ROOTS = { site: 1, tags: 1, recent: 1 };

function pathIsInvariant(path, bound) {
  return INVARIANT_ROOTS[path[0]] === 1 || bound.has(path[0]);
}

function nodeIsInvariant(n, bound) {
  if (n.kind === 'text') return true;
  if (n.kind === 'var' || n.kind === 'raw') return pathIsInvariant(n.path, bound);
  if (n.kind === 'if') {
    if (!pathIsInvariant(n.path, bound)) return false;
    for (let i = 0; i < n.then.length; i++) if (!nodeIsInvariant(n.then[i], bound)) return false;
    if (n.else !== null) for (let i = 0; i < n.else.length; i++) if (!nodeIsInvariant(n.else[i], bound)) return false;
    return true;
  }
  if (n.kind === 'for') {
    if (!pathIsInvariant(n.path, bound)) return false;
    const b2 = new Set(bound);
    b2.add(n.name);
    for (let i = 0; i < n.body.length; i++) if (!nodeIsInvariant(n.body[i], b2)) return false;
    return true;
  }
  return false; // include nodes are gone after expandAst; anything else is variant
}

/** Stage C — collapse invariant node runs to pre-rendered static text. Walks `nodes`
 * (an expanded AST) and replaces each maximal run of consecutive invariant nodes with
 * a single `{ kind: 'text', text: <pre-rendered HTML> }` node. `invScope` is the
 * per-case invariant scope `{ site, tags, recent }`. Invariant `for`/`if` nodes are
 * pre-rendered as a whole (their loops/branches execute once, here), so the main
 * template function never re-runs them. Returns a new node array. */
function collapseInvariant(nodes, invScope) {
  const out = [];
  let i = 0;
  const bound = new Set();
  while (i < nodes.length) {
    if (!nodeIsInvariant(nodes[i], bound)) { out.push(nodes[i]); i++; continue; }
    // Maximal run of invariant nodes starting at i.
    let j = i;
    while (j < nodes.length && nodeIsInvariant(nodes[j], bound)) j++;
    const run = nodes.slice(i, j);
    const fn = compileTemplate(run);
    const buf = [];
    fn(invScope, null, 0, TEMPLATE_HELPERS, buf);
    const html = buf.join('');
    if (html !== '') out.push({ kind: 'text', text: html });
    i = j;
  }
  return out;
}

/** A parsed template's nodes compiled to a render function (S, T, D, H, O) => void.
 * It appends its output to the shared array `O`; the caller joins `O` once. */
function compileTemplate(nodes) {
  const ctr = { next: 0 };
  const out = [];
  genNodes(nodes, ctr, out);
  return new Function('S', 'T', 'D', 'H', 'O', out.join(''));
}

// ---- the build pipeline (reference: index.js, plugins in order) ----

/** A source file's content with "\r\n" and lone "\r" made "\n" (zero-copy when no '\r'). */
function normalizeLineEnds(content) {
  const r = content.indexOf('\r');
  if (r === -1) return content;
  const parts = [];
  let start = 0;
  for (let i = r; i < content.length; i++) {
    if (content.charCodeAt(i) === 13) {
      parts.push(content.slice(start, i));
      parts.push('\n');
      if (content.charCodeAt(i + 1) === 10) i++;
      start = i + 1;
    }
  }
  parts.push(content.slice(start));
  return parts.join('');
}

/** Whether `target` opens on a scheme: a letter, then letters/digits/+/-/. , then ':'. */
function hasScheme(target) {
  if (target.length < 2) return false;
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: normalizeLineEnds(f.content) });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugifyMemo(s.data.title, b.slugMemo), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  // Per-case cache of resolvePath results, keyed by (dir + '\0' + rel). The broken-link
  // recording is per source file (keyed by s.path), so it stays outside the cache.
  const pathCache = new Map();
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if (c0 === 47 || c0 === 35) return target; // '/' or '#'
        if (c0 === 104 && (target.startsWith('http:') || target.startsWith('https:'))) return target;
        if (hasScheme(target)) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        let path;
        if (rel === '') {
          path = null;
        } else {
          const pkey = dir + '\0' + rel;
          path = pathCache.get(pkey);
          if (path === undefined) {
            path = resolvePath(dir, rel);
            pathCache.set(pkey, path);
          }
        }
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, b);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugifyMemo(name, b.slugMemo);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugifyMemo(name, b.slugMemo);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugifyMemo(name, b.slugMemo);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, title_esc: escapeHtml(s.data.title), url: s.url, url_esc: escapeHtml(s.url), date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, name_esc: escapeHtml(t.name), slug: t.slug, url: t.url, url_esc: escapeHtml(t.url), count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    title_esc: escapeHtml(s.data.title),
    url: s.url,
    url_esc: escapeHtml(s.url),
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    summary_esc: escapeHtml(s.data.summary ?? ''),
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, name_esc: escapeHtml(t.name), slug: t.slug, url: t.url, url_esc: escapeHtml(t.url) })),
  };
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
/** One output array reused across every page render in a case (module-level, stable
 * capacity). render() resets its length to 0, calls the template with it, joins it,
 * then resets it again so it holds no references across cases. */
const PAGE_OUT = [];

function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, title_esc: escapeHtml(b.input.site.title), base_url: b.base, base_url_esc: escapeHtml(b.base) };
  const allTags = b.tags.map((t) => ({ name: t.name, name_esc: escapeHtml(t.name), slug: t.slug, url: t.url, url_esc: escapeHtml(t.url), count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  // Stages B/C: collapse each expanded AST's invariant runs (pre-rendered once per
  // case with the invariant scope) and compile the result. The layout functions
  // then only execute the variant (page/posts/pager/tag) parts per page.
  const invScope = { site, tags: allTags, recent };
  const templates = new Map();
  for (const [name, nodes] of b.templates) templates.set(name, compileTemplate(collapseInvariant(nodes, invScope)));
  // One context object per case, reused across all page renders (mutated, then reset).
  const ctx = { site, tags: allTags, recent, page: null, posts: null, pager: null, tag: null };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const keys = Object.keys(vars);
    for (let i = 0; i < keys.length; i++) ctx[keys[i]] = vars[keys[i]];
    PAGE_OUT.length = 0;
    fn(ctx, templates, 0, TEMPLATE_HELPERS, PAGE_OUT);
    const html = PAGE_OUT.join('');
    PAGE_OUT.length = 0;
    for (let i = 0; i < keys.length; i++) ctx[keys[i]] = null;
    return html;
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
const PIPELINE = [readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report];

/** One site's output tree: path -> text. */
export function build(input) {
  const asts = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Stage A: expand includes at AST level (each layout becomes one flat tree).
  const templateAsts = new Map();
  for (const [name, nodes] of asts) templateAsts.set(name, expandAst(nodes, asts, 0));
  const templates = templateAsts; // layouts() compiles these (after collapsing).
  let base = input.site.base_url;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 47) end--;
  base = base.slice(0, end);
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugMemo: new Map(),
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** The driver's entry: one case's input -> its output tree. */
export function run(input) {
  return build(input);
}
