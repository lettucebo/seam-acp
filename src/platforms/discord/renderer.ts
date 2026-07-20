import { chunkForDiscord } from "../../core/text-chunker.js";
import type { StatusPanel, StructuredPanel } from "../../core/types.js";
import type { KV, Renderer } from "../renderer.js";

/** Color palette keyed by turn state. */
const COLOR_BY_STATE: Record<StatusPanel["state"], number> = {
  Working: 0xfaa61a,   // amber
  Done: 0x57f287,      // green
  Failed: 0xed4245,    // red
  "Timed out": 0x95a5a6, // grey
  Waiting: 0x5865f2,   // blurple
  Monitoring: 0x1abc9c, // teal — resting, background work pending
};

const ICON_BY_STATE: Record<StatusPanel["state"], string> = {
  Done: "✅",
  Failed: "❌",
  "Timed out": "⏱️",
  Waiting: "⏸️",
  Working: "⏳",
  Monitoring: "💤",
};

function trim(s: string, max: number): string {
  const t = (s ?? "").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function box(opts: {
  title: string;
  icon?: string;
  rows: KV[];
  /** Optional extra lines appended inside the code block, after the rows. */
  extra?: string;
  footer?: string;
}): string {
  const icon = opts.icon ?? "ℹ️";
  const maxKey = opts.rows.reduce((m, r) => Math.max(m, r.key.length), 0);
  const lines: string[] = [];
  lines.push(`${icon} **${opts.title}**`);
  lines.push("```text");
  for (const { key, value } of opts.rows) {
    lines.push(`${key.padEnd(maxKey)} : ${value}`);
  }
  if (opts.extra && opts.extra.length > 0) {
    lines.push(opts.extra);
  }
  lines.push("```");
  if (opts.footer && opts.footer.trim().length > 0) {
    lines.push(opts.footer);
  }
  return lines.join("\n").replace(/\s+$/, "");
}

/** Map tool label keywords to a relevant emoji. */
const TOOL_EMOJI: [RegExp, string][] = [
  [/\b(grep|search|find|semantic)\b/i, "🔍"],
  [/\b(read|view|cat|head|wc)\b/i, "📄"],
  [/\b(edit|write|replace|creat)\b/i, "✏️"],
  [/\b(run|command|exec|terminal|bash|sh\b)/i, "▶️"],
  [/\b(npm|node|npx|tsc|build|compile)\b/i, "🔨"],
  [/\b(python|py)\b/i, "🐍"],
  [/\b(web|url|browse|curl|fetch|http)\b/i, "🌐"],
  [/\b(list|ls|dir|directory)\b/i, "📂"],
  [/\b(git|commit|push|pull|stage|stash|diff|log)\b/i, "📦"],
  [/\b(image|screenshot|crop|photo)\b/i, "🖼️"],
  [/\b(delete|remove|clean|rm)\b/i, "🗑️"],
  [/\b(test|check|lint|verify|validate)\b/i, "✅"],
  [/\b(sleep|wait|restart|stop|kill)\b/i, "⏸️"],
  [/\b(string|debug|probe|inspect)\b/i, "🔬"],
  [/\bcode action\b/i, "📑"],
];

function toolEmoji(label: string): string {
  for (const [pattern, emoji] of TOOL_EMOJI) {
    if (pattern.test(label)) return emoji;
  }
  return "⚙️";
}

export const discordRenderer: Renderer = {
  statusPanel(state): StructuredPanel {
    const icon = ICON_BY_STATE[state.state];

    // --- fields (all inline) ---
    const modelValue =
      state.resolvedModel && state.resolvedModel !== state.model
        ? trim(state.resolvedModel, 40) + " (" + trim(state.model, 40) + ")"
        : trim(state.model, 40);
    const fields: StructuredPanel["fields"] = [
      { name: "Repo", value: trim(state.repoDisplay, 80), inline: true },
      ...(state.mode
        ? [{ name: "Mode", value: trim(state.mode, 40), inline: true }]
        : []),
      { name: "Model", value: modelValue, inline: true },
      { name: "Action", value: trim(state.action, 220), inline: true },
    ];
    // --- description: activity as inline code "tags" ---
    let description: string | undefined;
    if (state.activity && state.activity.length > 0) {
      description = state.activity
        .map((a) => `\`${toolEmoji(a)} ${trim(a, 60)}\``)
        .join("  ");
    }

    // --- footer: thinking lines (💡) + elapsed time (⏱) ---
    const footerParts: string[] = [];
    if (state.thinking && state.thinking.length > 0) {
      const thinkingLines = state.thinking
        .map((t) => `💡 ${trim(t.replace(/[*_`]/g, ""), 200)}`)
        .join("\n");
      footerParts.push(thinkingLines);
    }
    const segments = [`⏱ ${state.elapsedSeconds}s elapsed`];
    if (state.context) segments.push(`🪟 ${state.context}`);
    segments.push(`🧠 ${state.effort ?? "default"} effort`);
    footerParts.push("\n" + segments.join(" • "));

    return {
      color: COLOR_BY_STATE[state.state],
      title: state.state,
      fields,
      description,
      footer: footerParts.join("\n"),
    };
  },

  infoBox(opts) {
    return box(opts);
  },

  codeBlock(content, lang) {
    return `\`\`\`${lang ?? ""}\n${content}\n\`\`\``;
  },

  trimShort: trim,
  quote: (s) => `\`${s}\``,
  chunk: (s) => chunkForDiscord(s),
};
