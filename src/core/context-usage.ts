// Pure parser for the Copilot `/context` usage line, extracted from the
// orchestrator's probeCopilotContext so it is unit-testable and robust to the
// unit the CLI reports. Handles `k`/`m` (case-insensitive), raw and
// comma-formatted token counts, and independent units per side — so the status
// window keeps working if the CLI ever reports a large (e.g. 1M) window once
// GitHub enables the long-context tier over ACP (the old regex only matched
// `k`, which would silently stop parsing on `1M`).

/** Parse a `/context` line such as "24k/264k tokens (9%)", "1.1M / 1M tokens",
 *  or "24,000 / 264,000 tokens" into absolute token counts. Returns null when
 *  no "<used>/<size> tokens" pattern is present or the size is non-positive. */
export function parseContextUsage(
  text: string
): { used: number; size: number } | null {
  const m = text.match(
    /([\d.,]+)\s*([km])?\s*\/\s*([\d.,]+)\s*([km])?\s*tokens/i
  );
  if (!m) return null;
  const scale = (u?: string): number => {
    const c = u?.toLowerCase();
    return c === "k" ? 1_000 : c === "m" ? 1_000_000 : 1;
  };
  const num = (s: string): number => parseFloat(s.replace(/,/g, ""));
  const used = Math.round(num(m[1]!) * scale(m[2]));
  const size = Math.round(num(m[3]!) * scale(m[4]));
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
  return { used, size };
}
