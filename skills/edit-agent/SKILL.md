---
name: edit-agent
user-invocable: false
description: Edit Copilot Studio agent settings, instructions, or configuration. Use when the user asks to change agent instructions, display name, conversation starters, AI settings, or generative actions toggle.
argument-hint: <what to change>
allowed-tools: Bash(node *schema-lookup.bundle.js *), Bash(node *schema-lookup.bundle.js" *), Read, Edit, Glob
context: fork
agent: copilot-studio-author
---

# Edit Agent Settings/Instructions

Modify agent metadata (`agent.mcs.yml`) or configuration (`settings.mcs.yml`).

**Before you change anything.** If the agent is already on disk, search its own `settings.mcs.yml` for `template: cliagent*` or `authoringModel: CliCopilot` (details under "Workspace Type" in skill `int-project-context`). A match means a CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. Do this even for a one-line change. A fresh clone has no file to search yet, see the Cloning rule in `clone-agent`.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/edit-agent/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces.

## Instructions

1. **Auto-discover the agent directory**:
   ```
   Glob: **/agent.mcs.yml
   ```
   NEVER hardcode an agent name. If multiple agents found, ask which one.

2. **Identify what the user wants to change** and read the appropriate file:
   - **Instructions, display name, conversation starters, AI settings** → `agent.mcs.yml`
   - **GenerativeActionsEnabled, authentication, recognizer, capabilities** → `settings.mcs.yml`

3. **If the user wants to change the AI model**, run the schema lookup tool first:
   ```bash
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" models
   ```
   Use the output to determine the correct `modelNameHint` and `provider` values.
   **CRITICAL:** Do NOT include `kind` in the model block — the agent-level schema uses `CurrentModelsNoKind`.

4. **Read the current file** before making any changes.

5. **Make the requested changes** using the Edit tool.

## Editable Fields in `agent.mcs.yml`

| Field | Description | Example |
|-------|-------------|---------|
| `displayName` | Agent's display name | `displayName: My Agent` |
| `instructions` | System prompt / personality | Multi-line YAML with `\|` |
| `conversationStarters` | Suggested conversation starters | Array of `{title, text}` |
| `aISettings.model.modelNameHint` | Model hint (run `models` command for convention) | `Sonnet46`, `GPT5Chat` |
| `aISettings.model.provider` | Model provider (required for non-OpenAI) | `Anthropic` |

## Editable Fields in `settings.mcs.yml`

| Field | Description | Example |
|-------|-------------|---------|
| `GenerativeActionsEnabled` | Enable generative orchestration | `true` / `false` |
| `authenticationMode` | Auth mode | `Integrated`, `None` |
| `authenticationTrigger` | When to auth | `Always`, `AsNeeded` |
| `accessControlPolicy` | Access control | `ChatbotReaders` |
| `configuration.aISettings.*` | AI capabilities | Various booleans |
| `configuration.settings.*.content.capabilities.webBrowsing` | Web browsing | `true` / `false` |

## Writing Effective Instructions

For detailed guidance on writing knowledge-aware instructions, grounding directives, citation control, and scope enforcement, see [instructions-guide.md](instructions-guide.md).

## Instructions Format

In a classic agent, `instructions` in `agent.mcs.yml` is a plain string. Write it as a block scalar (`instructions: |`). Do not write an object there: both `instructions: {segments: ...}` and `instructions: {text: ...}` come out empty, because the language server sees no difference from an empty value. `validate` reports them as errors with source `instructions-shape`.

`segments` with `kind: StaticSegment` under `configuration.agentSettings` in `settings.mcs.yml` belongs to CLI agents. If you see it, run the CLI agent check in int-project-context before you change anything.

## Fields to NEVER Modify

- `schemaName` — This is the internal Power Platform identifier. Changing it breaks the agent.
- `publishedOn` — Managed by the platform.
- `template` — Managed by the platform.
- `language` — Changing this can corrupt the agent.

If the user asks to change any of these, warn them.

## Example: Update Instructions

```yaml
instructions: |
  You are a customer support agent for Contoso Ltd.

  Guidelines:
  - Be professional and empathetic
  - Always verify the customer's identity first
  - Escalate billing issues to a human agent
```
