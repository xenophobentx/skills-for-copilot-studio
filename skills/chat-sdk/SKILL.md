---
user-invocable: false
description: Send a message to a Copilot Studio agent via the Copilot Studio Client SDK (M365). Use for agents with integrated auth (Entra ID SSO). Requires an App Registration Client ID.
argument-hint: <utterance>
allowed-tools: Bash(node *chat-with-agent.bundle.js *), Read, Glob
agent: copilot-studio-test
---

# Chat via Copilot Studio SDK

Send a single utterance to a published agent via the Copilot Studio Client SDK. Use this for agents with **integrated authentication / Entra ID SSO** (authenticationmode 2).

## Prerequisites

Requires prior authentication via `/copilot-studio:test-auth`. Do NOT ask the user for a client ID yourself — the test-auth skill handles app registration setup and authentication.

## Instructions

1. Run the script with `--client-id` and the utterance from `$ARGUMENTS`:

   ```bash
   node ${CLAUDE_SKILL_DIR}/../../scripts/chat-with-agent.bundle.js \
     --client-id "<clientId>" "<utterance>" [--agent-dir <path>]
   ```

2. **Authentication**: Requires prior authentication via `/copilot-studio:test-auth`. The token is cached in the `"test-agent"` slot and shared with the eval API. If auth fails or the SDK hangs, tell the caller to re-run `test-auth`. If there is no cached token the script signs in itself: with a browser, or with a device code over SSH or without a display (`--auth-mode device|interactive` forces one). When the output has a `{"status":"device_code",...}` line, show the user the `verificationUri` and `userCode` right away and wait for the command to finish.

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
node ${CLAUDE_SKILL_DIR}/../../scripts/chat-with-agent.bundle.js \
  --client-id "<clientId>" --message-file "<path>"
```

## Multi-turn

Pass `--conversation-id` from the previous response:

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/chat-with-agent.bundle.js \
  --client-id "<id>" "<follow-up>" --conversation-id "<id>"
```

SDK sessions do not expire as quickly as DirectLine. Reuse `conversation_id` automatically for follow-ups.

## Error Handling

| Error | Cause | Resolution |
|-------|-------|------------|
| `Authentication failed` | Wrong client ID or tenant | Verify app registration and permissions |
| `Could not obtain conversation_id` | Agent not published or wrong config | Verify agent is published |
