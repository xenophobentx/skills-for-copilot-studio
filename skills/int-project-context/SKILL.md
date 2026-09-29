---
name: int-project-context
description: >
  Shared project context for all Copilot Studio sub-agents. Provides project
  structure, schema lookup usage, and skill invocation guidance.
user-invocable: false
---

# Copilot Studio — Shared Project Context

You are working inside a Copilot Studio agent project. All YAML files have the `.mcs.yml` extension.

## Project Structure

```
<agent-dir>/           # Auto-discover via Glob: **/agent.mcs.yml
├── agent.mcs.yml      # Agent metadata (display name, schema version)
├── settings.mcs.yml   # Agent settings (schemaName, GenerativeActionsEnabled, instructions)
├── topics/            # Conversation topics (AdaptiveDialog YAML files)
├── actions/           # Connector-based actions (TaskDialog YAML files)
├── knowledge/         # Knowledge sources (KnowledgeSourceConfiguration YAML files)
├── variables/         # Global variables (GlobalVariableComponent YAML files)
└── agents/            # Child agents (AgentDialog YAML files, each in its own subfolder)
```

## Workspace Type: Classic vs CLI Agent

This plugin supports CLASSIC (topic-based) agents only. Copilot Studio CLI agents (agentic-loop / GitHub Copilot harness agents, see #182) use a different layout and schema and are supported by [microsoft/copilot-studio-plugin](https://github.com/microsoft/copilot-studio-plugin). Do not apply the structure above to them. This section is the only place that defines how to detect one; other files refer here.

**Which agent to check.** Only the agent you are about to edit, pull, push or publish. Its root is the directory that contains its `agent.mcs.yml` or `.mcs/` folder (for files you are about to edit: the nearest parent directory with a `settings.mcs.yml`). A CLI agent elsewhere under the working directory (for example next to the classic agent in a migration workspace) does not matter. If the request does not say which of several agents it targets, ask.

**How to check.** Before the first write, pull, push or publish, run `Grep` with pattern `^\s*(template:\s*['"]?cliagent|authoring(Mode|Model):\s*['"]?CliCopilot)` (case-insensitive) on that agent root's `settings.mcs.yml`. A match means a CLI agent, that is either:
- `template` starts with `cliagent` (for example `template: cliagent-1.0.0`), or
- `authoringModel` (or `authoringMode`) is `CliCopilot`; it is usually indented under `configuration:`.

Supporting evidence only, never enough on its own: `configuration.agentSettings.instructions.segments` with `kind: StaticSegment`, a `capabilities/` folder, skills under `behaviors/` with `kind: InlineAgentSkill`, `authoringShape: 2` in `.mcs/botdefinition.json`, and no `agent.mcs.yml`/`topics/`. A classic agent has `agent.mcs.yml` plus `topics/`, `actions/`, `knowledge/`, `variables/`.

**In a CLI agent workspace this plugin only reads and describes.** Do not create or edit files, and do not pull, push, publish or clone into it (pull rewrites the files with classic tooling). Do not fall back to the "no agent found, clone one" flow either. Tell the user:

> This is a Copilot Studio CLI agent workspace, not a classic agent. This plugin targets classic (topic-based) agents, and classic edits are silently ignored or break CLI agents. Use the Copilot Studio plugin for CLI agents instead: https://github.com/microsoft/copilot-studio-plugin

## Schema Lookup Script

When you write new YAML files, be sure to use the schema lookup script to understand the schema, including mandatory fields, definitions, and references. The script is located at `${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js`, and you can use it in the terminal as follows:

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js search trigger             # Search by keyword
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js lookup SendActivity        # Look up a definition
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js resolve AdaptiveDialog     # Resolve with $refs
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js kinds                      # List all valid kind values
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js summary Question           # Compact overview
node ${CLAUDE_SKILL_DIR}/../../scripts/schema-lookup.bundle.js validate <file.yml>        # Validate a YAML file
```

If you already know the specific definition you want to look up, use `lookup`. If you want to explore the schema around a certain topic, use `search` or `summary`.
Always check the schema before writing YAML to ensure you include all required fields and use valid values.

**NEVER load the full schema file** (`reference/bot.schema.yaml-authoring.json`) — it's too long. Always use the script above.

## Connector Lookup Script

The connector lookup script is at `${CLAUDE_SKILL_DIR}/../../scripts/connector-lookup.bundle.js`. Use it for any questions about connectors, actions, their inputs, and outputs:

```bash
node ${CLAUDE_SKILL_DIR}/../../scripts/connector-lookup.bundle.js list                                 # List all connectors with operation counts
node ${CLAUDE_SKILL_DIR}/../../scripts/connector-lookup.bundle.js operations <connector>               # List operations for a connector
node ${CLAUDE_SKILL_DIR}/../../scripts/connector-lookup.bundle.js operation <connector> <operationId>  # Full details of one operation (inputs/outputs)
node ${CLAUDE_SKILL_DIR}/../../scripts/connector-lookup.bundle.js search <keyword>                     # Search operations across all connectors
```

`<connector>` matches by API name (`shared_office365`) or partial display name (`outlook`).

**When to use this**: When you need to understand available connectors, what inputs/outputs an action has, or what operations are available. The action YAML files in the agent only show *configured* inputs — connector-lookup shows the *full* connector definition with all available inputs and outputs.

## Skill-First Rule (VERY IMPORTANT)

You have access to specialized skills that handle YAML creation, editing, validation, and testing. **ALWAYS invoke the matching skill instead of doing it manually.**
Skills contain correct templates, schema validation, and patterns. Doing it manually risks hallucinated `kind:` values, missing required fields, and broken YAML.
Example skills include `/copilot-studio:new-topic` for creating new topics, `/copilot-studio:add-action` for adding connector actions and tools, and `/copilot-studio:validate` for validating YAML files.

**If no skill matches**, only then work manually — but always validate with `/copilot-studio:validate` afterward.

## Key Conventions

- **Agent Discovery**: NEVER hardcode agent names. Always `Glob: **/agent.mcs.yml`.
- **ID Generation**: Random alphanumeric, 6-8 chars after prefix (e.g., `sendMessage_g5Ls09`).
- **Template `_REPLACE`**: Always replace `_REPLACE` placeholder IDs with unique random IDs.
- **Power Fx**: Expressions start with `=`. String interpolation uses `{}`. Only use supported functions (check `int-reference` skill).
- **Generative Orchestration**: When `GenerativeActionsEnabled: true`, use topic inputs/outputs instead of hardcoded questions/messages.
