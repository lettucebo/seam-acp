import { describe, it, expect } from "vitest";
import {
  validateCommandName,
  validateIdList,
  validatePort,
  validatePermissionPolicy,
} from "../scripts/lib/validate.mjs";

describe("validateCommandName", () => {
  it("accepts a lowercase slug", () => {
    expect(validateCommandName("copilot").ok).toBe(true);
  });
  it("rejects uppercase", () => {
    expect(validateCommandName("Copilot").ok).toBe(false);
  });
  it("rejects spaces and symbols", () => {
    expect(validateCommandName("my bot").ok).toBe(false);
    expect(validateCommandName("bot!").ok).toBe(false);
  });
  it("rejects empty and over-32 chars", () => {
    expect(validateCommandName("").ok).toBe(false);
    expect(validateCommandName("a".repeat(33)).ok).toBe(false);
  });
  it("allows digits, underscore, hyphen", () => {
    expect(validateCommandName("scout_2-x").ok).toBe(true);
  });
});

describe("validateIdList", () => {
  it("accepts a single numeric id", () => {
    expect(validateIdList("123456789", { required: true }).ok).toBe(true);
  });
  it("accepts comma-separated numeric ids", () => {
    expect(validateIdList("123,456,789", { required: true }).ok).toBe(true);
  });
  it("rejects non-numeric", () => {
    expect(validateIdList("123,abc", { required: true }).ok).toBe(false);
  });
  it("rejects empty when required", () => {
    expect(validateIdList("", { required: true }).ok).toBe(false);
  });
  it("accepts empty when optional", () => {
    expect(validateIdList("", { required: false }).ok).toBe(true);
  });
  it("tolerates surrounding whitespace between ids", () => {
    expect(validateIdList(" 123 , 456 ", { required: true }).ok).toBe(true);
  });
});

describe("validatePort", () => {
  it("accepts a valid port", () => {
    expect(validatePort("3000").ok).toBe(true);
  });
  it("rejects 0 and out-of-range", () => {
    expect(validatePort("0").ok).toBe(false);
    expect(validatePort("70000").ok).toBe(false);
  });
  it("rejects non-numeric", () => {
    expect(validatePort("abc").ok).toBe(false);
  });
});

describe("validatePermissionPolicy", () => {
  it("accepts ask/always/deny", () => {
    expect(validatePermissionPolicy("ask").ok).toBe(true);
    expect(validatePermissionPolicy("always").ok).toBe(true);
    expect(validatePermissionPolicy("deny").ok).toBe(true);
  });
  it("rejects anything else", () => {
    expect(validatePermissionPolicy("yes").ok).toBe(false);
  });
});
