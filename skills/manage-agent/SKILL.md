---
name: manage-agent
user-invocable: false
description: Push/pull Copilot Studio agent content via the VS Code extension's LanguageServerHost LSP binary. Handles authentication (browser login, or a device code over SSH or without a display), sync push, sync pull, clone, and diff operations.
argument-hint: <push|pull|clone|changes|validate|publish|auth|list-agents|list-envs|doctor>
allowed-tools: Bash(node *manage-agent.bundle.js *), Read, Glob, Grep
context: fork
agent: copilot-studio-manage
---

# Manage Agent

Push and pull Copilot Studio agent content by calling the VS Code extension's LanguageServerHost binary directly, using the same custom LSP protocol the extension uses internally.

## IMPORTANT: Do Not Modify Scripts

This is a new capability under active development. The manage-agent scripts (`manage-agent.bundle.js`, `chat-with-agent.bundle.js`) are pre-built bundles that must not be modified, patched, or monkey-patched. If a script fails:

1. **Report the error as-is** — show the user the full error output
2. **Do not attempt to fix, patch, or work around script errors** — the scripts interact with the LSP binary using a specific protocol and any modifications will break things
3. **Direct the user to raise an issue** at https://github.com/microsoft/skills-for-copilot-studio/issues with the error output
4. **Suggest using the VS Code extension directly** — the user can perform the same push/pull/clone operations from the Copilot Studio VS Code extension UI as a fallback

## Prerequisites

1. **Copilot Studio VS Code extension** must be installed (`ms-copilotstudio.vscode-copilotstudio`).
2. **Azure AD app registration** (optional). If `--client-id` is omitted, the script uses VS Code's first-party client ID.
3. **Environment details** — tenant ID, environment ID, environment URL, and agent management URL. These come from the `.mcs/conn.json` inside a cloned agent workspace (created automatically during clone).

## Phase 0: Resolve Configuration

Search for `.mcs/conn.json` in the workspace and nearby directories to find existing connection details. The script auto-reads environment details from `conn.json`. If no `conn.json` is found, ask the user for the required parameters.

## Phase 1: Authenticate

All commands that need a token sign in the same way. If there is no cached token, the script picks a flow by itself:

- On a machine with a browser, a browser window opens for Microsoft sign-in. The script waits 5 minutes for it to finish and then fails with an error that names the alternative.
- Over SSH (`SSH_CONNECTION` or `SSH_TTY` is set), or on Linux without `DISPLAY` or `WAYLAND_DISPLAY`, the script uses the device code flow instead (see "When device code flow starts").

Add `--auth-mode device` to force the device code flow or `--auth-mode interactive` to force the browser. The environment variable `CPS_AUTH_MODE` does the same, and the flag wins. `CPS_AUTH_TIMEOUT_SECONDS` (1 to 3600) changes the browser wait (default 300).

A foreground Bash call returns its output only when the command ends, so start it in the background (Claude Code: `run_in_background: true`; GitHub Copilot CLI: bash `mode: "async"`), check its output after a few seconds, and when it has a `{"status":"device_code",...}` line show the user the `verificationUri` and `userCode` right away. Then wait for the command to finish.

Push, pull, clone, changes and list-agents use VS Code's first-party client ID with the Island API gateway. No separate auth step is needed before them. Just run the command directly (Phase 2). Tokens are cached in the OS credential store and silently refreshed for about 90 days, after which the sign-in runs again.

If the browser shows an AADSTS error such as AADSTS50020, the user most likely signed in with an account from the wrong tenant. The command keeps waiting until the timeout and then fails. Run it again and pick the right account.

### For the `auth` command (chat/test token)

The `auth` command acquires a generic `api.powerplatform.com` token and a Dataverse token. The chat and test skills use them, push and pull do not.

Run with a **5-minute timeout**:

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js auth \
  --tenant-id "<tenantId>" \
  --client-id "<clientId>" \
  --environment-url "<environmentUrl>"
