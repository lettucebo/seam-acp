import { describe, it, expect } from "vitest";
import { parse as parseDotenv } from "dotenv";
import {
  applyEnvUpdates,
  serializeValue,
  detectNewline,
} from "../scripts/lib/env-file.mjs";

describe("detectNewline", () => {
  it("detects CRLF when present", () => {
    expect(detectNewline("A=1\r\nB=2\r\n")).toBe("\r\n");
  });
  it("defaults to LF", () => {
    expect(detectNewline("A=1\nB=2\n")).toBe("\n");
  });
});

describe("applyEnvUpdates", () => {
  it("updates only the given key, preserving comments, other keys, and order", () => {
    const original = "# header\nDISCORD_BOT_TOKEN=old\n# note\nHEALTH_PORT=3000\n";
    const out = applyEnvUpdates(original, { DISCORD_BOT_TOKEN: "new" });
    expect(out).toBe(
      "# header\nDISCORD_BOT_TOKEN=new\n# note\nHEALTH_PORT=3000\n"
    );
  });

  it("preserves CRLF newline style", () => {
    const out = applyEnvUpdates("A=1\r\nB=2\r\n", { B: "3" });
    expect(out).toBe("A=1\r\nB=3\r\n");
  });

  it("appends keys that are not already present", () => {
    const out = applyEnvUpdates("A=1\n", { B: "2" });
    expect(out.startsWith("A=1\n")).toBe(true);
    expect(parseDotenv(out)).toEqual({ A: "1", B: "2" });
  });

  it("leaves an unknown/extra user key untouched", () => {
    const out = applyEnvUpdates("CUSTOM_THING=keepme\nA=1\n", { A: "2" });
    expect(out).toContain("CUSTOM_THING=keepme");
    expect(parseDotenv(out).A).toBe("2");
  });

  it("does not treat '=' inside a value as a key boundary", () => {
    const out = applyEnvUpdates("A=1\n", { A: "a=b=c" });
    expect(parseDotenv(out).A).toBe("a=b=c");
  });

  it("does not corrupt an unrelated existing value on update", () => {
    const original = "REPOS_ROOT=C:\\Source\\Repos\nHEALTH_PORT=3000\n";
    const out = applyEnvUpdates(original, { HEALTH_PORT: "8080" });
    expect(parseDotenv(out).REPOS_ROOT).toBe("C:\\Source\\Repos");
    expect(parseDotenv(out).HEALTH_PORT).toBe("8080");
  });

  it("updates the LAST occurrence of a duplicated key (dotenv is last-wins)", () => {
    const out = applyEnvUpdates("TOKEN=old1\nTOKEN=old2\n", { TOKEN: "new" });
    expect(parseDotenv(out).TOKEN).toBe("new");
    // no stale duplicate left that dotenv would read
    expect((out.match(/^TOKEN=/gm) || []).length).toBe(1);
  });

  it("removes a key line when the update value is null (avoids empty override)", () => {
    const out = applyEnvUpdates("A=1\nCOPILOT_CLI_PATH=\nB=2\n", { COPILOT_CLI_PATH: null });
    expect(out).toBe("A=1\nB=2\n");
  });
});

describe("serializeValue round-trips through the real dotenv parser", () => {
  const cases: Array<[string, string]> = [
    ["simple discord-like token", "MTAbc.dEf-9_0"],
    ["comma id list", "123456789,987654321"],
    ["windows path", "C:\\Source\\Repos"],
    ["windows path with a \\n trap", "C:\\temp\\new"],
    ["windows path with a \\t trap", "C:\\temp\\tabbed"],
    ["path with spaces", "C:\\Program Files\\app"],
    ["windows path with apostrophe + backslash-r trap", "C:\\Users\\O'Brien\\source\\repos"],
    ["value starting with a double quote", '"lead'],
    ["value starting with a single quote", "'lead"],
    ["value with middle spaces", "a b c"],
    ["value with an embedded newline", "alpha\nbeta"],
    ["value with an embedded tab", "a\tb"],
    ["value containing a hash", "abc#def"],
    ["value with trailing space", "abc "],
    ["value with a single quote", "it's fine"],
    ["empty value", ""],
    ["model id", "gpt-5.4"],
    ["auto", "auto"],
    ["policy word", "ask"],
  ];
  for (const [name, value] of cases) {
    it(`round-trips ${name}`, () => {
      const text = `KEY=${serializeValue(value)}\n`;
      expect(parseDotenv(text).KEY ?? "").toBe(value);
    });
  }
});
