// Pure, zero-dependency validators for installer input. Kept separate and tested
// (test/validate.test.ts) so the interactive prompts in setup.mjs stay thin.
//
// Each returns { ok: boolean, error?: string }.

const ok = () => ({ ok: true });
const err = (error) => ({ ok: false, error });

/** DISCORD_COMMAND_NAME: lowercase slug, 1-32 of a-z 0-9 _ - (matches config.ts). */
export function validateCommandName(value) {
  return /^[a-z0-9_-]{1,32}$/.test(String(value))
    ? ok()
    : err("must be 1-32 chars of lowercase a-z, 0-9, underscore, or hyphen");
}

/** Comma-separated numeric Discord snowflake IDs (users/channels/guilds). */
export function validateIdList(value, { required = false } = {}) {
  const raw = String(value).trim();
  if (raw === "") {
    return required ? err("at least one ID is required") : ok();
  }
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.every((p) => /^\d+$/.test(p))) return ok();
  return err("must be comma-separated numeric IDs");
}

/** TCP port 1-65535. */
export function validatePort(value) {
  const n = Number(String(value).trim());
  return Number.isInteger(n) && n >= 1 && n <= 65535
    ? ok()
    : err("must be an integer between 1 and 65535");
}

/** DEFAULT_PERMISSION_POLICY: ask | always | deny. */
export function validatePermissionPolicy(value) {
  return ["ask", "always", "deny"].includes(String(value).trim())
    ? ok()
    : err("must be one of: ask, always, deny");
}
