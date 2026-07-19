/**
 * Standalone MCP stdio server exposing an `ask_user` tool.
 *
 * Spawned per agent session by the ACP agent (Copilot) via
 * `--additional-mcp-config`. It is a stateless thin proxy: it forwards the
 * question / options to the seam-acp ChoiceBroker over a loopback HTTP endpoint
 * (authenticated with a per-session bearer token) and returns the human's
 * answer to the model. All UI / correlation / timeout logic lives in the
 * broker (see src/core/choice-broker.ts).
 *
 * Why this exists: GitHub Copilot's native `ask_user` tool is NOT exposed over
 * ACP (verified against Copilot 1.0.72 — the model reports it has no such tool
 * in an ACP session and falls back to asking in prose). Injecting this MCP tool
 * lets the model surface real interactive choices to the operator on Discord.
 *
 * Env:
 *   SEAM_CHOICE_URL   — broker endpoint, e.g. http://127.0.0.1:PORT/choice
 *   SEAM_CHOICE_TOKEN — per-session bearer token
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CHOICE_URL = process.env.SEAM_CHOICE_URL;
const CHOICE_TOKEN = process.env.SEAM_CHOICE_TOKEN;

interface BrokerOutcome {
  status: string;
  optionId?: string;
  label?: string;
  freeText?: string;
  error?: string;
}

function formatOutcome(o: BrokerOutcome): string {
  switch (o.status) {
    case "selected":
      return `The user selected: ${o.label ?? o.optionId ?? "(unknown)"}`;
    case "free_text":
      return `The user typed a custom answer: ${o.freeText ?? ""}`;
    case "timed_out":
      return (
        "The user did not answer in time. Use your best judgement to proceed, " +
        "or ask again if the decision is essential."
      );
    case "cancelled":
      return "The user cancelled this request.";
    default:
      return `ask_user error: ${o.error ?? o.status}`;
  }
}

const server = new McpServer({ name: "seam-ask-user", version: "1.0.0" });

server.registerTool(
  "ask_user",
  {
    title: "Ask the user to choose",
    description:
      "Ask the human operator to make a decision and WAIT for their answer. " +
      "ALWAYS call this whenever you need the user to choose between options, " +
      "confirm a direction, or approve moving to the next step (e.g. switching " +
      "to autopilot) — instead of only asking in prose, which the user may not " +
      "see promptly. Provide the concrete options you want them to pick from. " +
      "The user can select an option or type a custom answer, which is returned " +
      "to you as the tool result.",
    inputSchema: {
      question: z.string().describe("The question to ask the user."),
      options: z
        .array(z.string())
        .optional()
        .describe("Selectable answer options (0-25). Omit for a yes/no or open prompt."),
      allow_free_text: z
        .boolean()
        .optional()
        .describe("Allow the user to type a custom answer instead of picking (default true)."),
    },
  },
  async ({ question, options, allow_free_text }) => {
    if (!CHOICE_URL || !CHOICE_TOKEN) {
      return {
        content: [
          { type: "text", text: "ask_user is unavailable (bridge not configured)." },
        ],
        isError: true,
      };
    }
    try {
      const res = await fetch(CHOICE_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${CHOICE_TOKEN}`,
        },
        body: JSON.stringify({
          question,
          options: options ?? [],
          allowFreeText: allow_free_text ?? true,
        }),
      });
      const outcome = (await res.json()) as BrokerOutcome;
      return { content: [{ type: "text", text: formatOutcome(outcome) }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `ask_user failed to reach the operator: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
