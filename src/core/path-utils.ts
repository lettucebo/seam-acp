import fs from "node:fs";
import path from "node:path";

/** Resolve to an absolute, normalized path. Strips surrounding quotes. */
export function normalizeFullPath(p: string): string {
  return path.resolve(p.trim().replace(/^"|"$/g, ""));
}

/**
 * Returns true if `fullPath` is the same as or a descendant of `rootFullPath`.
 * Case-insensitive (matches the C# behavior, important on macOS/Windows).
 */
export function isWithinRoot(fullPath: string, rootFullPath: string): boolean {
  const fp = normalizeFullPath(fullPath);
  let rp = normalizeFullPath(rootFullPath);
  if (!rp.endsWith(path.sep)) rp += path.sep;

  const fpCmp = fp.toLowerCase();
  const rpCmp = rp.toLowerCase();
  return (
    fpCmp === rpCmp.slice(0, -1) || // exact root match
    fpCmp.startsWith(rpCmp)
  );
}

/**
 * Resolve user input as a repo path. Absolute paths pass through; relative
 * paths are joined under `reposRoot`. Caller still must check `isWithinRoot`.
 */
export function resolveRepoPath(reposRoot: string, userInput: string): string {
  const input = userInput.trim().replace(/^"|"$/g, "");
  if (!input) {
    throw new Error("Repo path is required");
  }
  const combined = path.isAbsolute(input)
    ? input
    : path.join(reposRoot, input);
  return normalizeFullPath(combined);
}

/**
 * Resolve user input to an existing directory strictly inside `reposRoot`,
 * using the OS realpath on BOTH sides so symlinks/junctions cannot escape the
 * root (a plain string prefix check does not catch a junction inside the root
 * that points elsewhere). Throws a user-facing Error on any violation.
 *
 * This is the single boundary gate every repo-binding path (typed `set`,
 * picker, clone, new) must go through. `resolveRepoPath` alone is NOT safe:
 * it lets absolute paths and `..` escapes through by design.
 */
export function resolveRepoWithinRoot(reposRoot: string, userInput: string): string {
  const candidate = resolveRepoPath(reposRoot, userInput);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync.native(reposRoot);
  } catch {
    throw new Error(`REPOS_ROOT is not accessible: ${reposRoot}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error(`Path does not exist: ${candidate}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${candidate}`);
  }
  const realTarget = fs.realpathSync.native(candidate);
  if (!isWithinRoot(realTarget, realRoot)) {
    throw new Error(`Path is outside REPOS_ROOT: ${candidate}`);
  }
  return realTarget;
}
