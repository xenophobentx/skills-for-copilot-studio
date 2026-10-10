---
name: detect-mode
user-invocable: false
description: Detect a Copilot Studio agent's authentication mode (DirectLine vs M365) by querying Dataverse. Returns the mode and connection details needed to chat.
argument-hint: "[--agent-dir <path>]"
allowed-tools: Bash(node *chat-with-agent.bundle.js --detect-only *), Read, Glob
agent: copilot-studio-test
---

# Detect Agent Authentication Mode

Query the Dataverse `bots` entity to determine whether the agent uses DirectLine (no auth / manual auth) or the Copilot Studio SDK (integrated auth / Entra ID SSO).

`$ARGUMENTS` is the text the user gave with this skill. If your client does not fill it in, use the user's request instead.

**Sandbox.** `chat-with-agent.bundle.js --detect-only` signs in, queries Dataverse and writes to `~/.copilot-studio-cli`. Run the command and do not assume it is blocked: a sandbox can allow the network and the folders it needs. If the command fails with a concrete sandbox error (network unreachable, `EPERM`, permission denied, read-only file system), ask for only the access that is missing (the network, write access to the folder in the error, or on macOS the keychain) and run it again. If you cannot ask (Codex with `approval_policy = "never"`), say which access is missing and stop.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/detect-mode/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## Instructions

1. Run the detect-only command:

   ```bash
   node "<pluginRoot>/scripts/chat-with-agent.bundle.js" --detect-only $ARGUMENTS
   ```

   If the agent is not at the project root, pass `--agent-dir <path>`.

2. Parse the JSON output from stdout:

   ### DirectLine mode (authenticationmode 1 or 3)
   ```json
   { "status": "ok", "mode": "directline", "authenticationmode": 1, "tokenEndpoint": "https://...", "schemaName": "..." }
   ```
   The agent uses **no authentication** or **manual authentication**. No user credentials needed. The `tokenEndpoint` is ready to use with `/copilot-studio:chat-directline`.

   ### M365 mode (authenticationmode 2)
   ```json
   { "status": "ok", "mode": "m365", "authenticationmode": 2, "schemaName": "..." }
   ```
   The agent uses **integrated authentication (Entra ID SSO)**. An App Registration Client ID is needed for `/copilot-studio:chat-sdk`.

3. Return the result to the caller. Do not proceed to chat — that is a separate step.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `No agent.mcs.yml found` | No agent in workspace | Clone the agent first |
| `No .mcs/conn.json found` | Agent not cloned via VS Code extension | Clone with the extension |
| `Could not detect authentication mode` | No cached Dataverse token | Run a push/pull first to cache tokens, or ask the user about their auth config |
