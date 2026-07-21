import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";

/**
 * `/seam` slash-command tree. Subcommands mirror the C# `cp …` text commands.
 * Models are resolved at runtime via the agent's `availableModels`, but for
 * v1 we accept a free-form string with autocomplete in a later phase.
 */
export function buildSeamCommand(
  reposRoot?: string,
  commandName = "seam"
): SlashCommandBuilder {
  // Slash-command option descriptions are static at registration time, but
  // REPOS_ROOT is known at startup, so bake the real path in when provided.
  // (Discord caps option/subcommand descriptions at 100 chars.)
  const root = reposRoot ?? "REPOS_ROOT";
  const cmd = new SlashCommandBuilder()
    .setName(commandName)
    .setDescription("Control the seam-acp agent");

  cmd.addSubcommand((sub) =>
    sub
      .setName("new")
      .setDescription("Create a new agent thread")
      .addStringOption((o) =>
        o
          .setName("name")
          .setDescription("Thread name (optional)")
          .setRequired(false)
      )
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("repo")
      .setDescription("Manage the working repo for this thread")
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription("Set the working repo for this thread (type to search)")
          .addStringOption((o) =>
            o
              .setName("path")
              .setDescription(`Repo under ${root}`.slice(0, 100))
              .setRequired(true)
              .setAutocomplete(true)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription(`List repos under ${root}`.slice(0, 100))
      )
      .addSubcommand((sub) =>
        sub
          .setName("clone")
          .setDescription("Clone a remote repo into REPOS_ROOT and bind it")
          .addStringOption((o) =>
            o
              .setName("source")
              .setDescription("owner/repo, https://…, ssh://…, or git@host:owner/repo")
              .setRequired(true)
          )
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("Optional folder name (defaults to the repo name)")
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("new")
          .setDescription("Create a new empty git repo in REPOS_ROOT and bind it")
          .addStringOption((o) =>
            o
              .setName("name")
              .setDescription("New project folder name")
              .setRequired(true)
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("model")
      .setDescription("Get or set the agent model for this thread")
      .addStringOption((o) =>
        o.setName("id").setDescription("Model id").setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("mode")
      .setDescription("Set the agent operational mode")
      .addStringOption((o) =>
        o.setName("id").setDescription("Mode id").setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("effort")
      .setDescription("Set reasoning effort (or run with no level to see current)")
      .addStringOption((o) =>
        o
          .setName("level")
          .setDescription("low | medium | high | xhigh | max — agent falls back if model doesn't support it")
          .setRequired(false)
          .addChoices(
            { name: "low", value: "low" },
            { name: "medium", value: "medium" },
            { name: "high", value: "high" },
            { name: "xhigh", value: "xhigh" },
            { name: "max", value: "max" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("abort").setDescription("Stop the current turn — cancel, then force-kill if it's hung")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("cancel").setDescription("Gracefully cancel the current turn (cleaner; use abort if it ignores it)")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("kill").setDescription("Force-kill ALL active agent sessions, including this thread (each resumes on next message)")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("image")
      .setDescription("Generate an image (Nano Banana 2 / Pro, Imagen 4, FLUX 2)")
      .addStringOption((o) =>
        o
          .setName("prompt")
          .setDescription("Image prompt. Leave blank to type a longer one in a modal.")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription(
        "End the current ACP session for this thread; next message starts fresh"
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("tools")
      .setDescription("Set tool allow / exclude lists")
      .addStringOption((o) =>
        o
          .setName("action")
          .setDescription("allow | exclude")
          .setRequired(true)
          .addChoices(
            { name: "allow", value: "allow" },
            { name: "exclude", value: "exclude" }
          )
      )
      .addStringOption((o) =>
        o
          .setName("list")
          .setDescription("Comma-separated tool names (empty = clear)")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("config").setDescription("Show current session config")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("config-set")
      .setDescription("Replace session config with a JSON blob")
      .addStringOption((o) =>
        o.setName("json").setDescription("Config JSON").setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("sessions").setDescription("List recent sessions")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("init")
      .setDescription("Bind this thread as a session and show repo picker")
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("approve")
      .setDescription("Set permission policy for this thread")
      .addStringOption((o) =>
        o
          .setName("policy")
          .setDescription("always | ask | deny")
          .setRequired(true)
          .addChoices(
            { name: "always (auto-approve everything)", value: "always" },
            { name: "ask (prompt me on Discord)", value: "ask" },
            { name: "deny (auto-deny everything)", value: "deny" }
          )
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("agent")
      .setDescription(
        "Get or set the agent for this thread (resets the session when changed)"
      )
      .addStringOption((o) =>
        o
          .setName("id")
          .setDescription("Agent id (e.g. copilot, claude)")
          .setRequired(false)
      )
  );

  cmd.addSubcommand((sub) =>
    sub
      .setName("attach")
      .setDescription("Upload a local file from the host machine to this channel")
      .addStringOption((o) =>
        o
          .setName("path")
          .setDescription(
            "Absolute path, or path relative to an allowed root (REPOS_ROOT / ATTACH_ROOTS)"
          )
          .setRequired(true)
      )
  );

  cmd.addSubcommand((sub) =>
    sub.setName("whoami").setDescription("Show which account this thread's agent is signed in as")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("usage").setDescription("Show usage / credits for this thread's agent (agy only)")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("avatar").setDescription("Push the bot avatar and banner to Discord (force re-upload)")
  );

  cmd.addSubcommand((sub) =>
    sub.setName("help").setDescription("Show help")
  );

  cmd.addSubcommandGroup((g) =>
    g
      .setName("schedule")
      .setDescription("Recurring scheduled prompts for this thread")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Create a scheduled prompt (finish setup on the card)")
          .addAttachmentOption((o) =>
            o.setName("file").setDescription("Optional reference file (re-sent on every run)").setRequired(false)
          )
          .addAttachmentOption((o) =>
            o.setName("file2").setDescription("Optional reference file").setRequired(false)
          )
          .addAttachmentOption((o) =>
            o.setName("file3").setDescription("Optional reference file").setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("List this thread's scheduled prompts")
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Delete a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription(`Schedule id (see /${commandName} schedule list)`).setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("toggle")
          .setDescription("Enable or disable a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("addfile")
          .setDescription("Attach another reference file to a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
          .addAttachmentOption((o) => o.setName("file").setDescription("File to add").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("removefile")
          .setDescription("Remove a reference file from a scheduled prompt")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
          .addStringOption((o) => o.setName("filename").setDescription("Filename to remove").setRequired(true))
      )
      .addSubcommand((sub) =>
        sub
          .setName("edit")
          .setDescription("Edit a scheduled prompt (reopens the builder card)")
          .addStringOption((o) => o.setName("id").setDescription("Schedule id").setRequired(true))
      )
  );

  return cmd;
}

export type SeamSubcommand =
  | "new"
  | "repo"
  | "model"
  | "mode"
  | "effort"
  | "abort"
  | "cancel"
  | "kill"
  | "image"
  | "reset"
  | "tools"
  | "config"
  | "config-set"
  | "sessions"
  | "repos"
  | "init"
  | "approve"
  | "agent"
  | "attach"
  | "whoami"
  | "usage"
  | "avatar"
  | "help";

export function getSubcommand(
  i: ChatInputCommandInteraction
): SeamSubcommand {
  return i.options.getSubcommand(true) as SeamSubcommand;
}