```

**Timeout: 300000ms (5 minutes)** — set this on the Bash tool call.

### Token caching and silent refresh

Tokens and MSAL refresh tokens are persisted in the OS credential store (macOS Keychain, Windows DPAPI, Linux secret-tool). After initial authentication:
- Access tokens are valid for ~1 hour
- Refresh tokens are valid for ~90 days
- The script automatically refreshes expired access tokens silently using the cached refresh token
- **Re-authentication is only needed on the very first use or after ~90 days**

### When device code flow starts

The script emits a JSON line to stdout:

```json
{"status":"device_code","userCode":"XXXXXXXX","verificationUri":"https://login.microsoft.com/device","message":"...","expiresIn":900}
```

**When you see this in the output**, immediately tell the user:

> **Authentication Required**
>
> Please open **{verificationUri}** in your browser and enter code **{userCode}**
>
> The command is waiting for you to complete sign-in. You have {expiresIn/60} minutes.

The command will automatically continue once the user completes authentication. **Do NOT cancel the command** — it is waiting for the browser sign-in to complete.

Two tokens are acquired sequentially (Copilot Studio API, then Dataverse API), so the user may need to authenticate **twice** on first use.

### If the command completes with `status: "ok"`

Tokens are cached. Proceed to Phase 2.

### If the command fails with `device_code_expired`

The user didn't authenticate in time. Re-run the `auth` command and remind them to authenticate promptly.

## Phase 2: Execute Command

**Do not pull, push, publish or clone into a CLI agent workspace** (`template: cliagent*` or `authoringModel: CliCopilot` in that agent's `settings.mcs.yml`). Check it first as described in "Workspace Type" in `int-project-context`, and point the user to [microsoft/copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin).

All commands auto-detect the agent directory (finds the subfolder with `.mcs/conn.json`) and read connection details from it.

### Pull (download remote changes)

`--client-id` is optional. When omitted, uses VS Code's 1p client (browser sign-in, or a device code over SSH).

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js pull \
  --workspace "<path-to-agent-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>"
```

If the same line of a file was changed both locally and on the server, pull writes git-style conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) into that `.mcs.yml` file. The command then prints `"status":"conflict"` with a `conflicts` list (`file` and `lines`) and exits non-zero. **Do not report this as a successful pull.** Tell the user which files and lines are affected, ask which version between the markers is the right one (or propose one), remove the marker lines, run `validate`, and only then push. Pull does not resolve conflicts itself.

### Push (upload local changes)

**Important:** Always `pull` before `push` to get fresh row versions. If you push without pulling first, you'll get a `ConcurrencyVersionMismatch` error.

Push automatically validates all `.mcs.yml` files before pushing and blocks if there are errors, or if validation is incomplete (the language server timed out or exited before reporting diagnostics for every file, or a file could not be read; the output then has `validation.status: "incomplete"`). A blocked push prints `"status":"error"` and exits non-zero. Add `--force` to bypass validation (not recommended).

Push also refuses (`"status":"error"`, non-zero exit, with a `conflicts` list) when any `.mcs.yml` file still contains conflict markers. This check runs before any sign-in or upload, and `--force` does not bypass it. Resolve the markers first (see Pull).

Push also refuses (`"status":"error"`, non-zero exit, with a `syntaxErrors` list of `file`, `line`, `column`, `message`) when a `.mcs.yml` file does not parse as YAML. What was measured against the service: pushing a topic with text after a closing quote, or with an unclosed quote that a later quote closes, emptied the topic on the server while `validate` called the file valid (an unclosed quote that runs to the end of the file is reported by the language server itself). The reported line is where the parser gave up; the real mistake can be above it. Like the conflict check it runs before any sign-in or upload and `--force` does not bypass it. Fix the syntax and run `validate`, which reports the same errors.

Unquoted values such as `description: Text: more text` do not block the push. The service keeps them (round trip checked), so push only logs a line with the file, line and reason. A relaxed value in the `mcs.metadata` block (for example the topic `description`) comes back quoted on the next pull or clone, so a diff on that line is expected and not a conflict.

**Disambiguation check:** Before pushing, check if any routing-relevant changes were made since the last push (new topics with `modelDescription`, new child agents, changed `modelDescription` or `beginDialog.description` on any surface). If so, suggest a disambiguation check:

