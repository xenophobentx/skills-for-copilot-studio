---
name: new-topic
user-invocable: false
description: Create a new Copilot Studio topic YAML file. Use when the user asks to create a new topic, conversation flow, or dialog for their agent.
argument-hint: <topic description>
allowed-tools: Bash(node *schema-lookup.bundle.js *), Bash(node *schema-lookup.bundle.js" *), Bash(node *manage-agent.bundle.js *), Bash(node *manage-agent.bundle.js" *), Read, Write, Glob
context: fork
agent: copilot-studio-author
---

# Create New Topic

Generate a new Copilot Studio topic YAML file based on user requirements.

**Before you change anything.** Search the agent's own `settings.mcs.yml` for `template: cliagent*` or `authoringModel: CliCopilot` (details under "Workspace Type" in skill `int-project-context`). A match means a CLI agent: stop, change nothing, and point the user to https://github.com/microsoft/copilot-studio-plugin. Do this even for a one-line change.

**Sandbox.** Only Step B, `manage-agent.bundle.js validate`, signs in, calls the network and writes to `~/.copilot-studio-cli`. Schema lookup, Step A and writing the topic are local. If your client runs commands in a sandbox (for example Codex without `--yolo`), run Step B outside the sandbox, with the user's permission. If you cannot ask (Codex with `approval_policy = "never"`) or Step B cannot run, skip Step B, still write and schema-validate the topic, and tell the user that the LSP validation did not run. With full access (`--yolo`), run Step B directly.

## Locate the plugin files

`<pluginRoot>` below is the plugin folder, the one that holds `skills/`, `scripts/` and `templates/`. Work it out once and use absolute paths from then on.

1. This file is `<pluginRoot>/skills/new-topic/SKILL.md`. In Claude Code `<pluginRoot>` is `${CLAUDE_SKILL_DIR}/../..`. If that shows up as literal text, your client does not fill it in: take the folder two levels above the folder of this file.
2. Otherwise read `pluginRoot` from `~/.copilot-studio-cli/sfcs-plugin-paths.json`. The setup hook writes it, so it can name another installed copy.

Check that the file you need exists under `<pluginRoot>` before you use it. In commands, put the whole path in double quotes, as the examples do: the folder name can contain spaces. If a script fails with `Cannot find module` or says the native dependencies are missing, run `node "<pluginRoot>/hooks/setup.js" --ensure` once and try again. It installs them without a hook and can take a minute.

## Instructions

1. **Auto-discover the agent directory**:
   ```
   Glob: **/agent.mcs.yml
   ```
   If multiple agents found, ask which one. NEVER hardcode an agent name.

2. **Check for matching templates** in `<pluginRoot>/templates/topics/` first:
   - `greeting.topic.mcs.yml` — OnConversationStart greeting
   - `fallback.topic.mcs.yml` — OnUnknownIntent fallback with escalation
   - `arithmeticsum.topic.mcs.yml` — Topic with inputs/outputs and computation
   - `question-topic.topic.mcs.yml` — Question with branching logic
   - `search-topic.topic.mcs.yml` — Generative answers from knowledge
   - `auth-topic.topic.mcs.yml` — Authentication flow
   - `error-handler.topic.mcs.yml` — Error handling
   - `disambiguation.topic.mcs.yml` — Multiple topics matched
   If a template matches, use it as the starting point.

3. **MANDATORY: Verify ALL `kind:` values against the schema** before writing them:
   ```bash
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" kinds                    # List all valid kind values
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" resolve AdaptiveDialog   # Resolve trigger structure
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" resolve <TriggerType>    # Resolve specific trigger
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" search <ActionKind>      # Verify an action kind exists
   ```
   **NEVER write a `kind:` value you haven't verified exists in the schema.** This is the #1 source of hallucination errors. If `schema-lookup.bundle.js search <kind>` returns no results, the kind does NOT exist — do not use it.

4. **Determine the trigger type** from the user's description:
   - `OnRecognizedIntent` — For topics triggered by user phrases (most common)
   - `OnConversationStart` — For welcome/greeting topics
   - `OnUnknownIntent` — For fallback topics
   - `OnEscalate` — For escalation to human agent
   - `OnError` — For error handling

5. **Generate the topic YAML** with:
   - A `# Name:` comment at the top
   - `kind: AdaptiveDialog`
   - Appropriate `beginDialog` with correct trigger
   - **Unique IDs** for ALL nodes (format: `<nodeType>_<6-8 random alphanumeric>`)
   - If using a template, replace ALL `_REPLACE` placeholders with unique IDs

6. **Check settings.mcs.yml** for `GenerativeActionsEnabled`. Read the agent's `settings.mcs.yml` to check.

7. **Save** to the agent's `topics/<topic-name>.topic.mcs.yml` directory

