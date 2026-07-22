// Pure, defensively-typed parsers for ACP `session/new` / `set_config_option`
// configOptions. Kept separate + unit-tested (test/config-options.test.ts) so the
// runtime wiring stays thin and the per-model effort/model discovery is testable
// with fixtures captured from the real `copilot --acp`.

interface RawSelectOption {
  value?: unknown;
  name?: unknown;
  description?: unknown;
  _meta?: Record<string, unknown>;
  options?: RawSelectOption[]; // nested group
}
interface RawConfigOption {
  id?: unknown;
  category?: unknown;
  type?: unknown;
  currentValue?: unknown;
  options?: RawSelectOption[];
}

/** A model enriched with the metadata Copilot advertises per option. */
export interface EnrichedModel {
  modelId: string;
  name: string;
  description?: string;
  /** Copilot credit multiplier, e.g. "15x" (copilotUsage). */
  usageMultiplier?: string;
  /** Copilot price band, e.g. "high" (copilotPriceCategory). */
  priceCategory?: string;
  /** Copilot enablement, e.g. "enabled" (copilotEnablement). */
  enablement?: string;
}

/** The reasoning-effort select for the current model. */
export interface EffortOption {
  levels: string[];
  current?: string;
}

function asOptions(configOptions: unknown): RawConfigOption[] {
  return Array.isArray(configOptions) ? (configOptions as RawConfigOption[]) : [];
}

function findOption(configOptions: unknown, id: string): RawConfigOption | undefined {
  return asOptions(configOptions).find((o) => o?.id === id || o?.category === id);
}

/** Flatten a select's options, unwrapping one level of groups. Skips any
 *  non-object entries so a malformed `[null]` / `[{options:[null]}]` can't throw. */
function flatten(options: RawSelectOption[] | undefined): RawSelectOption[] {
  if (!Array.isArray(options)) return [];
  return options
    .filter((o): o is RawSelectOption => o != null && typeof o === "object")
    .flatMap((o) =>
      Array.isArray(o.options)
        ? o.options.filter((x): x is RawSelectOption => x != null && typeof x === "object")
        : [o]
    );
}

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Parse the per-model `reasoning_effort` select. Returns undefined when the
 * current model exposes no effort option (e.g. Copilot's Haiku 4.5), so callers
 * can hide the picker rather than offer levels the model rejects.
 */
export function parseEffortOption(configOptions: unknown): EffortOption | undefined {
  const opt = findOption(configOptions, "reasoning_effort");
  if (!opt || opt.type !== "select") return undefined;
  const levels = flatten(opt.options)
    .map((o) => str(o.value))
    .filter((v): v is string => v !== undefined);
  if (levels.length === 0) return undefined;
  const current = str(opt.currentValue);
  return current !== undefined ? { levels, current } : { levels };
}

/**
 * Parse the `model` select into enriched entries, preserving the description and
 * Copilot `_meta` (usage multiplier / price category / enablement) that the ACP
 * advertises per option. Returns [] when no model option is present.
 */
export function parseModelOptions(configOptions: unknown): EnrichedModel[] {
  const opt = findOption(configOptions, "model");
  if (!opt || opt.type !== "select") return [];
  return flatten(opt.options)
    .map((o) => {
      const modelId = str(o.value);
      if (!modelId) return undefined;
      const meta = o._meta ?? {};
      const entry: EnrichedModel = { modelId, name: str(o.name) ?? modelId };
      const description = str(o.description);
      if (description) entry.description = description;
      const usage = str(meta?.copilotUsage);
      if (usage) entry.usageMultiplier = usage;
      const price = str(meta?.copilotPriceCategory);
      if (price) entry.priceCategory = price;
      const enablement = str(meta?.copilotEnablement);
      if (enablement) entry.enablement = enablement;
      return entry;
    })
    .filter((m): m is EnrichedModel => m !== undefined);
}

/**
 * Decide the effort levels + current value to expose in `SessionInfo`, honoring
 * three distinct states so callers can tell "unsupported" from "unknown":
 *   - a parsed `reasoning_effort` option  → use it (live, per-model);
 *   - NO option but a real snapshot exists AND the agent applies effort via a
 *     config option (Copilot/Codex) → authoritative EMPTY `[]` (this model has
 *     none, e.g. Haiku) — do NOT fall back to the profile's cold-start list;
 *   - otherwise (no snapshot yet, or a `_meta`/none/modelBaked agent that never
 *     surfaces effort as a config option — e.g. Claude) → the profile fallback.
 * Returning `[]` vs the fallback is what lets the picker hide itself for a
 * no-effort model instead of offering levels the model rejects.
 */
export function resolveEffortLevels(opts: {
  parsed: EffortOption | undefined;
  mechanism: string | undefined;
  hasSnapshot: boolean;
  fallbackLevels: ReadonlyArray<string>;
}): { levels: string[]; current?: string } {
  if (opts.parsed) {
    return opts.parsed.current !== undefined
      ? { levels: [...opts.parsed.levels], current: opts.parsed.current }
      : { levels: [...opts.parsed.levels] };
  }
  if (opts.hasSnapshot && opts.mechanism === "configOption") {
    return { levels: [] };
  }
  return { levels: [...opts.fallbackLevels] };
}
