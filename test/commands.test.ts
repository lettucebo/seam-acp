import { describe, it, expect } from "vitest";
import { buildSeamCommand } from "../src/platforms/discord/commands.js";

describe("buildSeamCommand", () => {
  const json = buildSeamCommand().toJSON();
  const options = json.options ?? [];

  it("stays within Discord's 25 top-level option limit", () => {
    expect(options.length).toBeLessThanOrEqual(25);
  });

  it("exposes repo as a subcommand group containing set + list", () => {
    const repo = options.find((o) => o.name === "repo");
    expect(repo).toBeDefined();
    // ApplicationCommandOptionType.SubcommandGroup === 2
    expect(repo!.type).toBe(2);
    const subs = ((repo as { options?: { name: string }[] }).options ?? []).map(
      (s) => s.name
    );
    expect(subs).toContain("set");
    expect(subs).toContain("list");
  });

  it("enables autocomplete on `repo set <path>`", () => {
    const repo = options.find((o) => o.name === "repo") as {
      options: { name: string; options?: { name: string; autocomplete?: boolean }[] }[];
    };
    const set = repo.options.find((s) => s.name === "set")!;
    const pathOpt = (set.options ?? []).find((o) => o.name === "path")!;
    expect(pathOpt.autocomplete).toBe(true);
  });

  it("enables autocomplete on `model <id>`", () => {
    const model = options.find((o) => o.name === "model") as {
      options?: { name: string; autocomplete?: boolean }[];
    };
    const idOpt = (model.options ?? []).find((o) => o.name === "id")!;
    expect(idOpt.autocomplete).toBe(true);
  });

  it("no longer exposes the old flat repo/repos subcommands", () => {
    const names = options.map((o) => o.name);
    // `repo` now exists as a GROUP (type 2), not a flat subcommand; `repos`
    // is gone entirely (moved to `repo list`).
    expect(names).not.toContain("repos");
    const repo = options.find((o) => o.name === "repo");
    expect(repo!.type).not.toBe(1); // not a plain subcommand
  });

  it("uses the configured command name", () => {
    expect(buildSeamCommand("C:/x", "copilot").toJSON().name).toBe("copilot");
    expect(buildSeamCommand("C:/x", "scout").toJSON().name).toBe("scout");
    // no arg -> default
    expect(buildSeamCommand().toJSON().name).toBe("seam");
  });

  it("bakes the configured name into option descriptions (no stray /seam)", () => {
    const json = JSON.stringify(buildSeamCommand("C:/x", "copilot").toJSON());
    expect(json).not.toContain("/seam ");
    expect(json).toContain("/copilot schedule list");
  });
});
