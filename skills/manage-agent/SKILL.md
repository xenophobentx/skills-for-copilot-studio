---
name: manage-agent
user-invocable: false
description: Push/pull Copilot Studio agent content via the VS Code extension's LanguageServerHost LSP binary. Handles authentication (browser login, or a device code over SSH or without a display), sync push, sync pull, clone, and diff operations.
argument-hint: <push|pull|clone|changes|remote-changes|verify|validate|publish|auth|list-agents|list-envs|doctor|pack-copy>
allowed-tools: Bash(node *manage-agent.bundle.js *), Bash(pac copilot pack *), Read, Glob, Grep
context: fork
agent: copilot-studio-manage
---

# Manage Agent

Push and pull Copilot Studio agent content by calling the VS Code extension's LanguageServerHost binary directly, using the same custom LSP protocol the extension uses internally.

**Before you change anything.** Search the agent's own `settings.mcs.yml` for `template: cliagent*` or `authoringModel: CliCopilot` (details under "Workspace Type" in skill `int-project-context`). A match means a CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. Do this even for a one-line change.

**Sandbox.** The commands below sign in, call the network and write to `~/.copilot-studio-cli`. If your client runs commands in a sandbox (Codex with the default `workspace-write`), run them outside it, with the user's permission. If there is a sandbox and the client cannot ask (Codex with `approval_policy = "never"`), say which commands need network access and stop. With full access (`--yolo`), run them directly.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/manage-agent/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

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

Find the agent folder (the one with `.mcs/conn.json`) and pass it as `--workspace`. `validate`, `push`, `pull`, `changes`, `remote-changes`, `verify` and `publish` read the tenant ID, environment ID, agent ID, environment URL and agent management URL from that `conn.json`, so `--workspace` is the only option you need for them. Do not open `conn.json` to copy the values into flags. A flag you do pass wins over the file, and the script prints a warning when it differs from the file. The script prints a `Target` line on stderr with the environment name and ID, agent ID, tenant and both hosts. Show it to the user before a `push`, `pull` or `publish`. If the folder holds several agents, the script stops and lists them; pass the one you mean. If you pass an environment that is not the one in `conn.json`, `push`, `pull` and `publish` refuse unless `--force` is given, and `validate` and `changes` warn. A URL in `conn.json` is used only when it is https on a known Microsoft host; otherwise the script looks the environment up.

If the folder has no `conn.json` (copied without `.mcs`, or never cloned), it has no `.mcs/botdefinition.json` either, and `validate`, `push`, `pull` and `changes` stop on that. Do not ask the user for IDs for them: clone the agent again into a new folder, copy the edited YAML files over, and use the new folder. `publish` is the exception: it needs `--tenant-id`, `--environment-url` and `--agent-id` when there is no `conn.json`.

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
node <pluginRoot>/scripts/manage-agent.bundle.js auth \
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

