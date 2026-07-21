/**
 * Pure helpers for the `/<cmd> model id` autocomplete choice list. Extracted
 * from the orchestrator so the merge / dedupe / label logic is unit-testable
 * without Discord or a live runtime.
 */

export interface ModelInfo {
  modelId: string;
  name?: string;
  contextLimit?: number;
}

/** Format a token count as a compact window size (200000 → "200K", 1_000_000 → "1M"). */
export function formatContextWindow(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

/** Human label for a model choice: name (or id), with the context window
 *  appended when known (e.g. "Opus 4.8 (claude-opus-4-8) • 1M ctx"). */
export function modelChoiceLabel(m: ModelInfo): string {
  const base = m.name && m.name !== m.modelId ? `${m.name} (${m.modelId})` : m.modelId;
  const ctx = m.contextLimit ? formatContextWindow(m.contextLimit) : "";
  return ctx ? `${base} • ${ctx} ctx` : base;
}

/**
 * Build the Discord autocomplete choice list for model ids. Always surfaces the
 * current model and `auto` first (enriched from the catalog so their name/context
 * survive), then the rest of the catalog. Dedupes by id, skips ids that exceed
 * Discord's 100-char option-value limit (never truncates a value), filters by the
 * typed substring, and caps at 25.
 */
export function computeModelChoices(
  source: ReadonlyArray<ModelInfo>,
  current: string,
  query: string
): { name: string; value: string }[] {
  // Index the catalog so `current` / `auto` can be enriched with name+context.
  const byId = new Map<string, ModelInfo>();
  for (const m of source) {
    if (m.modelId && !byId.has(m.modelId.toLowerCase())) byId.set(m.modelId.toLowerCase(), m);
  }

  const ordered: ModelInfo[] = [];
  const seen = new Set<string>();
  const push = (m: ModelInfo): void => {
    const id = m.modelId;
    if (!id) return;
    const key = id.toLowerCase();
    if (seen.has(key)) return;
    if (id.length > 100) return; // can't be a valid Discord option value
    seen.add(key);
    ordered.push(m);
  };

  if (current) push(byId.get(current.toLowerCase()) ?? { modelId: current });
  push(byId.get("auto") ?? { modelId: "auto", name: "auto" });
  for (const m of source) push(m);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? ordered.filter(
        (m) => m.modelId.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q)
      )
    : ordered;

  return filtered.slice(0, 25).map((m) => ({
    name: modelChoiceLabel(m).slice(0, 100),
    value: m.modelId, // raw id — never truncated (long ids were skipped above)
  }));
}
