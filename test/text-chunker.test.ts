import { describe, it, expect } from "vitest";
import { chunkForDiscord, chunkMarkdownForDiscord, unwrapMarkdownCodeFences } from "../src/core/text-chunker.js";

describe("chunkForDiscord", () => {
  it("returns empty for empty input", () => {
    expect(chunkForDiscord("")).toEqual([]);
  });

  it("returns single chunk for short text", () => {
    expect(chunkForDiscord("hello")).toEqual(["hello"]);
  });

  it("normalizes CRLF to LF", () => {
    expect(chunkForDiscord("a\r\nb")).toEqual(["a\nb"]);
  });
  it("splits on a newline boundary near the end of a window", () => {
    // 200 chars of 'a', a newline, 200 chars of 'b'; cap at 250 should split at the newline
    const text = "a".repeat(200) + "\n" + "b".repeat(200);
    const chunks = chunkForDiscord(text, 250);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(200));
    expect(chunks[1]).toBe("b".repeat(200));
  });

  it("hard-cuts when no good newline boundary exists", () => {
    const text = "x".repeat(2500);
    const chunks = chunkForDiscord(text, 1000);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.length).toBe(1000);
    expect(chunks[1]?.length).toBe(1000);
    expect(chunks[2]?.length).toBe(500);
  });

  it("avoids tiny tail chunks by ignoring near-start newlines", () => {
    // Newline at offset 50, then 1500 chars; cap=1900 should NOT split at offset 50.
    const text = "a".repeat(50) + "\n" + "b".repeat(1500);
    const chunks = chunkForDiscord(text);
    // Whole thing fits in 1900.
    expect(chunks.length).toBe(1);
  });

  it("skips runs of empty newlines between chunks", () => {
    const text = "a".repeat(300) + "\n\n\n" + "b".repeat(300);
    const chunks = chunkForDiscord(text, 350);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(300));
    expect(chunks[1]).toBe("b".repeat(300));
  });

  it("trims trailing whitespace from the end of each chunk", () => {
    // Internal whitespace must be preserved (matches C# TrimEnd semantics).
    expect(chunkForDiscord("hello   \nworld   ", 1000)).toEqual([
      "hello   \nworld",
    ]);
    // Force a split: tail of first chunk should have its trailing spaces stripped.
    const text = "a".repeat(40) + "   \n" + "b".repeat(40);
    const chunks = chunkForDiscord(text, 50);
    expect(chunks[0]?.endsWith(" ")).toBe(false);
  });
});

describe("chunkMarkdownForDiscord", () => {
  it("passes short markdown through unchanged", () => {
    expect(chunkMarkdownForDiscord("# Title\n- a\n- b")).toEqual(["# Title\n- a\n- b"]);
  });

  it("keeps a code fence balanced when it splits across chunks", () => {
    const code = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const text = `intro\n\`\`\`ts\n${code}\n\`\`\`\nouter`;
    const chunks = chunkMarkdownForDiscord(text, 400);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must have an even number of ``` fences (balanced on its own).
    for (const c of chunks) {
      const fences = c.split("\n").filter((l) => /^\s*```/.test(l)).length;
      expect(fences % 2).toBe(0);
    }
    // A mid-fence chunk reopens with the original language tag.
    expect(chunks.some((c) => c.includes("```ts"))).toBe(true);
  });
});

describe("unwrapMarkdownCodeFences", () => {
  it("leaves content without a markdown wrapper unchanged", () => {
    const t = "# Hi\n```powershell\naz login\n```\ndone";
    expect(unwrapMarkdownCodeFences(t)).toBe(t);
  });

  it("unwraps an outer ```markdown block containing nested ```powershell blocks", () => {
    const t = [
      "## 草稿",
      "```markdown",
      "## 安裝與啟動",
      "### 2. 登入",
      "```powershell",
      "az login",
      "```",
      "### 3. 檢查",
      "```powershell",
      "terraform plan",
      "```",
      "```",
      "## Todo",
    ].join("\n");
    const out = unwrapMarkdownCodeFences(t);
    const lines = out.split("\n");
    // The outer ```markdown wrapper and its matching closer are removed…
    expect(out).not.toContain("```markdown");
    // …but the two inner powershell fences survive (4 fence lines remain).
    expect(lines.filter((l) => /^```/.test(l)).length).toBe(4);
    // Every remaining fence is balanced (even count).
    expect(lines.filter((l) => /^```/.test(l)).length % 2).toBe(0);
    expect(out).toContain("## 安裝與啟動");
    expect(out).toContain("## Todo");
  });

  it("does not remove an unmatched (unclosed) markdown fence", () => {
    const t = "```markdown\n## still open";
    expect(unwrapMarkdownCodeFences(t)).toBe(t);
  });
});
