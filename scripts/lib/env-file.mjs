// Pure, zero-dependency helpers for reading and updating a `.env` file as DATA
// (never by sourcing/eval). Used by the cross-platform installer (scripts/setup.mjs)
// so there is ONE implementation of the risky parse/merge/serialize logic.
//
// Design goals:
//  - Update only the keys the installer manages; preserve every other line,
//    comment, order, and the file's newline style.
//  - Serialize values so they round-trip through the app's real `dotenv` parser
//    (see test/env-file.test.ts), including Windows paths that contain \n/\t traps.

/** Return the newline sequence used by `text` ("\r\n" if any CRLF, else "\n"). */
export function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Serialize a value for a `.env` line so `dotenv.parse` yields it back verbatim.
 * Prefers single quotes (literal in dotenv — safe for backslash/space paths).
 */
export function serializeValue(value) {
  const v = String(value);
  if (v === "") return "";
  // dotenv only needs quoting when unquoted parsing would change the value:
  //  - leading/trailing whitespace (dotenv trims it)
  //  - an inline comment (whitespace followed by '#')
  //  - a leading quote char (dotenv would treat the value as quoted)
  // A bare mid-value quote/hash/backslash round-trips fine unquoted — which is
  // also the ONLY safe encoding for Windows backslash paths (dotenv expands
  // \n/\r inside double quotes and can't carry a literal backslash).
  const needsQuote =
    /^\s|\s$/.test(v) || v.includes("#") || v[0] === '"' || v[0] === "'";
  if (!needsQuote) return v;
  if (!v.includes("'")) return `'${v}'`; // single quotes are literal in dotenv
  // Value has a single quote AND needs quoting: fall back to double quotes and
  // escape only real control chars (dotenv unescapes \n/\r/\t inside quotes).
  const esc = v
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${esc}"`;
}

const KEY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;

/**
 * Apply `updates` (object of key -> value) to `.env` text.
 * - A value of `null`/`undefined` DELETES every line for that key.
 * - Otherwise the key is replaced at its LAST occurrence (dotenv is last-wins),
 *   earlier duplicates of that managed key are dropped, and keys not present are
 *   appended. Unmanaged lines, comments, order, and newline style are preserved.
 */
export function applyEnvUpdates(originalText, updates) {
  const nl = detectNewline(originalText);
  const hadTrailingNewline = originalText.length === 0 || /\r?\n$/.test(originalText);
  const lines = originalText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "" && hadTrailingNewline) {
    lines.pop();
  }

  const keys = Object.keys(updates);
  const deleteKeys = new Set(keys.filter((k) => updates[k] === null || updates[k] === undefined));

  // Find the LAST line index for each managed key (dotenv reads last-wins).
  const lastIndex = {};
  lines.forEach((line, i) => {
    const m = line.match(KEY_RE);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[2])) lastIndex[m[2]] = i;
  });

  const out = [];
  lines.forEach((line, i) => {
    const m = line.match(KEY_RE);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[2])) {
      const key = m[2];
      if (deleteKeys.has(key)) return; // drop all occurrences
      if (i !== lastIndex[key]) return; // drop earlier duplicates; keep the last
      out.push(`${m[1]}${key}${m[3]}=${serializeValue(updates[key])}`);
      return;
    }
    out.push(line);
  });

  for (const key of keys) {
    if (deleteKeys.has(key)) continue;
    if (!(key in lastIndex)) out.push(`${key}=${serializeValue(updates[key])}`);
  }

  let result = out.join(nl);
  if (hadTrailingNewline) result += nl;
  return result;
}

/**
 * Parse `.env` text into a plain object (data only — never sourced). Mirrors the
 * subset of dotenv semantics the installer relies on for reading existing values.
 */
export function parseEnv(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(KEY_RE);
    if (!m) continue;
    let val = m[4].trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1);
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");
    } else {
      // Unquoted: strip an inline comment that follows whitespace.
      const hash = val.search(/\s#/);
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    result[m[2]] = val;
  }
  return result;
}
