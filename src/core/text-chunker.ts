/**
 * Splits text into chunks suitable for sending as Discord messages.
 *
 * Behavior is a port of the C# `TextChunker.ChunkForDiscord`:
 *  - Default cap is 1900 chars (under Discord's 2000 limit, leaving headroom).
 *  - Prefers splitting on the last newline within the window.
 *  - Avoids tiny chunks (<100 chars in) by falling back to a hard cut.
 *  - Skips runs of empty lines at chunk boundaries.
 */
export function chunkForDiscord(text: string, maxLen = 1900): string[] {
  if (!text) return [];

  const normalized = text.replace(/\r\n/g, "\n");
  const result: string[] = [];

  let start = 0;
  while (start < normalized.length) {
    const remaining = normalized.length - start;
    const len = Math.min(maxLen, remaining);

    let split: number;
    if (len < remaining) {
      // Look for the last newline in [start, start+len-1]
      const window = normalized.slice(start, start + len);
      const lastNl = window.lastIndexOf("\n");
      const candidate = lastNl === -1 ? -1 : start + lastNl;
      if (candidate <= start + 100) {
        split = start + len;
      } else {
        split = candidate;
      }
    } else {
      split = start + len;
    }

    const part = normalized.slice(start, split).replace(/\s+$/, "");
    if (part.length > 0) result.push(part);

    start = split;
    while (start < normalized.length && normalized[start] === "\n") start++;
  }

  return result;
}

/**
 * Like {@link chunkForDiscord}, but keeps fenced code blocks (```) balanced
 * across chunk boundaries so every message renders as valid markdown on its
 * own. When a chunk would end inside an open fence, a closing ``` is appended
 * and the fence (with its language) is reopened at the start of the next chunk.
 */
export function chunkMarkdownForDiscord(text: string, maxLen = 1900): string[] {
  const chunks = chunkForDiscord(text, maxLen);
  const out: string[] = [];
  let reopen: string | null = null;
  for (const raw of chunks) {
    let body = reopen ? `${reopen}\n${raw}` : raw;
    let inFence = false;
    let header = "```";
    for (const line of body.split("\n")) {
      if (/^\s*```/.test(line)) {
        if (!inFence) {
          inFence = true;
          header = line.trim();
        } else {
          inFence = false;
        }
      }
    }
    if (inFence) {
      body = `${body}\n\`\`\``;
      reopen = header;
    } else {
      reopen = null;
    }
    out.push(body);
  }
  return out;
}
