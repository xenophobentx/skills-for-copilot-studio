---
name: test-auth
user-invocable: false
description: >
  Authenticate for Copilot Studio evaluation API and SDK chat. Caches a token
  that is shared across run-eval and chat-sdk skills. Run this before any
  eval or SDK chat workflow. Requires an App Registration with MakerOperations
  and Copilots.Invoke permissions.
allowed-tools: Bash(node *eval-api.bundle.js auth *), Read, Glob
context: fork
agent: copilot-studio-test
---

# Test Agent Authentication

Authenticate with the Power Platform API for evaluation and SDK chat workflows.
This caches a token in the `"test-agent"` slot that is shared by `run-eval` and `chat-sdk`.

**Sandbox.** `eval-api.bundle.js auth` signs in, calls the network and writes to `~/.copilot-studio-cli`. If your client runs commands in a sandbox (for example Codex without `--yolo`), run it outside the sandbox, with the user's permission. If you cannot ask (Codex with `approval_policy = "never"`), say what needs network access and stop. With full access (`--yolo`), run it directly.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/test-auth/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## Step 1: Find the workspace

Locate the agent workspace (directory containing `.mcs/conn.json`):
```bash
Glob: **/agent.mcs.yml
```

The `conn.json` provides the tenant ID automatically — no need to ask the user for it.

## Step 2: Get the client ID

**CRITICAL: You MUST present the FULL configuration checklist below when asking for the client ID. Do NOT omit any items — users frequently miss the redirect URI and public client settings, which causes auth failures.**

Ask the user for their **App Registration Client ID** and show them **all** of the following requirements in your message:

> What is your App Registration Client ID for the Evaluation API?
>
> Before sharing it, please verify your App Registration has **all** of these settings:
>
> 1. **Redirect URI**: Under **Authentication** > **Mobile and desktop applications** > redirect URI set to `http://localhost`
> 2. **Public client**: Under **Authentication** > **Advanced settings** > **Allow public client flows** set to **Yes**
> 3. **API permissions**: Under **API permissions**, these **delegated** permissions on the **Power Platform API**:
>    - `CopilotStudio.MakerOperations.Read` (list test sets, get results)
>    - `CopilotStudio.MakerOperations.ReadWrite` (start evaluation runs)
>    - `CopilotStudio.Copilots.Invoke` (SDK chat — send utterances to the agent)
> 4. **Admin consent**: Granted for the tenant (green checkmarks in the API permissions list)
>
> Missing any of these will cause authentication to fail.

If the user doesn't have one, guide them:

> **How to create an App Registration:**
> 1. Go to [Azure Portal > App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
> 2. Click **New registration**, name it (e.g., "Copilot Studio Eval")
> 3. Under **API permissions** > **Add a permission** > **APIs my organization uses** > search **Power Platform API**
> 4. Select **Delegated permissions** and add:
>    - `CopilotStudio.MakerOperations.Read`
>    - `CopilotStudio.MakerOperations.ReadWrite`
>    - `CopilotStudio.Copilots.Invoke`
> 5. Click **Grant admin consent** for the tenant
> 6. Under **Authentication** > **Add a platform** > **Mobile and desktop applications** > set redirect URI to `http://localhost`
> 7. Still in **Authentication**, scroll to **Advanced settings** and set **Allow public client flows** to **Yes** (required — without this the interactive browser login will fail with an AADSTS error)
> 8. Copy the **Application (client) ID** from the Overview page

## Step 3: Authenticate

Run the auth command (opens a browser; over SSH or without a display it prints a device code instead, and `--auth-mode device|interactive` forces one flow):

```bash
node "<pluginRoot>/scripts/eval-api.bundle.js" auth --workspace <path> --client-id <id>
```

A foreground call returns its output only when the command ends, so start the command so that it streams or yields, and keep its handle. Claude Code: `run_in_background: true`, then keep the task ID. GitHub Copilot CLI: bash `mode: "async"`. Codex: `exec_command` returns after a short wait with a `session_id` while the process still runs, and `write_stdin` with that `session_id`, empty `chars` and a `yield_time_ms` of 30000 polls it until the result has an `exit_code` (checked with Codex 0.162.1). Read the output after a few seconds. When it has a `{"status":"device_code",...}` line, show the user the `verificationUri` and `userCode` in your message right away, before you poll again. Then poll until the command exits.

If successful, you'll see:
```json
{"status": "ok", "message": "Authentication successful. Token cached for subsequent commands."}
```

**Return the client ID and workspace path to the caller** — they need these for subsequent `run-eval` and `chat-sdk` calls.

## Troubleshooting

- **HTTP 403 / InsufficientDelegatedPermissions**: The app registration is missing required permissions. Guide the user through adding them (Step 2).
- **AADSTS700016 / app not found in directory**: The client ID doesn't exist in the agent's tenant. The app must be registered in the same tenant as the Copilot Studio environment (check `conn.json` > `AccountInfo.TenantId`).
- **AADSTS7000218 / request body must contain client_secret or client_assertion**: The app registration is not configured as a public client. Go to **Authentication** > **Advanced settings** > set **Allow public client flows** to **Yes**.
- **SDK chat hangs after auth**: The cached token may have stale permissions. Clear the cache and re-authenticate:
  - Delete `~/.copilot-studio-cli/test-agent.cache.json`
  - Run `security delete-generic-password -s "copilot-studio-cli" -a "test-agent"` to clear the macOS Keychain entry
  - Re-run the auth command