8. **MANDATORY: Validate the generated file** after saving:

   **Step A: Schema validation** — always run this first:
   ```bash
   node "<pluginRoot>/scripts/schema-lookup.bundle.js" validate <saved-file.yml>
   ```

   **Step B: LSP-based validation** — also run this if the agent has `.mcs/conn.json`:
   The script reads the connection details from `.mcs/conn.json`, so `--workspace` is enough:
   ```bash
   node "<pluginRoot>/scripts/manage-agent.bundle.js" validate \
     --workspace "<path-to-agent-folder>"
   ```

   Both validations are complementary: schema validation checks structural correctness (action kinds, property placement), while LSP validation checks Power Fx expressions, cross-file references, and environment-specific rules. If either fails, fix the issues before reporting success to the user.

## Generative Orchestration Guidelines

When the agent has `GenerativeActionsEnabled: true` in settings:

**Use Topic Inputs** (AutomaticTaskInput) instead of Question nodes to auto-collect user info.
Place `inputs` at the **AdaptiveDialog root level** (NOT inside `beginDialog`):
```yaml
kind: AdaptiveDialog
inputs:                    # <-- at AdaptiveDialog root, NOT inside beginDialog
  - kind: AutomaticTaskInput
    propertyName: userName
    description: "The user's name"
    entity: StringPrebuiltEntity
    shouldPromptUser: true
beginDialog:
  kind: OnRecognizedIntent
  id: main
  actions:
    - ...
```
- The orchestrator auto-collects inputs based on the description — no explicit Question node needed.
- Still use Question nodes when: conditional asks (ask X only if Y), or end-of-flow confirmations.

**Use Topic Outputs** instead of SendActivity for final results.
Use `outputType` at the root level and `SetVariable` to set output values — do NOT use `TaskOutput` (which is only valid in `TaskDialog` connector actions):
```yaml
kind: AdaptiveDialog
inputs:
  - ...
beginDialog:
  kind: OnRecognizedIntent
  id: main
  actions:
    - kind: SetVariable
      id: setVar_abc123
      variable: Topic.result
      value: ="computed value"
outputType:                # <-- at AdaptiveDialog root
  properties:
    result:
      displayName: result
      description: The computed result
      type: String
```
- The orchestrator generates the user-facing message from outputs.
- Do NOT use SendActivity to show final outputs (rare exceptions: precise mid-flow messages).

**Include inputType/outputType schemas** at the AdaptiveDialog root level when using inputs/outputs:
```yaml
inputType:
  properties:
    userName:
      displayName: userName
      description: "The user's name"
      type: String
outputType:
  properties:
    result:
      displayName: result
      type: String
```

## Topic-Action Chaining Under Generative Orchestration

When a topic exists alongside other topics or other actions (i.e. TaskDialog), think carefully about **the topic outputs** — it directly affects whether the orchestrator will chain to an action.

**Two scenarios:**

1. **Topic is self-contained** (e.g., reservation confirmation, calculation result): The topic does the work itself. It can gather the inputs too or just ask for those, but work is executed into the topic. In such case, output a confirmation/status message. The orchestrator treats the task as done or not, depending on the confirmation — this is correct.

2. **Topic gathers data for an action to consume** (e.g., collecting a complaint that a Teams action should send, without manually calling the action into the topic): The topic output must be the **data itself**, not a confirmation. If you output "Your complaint has been sent!", the orchestrator assumes the job is done and will NOT invoke the action which means the complaint will never be sent. Instead, output the complaint text so the orchestrator can see there's an action to send it and feed it to such action.

**Ask yourself:** Does this topic complete the task on its own, or does it prepare data for an action/other topic? If the latter, output the data, not a status message.

**Alternative approaches for data-gathering topics:**
- Remove the topic entirely and tailor the action's input descriptions for the specific use case (simplest). Basically the action will gather the data directly via its inputs, no topic needed. Useful for simple data collection (i.e. one-shot).
- Use a global variable: the topic sets it (one-shot or by asking multiple questions and consolidating into the same variable via PowerFX), and the action's body references it via Power FX. This is more complex but can be useful for multi-turn data gathering that feeds somewhere else, especially if you need to do some logic on the data before sending it.
- Output the collected data in a topic output variable so the orchestrator can pass it to the next action/topic.

## Power Fx Quick Reference

- Expressions start with `=`: `value: =Text(Topic.num1 + Topic.num2)`
- String interpolation uses `{}`: `activity: "Hello {Topic.UserName}"`
- Common functions: `Text()`, `Now()`, `IsBlank()`, `!IsBlank()`, `DateTimeFormat.UTC`
- Variable init: `variable: init:Topic.MyVar` (first assignment uses `init:`)
- **Type coercion to text**: Use `SetTextVariable` instead of `SetVariable` to convert non-text types (Number, DateTime, etc.) to text via template interpolation: `value: "Guests: {Topic.NumberOfGuests}"`
