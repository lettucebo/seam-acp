import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { AgentRuntime } from "../src/agents/agent-runtime.js";
import { makeCopilotProfile } from "../src/agents/profiles/copilot.js";
import { ChoiceBroker, type ChoicePresenter } from "../src/core/choice-broker.js";
import { logger } from "../src/lib/logger.js";

// Cross-platform copilot detection (the other int test uses `which`, which is
// absent on Windows — this one must run on Windows too).
const whichBin = process.platform === "win32" ? "where" : "which";
const copilotInstalled =
  spawnSync(whichBin, ["copilot"], { encoding: "utf8" }).status === 0;

const serverJs = path.resolve(process.cwd(), "dist", "ask-user-mcp-server.js");
const built = fs.existsSync(serverJs);

const maybe = copilotInstalled && built ? describe : describe.skip;

maybe("ask_user MCP round-trip against `copilot --acp` (integration)", () => {
  it(
    "model calls ask_user, broker answers, model reports the choice",
    async () => {
      let presentedOptions: string[] = [];
      const presenter: ChoicePresenter = async (_key, prompt) => {
        presentedOptions = prompt.options.map((o) => o.label);
        // Always pick "Green" so we can assert the answer flowed back.
        const green = prompt.options.find((o) => o.label === "Green");
        return {
          status: "selected",
          optionId: green?.optionId ?? "0",
          label: green?.label ?? prompt.options[0]?.label ?? "",
        };
      };

      const broker = new ChoiceBroker({ presenter, logger, timeoutMs: 30_000 });
      await broker.start();
      const token = broker.registerRuntime("int-test");

      const profile = makeCopilotProfile({
        defaultModel: "gpt-5.4",
        mcpServers: [
          {
            name: "seam_ask_user",
            command: "node",
            args: [serverJs],
            env: [
              { name: "SEAM_CHOICE_URL", value: broker.callbackUrl },
              { name: "SEAM_CHOICE_TOKEN", value: token },
            ],
          },
        ],
      });

      const runtime = new AgentRuntime({ profile, logger });
      const text: string[] = [];
      runtime.onEvent((e) => {
        if (e.kind === "agent-text") text.push(e.text);
      });

      try {
        await runtime.start();
        await runtime.newSession({ cwd: process.cwd() });
        const result = await runtime.prompt(
          "Call your ask_user tool with the question 'Pick a colour' and options " +
            "Red, Green, Blue. After it returns, reply with exactly the colour I chose."
        );
        expect(["end_turn", "cancelled", "max_tokens"]).toContain(result.stopReason);
        // The broker was reached with the three options.
        expect(presentedOptions).toEqual(["Red", "Green", "Blue"]);
        // The chosen answer flowed back into the model's reply.
        expect(text.join(" ")).toMatch(/Green/i);
      } finally {
        await runtime.dispose();
        await broker.stop();
      }
    },
    120_000
  );
});
