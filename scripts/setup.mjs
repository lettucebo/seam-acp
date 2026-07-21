#!/usr/bin/env node
// seam-acp shared installer core (zero external deps — Node >=22 built-ins only).
//
// The thin native bootstrappers (install.sh / install.ps1) install prerequisites,
// then hand off here for the parts that MUST behave identically on every OS:
//   1. Collect / merge configuration into .env (safe, in-place, secret-preserving).
//   2. Install deps + build (npm ci + npm run build).
//   3. Best-effort auth checks (gh, copilot) with clear guidance.
//
// Residency (Task Scheduler / launchd / systemd) is handled by the native
// installer after this exits 0, because it is inherently OS-specific.
//
// Flags: --yes  --dry-run  --skip-auth  --help

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyEnvUpdates,
  parseEnv,
  detectNewline,
} from "./lib/env-file.mjs";
import {
  validateCommandName,
  validateIdList,
  validatePort,
  validatePermissionPolicy,
} from "./lib/validate.mjs";

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(REPO_ROOT, ".env");
const ENV_EXAMPLE = path.join(REPO_ROOT, ".env.example");

// ---- flags -----------------------------------------------------------------
const argv = new Set(process.argv.slice(2));
const FLAG = {
  yes: argv.has("--yes") || argv.has("-y"),
  dryRun: argv.has("--dry-run"),
  skipAuth: argv.has("--skip-auth"),
  help: argv.has("--help") || argv.has("-h"),
};
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const interactive = isTTY && !FLAG.yes;

// ---- output ----------------------------------------------------------------
const useColor =
  process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
const bold = (s) => c("1", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const red = (s) => c("31", s);
const dim = (s) => c("2", s);
const info = (s) => console.log(s);
const step = (s) => console.log(`\n${bold("▶ " + s)}`);
const warn = (s) => console.log(yellow("! " + s));
const okmsg = (s) => console.log(green("✓ " + s));
const failmsg = (s) => console.log(red("✗ " + s));

function die(msg, code = 1) {
  failmsg(msg);
  process.exit(code);
}

if (FLAG.help) {
  info(`seam-acp setup

Usage: node scripts/setup.mjs [--yes] [--dry-run] [--skip-auth]

  --yes        Non-interactive: keep existing/default values, don't prompt.
               Fails if a required value is missing and cannot be inferred.
  --dry-run    Show what would change; write nothing, build nothing.
  --skip-auth  Skip the gh/copilot auth checks (treat as unverified).
`);
  process.exit(0);
}

// ---- prompt helpers --------------------------------------------------------
function ask(query, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const suffix = def ? dim(` [${def}]`) : "";
    rl.question(`${query}${suffix}: `, (answer) => {
      rl.close();
      const a = answer.trim();
      resolve(a === "" && def !== undefined ? def : a);
    });
  });
}

