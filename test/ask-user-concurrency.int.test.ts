import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { AgentRuntime } from "../src/agents/agent-runtime.js";
import { makeCopilotProfile } from "../src/agents/profiles/copilot.js";
import { ChoiceBroker, type ChoicePresenter, type ChoiceOutcome } from "../src/core/choice-broker.js";
import { logger } from "../src/lib/logger.js";

const whichBin = process.platform === "win32" ? "where" : "which";
const copilotInstalled =
  spawnSync(whichBin, ["copilot"], { encoding: "utf8" }).status === 0;
const serverJs = path.resolve(process.cwd(), "dist", "ask-user-mcp-server.js");
const built = fs.existsSync(serverJs);
const maybe = copilotInstalled && built ? describe : describe.skip;

function makeProfile(token: string, broker: ChoiceBroker) {
  return makeCopilotProfile({
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
}

maybe("two concurrent sessions route ask_user independently (integration)", () => {
  it(
    "each session's ask_user reaches the correct thread with no cross-talk",
    async () => {
      // Record which broker key saw which options, and gate both presenter
      // calls until BOTH have arrived so the two turns are genuinely in flight
      // at the same time.
      const seen = new Map<string, string[]>();
      let arrived = 0;
      let releaseBoth!: () => void;
      const bothArrived = new Promise<void>((r) => (releaseBoth = r));
      const presenter: ChoicePresenter = async (key, prompt) => {
        seen.set(key, prompt.options.map((o) => o.label));
        if (++arrived === 2) releaseBoth();
        await bothArrived;
        return {
          status: "selected",
          optionId: prompt.options[0]!.optionId,
          label: prompt.options[0]!.label,
        } satisfies ChoiceOutcome;
      };

      const broker = new ChoiceBroker({ presenter, logger, timeoutMs: 60_000 });
      await broker.start();

      const keyA = "thread-A";
      const keyB = "thread-B";
      const tokenA = broker.registerRuntime(keyA);
      const tokenB = broker.registerRuntime(keyB);

      const rtA = new AgentRuntime({ profile: makeProfile(tokenA, broker), logger });
      const rtB = new AgentRuntime({ profile: makeProfile(tokenB, broker), logger });
      const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), "seamA-"));
      const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), "seamB-"));

      const textA: string[] = [];
      const textB: string[] = [];
      rtA.onEvent((e) => { if (e.kind === "agent-text") textA.push(e.text); });
      rtB.onEvent((e) => { if (e.kind === "agent-text") textB.push(e.text); });

      try {
        await Promise.all([rtA.start(), rtB.start()]);
        await Promise.all([rtA.newSession({ cwd: cwdA }), rtB.newSession({ cwd: cwdB })]);

        const promptA = rtA.prompt(
          "Call your ask_user tool with question 'Pick' and options Alpha, Beta. " +
            "Then reply with exactly the option I chose."
        );
        const promptB = rtB.prompt(
          "Call your ask_user tool with question 'Pick' and options Gamma, Delta. " +
            "Then reply with exactly the option I chose."
        );
        const [resA, resB] = await Promise.all([promptA, promptB]);

        expect(["end_turn", "cancelled", "max_tokens"]).toContain(resA.stopReason);
        expect(["end_turn", "cancelled", "max_tokens"]).toContain(resB.stopReason);

        // Each thread saw ONLY its own options — no cross-routing.
        expect(seen.get(keyA)).toEqual(["Alpha", "Beta"]);
        expect(seen.get(keyB)).toEqual(["Gamma", "Delta"]);

        // The correct answer flowed back to each model.
        expect(textA.join(" ")).toMatch(/Alpha/i);
        expect(textB.join(" ")).toMatch(/Gamma/i);
      } finally {
        await Promise.allSettled([rtA.dispose(), rtB.dispose()]);
        await broker.stop();
        fs.rmSync(cwdA, { recursive: true, force: true });
        fs.rmSync(cwdB, { recursive: true, force: true });
      }
    },
    180_000
  );
});
