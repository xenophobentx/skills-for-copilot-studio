---
name: chat-sdk
user-invocable: false
description: Send a message to a Copilot Studio agent via the Copilot Studio Client SDK (M365). Use for agents with integrated auth (Entra ID SSO). Requires an App Registration Client ID.
argument-hint: <utterance>
allowed-tools: Bash(node *chat-with-agent.bundle.js *), Read, Glob
agent: copilot-studio-test
---

# Chat via Copilot Studio SDK

Send a single utterance to a published agent via the Copilot Studio Client SDK. Use this for agents with **integrated authentication / Entra ID SSO** (authenticationmode 2).

`$ARGUMENTS` is the text the user gave with this skill. If your client does not fill it in, use the user's request instead.

**Sandbox.** `chat-with-agent.bundle.js` signs in, calls the network and writes to `~/.copilot-studio-cli`. If your client runs commands in a sandbox (for example Codex without `--yolo`), run it outside the sandbox, with the user's permission. If you cannot ask (Codex with `approval_policy = "never"`), say what needs network access and stop. With full access (`--yolo`), run it directly.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/chat-sdk/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## Prerequisites

Requires prior authentication via `/copilot-studio:test-auth`. Do NOT ask the user for a client ID yourself — the test-auth skill handles app registration setup and authentication.

## Instructions

1. Run the script with `--client-id` and the utterance from `$ARGUMENTS`:

   ```bash
   node <pluginRoot>/scripts/chat-with-agent.bundle.js \
     --client-id "<clientId>" "<utterance>" [--agent-dir <path>]
   ```

2. **Authentication**: Requires prior authentication via `/copilot-studio:test-auth`. The token is cached in the `"test-agent"` slot and shared with the eval API. If auth fails or the SDK hangs, tell the caller to re-run `test-auth`. If there is no cached token the script signs in itself: with a browser, or with a device code over SSH or without a display (`--auth-mode device|interactive` forces one). A device code cannot be shown while this command runs, so if there is no cached token, sign in with `/copilot-studio:test-auth` first.

3. Parse the JSON output from stdout:

```json
{
  "status": "ok",
  "protocol": "m365",
  "utterance": "hello",
  "conversation_id": "abc123-...",
  "start_activities": [ ... ],
  "activities": [ ... ]
}
```

Display the agent's response from the `activities` array:
- **Text**: activities where `type === "message"` — show `text`
- **Suggested actions**: `suggestedActions.actions` array
- **Adaptive cards**: `attachments` with `contentType === "application/vnd.microsoft.card.adaptive"`

**Save `conversation_id`** for follow-ups.

## Messages with double quotes

On Windows PowerShell 5.1 a message that contains double quotes is split into several arguments, and the script stops with "separate message arguments". Write the message to a UTF-8 file and pass `--message-file` instead of the message:

```bash
node <pluginRoot>/scripts/chat-with-agent.bundle.js \
  --client-id "<clientId>" --message-file "<path>"
```

## Multi-turn

Pass `--conversation-id` from the previous response:

```bash
node <pluginRoot>/scripts/chat-with-agent.bundle.js \
  --client-id "<id>" "<follow-up>" --conversation-id "<id>"
```

SDK sessions do not expire as quickly as DirectLine. Reuse `conversation_id` automatically for follow-ups.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `Authentication failed` | Wrong client ID or tenant | Verify app registration and permissions |
| `Could not obtain conversation_id` | Agent not published or wrong config | Verify agent is published |