function askHidden(query) {
  return new Promise((resolve) => {
    process.stdout.write(`${query}: `);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    let input = "";
    const onData = (buf) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(input);
        }
        if (ch === "\u0003") {
          stdin.setRawMode?.(wasRaw);
          stdin.pause();
          process.stdout.write("\n");
          process.exit(130);
        } else if (ch === "\u007f" || ch === "\b") {
          if (input.length) {
            input = input.slice(0, -1);
            process.stdout.write("\b \b");
          }
        } else {
          input += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(query, def = true) {
  if (!interactive) return def;
  const ans = (await ask(`${query} ${def ? "(Y/n)" : "(y/N)"}`, "")).toLowerCase();
  if (ans === "") return def;
  return ans === "y" || ans === "yes";
}

// ---- config schema ---------------------------------------------------------
function defaultReposRoot() {
  if (process.platform === "win32") {
    return path.join(process.env.USERPROFILE || os.homedir(), "source", "repos");
  }
  return path.join(os.homedir(), "Projects");
}

const FIELDS = [
  {
    key: "DISCORD_BOT_TOKEN",
    label: "Discord bot token (from the Developer Portal → Bot → Reset Token)",
    secret: true,
    required: true,
    validate: (v) => (v.trim() ? { ok: true } : { ok: false, error: "required" }),
  },
  {
    key: "DISCORD_ALLOWED_USER_IDS",
    label: "Allowed Discord user IDs — your own ID at minimum (comma-separated)",
    required: true,
    validate: (v) => validateIdList(v, { required: true }),
  },
  {
    key: "DISCORD_COMMAND_NAME",
    label: "Slash-command name — what to call it, e.g. copilot → /copilot",
    default: "seam",
    validate: validateCommandName,
  },
  {
    key: "REPOS_ROOT",
    label: "Root folder containing repos the agent may work in",
    default: defaultReposRoot(),
    validate: (v) => (v.trim() ? { ok: true } : { ok: false, error: "required" }),
    ensureDir: true,
  },
  {
    key: "DISCORD_ALLOWED_CHANNEL_IDS",
    label: "Allowed parent channel IDs — optional, REQUIRED for /repo clone|new",
    required: false,
    validate: (v) => validateIdList(v, { required: false }),
  },
  {
    key: "DISCORD_DEV_GUILD_ID",
    label: "Dev guild ID for instant slash-command registration — optional, recommended",
    required: false,
    validate: (v) => validateIdList(v, { required: false }),
  },
  {
    key: "DEFAULT_MODEL",
    label: "Default model id (e.g. auto, gpt-5.4, claude-opus-4.7)",
    default: "auto",
  },
  {
    key: "DEFAULT_PERMISSION_POLICY",
    label: "Default permission policy: ask | always | deny",
    default: "ask",
    validate: validatePermissionPolicy,
    warnIf: (v) =>
      v === "always"
        ? "'always' auto-approves EVERYTHING (yolo) — only for a private, trusted server"
        : null,
  },
  {
    key: "HEALTH_PORT",
    label: "Health/liveness port",
    default: "3000",
    validate: validatePort,
  },
];

// ---- copilot path resolution ----------------------------------------------
function which(cmd) {
  const finder = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(finder, [cmd], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function resolveCopilotPath() {
  const hits = which("copilot");
  if (!hits) return null;
  if (process.platform !== "win32") return hits[0];
  // Windows: the app spawns without a shell, so it needs a real .exe, NOT the
  // npm .cmd/.ps1 shim. Prefer an .exe hit.
  const exe = hits.find((h) => h.toLowerCase().endsWith(".exe"));
  return exe || hits[0];
}

// ---- main ------------------------------------------------------------------
async function main() {
  info(bold("seam-acp — configuration & build"));
  info(dim(`repo: ${REPO_ROOT}`));
  if (FLAG.dryRun) warn("dry-run: no files will be written, nothing will be built");

  // Guard: must be the seam-acp repo.
  let pkg;
  try {
    pkg = require(path.join(REPO_ROOT, "package.json"));
  } catch {
    die("could not read package.json — run this from inside the cloned seam-acp repo");
  }
  if (pkg.name !== "seam-acp") {
    die(`this is not the seam-acp repo (package.json name = ${pkg.name})`);
  }

  // Load existing .env (as data) + .env.example as the base for a fresh file.
  const existingText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
  const exampleText = fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, "utf8") : "";
  const baseText = existingText || exampleText;
  const existingValues = parseEnv(existingText);

  step("Configuration");
  if (!interactive) {
    info(dim(FLAG.yes ? "non-interactive (--yes): using existing/default values" : "no TTY: using existing/default values"));
  }

  const updates = {};
  const problems = [];
  for (const f of FIELDS) {
    const current = existingValues[f.key];
    const fallback = current ?? f.default;

    if (!interactive) {
      const value = fallback ?? "";
      const res = f.validate ? f.validate(value) : { ok: true };
      if (!res.ok) {
        // validate() returns ok for optional-empty, so any failure here is a
        // real problem (required-missing or an invalid managed value) → fatal.
        problems.push(`${f.key} (${res.error})`);
        continue;
      }
      if (current === undefined || current !== value) updates[f.key] = value;
      continue;
    }

    // Interactive: prompt with validation loop.
    for (;;) {
      const value = f.secret
        ? (await askHidden(current ? `${f.label} ${dim("(Enter = keep existing)")}` : f.label)) || current || ""
        : await ask(f.label, fallback);
      const res = f.validate ? f.validate(value) : { ok: true };
      if (!res.ok) {
        failmsg(`${f.key}: ${res.error}`);
        continue;
      }
      const warnMsg = f.warnIf ? f.warnIf(value) : null;
      if (warnMsg && !(await confirm(`${warnMsg}. Continue?`, false))) continue;
      if (value !== (current ?? "")) updates[f.key] = value;
      break;
    }
  }

  if (problems.length) {
    failmsg("invalid or missing configuration and no TTY to prompt:");
    for (const m of problems) info("  - " + m);
    info(dim("Fix them in .env (or run interactively) and re-run."));
    process.exit(2);
  }

  // Auto-manage COPILOT_CLI_PATH so the launcher/app use an explicit absolute
  // binary. dotenv loads with override:true, so an empty value would ERASE the
  // launcher's path — write a real resolved path, or DELETE the key entirely.
  const copilotPath = resolveCopilotPath();
  const winShim =
    copilotPath && process.platform === "win32" && !copilotPath.toLowerCase().endsWith(".exe");
  if (copilotPath && !winShim) {
    if (existingValues.COPILOT_CLI_PATH !== copilotPath) updates.COPILOT_CLI_PATH = copilotPath;
  } else {
    if (winShim) {
      warn(`resolved copilot is not an .exe (${copilotPath}); the app spawns without a shell and cannot run .cmd/.ps1 shims. Prefer 'winget install GitHub.Copilot'.`);
    }
    // Drop an empty COPILOT_CLI_PATH= (e.g. copied from .env.example) so it can't
    // override the launcher's env at runtime. Never delete a user-set path.
    if ((existingValues.COPILOT_CLI_PATH ?? "") === "") updates.COPILOT_CLI_PATH = null;
  }

  // Write .env (atomic, restrictive perms established before secret bytes).
  const newText = applyEnvUpdates(baseText, updates);
  const changed = newText !== existingText;
  step("Writing .env");
  if (Object.keys(updates).length === 0 && !changed) {
    okmsg(".env already up to date");
  } else if (FLAG.dryRun) {
    const redactedKeys = Object.keys(updates).map((k) =>
      FIELDS.find((f) => f.key === k)?.secret ? `${k}=***` : `${k}=${updates[k]}`
    );
    info(dim("would set: " + (redactedKeys.join(", ") || "(nothing)")));
  } else {
    if (existingText && changed) {
      const backup = `${ENV_PATH}.${Date.now()}.bak`;
      writeFilePrivate(backup, existingText);
      okmsg(`backed up existing .env → ${path.basename(backup)}`);
    }
    writeFilePrivate(ENV_PATH, newText);
    okmsg(`.env written (${Object.keys(updates).length} key(s) set)`);
  }

  // Ensure REPOS_ROOT + data/ exist.
  const reposRoot = updates.REPOS_ROOT ?? existingValues.REPOS_ROOT ?? defaultReposRoot();
  ensureDir(reposRoot, "REPOS_ROOT");
  ensureDir(path.join(REPO_ROOT, "data"), "data");

  // Build.
  step("Installing dependencies & building");
  if (!FLAG.dryRun && !which("npm")) {
    die("npm not found on PATH (it normally ships with Node) — install/repair Node and re-run");
  }
  const hasLock = fs.existsSync(path.join(REPO_ROOT, "package-lock.json"));
  const hasModules = fs.existsSync(path.join(REPO_ROOT, "node_modules"));
  // `npm ci` wipes node_modules — deterministic for a FRESH install, but on a
  // Windows re-run a running bot locks better_sqlite3.node and the wipe fails
  // (EPERM). Reconcile with `npm install` when node_modules already exists.
  const npmSub = hasLock && !hasModules ? "ci" : "install";
  runOrDry(["npm", npmSub]);
  runOrDry(["npm", "run", "build"]);

  // Auth checks (best-effort, never block).
  step("Auth checks");
  if (FLAG.skipAuth) {
    warn("skipped (--skip-auth): auth is UNVERIFIED");
  } else {
    checkAuth(copilotPath);
  }

  step("Done");
  okmsg("configuration and build complete");
  info(dim("The native installer will next offer 24/7 residency and a readiness check."));
}

// ---- helpers ---------------------------------------------------------------
function writeFilePrivate(file, content) {
  const tmp = `${file}.tmp.${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600); // perms set before any bytes written
  try {
    fs.writeFileSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(tmp, file);
  // Windows: 0o600 is a no-op; restrict the DACL to the current user (best effort).
  if (process.platform === "win32") {
    const user = process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
    if (user) {
      spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
        stdio: "ignore",
      });
    }
  }
}

function ensureDir(dir, label) {
  if (FLAG.dryRun) return;
  if (fs.existsSync(dir)) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    okmsg(`created ${label}: ${dir}`);
  } catch (e) {
    warn(`could not create ${label} (${dir}): ${e.message}`);
  }
}

function runOrDry(cmd) {
  if (FLAG.dryRun) {
    info(dim("would run: " + cmd.join(" ")));
    return;
  }
  info(dim("$ " + cmd.join(" ")));
  // On Windows, npm is a `.cmd` shim; spawning it with shell:false throws EINVAL
  // (Node's CVE-2024-27980 fix, present in every Node >=22). Run it through the
  // shell there. Our args are static (ci / run build), so there's no injection.
  const isWin = process.platform === "win32";
  const r = isWin
    ? spawnSync(cmd.join(" "), { cwd: REPO_ROOT, stdio: "inherit", shell: true })
    : spawnSync(cmd[0], cmd.slice(1), { cwd: REPO_ROOT, stdio: "inherit", shell: false });
  if (r.status !== 0) die(`command failed: ${cmd.join(" ")}`);
}

function checkAuth(copilotPath) {
  // gh — needed by the default github clone policy.
  const gh = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (gh.status === 0) okmsg("gh: authenticated");
  else warn("gh: not authenticated — run `gh auth login` (needed for /repo clone under the default github policy)");

  // copilot — best-effort. Presence != verified; guide the user to log in.
  if (!copilotPath) {
    warn("copilot CLI not found on PATH — install it, then run `copilot` and `/login`");
    return;
  }
  const home =
    process.platform === "win32"
      ? process.env.USERPROFILE || os.homedir()
      : os.homedir();
  const cfg = path.join(home, ".copilot", "config.json");
  if (fs.existsSync(cfg)) okmsg(`copilot: config found (${dim(cfg)}) — if turns fail, run \`copilot login\``);
  else warn("copilot: not logged in — run `copilot login` (or `copilot` then `/login`)");
}

main().catch((e) => die(e?.stack || String(e)));