> "You've made changes to topic/tool/child agent descriptions since the last push. Want to run a disambiguation check first to catch any routing collisions?"

If the user declines, proceed with push. Do NOT block on this — it's advisory.

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js push \
  --workspace "<path-to-agent-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>"
```

### Validate (check YAML before pushing)

Validates all `.mcs.yml` files in the workspace using the LSP binary's full diagnostics (YAML structure, Power Fx, schema, cross-file references).

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js validate \
  --workspace "<path-to-agent-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>"
```

Returns JSON: `{ "status": "ok"|"error"|"incomplete", "valid": true|false, "summary": { "errors": N, "warnings": N }, "files": [...] }`

If the language server times out or exits before publishing diagnostics for every file, or a file cannot be read, `status` is `"incomplete"` (`valid` is `false`), the output adds `incomplete: true`, `reason` (`"timeout"`, `"lsp-exited"` or `"unreadable"`), `message`, `missingFiles` and `unreadableFiles` (`[{ file, error }]`), and the process exits with code 1. An incomplete run is not a clean pass; re-run it.

### Clone (download agent to new local folder)

Requires either `--agent-id` (the bot GUID from `list-agents`) **or** `--url` (a Copilot Studio web URL). Uses Island API token automatically.

**With explicit IDs:**

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js clone \
  --workspace "<target-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>" \
  --agent-id "<agentId>"
```

**With a Copilot Studio URL (recommended shortcut):**

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js clone \
  --workspace "<target-folder>" \
  --tenant-id "<tenantId>" \
  --url "https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>/overview"
```

When `--url` is provided, the script extracts `environmentId` and `agentId` from the URL and resolves `environmentUrl` and `agentMgmtUrl` automatically via the BAP API. The `--url` flag also works with `push`, `pull`, `changes`, and `validate` commands.

`clone` also takes `--cluster-category N`. It sets the cluster category for the Island API token and for the environment lookup, and it is written to `.mcs/conn.json`, where push and pull read it later. Without the option, `clone` takes it from the `--url` host (`copilotstudio.preview.microsoft.com` is 4, `.preprod.` is 3, `.test.` is 2) and uses 5 (Prod) for everything else. Set it by hand only for a non-Prod environment that you reached without a URL. Accepted values are 0 to 8; anything else stops with an error. Other commands ignore the option and warn. Only 4 and 5 were tested. For 0 to 3 (test and preprod) the plugin picks the same BAP host as the VS Code extension, which was not tested. Categories 6 to 8 are government clouds, which this plugin does not support: it has no environment lookup and no sign-in for them, so passing `--environment-url` and `--agent-mgmt-url` gets past the lookup but sign-in still fails.

### View Changes (diff local vs remote)

`--client-id` is optional. When omitted, uses VS Code's 1p client (browser sign-in, or a device code over SSH).

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js changes \
  --workspace "<path-to-agent-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>"
```

### Publish (make draft agent live)

Publishes the agent so that the current draft becomes the live version reachable by external clients (`/chat-with-agent`, `/run-tests`, Teams, etc.). Uses the Dataverse `PvaPublish` bound action directly (no LSP binary needed).

**IMPORTANT — Publishing makes this version of the agent available to ALL users the agent is shared with.** If you are working in a development environment this is fine, but if the agent is shared with production users, **always confirm with the user before publishing.** Ask: "This will publish the agent and make it live for all users it's shared with. Should I proceed?"

The command polls the `publishedon` field on the bot entity until the timestamp changes, confirming that publish has taken effect. Default timeout is 5 minutes.

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js publish \
  --workspace "<path-to-agent-folder>" \
  --tenant-id "<tenantId>" \
  --environment-url "<envUrl>" \
  [--timeout <ms>]
```

**Timeout: 300000ms (5 minutes)** — set this on the Bash tool call.

Optional: `--agent-id "<agentId>"` overrides the bot ID from `conn.json`.

#### Publish output (success)
```json
{"status":"ok","botId":"...","publishedOn":"2026-03-27T12:00:00Z","previousPublishedOn":"2026-03-26T10:00:00Z","durationMs":45000,"durationSeconds":45}
```

