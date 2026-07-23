import { describe, it, expect } from "vitest";
import { parseContextUsage } from "../src/core/context-usage.js";

describe("parseContextUsage", () => {
  it("parses the current k/k format (with % noise and a model prefix)", () => {
    expect(parseContextUsage("claude-opus-4.8 · 24k/264k tokens (9%)")).toEqual({
      used: 24000,
      size: 264000,
    });
  });

  it("parses a large M window (forward-compat once long-context activates)", () => {
    expect(parseContextUsage("1.1M / 1M tokens")).toEqual({ used: 1_100_000, size: 1_000_000 });
  });

  it("parses raw comma-formatted token counts", () => {
    expect(parseContextUsage("24,000 / 264,000 tokens")).toEqual({ used: 24000, size: 264000 });
  });

  it("parses mixed units per side", () => {
    expect(parseContextUsage("24k / 1M tokens")).toEqual({ used: 24000, size: 1_000_000 });
  });

  it("returns null when there is no <used>/<size> tokens pattern", () => {
    expect(parseContextUsage("Send a message first to see context usage.")).toBeNull();
    expect(parseContextUsage("")).toBeNull();
  });

  it("returns null when the window size is zero (avoids divide-by-zero downstream)", () => {
    expect(parseContextUsage("0k/0k tokens")).toBeNull();
  });
});
