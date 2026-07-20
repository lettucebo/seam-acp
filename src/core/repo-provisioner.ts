import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Logger } from "../lib/logger.js";

/**
 * Repo provisioning: parse/validate a clone source, validate a new-repo name,
 * and execute clone/init into a hidden staging directory that is atomically
 * renamed into REPOS_ROOT on success. All git/gh invocations are non-interactive
 * and hardened. The pure functions (parseSource / validateTargetName) carry the
 * security policy and are unit-tested in isolation.
 */

export type CloneKind = "gh" | "git";
export type HostPolicy = "github" | "public" | "allowlist";

export interface ParsedSource {
  kind: CloneKind;
  /** What to hand to `gh repo clone` (owner/repo) or `git clone` (full URL). */
  canonicalSource: string;
  /** Folder name derived from the source (already name-validated). */
  defaultName: string;
}

export interface ProvisionResult {
  path: string;
  name: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const RESERVED_WIN = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * Validate a repo folder name for cross-platform (esp. Windows) safety.
 * Returns the trimmed name, or throws with a user-facing message.
 */
export function validateTargetName(name: string): string {
  const n = (name ?? "").trim();
  if (!n) throw new Error("Repository name is required");
  if (n.length > 100) throw new Error("Repository name is too long (max 100 chars)");
  if (CONTROL_CHARS.test(n)) throw new Error("Repository name contains control characters");
  if (/[<>:"/\\|?*]/.test(n)) {
    throw new Error('Repository name contains an illegal character (one of < > : " / \\ | ? *)');
  }
  if (n.startsWith("-")) throw new Error("Repository name cannot start with '-'");
  if (n.startsWith(".")) throw new Error("Repository name cannot start with '.'");
  if (/[. ]$/.test(n)) throw new Error("Repository name cannot end with '.' or a space");
  if (n.includes("..")) throw new Error("Repository name cannot contain '..'");
  const stem = (n.split(".")[0] ?? "").toUpperCase();
  if (RESERVED_WIN.has(stem)) throw new Error(`"${n}" is a reserved Windows device name`);
  return n;
}

function deriveNameFromPath(p: string): string {
  const segs = p.split("/").filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  return last.replace(/\.git$/i, "");
}

/** True for loopback / link-local / private / clearly-internal hosts (SSRF guard). */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) {
    return true;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 127) return true; // this-host / loopback
    if (a === 10) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    return false;
  }
  if (h === "::1" || h === "::") return true;
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // link-local / ULA
  return false;
}

function assertHostAllowed(
  host: string,
  opts: { hostPolicy: HostPolicy; allowlistHosts?: Set<string> }
): void {
  const h = host.toLowerCase();
  if (opts.hostPolicy === "github") {
    if (h !== "github.com") {
      throw new Error(
        `Host '${host}' is not allowed (REPO_CLONE_HOST_POLICY=github). Only github.com is permitted.`
      );
    }
    return;
  }
  if (opts.hostPolicy === "allowlist") {
    if (!opts.allowlistHosts || !opts.allowlistHosts.has(h)) {
      throw new Error(`Host '${host}' is not in REPO_CLONE_ALLOWED_HOSTS`);
    }
    return;
  }
  // public: allow any external host but block internal/loopback (SSRF guard)
  if (isInternalHost(host)) {
    throw new Error(`Host '${host}' looks internal/loopback; refusing (SSRF guard)`);
  }
}

/**
 * Parse and validate a clone source under the configured host policy. Accepts
 * `owner/repo`, `https://…`, `ssh://…`, and scp-style `git@host:owner/repo`.
 * Rejects other schemes (file:, ext:, http:, …), embedded credentials,
 * leading dashes, and control chars. Throws a user-facing Error otherwise.
 */