#### When to publish

- After a successful `push`, if the user wants changes to be testable via `/chat-with-agent` or `/run-tests`
- In an improvement loop (edit → push → publish → test), publish is required between push and test
- The command confirms publish completion via API — **do not use time-based waits**

### List Agents

Uses Dataverse REST API directly (no LSP binary needed). `--client-id` is optional.

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js list-agents \
  --tenant-id "<tenantId>" \
  --environment-url "<envUrl>" \
  [--no-owner]
```

By default lists only agents owned by the current user. Add `--no-owner` to list all unmanaged agents.

### List Environments

Uses BAP REST API directly (no LSP binary needed). `--client-id` is optional.

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/manage-agent.bundle.js list-envs \
  --tenant-id "<tenantId>"
```


## Output Format

All commands output JSON to stdout with a `status` field:

### Device code prompt (during auth)
```json
{"status":"device_code","userCode":"XXXXXXXX","verificationUri":"https://login.microsoft.com/device","message":"...","expiresIn":900}
```

### Success
```json
{"status":"ok","method":"powerplatformls/syncPull","result":{...}}
```

### Conflict (pull wrote merge markers)
```json
{"status":"conflict","method":"powerplatformls/syncPull","result":{...},"conflicts":[{"file":"topics/Greeting.mcs.yml","lines":[12,14,16]}],"message":"..."}
```
The pull itself completed, but the listed files contain `<<<<<<<` / `=======` / `>>>>>>>` marker lines that must be resolved by hand. The exit code is non-zero.

### Error
```json
{"status":"error","error":"description of what went wrong"}
```

## Error Handling

| Error | Likely cause | Resolution |
|-------|-------------|------------|
| Extension not found | Copilot Studio VS Code extension not installed | Install from VS Code marketplace |
| LSP request timed out | Binary not responding or wrong protocol version | Check extension version, try updating |
| device_code_expired | User didn't authenticate in time | Re-run auth, authenticate promptly |
| `Browser sign-in did not finish within 300 seconds` | No browser could open, the tab was closed, or the wrong account was used | Run again, with `--auth-mode device` if there is no browser |
| ConcurrencyVersionMismatch | Push without fresh row versions | Pull first, then push |
| `conflict` status after pull, or "Push refused: unresolved merge conflict markers" | Same line changed locally and on the server | Pick the right version between the markers, delete the marker lines, run `validate`, then push |
| "Push refused: YAML syntax errors", or a `yaml-syntax` error from `validate` | A `.mcs.yml` file does not parse (unclosed quote, text after a closing quote, tab indentation, bad indentation, unclosed `[` or `{`) | Fix the file at the reported line (the real mistake can be above it), run `validate`, then push |
| Token expired + silent refresh failed | Refresh token expired (~90 days) | Run the `auth` command again |
| Binary missing | Extension installed but binary not present | Reinstall the extension |
| PvaPublish failed | Insufficient permissions or bot not found | Verify the user has publish permissions and the agent ID is correct |
| Publish timed out | Publish still in progress after timeout | Increase `--timeout` or check the Copilot Studio UI for status |
| `No .mcs/botdefinition.json found in ...` | The workspace has no `.mcs/botdefinition.json`. `.mcs/.gitignore` ignores everything, so a workspace that went through git, or was copied without `.mcs/`, loses it | See "Missing `.mcs/botdefinition.json`" below |

### Missing `.mcs/botdefinition.json`

`validate`, `push`, `pull` and `changes` stop with `No .mcs/botdefinition.json found` when the workspace lacks that file. `clone` creates it, but it is not tracked in git: `.mcs/.gitignore` contains `*`. A workspace restored from git, or copied without `.mcs/`, therefore does not have it, and the LSP would otherwise report a misleading `Missing required property 'CdsBotId'` or `Please resync`. There is no resync command. To recover:

1. `clone` the agent again into a new, empty folder.
2. Copy the edited `.mcs.yml` files over the new clone.
3. Run `validate`, then `push`.
