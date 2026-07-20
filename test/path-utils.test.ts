import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  isWithinRoot,
  normalizeFullPath,
  resolveRepoPath,
  resolveRepoWithinRoot,
} from "../src/core/path-utils.js";

const tmp = os.tmpdir();

describe("normalizeFullPath", () => {
  it("returns absolute path", () => {
    const p = normalizeFullPath("./foo");
    expect(path.isAbsolute(p)).toBe(true);
  });

  it("strips quotes", () => {
    const p = normalizeFullPath('"/tmp/foo"');
    expect(p).toBe(path.resolve("/tmp/foo"));
  });
});

describe("isWithinRoot", () => {
  it("matches descendants", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(path.join(root, "a", "b"), root)).toBe(true);
  });

  it("matches root itself", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(root, root)).toBe(true);
  });

  it("rejects sibling that shares prefix", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(path.join(tmp, "repos-other", "x"), root)).toBe(false);
  });

  it("rejects parent", () => {
    const root = path.join(tmp, "repos");
    expect(isWithinRoot(tmp, root)).toBe(false);
  });

  it("rejects directory traversal", () => {
    const root = path.join(tmp, "repos");
    const escape = path.join(root, "..", "outside");
    expect(isWithinRoot(escape, root)).toBe(false);
  });
});

describe("resolveRepoPath", () => {
  it("joins relative input under root", () => {
    const root = path.join(tmp, "repos");
    expect(resolveRepoPath(root, "myrepo")).toBe(path.join(root, "myrepo"));
  });

  it("passes absolute paths through (still must be sandbox-checked)", () => {
    const root = path.join(tmp, "repos");
    const abs = path.join(tmp, "elsewhere");
    expect(resolveRepoPath(root, abs)).toBe(abs);
  });

  it("throws on empty input", () => {
    expect(() => resolveRepoPath(tmp, "")).toThrow();
  });
});

describe("resolveRepoWithinRoot", () => {
  let root: string;

  beforeAll(() => {
    // Real dir tree so realpath/statSync work. Use realpath of mkdtemp base
    // because macOS/Windows temp dirs are themselves symlinks/8.3 names.
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, "seam-root-")));
    fs.mkdirSync(path.join(root, "myrepo"));
    fs.writeFileSync(path.join(root, "afile.txt"), "x");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves an existing directory under root to its realpath", () => {
    const out = resolveRepoWithinRoot(root, "myrepo");
    expect(out).toBe(path.join(root, "myrepo"));
  });

  it("throws when the path does not exist", () => {
    expect(() => resolveRepoWithinRoot(root, "nope")).toThrow(/does not exist/i);
  });

  it("throws when the target is a file, not a directory", () => {
    expect(() => resolveRepoWithinRoot(root, "afile.txt")).toThrow(/not a directory/i);
  });

  it("throws for an absolute path outside root (the existing vuln)", () => {
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, "seam-outside-")));
    try {
      expect(() => resolveRepoWithinRoot(root, outside)).toThrow(/outside REPOS_ROOT/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("throws for a .. traversal escape", () => {
    expect(() => resolveRepoWithinRoot(root, path.join("..", "..", "Windows"))).toThrow();
  });
});
