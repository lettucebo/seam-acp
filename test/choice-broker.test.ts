import { describe, it, expect, afterEach } from "vitest";
import {
  ChoiceBroker,
  normalizePrompt,
  type ChoiceOutcome,
  type ChoicePresenter,
} from "../src/core/choice-broker.js";
import { logger } from "../src/lib/logger.js";

async function makeBroker(
  presenter: ChoicePresenter,
  timeoutMs?: number
): Promise<ChoiceBroker> {
  const broker = new ChoiceBroker({
    presenter,
    logger,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  await broker.start();
  return broker;
}

function post(url: string, token: string | null, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("ChoiceBroker", () => {
  let broker: ChoiceBroker | undefined;
  afterEach(async () => {
    await broker?.stop();
    broker = undefined;
  });

  it("binds to loopback only", async () => {
    broker = await makeBroker(async () => ({ status: "selected" }));
    expect(broker.callbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/choice$/);
  });

  it("rejects requests without a valid bearer token", async () => {
    broker = await makeBroker(async () => ({ status: "selected" }));
    const noToken = await post(broker.callbackUrl, null, { question: "q" });
    expect(noToken.status).toBe(401);
    const badToken = await post(broker.callbackUrl, "deadbeef", { question: "q" });
    expect(badToken.status).toBe(401);
  });

  it("presents the choice and returns the presenter outcome", async () => {
    const seen: { key: string; question: string; options: number } = {
      key: "",
      question: "",
      options: -1,
    };
    const presenter: ChoicePresenter = async (key, prompt) => {
      seen.key = key;
      seen.question = prompt.question;
      seen.options = prompt.options.length;
      return { status: "selected", optionId: "1", label: prompt.options[1]!.label };
    };
    broker = await makeBroker(presenter);
    const token = broker.registerRuntime("thread-42");
    const res = await post(broker.callbackUrl, token, {
      question: "Pick a colour",
      options: ["Red", "Green", "Blue"],
    });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as ChoiceOutcome;
    expect(outcome.status).toBe("selected");
    expect(outcome.label).toBe("Green");
    expect(seen.key).toBe("thread-42");
    expect(seen.question).toBe("Pick a colour");
    expect(seen.options).toBe(3);
  });

  it("rejects a second concurrent choice for the same runtime with 409", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const presenter: ChoicePresenter = async () => {
      await gate;
      return { status: "selected", optionId: "0", label: "A" };
    };
    broker = await makeBroker(presenter);
    const token = broker.registerRuntime("thread-1");

    const first = post(broker.callbackUrl, token, { question: "q", options: ["A"] });
    // give the first request time to register as active
    await new Promise((r) => setTimeout(r, 50));
    const second = await post(broker.callbackUrl, token, { question: "q2", options: ["B"] });
    expect(second.status).toBe(409);

    release?.();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  });

  it("returns timed_out when the presenter never resolves", async () => {
    const presenter: ChoicePresenter = (_key, _prompt, signal) =>
      new Promise<ChoiceOutcome>((resolve) => {
        signal.addEventListener("abort", () => resolve({ status: "timed_out" }));
      });
    broker = await makeBroker(presenter, 120);
    const token = broker.registerRuntime("thread-x");
    const res = await post(broker.callbackUrl, token, { question: "q", options: ["A"] });
    expect(res.status).toBe(200);
    const outcome = (await res.json()) as ChoiceOutcome;
    expect(outcome.status).toBe("timed_out");
  });

  it("revoking a token aborts in-flight and blocks further use", async () => {
    let aborted = false;
    const presenter: ChoicePresenter = (_key, _prompt, signal) =>
      new Promise<ChoiceOutcome>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ status: "cancelled" });
        });
      });
    broker = await makeBroker(presenter, 5000);
    const token = broker.registerRuntime("thread-r");
    const inflight = post(broker.callbackUrl, token, { question: "q", options: ["A"] });
    await new Promise((r) => setTimeout(r, 50));
    broker.revoke(token);
    await inflight;
    expect(aborted).toBe(true);
    // token no longer valid
    const after = await post(broker.callbackUrl, token, { question: "q", options: ["A"] });
    expect(after.status).toBe(401);
  });
});

describe("normalizePrompt", () => {
  it("requires a non-empty question", () => {
    expect(normalizePrompt({})).toBeUndefined();
    expect(normalizePrompt({ question: "   " })).toBeUndefined();
    expect(normalizePrompt("nope")).toBeUndefined();
  });

  it("accepts string options and indexes them", () => {
    const p = normalizePrompt({ question: "q", options: ["A", "B"] })!;
    expect(p.options).toEqual([
      { optionId: "0", label: "A" },
      { optionId: "1", label: "B" },
    ]);
    expect(p.allowFreeText).toBe(true);
  });

  it("accepts object options and honours allowFreeText=false", () => {
    const p = normalizePrompt({
      question: "q",
      options: [{ optionId: "x", label: "Ex", description: "d" }],
      allowFreeText: false,
    })!;
    expect(p.options[0]).toEqual({ optionId: "x", label: "Ex", description: "d" });
    expect(p.allowFreeText).toBe(false);
  });

  it("clamps to 25 options", () => {
    const many = Array.from({ length: 40 }, (_, i) => `opt${i}`);
    const p = normalizePrompt({ question: "q", options: many })!;
    expect(p.options.length).toBe(25);
  });
});