export function parseSource(
  rawSource: string,
  opts: { hostPolicy: HostPolicy; allowlistHosts?: Set<string> }
): ParsedSource {
  const source = (rawSource ?? "").trim();
  if (!source) throw new Error("A clone source is required");
  if (CONTROL_CHARS.test(source)) throw new Error("Source contains control characters");
  if (source.startsWith("-")) throw new Error("Source cannot start with '-'");

  // owner/repo shorthand (no scheme, single slash)
  if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(source)) {
    const repo = source.split("/")[1] ?? "";
    const name = validateTargetName(deriveNameFromPath(repo));
    if (opts.hostPolicy === "allowlist" && !opts.allowlistHosts?.has("github.com")) {
      throw new Error("owner/repo shorthand needs github.com in REPO_CLONE_ALLOWED_HOSTS");
    }
    return { kind: "gh", canonicalSource: source, defaultName: name };
  }

  // scp-style: git@host:owner/repo(.git)  (no scheme)
  const scp = source.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/);
  if (scp && !source.includes("://")) {
    const host = scp[2]!;
    const pathPart = scp[3]!;
    assertHostAllowed(host, opts);
    const name = validateTargetName(deriveNameFromPath(pathPart));
    if (host.toLowerCase() === "github.com") {
      const ownerRepo = pathPart.replace(/\.git$/i, "");
      return { kind: "gh", canonicalSource: ownerRepo, defaultName: name };
    }
    return { kind: "git", canonicalSource: source, defaultName: name };
  }

  // URL form
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("Unrecognized source format (expected owner/repo, https://…, ssh://…, or git@host:owner/repo)");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "https" && scheme !== "ssh") {
    throw new Error(`Unsupported URL scheme '${scheme}:' (only https and ssh are allowed)`);
  }
  if (url.password) throw new Error("Source must not embed credentials (user:password@…)");
  if (scheme === "https" && url.username) {
    throw new Error("Source must not embed a username");
  }
  const host = url.hostname;
  assertHostAllowed(host, opts);

  if (host.toLowerCase() === "github.com" && scheme === "https") {
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length >= 2) {
      const repo = (segs[1] ?? "").replace(/\.git$/i, "");
      const name = validateTargetName(repo);
      return { kind: "gh", canonicalSource: `${segs[0]}/${repo}`, defaultName: name };
    }
  }
  const name = validateTargetName(deriveNameFromPath(url.pathname));
  return { kind: "git", canonicalSource: source, defaultName: name };
}

const GIT = process.platform === "win32" ? "git.exe" : "git";
const GH = process.platform === "win32" ? "gh.exe" : "gh";

/** Non-interactive, hardened git environment (no prompts, no risky protocols). */
function hardenedGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    GCM_INTERACTIVE: "never",
  };
}

/** git -c hardening flags applied to every clone. */
const GIT_HARDENING = [
  "-c", "protocol.ext.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "protocol.ftp.allow=never",
  "-c", "credential.helper=",
  "-c", "core.symlinks=false",
];

export class RepoProvisioner {
  private readonly activePids = new Set<number>();

  constructor(
    private readonly reposRoot: string,
    private readonly logger: Logger,
    private readonly opts: {
      hostPolicy: HostPolicy;
      allowlistHosts?: Set<string>;
      cloneTimeoutMs?: number;
    }
  ) {}