**Do not pull, push, publish or clone into a CLI agent workspace** (`template: cliagent*` or `authoringModel: CliCopilot` in that agent's `settings.mcs.yml`). Check it first as described in "Workspace Type" in `int-project-context`, and point the user to [microsoft/copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin). `pull` and `push` also refuse such a workspace themselves. Never pass `--allow-cli-agent` unless the user names that flag. A pull into one was reported to cut the tail off `settings.mcs.yml` (upstream issue #180).

All commands auto-detect the agent directory (finds the subfolder with `.mcs/conn.json`). `validate`, `push`, `pull`, `changes`, `remote-changes`, `verify` and `publish` read the connection details from it, so the examples below show `--workspace` only. `clone` has no `conn.json` yet and needs the flags shown in its section. If `--workspace` points at a folder without `conn.json`, the script says so and what to do about it (see Phase 0).

### Remote changes (what a pull would change, writes nothing)

Run this before a pull when the agent may have been edited in the portal or by someone else. It asks the server which files changed and compares them with your files. `pull --dry-run` does the same. `--dry-run` works with `pull` only; any other command refuses it with an error, so there is no dry run for `push`.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js remote-changes \
  --workspace "<path-to-agent-folder>"
```

The output has `message` (one sentence), `remote` (one entry per file the server changed: `file`, `server` as added, modified or deleted, `local` if you changed it too, `bothSides`, `merge`, and `diff` with the first differing lines of both sides), `bothSides` (files changed on the server and here with different content), `conflicts` (files where the same lines changed on both sides, so a pull writes conflict markers), and `localOnly` (your changes the pull does not touch). `merge` is `clean` (different lines, should merge), `conflict`, `same`, or `unknown` (the base copy could not be read, so it may or may not merge cleanly). The `diff` is a text diff and can include comment and formatting lines. If `conflicts` is not empty, tell the user which files before you pull and show the `diff`. Do not pull on your own in that case.

### Verify (compare the folder with the server)

`verify` clones the agent into a temp folder and compares it with the workspace. It writes nothing on the server. Use it when a push result looks doubtful. Local edits that were not pushed yet show up as `differs`. The output is the `verification` object described under Push; `status` is `ok`, or `unverified` with exit code 1.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js verify \
  --workspace "<path-to-agent-folder>"
```

### Pull (download remote changes)

`--client-id` is optional. When omitted, uses VS Code's 1p client (browser sign-in, or a device code over SSH).

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js pull \
  --workspace "<path-to-agent-folder>"
```

Before it calls the server, pull copies the agent folder (without `.mcs`, other dot folders and `node_modules`) to `.mcs/backups/<UTC timestamp>/` and prints the path in `backup.path`, with `backup.restore` saying how to go back. The last 5 backups are kept. `--keep-backups <n>` (a whole number) changes that, `--keep-backups 0` turns the backup off. If the backup cannot be made, the pull still runs and `warnings` says so. Restoring puts your old files back as local edits, and a push after that overwrites what the pull brought in; deleted topics come back. Tell the user the backup path whenever a pull changed local files or reported a conflict.

If the same line of a file was changed both locally and on the server, pull writes git-style conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) into that `.mcs.yml` file. The command then prints `"status":"conflict"` with a `conflicts` list (`file` and `lines`) and exits non-zero. **Do not report this as a successful pull.** Tell the user which files and lines are affected, ask which version between the markers is the right one (or propose one), remove the marker lines, run `validate`, and only then push. Pull does not resolve conflicts itself.

### Push (upload local changes)

**Important:** Always `pull` before `push` to get fresh row versions. If you push without pulling first, you'll get a `ConcurrencyVersionMismatch` error.

Push automatically validates all `.mcs.yml` files before pushing and blocks if there are errors, or if validation is incomplete (the language server timed out or exited before reporting diagnostics for every file, or a file could not be read; the output then has `validation.status: "incomplete"`). A blocked push prints `"status":"error"` and exits non-zero. Add `--force` to bypass validation (not recommended). `--force` also skips the check that `instructions` in the root `agent.mcs.yml` is a string (`instructions-shape`, see the validate skill). Pushing an object or a list there can clear the instructions on the server. `--force` also lets push, pull and publish go to an environment, Dataverse URL or agent management URL that is not the one in the workspace's `conn.json`. So `--force` skips three things: validation, `instructions-shape`, and the environment guard. Add it only after the user has read the reason for the block, and never together with an environment flag that you copied from somewhere else.

Push also refuses (`"status":"error"`, non-zero exit, with a `conflicts` list) when any `.mcs.yml` file still contains conflict markers. This check runs before any sign-in or upload, and `--force` does not bypass it. Resolve the markers first (see Pull).

Push also refuses (`"status":"error"`, non-zero exit, with a `syntaxErrors` list of `file`, `line`, `column`, `message`) when a `.mcs.yml` file does not parse as YAML. What was measured against the service: pushing a topic with text after a closing quote, or with an unclosed quote that a later quote closes, emptied the topic on the server while `validate` called the file valid (an unclosed quote that runs to the end of the file is reported by the language server itself). The reported line is where the parser gave up; the real mistake can be above it. Like the conflict check it runs before any sign-in or upload and `--force` does not bypass it. Fix the syntax and run `validate`, which reports the same errors.

Unquoted values such as `description: Text: more text` do not block the push. The service keeps them (round trip checked), so push only logs a line with the file, line and reason. A relaxed value in the `mcs.metadata` block (for example the topic `description`) comes back quoted on the next pull or clone, so a diff on that line is expected and not a conflict.

After the language server accepts the push, the script clones the agent into a temp folder and compares it with your folder. Upstream issue #188 reports a push that succeeded and uploaded nothing; that was not reproduced with extension 1.9.14. The result has a `verification` object. `status: "verified"` means every file matches. The check never changes the push result: the push stays `"status":"ok"` with exit code 0. If a `.mcs.yml` file is not on the server (evaluation files are left out, a clone does not return them), or a file differs, `verification.status` is `"mismatch"` and `warnings` names the files; `differs` has `diff` with the lines of both sides (a text diff). **Tell the user which files differ. Do not push again without asking.** The cause can be a push that did not apply, a skipped file, or someone else editing the agent. Run `remote-changes` or `verify`, or check the portal. If the check itself fails (network, token), `verification.status` is `"error"` and `warnings` says the push went through; do not push again, run `verify` later. `push --verify` makes a mismatch fail with `"status":"unverified"` and exit code 1. `push --no-verify` skips the check (`--verify` and `--no-verify` together are refused). The language server also writes server changes into your folder during a push, so look at `result.localChanges`. `serverOnly` lists files that exist only on the server and does not fail the check. The extra clone takes a few seconds.

**Disambiguation check:** Before pushing, check if any routing-relevant changes were made since the last push (new topics with `modelDescription`, new child agents, changed `modelDescription` or `beginDialog.description` on any surface). If so, suggest a disambiguation check:

> "You've made changes to topic/tool/child agent descriptions since the last push. Want to run a disambiguation check first to catch any routing collisions?"

If the user declines, proceed with push. Do NOT block on this — it's advisory.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js push \
  --workspace "<path-to-agent-folder>"
```

### Validate (check YAML before pushing)

Validates all `.mcs.yml` files in the workspace using the LSP binary's full diagnostics (YAML structure, Power Fx, schema, cross-file references).

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js validate \
  --workspace "<path-to-agent-folder>"
```

Returns JSON: `{ "status": "ok"|"error"|"incomplete", "valid": true|false, "summary": { "errors": N, "warnings": N }, "files": [...] }`

If the language server times out or exits before publishing diagnostics for every file, or a file cannot be read, `status` is `"incomplete"` (`valid` is `false`), the output adds `incomplete: true`, `reason` (`"timeout"`, `"lsp-exited"` or `"unreadable"`), `message`, `missingFiles` and `unreadableFiles` (`[{ file, error }]`), and the process exits with code 1. An incomplete run is not a clean pass; re-run it.

### Clone (download agent to new local folder)

Requires either `--agent-id` (the bot GUID from `list-agents`) **or** `--url` (a Copilot Studio web URL). Uses Island API token automatically.

**With explicit IDs:**

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js clone \
  --workspace "<target-folder>" \
  --tenant-id "<tenantId>" \
  --environment-id "<envId>" \
  --environment-url "<envUrl>" \
  --agent-mgmt-url "<mgmtUrl>" \
  --agent-id "<agentId>"
```

**With a Copilot Studio URL (recommended shortcut):**

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js clone \
  --workspace "<target-folder>" \
  --tenant-id "<tenantId>" \
  --url "https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>/overview"
```

When `--url` is provided, the script extracts `environmentId` and `agentId` from the URL and resolves `environmentUrl` and `agentMgmtUrl` automatically via the BAP API. The `--url` flag also works with `push`, `pull`, `changes`, and `validate` commands, but a cloned workspace does not need it.

`clone` also takes `--cluster-category N`. It sets the cluster category for the Island API token and for the environment lookup, and it is written to `.mcs/conn.json`, where push and pull read it later. Without the option, `clone` takes it from the `--url` host (`copilotstudio.preview.microsoft.com` is 4, `.preprod.` is 3, `.test.` is 2) and uses 5 (Prod) for everything else. Set it by hand only for a non-Prod environment that you reached without a URL. Accepted values are 0 to 8; anything else stops with an error. Other commands ignore the option and warn. Only 4 and 5 were tested. For 0 to 3 (test and preprod) the plugin picks the same BAP host as the VS Code extension, which was not tested. Categories 6 to 8 are government clouds, which this plugin does not support: it has no environment lookup and no sign-in for them, so passing `--environment-url` and `--agent-mgmt-url` gets past the lookup but sign-in still fails.

### View Changes (diff local vs remote)

`--client-id` is optional. When omitted, uses VS Code's 1p client (browser sign-in, or a device code over SSH).

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js changes \
  --workspace "<path-to-agent-folder>"
```

### Publish (make draft agent live)

Publishes the agent so that the current draft becomes the live version reachable by external clients (`/chat-with-agent`, `/run-tests-kit`, Teams, etc.). Uses the Dataverse `PvaPublish` bound action directly (no LSP binary needed).

**IMPORTANT — Publishing makes this version of the agent available to ALL users the agent is shared with.** If you are working in a development environment this is fine, but if the agent is shared with production users, **always confirm with the user before publishing.** Ask: "This will publish the agent and make it live for all users it's shared with. Should I proceed?"

The command polls the `publishedon` field on the bot entity until the timestamp changes, confirming that publish has taken effect. Default timeout is 5 minutes.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js publish \
  --workspace "<path-to-agent-folder>" \
  [--timeout <ms>]
```

**Timeout: 300000ms (5 minutes)** — set this on the Bash tool call.

Optional: `--agent-id "<agentId>"` overrides the bot ID from `conn.json` (the script warns when it differs). Without a `conn.json`, publish needs `--tenant-id`, `--environment-url` and `--agent-id`.

#### Publish output (success)
```json
{"status":"ok","botId":"...","publishedOn":"2026-03-27T12:00:00Z","previousPublishedOn":"2026-03-26T10:00:00Z","durationMs":45000,"durationSeconds":45}
```

#### When to publish

- After a successful `push`, if the user wants changes to be testable via `/chat-with-agent` or `/run-tests-kit`
- In an improvement loop (edit → push → publish → test), publish is required between push and test
- The command confirms publish completion via API — **do not use time-based waits**

### Pack for `pac copilot pack` (pack-copy)

Only for a user who wants a solution zip of the topics. `pac copilot pack` (2.13.1) accepts only `agent.mcs.yml`, `settings.mcs.yml`, `icon.png`, `.mcs/` and `topics/*.mcs.yml`. Any other file or folder in the agent folder stops it with `Unsupported directory: workflows/.` (or `knowledge/`, `agents/`, `actions/`, `.git/`) or `Unsupported file: README.md.` (a `.DS_Store` from Finder counts too), although clone and pull create several of them (upstream issue #185). A `.mcs.yml` in a subfolder of `topics/` is not refused, pac silently leaves it out of the zip. `pack-copy` copies the accepted entries into a new folder:

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js pack-copy \
  --workspace "<path-to-agent-folder>" --out "<new empty folder>"
```

Read the `skipped` list in the output and show it to the user before you pack. It is everything the zip will not contain: flows, knowledge sources, actions, child agents, variables. The zip is not a copy of the agent, and an agent whose topics use those will be incomplete or broken after import. Only if the user still wants it, run:

```bash
pac copilot pack --publisher-prefix <prefix> --project-dir "<new empty folder>" --output-path "<zip folder>"
```

`--out` must be a new or empty folder outside the agent folder (a symlink into it counts as inside). A symlinked `topics` folder is refused. Nothing is changed in the agent folder, and the command makes no network calls.

### List Agents

Uses Dataverse REST API directly (no LSP binary needed). `--client-id` is optional.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js list-agents \
  --tenant-id "<tenantId>" \
  --environment-url "<envUrl>" \
  [--no-owner]
```

By default lists only agents owned by the current user. Add `--no-owner` to list all unmanaged agents.

### List Environments

Uses BAP REST API directly (no LSP binary needed). `--client-id` is optional.

```bash
node <pluginRoot>/scripts/manage-agent.bundle.js list-envs \
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

### Push accepted, server copy differs (warning)
```json
{"status":"ok","method":"powerplatformls/syncPush","result":{...},"verification":{"status":"mismatch","checked":18,"differs":[{"file":"topics/Greeting.mcs.yml","diff":{"line":12,"local":["..."],"remote":["..."],"truncated":false}}],"localOnly":[],"serverOnly":[]},"warnings":["The push went through, but the server copy of some files differs from yours. Tell the user which files differ. Do not push again without asking. ..."]}
```
With `push --verify` the same output has `"status":"unverified"` and the exit code is 1.

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
| `warnings` with `verification.status` `mismatch` after push | The server copy of a file differs from yours: the push did not apply, the language server skipped the file, or the agent was edited elsewhere | Tell the user which files differ (`verification.differs`, `localOnly`). Do not push again without asking. Run `remote-changes` or `verify`, or compare with the portal |
| `warnings` with `verification.status` `error` after push | The check after the push failed (network, token). The push itself went through | Do not push again. Run `verify` later |
| Token expired + silent refresh failed | Refresh token expired (~90 days) | Run the `auth` command again |
| Binary missing | Extension installed but binary not present | Reinstall the extension |
| PvaPublish failed | Insufficient permissions or bot not found | Verify the user has publish permissions and the agent ID is correct |
| Publish timed out | Publish still in progress after timeout | Increase `--timeout` or check the Copilot Studio UI for status |
| `No .mcs/botdefinition.json found in ...` | The workspace has no `.mcs/botdefinition.json`. `.mcs/.gitignore` ignores everything, so a workspace that went through git, or was copied without `.mcs/`, loses it | See "Missing `.mcs/botdefinition.json`" below |
| `Can't read file outside of client workspace` in the LSP log, with `pull failed: A task was canceled.` or a `validate` result of `incomplete` | LanguageServerHost could not resolve a file inside the workspace (upstream issue #178, seen with extension 1.5.57 on Windows with many child agents). The cause is not known. | Check that `--workspace` is spelled with the real case of the folder, update the Copilot Studio VS Code extension, and if it stays, do this step in the extension. The command prints this hint after the error. |

### Missing `.mcs/botdefinition.json`

`validate`, `push`, `pull`, `changes`, `remote-changes` and `verify` stop with `No .mcs/botdefinition.json found` when the workspace lacks that file. `clone` creates it, but it is not tracked in git: `.mcs/.gitignore` contains `*`. A workspace restored from git, or copied without `.mcs/`, therefore does not have it, and the LSP would otherwise report a misleading `Missing required property 'CdsBotId'` or `Please resync`. There is no resync command. To recover:

1. `clone` the agent again into a new, empty folder.
2. Copy the edited `.mcs.yml` files over the new clone.
3. Run `validate`, then `push`.
