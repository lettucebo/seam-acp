import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseSource,
  validateTargetName,
  isInternalHost,
  RepoProvisioner,
} from "../src/core/repo-provisioner.js";

const github = { hostPolicy: "github" as const };
const publicPolicy = { hostPolicy: "public" as const };

describe("validateTargetName", () => {
  it("accepts a normal name", () => {
    expect(validateTargetName("my-repo")).toBe("my-repo");
  });
  it("trims", () => {
    expect(validateTargetName("  my-repo  ")).toBe("my-repo");
  });
  it("rejects empty", () => {
    expect(() => validateTargetName("  ")).toThrow(/required/i);
  });
  it("rejects Windows reserved names (with or without extension)", () => {
    expect(() => validateTargetName("CON")).toThrow(/reserved/i);
    expect(() => validateTargetName("nul.txt")).toThrow(/reserved/i);
    expect(() => validateTargetName("COM1")).toThrow(/reserved/i);
  });
  it("rejects illegal characters", () => {
    for (const bad of ["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a|b"]) {
      expect(() => validateTargetName(bad)).toThrow(/illegal/i);
    }
  });
  it("rejects leading dash / dot and traversal", () => {
    expect(() => validateTargetName("-x")).toThrow();
    expect(() => validateTargetName(".x")).toThrow();
    expect(() => validateTargetName("a..b")).toThrow(/\.\./);
  });
  it("rejects trailing dot or space (silently stripped by Windows)", () => {
    expect(() => validateTargetName("repo.")).toThrow(/end with/i);
    expect(() => validateTargetName("repo ")).not.toThrow(); // trimmed first -> "repo"
  });
  it("rejects over-long names", () => {
    expect(() => validateTargetName("a".repeat(101))).toThrow(/too long/i);
  });
});

describe("isInternalHost (SSRF guard)", () => {
  it("flags loopback / link-local / private / metadata", () => {
    for (const h of ["localhost", "127.0.0.1", "169.254.169.254", "10.1.2.3", "192.168.0.5", "172.16.0.1", "foo.local", "svc.internal", "::1"]) {
      expect(isInternalHost(h)).toBe(true);
    }
  });
  it("allows public hosts", () => {
    for (const h of ["github.com", "gitlab.com", "8.8.8.8", "bitbucket.org"]) {
      expect(isInternalHost(h)).toBe(false);
    }
  });
  it("catches IPv4-mapped IPv6 and trailing-dot bypasses", () => {
    for (const h of ["::ffff:127.0.0.1", "::ffff:169.254.169.254", "[::ffff:7f00:1]", "localhost.", "svc.internal.", "foo.local."]) {
      expect(isInternalHost(h)).toBe(true);
    }
  });
  it("does not over-block public hosts that merely start with fc/fd or end with a dot", () => {
    for (const h of ["fd.io", "fc2.com", "example.com."]) {
      expect(isInternalHost(h)).toBe(false);
    }
  });
});

describe("parseSource — github policy", () => {
  it("parses owner/repo shorthand as gh", () => {
    const p = parseSource("lettucebo/Work", github);
    expect(p).toEqual({ kind: "gh", canonicalSource: "lettucebo/Work", defaultName: "Work" });
  });
  it("normalizes a github.com https URL (and deep links) to owner/repo", () => {
    expect(parseSource("https://github.com/lettucebo/seam-acp", github)).toMatchObject({
      kind: "gh",
      canonicalSource: "lettucebo/seam-acp",
      defaultName: "seam-acp",
    });
    expect(parseSource("https://github.com/lettucebo/seam-acp.git", github)).toMatchObject({
      canonicalSource: "lettucebo/seam-acp",
      defaultName: "seam-acp",
    });
    // deep link -> still owner/repo, not "issues"/"1"
    expect(parseSource("https://github.com/lettucebo/seam-acp/issues/1", github)).toMatchObject({
      canonicalSource: "lettucebo/seam-acp",
      defaultName: "seam-acp",
    });
  });
  it("rejects non-github hosts under github policy", () => {
    expect(() => parseSource("https://gitlab.com/a/b", github)).toThrow(/not allowed/i);
    expect(() => parseSource("git@gitlab.com:a/b.git", github)).toThrow(/not allowed/i);
  });
});

describe("parseSource — public policy (B2 hardening)", () => {
  it("allows external gitlab/bitbucket over https as git clone", () => {
    expect(parseSource("https://gitlab.com/group/proj", publicPolicy)).toMatchObject({
      kind: "git",
      defaultName: "proj",
    });
  });
  it("allows ssh and scp-style for external hosts", () => {
    expect(parseSource("ssh://git@gitlab.com/group/proj.git", publicPolicy)).toMatchObject({ kind: "git", defaultName: "proj" });
    expect(parseSource("git@bitbucket.org:team/proj.git", publicPolicy)).toMatchObject({ kind: "git", defaultName: "proj" });
  });
  it("blocks SSRF to internal hosts", () => {
    expect(() => parseSource("https://169.254.169.254/latest/meta-data", publicPolicy)).toThrow(/internal|loopback|SSRF/i);
    expect(() => parseSource("https://localhost/x", publicPolicy)).toThrow(/internal|loopback|SSRF/i);
    expect(() => parseSource("https://10.0.0.5/x", publicPolicy)).toThrow(/internal|loopback|SSRF/i);
  });
  it("rejects dangerous schemes and injection", () => {
    expect(() => parseSource("file:///etc/passwd", publicPolicy)).toThrow(/scheme|format/i);
    expect(() => parseSource("ext::sh -c 'id'", publicPolicy)).toThrow();
    expect(() => parseSource("http://example.com/x", publicPolicy)).toThrow(/scheme/i);
    expect(() => parseSource("--upload-pack=evil", publicPolicy)).toThrow(/start with '-'/i);
  });
  it("rejects embedded credentials", () => {
    expect(() => parseSource("https://user:pass@gitlab.com/a/b", publicPolicy)).toThrow(/credential/i);
    expect(() => parseSource("https://user@gitlab.com/a/b", publicPolicy)).toThrow(/username/i);
  });
});

describe("parseSource — allowlist policy", () => {
  const allow = { hostPolicy: "allowlist" as const, allowlistHosts: new Set(["gitlab.example.com"]) };
  it("allows listed host, rejects others", () => {
    expect(parseSource("https://gitlab.example.com/a/b", allow)).toMatchObject({ kind: "git", defaultName: "b" });
    expect(() => parseSource("https://github.com/a/b", allow)).toThrow(/not in/i);
  });
});

describe("RepoProvisioner.init (integration — needs git)", () => {
  const stubLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return stubLogger;
    },
  } as unknown as import("../src/lib/logger.js").Logger;

  it("inits an empty repo with a commit, leaves no staging, and rejects conflicts", async () => {
    const root = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "seam-prov-"))
    );
    try {
      const prov = new RepoProvisioner(root, stubLogger, { hostPolicy: "github" });
      const result = await prov.init("my-new-proj");
      expect(result.name).toBe("my-new-proj");
      expect(fs.existsSync(path.join(root, "my-new-proj", ".git"))).toBe(true);
      // staging dirs must be cleaned up (renamed away)
      expect(fs.readdirSync(root).filter((n) => n.startsWith(".staging-"))).toEqual([]);
      // conflict on the same name
      await expect(prov.init("my-new-proj")).rejects.toThrow(/already exists/i);
      // invalid name rejected before touching the filesystem
      await expect(prov.init("CON")).rejects.toThrow(/reserved/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

