---
name: clone-agent
user-invocable: false
description: Clone a Copilot Studio agent from the cloud. Guides through environment selection, agent selection, and downloads agent YAML files.
argument-hint: "[agent name or environment hint]"
allowed-tools: Bash(node *manage-agent.bundle.js *), Bash(node *manage-agent.bundle.js" *), Read, Glob, Grep
context: fork
agent: copilot-studio-manage
---

# Clone Agent

Guided flow to clone a Copilot Studio agent from the cloud to a local workspace. Walks the user through environment selection, agent selection, and downloads the agent's YAML files.

**Before you change anything.** If the agent is already on disk, search its own `settings.mcs.yml` for `template: cliagent*` or `authoringModel: CliCopilot` (details under "Workspace Type" in skill `int-project-context`). A match means a CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. Do this even for a one-line change. A fresh clone has no file to search yet, see the Cloning rule in `clone-agent`.

**Cloning.** There is no local `settings.mcs.yml` to check before a download. Clone into an empty folder, never into a folder that already holds an agent (check that agent as above). Right after the download, search the new folder's `settings.mcs.yml` for the same two markers. On a match it is a CLI agent: do not edit, pull, push or publish it, tell the user the path of the downloaded folder and that it is a CLI agent workspace, point to https://github.com/microsoft/copilot-studio-plugin, and leave the folder for the user to keep or delete.

**Sandbox.** The `manage-agent.bundle.js` commands below sign in, call the network and write to `~/.copilot-studio-cli`. If your client runs commands in a sandbox (for example Codex without `--yolo`), run them outside the sandbox, with the user's permission. If you cannot ask (Codex with `approval_policy = "never"`), say what needs network access and stop. With full access (`--yolo`), run them directly.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/clone-agent/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## IMPORTANT: Do Not Modify Scripts

This is a new capability under active development. If the manage-agent script fails, **do not attempt to fix, patch, or work around it**. Instead:
1. Show the user the full error output
2. Direct them to https://github.com/microsoft/skills-for-copilot-studio/issues
3. Suggest using the Copilot Studio VS Code extension directly as a fallback for push/pull/clone

## Phase 0: Resolve Configuration

Look for existing connection details in this order. Stop at the first source that provides a `tenantId`:

### 0a. Scan for existing `.mcs/conn.json` files

Search the filesystem for previously cloned agents — these already have all the connection details:

```
Glob: **/.mcs/conn.json
```

Also search common project locations:

```
Glob: /Users/**/projects/**/.mcs/conn.json
```

Each `conn.json` contains `TenantId`, `EnvironmentId`, `DataverseEndpoint`, `AgentManagementEndpoint`, and `AccountInfo`. Parse any found files and collect unique tenant/environment pairs. If matches are found, present them to the user:

> **Found existing agent connections:**
> 1. Employee Assistant — Elad's Env (tenant: 8a235459...)
> 2. IT Agent — Contoso Dev (tenant: efb073bb...)
>
> Use one of these, or enter a different tenant ID?

If the user picks one → extract `tenantId`, `environmentId`, `environmentUrl`, `agentMgmtUrl` and **skip to Phase 2** (or Phase 1 if they want a different environment).

### 0b. Check for a Copilot Studio URL

If the user pastes a Copilot Studio URL (e.g. from their browser while viewing the agent), extract environment and agent IDs directly — no need for `list-envs` or `list-agents`.

Recognised URL formats:
```
https://copilotstudio.microsoft.com/environments/<envId>/bots/<agentId>/overview
https://copilotstudio.preview.microsoft.com/environments/<envId>/bots/<agentId>
https://copilotstudio.preprod.microsoft.com/environments/<envId>/bots/<agentId>
https://copilotstudio.test.microsoft.com/environments/<envId>/bots/<agentId>
```

If the user provides a URL like this, you still need a `tenantId` (from a `conn.json` or by asking the user). Then **skip to Phase 3**, passing `--url` instead of `--agent-id` / `--environment-id` / `--environment-url` / `--agent-mgmt-url`:

```bash
node "<pluginRoot>/scripts/manage-agent.bundle.js" clone \
  --workspace "." \
  --tenant-id "<tenantId>" \
  --url "<copilotStudioUrl>"
```

The script will parse the URL to extract the environment ID and agent ID, then resolve the remaining environment details (Dataverse URL, agent management URL) automatically via the BAP API.

The URL host also sets the cluster category stored in `.mcs/conn.json` (preview 4, preprod 3, test 2, otherwise 5). For a non-Prod environment without a URL, add `--cluster-category N` to the clone command. Only 4 and 5 were tested. For a preprod or test URL, if the lookup fails, pass `--environment-url` and `--agent-mgmt-url` as well.

### 0c. Ask the user

If no `conn.json` found (or user wants a different tenant) → ask for their **tenant ID** (required).

No `--client-id` is needed. The script uses VS Code's first-party client ID and signs in with a browser, or with a device code over SSH or without a display.

## Phase 1: Select Environment

Tell the user: **"A browser window may open for Microsoft sign-in (tokens are cached after first login)."** Over SSH or without a display the script prints a device code instead. A foreground Bash call returns its output only when the command ends, so start it in the background (Claude Code: `run_in_background: true`; GitHub Copilot CLI: bash `mode: "async"`), check its output after a few seconds, and when it has a `{"status":"device_code",...}` line show the user the `verificationUri` and `userCode` right away. Then wait for the command to finish.

Run the list-envs command:

```bash
node "<pluginRoot>/scripts/manage-agent.bundle.js" list-envs \
  --tenant-id "<tenantId>"
```

**Timeout: 300000ms (5 minutes)**, set on the Bash tool call to allow time for sign-in.

Parse the JSON output. On success (`status: "ok"`), present the environments as a numbered list to the user:

```
1. Contoso Dev (abc123-...)
2. Contoso Prod (def456-...)
```

Ask the user to pick an environment. Extract:
- `environmentId`
- `environmentUrl` (the `url` or `dataverseUrl` field)
- `agentMgmtUrl` (the `agentManagementUrl` field)

## Phase 2: Select Agent

First, ask the user: **"Do you want to list only agents you own, or all agents in the environment?"**

- If **only mine** → run without `--no-owner` (default, filters by current user)
- If **all agents** → add `--no-owner` flag

```bash
node "<pluginRoot>/scripts/manage-agent.bundle.js" list-agents \
  --tenant-id "<tenantId>" \
  --environment-url "<environmentUrl>" \
  [--no-owner]
```

**Timeout: 300000ms (5 minutes)**

Parse the JSON output. Each agent has `agentId`, `displayName`, and `ownedByCurrentUser`. Present agents as a numbered list:

```
1. My Support Bot (yours)
2. HR Assistant
3. IT Helpdesk (yours)
```

Ask the user to pick an agent. Extract the `agentId`.

## Phase 3: Clone

Run the clone command. Use the current directory as the workspace if it is empty, otherwise create a new empty folder and use that (the clone writes a folder named after the agent inside it). The `--agent-id` is required (from Phase 2):

```bash
node "<pluginRoot>/scripts/manage-agent.bundle.js" clone \
  --workspace "." \
  --tenant-id "<tenantId>" \
  --agent-id "<agentId>" \
  --environment-id "<environmentId>" \
  --environment-url "<environmentUrl>" \
  --agent-mgmt-url "<agentMgmtUrl>"
```

**Timeout: 300000ms (5 minutes)**

On success:
0. Apply the Cloning rule above to the folder named in `agentFolderName`. If it is a CLI agent, stop here.
1. Run `Glob: **/agent.mcs.yml` to find and show the cloned agent file
2. Check that `.mcs/conn.json` was created in the agent directory
3. Summarize what was cloned and where the files are

## Error Handling

| Error | Resolution |
|-------|-----------|
| Browser auth fails or times out | Ask user to try again; check that they have access to the tenant |
| No environments found | Verify tenant ID is correct and user has Power Platform access |
| No agents found | Verify environment selection; user may need Copilot Studio access |
| Clone fails | Check permissions; the user needs maker/admin access to the agent |
