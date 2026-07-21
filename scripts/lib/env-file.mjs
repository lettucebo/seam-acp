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
  // Quote when the value has whitespace, a hash, or a quote char; otherwise a
  // bare value (incl. Windows backslash paths) round-trips fine unquoted.
  const needsQuote = /[\s#"']/.test(v);
  if (!needsQuote) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value contains a single quote. Double-quote and escape the sequences
  // dotenv unescapes inside double quotes.
  const esc = v
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${esc}"`;
}

const KEY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/;

/**
 * Apply `updates` (object of key -> value) to `.env` text.
 * Existing managed keys are replaced in place; unmanaged lines, comments, order,
 * and newline style are preserved; keys not present are appended at the end.
 */
export function applyEnvUpdates(originalText, updates) {
  const nl = detectNewline(originalText);
  const hadTrailingNewline = originalText.length === 0 || /\r?\n$/.test(originalText);
  const lines = originalText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "" && hadTrailingNewline) {
    lines.pop();
  }

  const remaining = { ...updates };
  const out = lines.map((line) => {
    const m = line.match(KEY_RE);
    if (m && Object.prototype.hasOwnProperty.call(remaining, m[2])) {
      const key = m[2];
      const rendered = `${m[1]}${key}${m[3]}=${serializeValue(remaining[key])}`;
      delete remaining[key];
      return rendered;
    }
    return line;
  });

  for (const key of Object.keys(remaining)) {
    out.push(`${key}=${serializeValue(remaining[key])}`);
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
