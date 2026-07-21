import { describe, it, expect } from "vitest";
import {
  computeModelChoices,
  modelChoiceLabel,
  formatContextWindow,
  type ModelInfo,
} from "../src/core/model-choices.js";

const catalog: ModelInfo[] = [
  { modelId: "gpt-5.4", name: "GPT-5.4" },
  { modelId: "claude-opus-4-8", name: "Opus 4.8", contextLimit: 1_000_000 },
  { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", contextLimit: 200_000 },
];

describe("formatContextWindow", () => {
  it("formats K / M and omits non-positive", () => {
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(1_500_000)).toBe("1.5M");
    expect(formatContextWindow(0)).toBe("");
    expect(formatContextWindow(-5)).toBe("");
  });
});

describe("modelChoiceLabel", () => {
  it("appends context when known, and degrades cleanly when not", () => {
    expect(modelChoiceLabel({ modelId: "claude-opus-4-8", name: "Opus 4.8", contextLimit: 1_000_000 })).toBe(
      "Opus 4.8 (claude-opus-4-8) • 1M ctx"
    );
    // no context (e.g. Copilot) → no ' • undefined ctx'
    expect(modelChoiceLabel({ modelId: "gpt-5.4", name: "GPT-5.4" })).toBe("GPT-5.4 (gpt-5.4)");
    expect(modelChoiceLabel({ modelId: "auto" })).toBe("auto");
  });
});

describe("computeModelChoices", () => {
  it("puts current + auto first and enriches current from the catalog (metadata retained)", () => {
    const out = computeModelChoices(catalog, "claude-opus-4-8", "");
    expect(out[0]).toEqual({ name: "Opus 4.8 (claude-opus-4-8) • 1M ctx", value: "claude-opus-4-8" });
    expect(out[1]).toEqual({ name: "auto", value: "auto" });
    // no duplicate of the current model further down
    expect(out.filter((c) => c.value === "claude-opus-4-8")).toHaveLength(1);
  });

  it("adds a bare current model not in the catalog", () => {
    const out = computeModelChoices(catalog, "some-new-model", "");
    expect(out[0]).toEqual({ name: "some-new-model", value: "some-new-model" });
  });

  it("empty query returns the full deduped list (<=25), auto included once", () => {
    const out = computeModelChoices(catalog, "gpt-5.4", "");
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.filter((c) => c.value === "auto")).toHaveLength(1);
    const ids = out.map((c) => c.value);
    expect(new Set(ids).size).toBe(ids.length); // no dupes
  });

  it("filters by substring over id and name", () => {
    expect(computeModelChoices(catalog, "gpt-5.4", "opus").map((c) => c.value)).toEqual(["claude-opus-4-8"]);
    expect(computeModelChoices(catalog, "gpt-5.4", "sonnet").map((c) => c.value)).toEqual(["claude-sonnet-4-6"]);
  });

  it("keeps values raw and skips ids longer than Discord's 100-char limit", () => {
    const longId = "x".repeat(101);
    const out = computeModelChoices([{ modelId: longId, name: "Too Long" }, ...catalog], "gpt-5.4", "");
    expect(out.every((c) => c.value.length <= 100)).toBe(true);
    expect(out.some((c) => c.value === longId)).toBe(false);
    // a normal id is returned verbatim (not sliced)
    expect(out.some((c) => c.value === "claude-opus-4-8")).toBe(true);
  });
});
