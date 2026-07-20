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

/**
 * Copilot's writing-plans skill often wraps a "draft to paste" in an outer
 * ```markdown … ``` fence that itself contains ```powershell / ``` blocks.
 * Discord (and CommonMark) match fences by equal backtick count, so the inner
 * fences prematurely close the outer one and the whole block renders scrambled.
 *
 * This unwraps any fenced block whose info string is `markdown`/`md` — removing
 * just that block's opening and closing fence lines and keeping its inner
 * content — so the inner markdown (headers, links, ```powershell code blocks)
 * renders natively. Matching is done with a stack using the CommonMark rule
 * that a closing fence has no info string, which correctly pairs nested fences
 * even when they all use three backticks.
 */
export function unwrapMarkdownCodeFences(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const fenceRe = /^(\s*)(`{3,})(.*)$/;
  const stack: Array<{ index: number; lang: string }> = [];
  const remove = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const m = fenceRe.exec(lines[i]!);
    if (!m) continue;
    const info = m[3]!.trim();
    if (info) {
      // Fence with an info string = opening fence.
      stack.push({ index: i, lang: info.toLowerCase() });
    } else if (stack.length > 0) {
      // Bare fence with an open block = closing fence.
      const open = stack.pop()!;
      if (open.lang === "markdown" || open.lang === "md") {
        remove.add(open.index);
        remove.add(i);
      }
    } else {
      // Bare fence with nothing open = treat as an opening fence.
      stack.push({ index: i, lang: "" });
    }
  }
  if (remove.size === 0) return text;
  return lines.filter((_, i) => !remove.has(i)).join("\n");
}
