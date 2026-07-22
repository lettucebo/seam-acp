import { describe, it, expect } from "vitest";
import {
  parseEffortOption,
  parseModelOptions,
  resolveEffortLevels,
} from "../src/core/config-options.js";

// Fixtures mirror the REAL `copilot --acp` session/new configOptions (v1.0.74-0).
const modelOption = {
  type: "select",
  id: "model",
  name: "Model",
  currentValue: "claude-sonnet-5",
  options: [
    { value: "auto", name: "Auto", description: "Let Copilot pick the best model" },
    {
      value: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      description: "Claude Opus 4.8",
      _meta: { copilotUsage: "15x", copilotPriceCategory: "high", copilotEnablement: "enabled" },
    },
    {
      value: "claude-haiku-4.5",
      name: "Claude Haiku 4.5",
      description: "Claude Haiku 4.5",
      _meta: { copilotUsage: "0.33x", copilotPriceCategory: "low", copilotEnablement: "enabled" },
    },
  ],
};
const effortOption = {
  type: "select",
  id: "reasoning_effort",
  name: "Reasoning Effort",
  currentValue: "max",
  options: [
    { value: "low", name: "low", description: "Minimal reasoning before responding." },
    { value: "medium", name: "medium" },
    { value: "high", name: "high" },
    { value: "xhigh", name: "xhigh", description: "Extensive reasoning for the hardest problems." },
    { value: "max", name: "max", description: "Maximum reasoning; slowest but most thorough." },
  ],
};
const fullConfig = [{ type: "select", id: "mode" }, modelOption, effortOption, { id: "allow_all" }];
// Haiku's session omits reasoning_effort entirely (empirically verified).
const haikuConfig = [{ type: "select", id: "mode" }, modelOption, { id: "allow_all" }];

describe("parseEffortOption", () => {
  it("extracts the per-model effort levels and current value", () => {
    expect(parseEffortOption(fullConfig)).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      current: "max",
    });
  });
  it("returns undefined when the model exposes no reasoning_effort option", () => {
    expect(parseEffortOption(haikuConfig)).toBeUndefined();
  });
  it("returns undefined for null/empty config", () => {
    expect(parseEffortOption(null)).toBeUndefined();
    expect(parseEffortOption([])).toBeUndefined();
  });
  it("does not throw on malformed null option entries", () => {
    const malformed = [
      { type: "select", id: "reasoning_effort", currentValue: "low", options: [null, { value: "low" }, { value: null }] },
    ];
    expect(parseEffortOption(malformed)).toEqual({ levels: ["low"], current: "low" });
    const nestedNull = [{ type: "select", id: "model", options: [{ options: [null, { value: "m", name: "M" }] }] }];
    expect(parseModelOptions(nestedNull)).toEqual([{ modelId: "m", name: "M" }]);
  });
});

describe("resolveEffortLevels (three-state)", () => {
  const parsedOpus = { levels: ["low", "medium", "high", "xhigh", "max"], current: "max" };
  const fallback = ["low", "medium", "high", "xhigh", "max"];

  it("uses the live parsed option when present", () => {
    expect(
      resolveEffortLevels({ parsed: parsedOpus, mechanism: "configOption", hasSnapshot: true, fallbackLevels: fallback })
    ).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], current: "max" });
  });

  it("returns authoritative EMPTY for a configOption agent whose snapshot omits effort (Haiku)", () => {
    expect(
      resolveEffortLevels({ parsed: undefined, mechanism: "configOption", hasSnapshot: true, fallbackLevels: fallback })
    ).toEqual({ levels: [] });
  });

  it("uses the profile fallback for a meta agent (Claude never surfaces effort as a config option)", () => {
    expect(
      resolveEffortLevels({ parsed: undefined, mechanism: "meta", hasSnapshot: true, fallbackLevels: fallback })
    ).toEqual({ levels: fallback });
  });

  it("uses the profile fallback at cold-start (no snapshot yet) even for a configOption agent", () => {
    expect(
      resolveEffortLevels({ parsed: undefined, mechanism: "configOption", hasSnapshot: false, fallbackLevels: fallback })
    ).toEqual({ levels: fallback });
  });

  it("drops a stale current when the new snapshot has no effort", () => {
    const r = resolveEffortLevels({ parsed: undefined, mechanism: "configOption", hasSnapshot: true, fallbackLevels: fallback });
    expect(r.current).toBeUndefined();
  });
});

describe("parseModelOptions", () => {
  it("enriches each model with description + Copilot _meta (usage/price/enablement)", () => {
    const models = parseModelOptions(fullConfig);
    const opus = models.find((m) => m.modelId === "claude-opus-4.8");
    expect(opus).toEqual({
      modelId: "claude-opus-4.8",
      name: "Claude Opus 4.8",
      description: "Claude Opus 4.8",
      usageMultiplier: "15x",
      priceCategory: "high",
      enablement: "enabled",
    });
  });
  it("keeps models without _meta (e.g. Auto) as bare entries", () => {
    const auto = parseModelOptions(fullConfig).find((m) => m.modelId === "auto");
    expect(auto).toEqual({ modelId: "auto", name: "Auto", description: "Let Copilot pick the best model" });
  });
  it("returns [] when there is no model option", () => {
    expect(parseModelOptions([{ id: "mode" }])).toEqual([]);
    expect(parseModelOptions(null)).toEqual([]);
  });
});
