---
name: run-eval
user-invocable: false
description: >
  Run evaluations against a Copilot Studio agent via the Power Platform Evaluation API.
  Works on DRAFT agents — no publish step required. Lists test sets, starts a run,
  polls until complete, fetches results, and proposes YAML fixes for failures.
  Use when the user wants to test agent changes without publishing.
allowed-tools: Bash(node *eval-api.bundle.js *), Bash(node *manage-agent.bundle.js push *), Bash(node *manage-agent.bundle.js pull *), Read, Glob, Grep, Edit
context: fork
agent: copilot-studio-test
---

# Run Evaluation (PPAPI)

Run evaluations against a Copilot Studio agent's **draft** — no publish needed.

**Before you change anything.** Search the agent's own `settings.mcs.yml` for `template: cliagent*` or `authoringModel: CliCopilot` (details under "Workspace Type" in skill `int-project-context`). A match means a CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. Do this even for a one-line change.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/run-eval/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

The caller (test agent) must provide `--client-id` and `--workspace`. If you don't have the client ID, return immediately and tell the caller to run `test-auth` first.

All eval-api commands run in the **foreground**. NEVER use `run_in_background`.

## Step 1: List test sets and let the user choose

```bash
node <pluginRoot>/scripts/eval-api.bundle.js list-testsets --workspace <path> --client-id <id>
```

- **No test sets found**: Tell the user to create one in Copilot Studio (Evaluate tab > New evaluation). Stop.
- **One test set**: Tell the user which one you're using and proceed.
- **Multiple test sets**: Show them all and ask the user to pick. Do not proceed until they answer.

## Step 2: Ask about authenticated execution — MANDATORY, do not skip

**You MUST ask this question and wait for the user's answer before starting the run.**

Ask the user:

> **Does your agent use authenticated knowledge sources or connector actions (tools) that require user identity?**
> If so, you'll need to provide a connection ID — without it, the eval runs anonymously and **tools and knowledge sources will not be used**.
>
> **How to obtain the connection ID:**
> 1. Go to https://make.powerautomate.com
> 2. Open **Connections** from the side menu
> 3. Select the relevant **Microsoft Copilot Studio** connection
> 4. Copy the connection ID from the URL (the GUID segment after `/connections/`)
>
> If your agent doesn't use authenticated knowledge or tools, you can skip this.

**Do not proceed to Step 3 until the user responds.**

## Step 3: Start the run

```bash
node <pluginRoot>/scripts/eval-api.bundle.js start-run --workspace <path> --client-id <id> --testset-id <id> --run-name "Draft eval <date>"
```

Add `--connection-id <id>` if the user provided a connection ID in Step 2.

Add `--published` only if the user explicitly asked for published-bot testing.

## Step 4: Poll until complete

```bash
node <pluginRoot>/scripts/eval-api.bundle.js get-run --workspace <path> --client-id <id> --run-id <runId>
```

Poll every 15-30 seconds. Report progress: "Processing: 3/10 test cases..."

Stop when `state` is `Completed`, `Failed`, `Abandoned`, or `Cancelled`.

## Step 5: Fetch and analyze results

```bash
node <pluginRoot>/scripts/eval-api.bundle.js get-results --workspace <path> --client-id <id> --run-id <runId>
```

Present a summary table (total, passed, failed, errors). For failures:

| Metric | What to check |
|--------|---------------|
| `GeneralQuality` Fail | Which of relevance/completeness/groundedness/abstention failed |
| `ExactMatch` Fail | Score 0.0–1.0 |
| `CapabilityUse` Fail | `missingInvocationSteps` |
| `Error` status | `errorReason` — often a test set config issue, not a YAML issue |

## Step 6: Propose fixes (if failures found)

For YAML authoring failures: find the relevant topic, read it, propose specific edits. Wait for user approval before applying.

After applying: offer to push and re-run (go back to Step 3).