  /** Remove any leftover `.staging-*` dirs (e.g. after a crash) at startup. */
  sweepStaleStaging(): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.reposRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith(".staging-")) {
        const p = path.join(this.reposRoot, e.name);
        try {
          fs.rmSync(p, { recursive: true, force: true });
          this.logger.info({ dir: p }, "swept stale staging dir");
        } catch (err) {
          this.logger.warn({ err, dir: p }, "failed to sweep staging dir");
        }
      }
    }
  }

  /** Force-kill any in-flight provisioning child process trees (on shutdown). */
  shutdown(): void {
    for (const pid of this.activePids) killTree(pid);
    this.activePids.clear();
  }

  async clone(rawSource: string, requestedName?: string): Promise<ProvisionResult> {
    const parsed = parseSource(rawSource, this.opts);
    const name = requestedName ? validateTargetName(requestedName) : parsed.defaultName;
    const finalPath = path.join(this.reposRoot, name);
    if (fs.existsSync(finalPath)) {
      throw new Error(`\`${name}\` already exists under REPOS_ROOT. Use \`/seam repo set ${name}\`.`);
    }
    const staging = this.stagingDir();
    try {
      if (parsed.kind === "gh") {
        await this.run(GH, ["repo", "clone", parsed.canonicalSource, staging], hardenedGitEnv());
      } else {
        await this.run(GIT, [...GIT_HARDENING, "clone", "--", parsed.canonicalSource, staging], hardenedGitEnv());
      }
      await renameWithRetry(staging, finalPath, this.logger);
      return { path: finalPath, name };
    } catch (err) {
      await this.rmStaging(staging);
      throw err;
    }
  }

  async init(requestedName: string): Promise<ProvisionResult> {
    const name = validateTargetName(requestedName);
    const finalPath = path.join(this.reposRoot, name);
    if (fs.existsSync(finalPath)) {
      throw new Error(`\`${name}\` already exists under REPOS_ROOT. Use \`/seam repo set ${name}\`.`);
    }
    const staging = this.stagingDir();
    try {
      await fsp.mkdir(staging);
      await this.run(GIT, ["init", "-b", "main", staging], hardenedGitEnv());
      // An initial empty commit gives a valid HEAD so Copilot's git reads don't
      // choke on a ref that points at nothing.
      const identity: NodeJS.ProcessEnv = {
        ...hardenedGitEnv(),
        GIT_AUTHOR_NAME: "seam-acp",
        GIT_AUTHOR_EMAIL: "seam-acp@localhost",
        GIT_COMMITTER_NAME: "seam-acp",
        GIT_COMMITTER_EMAIL: "seam-acp@localhost",
      };
      await this.run(GIT, ["-C", staging, "commit", "--allow-empty", "-m", "Initial commit"], identity);
      await renameWithRetry(staging, finalPath, this.logger);
      return { path: finalPath, name };
    } catch (err) {
      await this.rmStaging(staging);
      throw err;
    }
  }

  private stagingDir(): string {
    return path.join(this.reposRoot, `.staging-${randomBytes(4).toString("hex")}`);
  }

  private async rmStaging(dir: string): Promise<void> {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn({ err, dir }, "failed to remove staging dir");
    }
  }

  private run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    const timeoutMs = this.opts.cloneTimeoutMs ?? 300_000;
    return new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      if (typeof child.pid === "number") this.activePids.add(child.pid);
      let stderrTail = "";
      const cap = (buf: Buffer) => {
        stderrTail = (stderrTail + buf.toString()).slice(-2000);
      };
      child.stdout?.on("data", () => {});
      child.stderr?.on("data", cap);

      const timer = setTimeout(() => {
        if (typeof child.pid === "number") killTree(child.pid);
        reject(new Error(`\`${file}\` timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        if (typeof child.pid === "number") this.activePids.delete(child.pid);
        reject(new Error(`failed to launch ${file}: ${(err as Error).message}`));
      });
      // Wait for 'close' (all stdio flushed) not just 'exit', so the rename that
      // follows doesn't race open file handles.
      child.on("close", (code) => {
        clearTimeout(timer);
        if (typeof child.pid === "number") this.activePids.delete(child.pid);
        if (code === 0) {
          resolve();
        } else {
          const tail = stderrTail.trim().split("\n").slice(-4).join("\n");
          reject(new Error(`${file} exited with code ${code}${tail ? `:\n${tail}` : ""}`));
        }
      });
    });
  }
}

/** Kill an entire process tree by PID (Windows: taskkill /T; POSIX: kill). */
function killTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

/**
 * Rename staging -> final with bounded retry. NTFS rename is atomic on the same
 * volume, but antivirus/indexer scanning freshly-cloned files can cause
 * transient EPERM/EBUSY/EACCES; we retry with short backoff. Never replaces an
 * existing final path.
 */
async function renameWithRetry(staging: string, finalPath: string, logger: Logger): Promise<void> {
  if (fs.existsSync(finalPath)) {
    throw new Error(`target already exists: ${finalPath}`);
  }
  const delays = [50, 100, 200, 500, 1000];
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(staging, finalPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!transient || attempt >= delays.length) throw err;
      logger.warn({ err, staging, finalPath, attempt }, "rename retry (transient sharing error)");
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}
