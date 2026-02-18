# Skill use: flow, directories, and workspace

This doc summarizes how skills are used in OpenClaw: the code path, where skills are found, how the workspace directory is set, how skills in the workspace are populated, and a full walkthrough for one skill (clawhub) with code-level detail.

## Flow of using a skill

There are two entry points: **model-invoked** (normal agent run with skills in the system prompt) and **slash-command** (e.g. `/clawhub search postgres`).

### Model-invoked flow (summary)

1. **Load skill entries**  
   `src/agents/skills/workspace.ts` → `loadSkillEntries`. Skills are loaded from extra dirs, bundled, managed (`~/.openclaw/skills`), and workspace `workspaceDir/skills`. Merged by skill name; each dir yields `SkillEntry { skill, frontmatter, metadata, invocation }`.

2. **Filter and build skills snapshot (per session)**  
   `src/auto-reply/reply/session-updates.ts` → `ensureSkillSnapshot`; calls `src/agents/skills/workspace.ts` → `buildWorkspaceSkillSnapshot`. On first turn or when snapshot version is stale, eligible entries are filtered (config, allowlist, eligibility, optional `skillFilter`). Snapshot = `{ prompt, skills, resolvedSkills, version }`; `prompt` is the string injected into the system prompt (from `formatSkillsForPrompt` in pi-coding-agent).

3. **Wire snapshot into the run**  
   `src/auto-reply/reply/get-reply-run.ts` calls `ensureSkillSnapshot`, gets `skillsSnapshot`, and puts it on `followupRun.run.skillsSnapshot`. Run params flow through the reply pipeline into the embedded runner.

4. **Resolve skills prompt for the run**  
   `src/agents/pi-embedded-runner/run/attempt.ts` → `resolveSkillsPromptForRun` (from `src/agents/skills.ts` / `workspace.ts`). Uses `skillsSnapshot.prompt` if present; otherwise builds from entries + config. Result is `skillsPrompt` (the `<available_skills>...</available_skills>` block).

5. **Build full system prompt**  
   `src/agents/system-prompt.ts` → `buildAgentSystemPrompt` → `buildSkillsSection`; called from `src/agents/pi-embedded-runner/system-prompt.ts` → `buildEmbeddedSystemPrompt`. The system prompt gets a "## Skills (mandatory)" section: scan `<available_skills>`, pick at most one skill, read its SKILL.md at `<location>` with the read tool, then follow it.

6. **Model picks skill and calls tools**  
   Model matches the user request to a skill's `<description>`, calls the **read** tool (e.g. `read_file`) for that skill's `<location>`, then may call **exec** and other tools per SKILL.md. Tools are created in `src/agents/pi-tools.ts` → `createOpenClawCodingTools` (read from `pi-tools.read.ts`, exec from `bash-tools.ts`); registered via `src/agents/pi-tool-definition-adapter.ts` → `toClientToolDefinitions`.

7. **Tool execution**  
   pi-coding-agent/pi-ai: `streamSimple` consumes the provider response; tool-call blocks in assistant `content` are identified by `type` + `id`; SDK matches by `name` and calls `execute(toolCallId, params, ...)`. Skill binaries / exec permission: gateway uses allowlist + safeBins; node-host uses `skillBins` from gateway `skills.bins` RPC and `autoAllowSkills`. Exec runs via `runExecProcess` (gateway) or `node.invoke` with `system.run` (node-host). Tool result is fed back into the session; the loop continues until the model sends a final reply.

A detailed walkthrough with code and the clawhub example is in [Detailed walkthrough (clawhub example)](#detailed-walkthrough-clawhub-example) below.

### Slash-command flow

- **Code:** `src/auto-reply/reply/get-reply-inline-actions.ts` → `handleInlineActions`. If the normalized body starts with `/`, `listSkillCommandsForWorkspace` (→ `buildWorkspaceSkillCommandSpecs` in `src/agents/skills/workspace.ts`) loads skill commands; `resolveSkillCommandInvocation` (`src/auto-reply/skill-commands.ts`) parses `/command [args]` or `/skill <name> [args]`.
- **If `dispatch.kind === "tool"`:** The handler runs the specified tool (e.g. exec) immediately with the parsed args and returns the tool result as the reply.
- **Otherwise:** The body is rewritten to "Use the \"&lt;skillName&gt;\" skill for this request." (plus optional user input), and the normal model-invoked flow runs with that prompt.

---

## Where the system finds skills

Skills are discovered from these directories (code: `src/agents/skills/workspace.ts` → `loadSkillEntries`). Merge precedence: **later overwrites same name** → workspace wins.

| Precedence (low → high) | Source                | Where                                                                                                                                                                                                                        |
| ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1                       | **Extra dirs**        | `config.skills.load.extraDirs` (paths resolved with `resolveUserPath`)                                                                                                                                                       |
| 2                       | **Plugin skill dirs** | From plugin manifest registry; each plugin lists `skills` paths under its `rootDir` (`src/agents/skills/plugin-skills.ts` → `resolvePluginSkillDirs`). Merged into the same load as extra.                                   |
| 3                       | **Bundled**           | `src/agents/skills/bundled-dir.ts` → `resolveBundledSkillsDir()`: env `OPENCLAW_BUNDLED_SKILLS_DIR`, or `skills/` next to the executable, or `<packageRoot>/skills`, or first `skills` dir found walking up from the module. |
| 4                       | **Managed**           | `CONFIG_DIR + "/skills"` → default **`~/.openclaw/skills`** (or `OPENCLAW_STATE_DIR` / `CLAWDBOT_STATE_DIR` if set).                                                                                                         |
| 5                       | **Workspace**         | **`workspaceDir + "/skills"`** (agent's workspace directory + `skills`).                                                                                                                                                     |

---

## How the workspace dir is set

**Code:** `src/agents/agent-scope.ts` → `resolveAgentWorkspaceDir(cfg, agentId)`.

1. **Per-agent:** If the agent has `config.agents.list[].workspace` set, that path is used (after `resolveUserPath`).
2. **Default agent only:** Else if this agent is the default, use `config.agents.defaults.workspace` if set; otherwise **`DEFAULT_AGENT_WORKSPACE_DIR`**.
3. **Other agents:** **`~/.openclaw/workspace-<agentId>`** (or state dir from `OPENCLAW_STATE_DIR` / `CLAWDBOT_STATE_DIR` if set).

**Default workspace dir** (`src/agents/workspace.ts` → `resolveDefaultAgentWorkspaceDir()`):

- If `OPENCLAW_PROFILE` is set and not `"default"`: **`~/.openclaw/workspace-<profile>`**.
- Otherwise: **`~/.openclaw/workspace`**.

**Where it's configured:**

- **CLI:** `openclaw setup --workspace <dir>` writes `agents.defaults.workspace` and calls `ensureAgentWorkspace` (`src/commands/setup.ts`).
- **Onboard:** `--workspace <dir>` in `src/cli/program/register.onboard.ts`.
- **Config:** In `openclaw.json` (or equivalent): `agents.defaults.workspace` and/or `agents.list[].workspace`.

---

## How skills in the workspace dir are populated

The app **does not** create or populate `workspaceDir/skills` for you.

- **Loading:** `loadSkillEntries(workspaceDir, ...)` **reads** `workspaceDir/skills` if it exists (each subdirectory containing a `SKILL.md` is one skill). If the directory doesn't exist or is empty, that source contributes no skills.
- **Workspace bootstrap:** `ensureAgentWorkspace` in `src/agents/workspace.ts` only creates the workspace root and bootstrap files (e.g. AGENTS.md, SOUL.md, TOOLS.md). It does **not** create a `skills` directory or copy any skills into it.

Ways the workspace skills directory gets content:

1. **Manual:** Create `workspaceDir/skills` and add skill folders (each with a `SKILL.md`), e.g. by copying from the repo or another machine.
2. **ClawHub (or similar):** The clawhub skill/CLI can install skills (e.g. from clawhub.com). Where it installs (workspace vs `~/.openclaw/skills`) is defined by that tool; the core only loads from the paths listed above.
3. **Sandbox sync:** When a sandbox is used with read-only or no workspace access, `syncSkillsToWorkspace` in `src/agents/skills/workspace.ts` copies the **merged** skill set into the **sandbox's** `workspace/skills`. The agent's own `workspaceDir/skills` is not modified.
4. **`skills.install` (gateway):** Runs a skill's **dependency** install (e.g. npm, brew) for a skill already present in the merged set; it does not copy or create the skill under `workspaceDir/skills`.

**Summary:** Workspace dir is set by config (and setup/onboard). Skills under that dir are only **read** by the loader; the core never creates or populates `workspaceDir/skills`. You populate it manually or via tools like ClawHub; the sandbox is the only place that gets an automatic copy of the merged skills (into the sandbox's own `workspace/skills`).

---

## Detailed walkthrough (clawhub example)

This section traces the full flow for one skill (**clawhub**): how it is loaded, filtered, snapshotted, and injected into the agent run; what the system prompt looks like after each major step; how the model picks the skill and may call tools (read, exec); how the system gets and identifies tool calls from the LLM; how skill binaries are collected and exec permission is granted; how the tool is executed and the result is sent back to the LLM; and how the LLM produces the final result (possibly after several tool-call iterations). All code paths are real; the only assumed part is the exact output of `formatSkillsForPrompt` (from `@mariozechner/pi-coding-agent`), which we show in a plausible form.

**Example skill:** `skills/clawhub/SKILL.md`

```yaml
---
name: clawhub
description: Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed clawhub CLI.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["clawhub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "clawhub",
              "bins": ["clawhub"],
              "label": "Install ClawHub CLI (npm)",
            },
          ],
      },
  }
---
```

### Step 1: Load skill entries from workspace

**Where:** `src/agents/skills/workspace.ts` → `loadSkillEntries` (used by `buildWorkspaceSkillSnapshot` / `buildWorkspaceSkillsPrompt`).

**What runs:** Skills are loaded from (in precedence order) extra dirs, bundled, managed (`~/.openclaw/skills`), and workspace `workspaceDir/skills`. Merged by skill name; workspace wins. Each skill dir is parsed by `loadSkillsFromDir` (pi-coding-agent); frontmatter is parsed into `SkillEntry { skill, frontmatter, metadata, invocation }`.

**Code:**

```ts
// workspace.ts (simplified)
const workspaceSkills = loadSkills({
  dir: path.join(workspaceDir, "skills"),
  source: "openclaw-workspace",
});
// ... merge with bundled/managed/extra ...
const skillEntries = Array.from(merged.values()).map((skill) => ({
  skill,
  frontmatter: parseFrontmatter(raw),
  metadata: resolveOpenClawMetadata(frontmatter),
  invocation: resolveSkillInvocationPolicy(frontmatter),
}));
```

**After step 1:** We have a `SkillEntry` for clawhub: `skill.name === "clawhub"`, `skill.description` is the frontmatter description, `skill.baseDir` points to the skill directory. The same entry carries `metadata` from frontmatter (e.g. `requires.bins`, `install[].bins`), which the system uses later to collect skill binaries for exec permission. No system prompt yet; this is just in-memory entries.

### Step 2: Filter and build the skills snapshot (first turn or refresh)

**Where:** `src/auto-reply/reply/session-updates.ts` → `ensureSkillSnapshot`; it calls `buildWorkspaceSkillSnapshot` in `src/agents/skills/workspace.ts`.

**What runs:** On first turn (or when snapshot version is stale), the session is updated with a new `skillsSnapshot`. Eligible entries are filtered by config, allowlist, eligibility (e.g. remote node), and optional **skillFilter** (e.g. from Telegram topic or Slack channel). Only entries with `disableModelInvocation !== true` go into the prompt. The snapshot is `{ prompt, skills, resolvedSkills, version }`; `prompt` is the string that will be injected into the system prompt.

**Code:**

```ts
// session-updates.ts (excerpt)
const skillSnapshot =
  isFirstTurnInSession || !current.skillsSnapshot || shouldRefreshSnapshot
    ? buildWorkspaceSkillSnapshot(workspaceDir, {
        config: cfg,
        skillFilter, // e.g. undefined = all skills, or ["clawhub"] if channel restricts
        eligibility: { remote: remoteEligibility },
        snapshotVersion,
      })
    : current.skillsSnapshot;
```

```ts
// workspace.ts – buildWorkspaceSkillSnapshot
const eligible = filterSkillEntries(skillEntries, opts?.config, opts?.skillFilter, opts?.eligibility);
const promptEntries = eligible.filter((e) => e.invocation?.disableModelInvocation !== true);
const resolvedSkills = promptEntries.map((entry) => entry.skill);
const prompt = [remoteNote, formatSkillsForPrompt(resolvedSkills)].filter(Boolean).join("\n");
return { prompt, skills: eligible.map(...), resolvedSkills, version: opts?.snapshotVersion };
```

**After step 2:** Session store holds e.g. `sessionStore[sessionKey].skillsSnapshot = { prompt: "<skills block>", skills: [{ name: "clawhub", ... }], version: 1 }`. The **prompt** string is whatever `formatSkillsForPrompt(resolvedSkills)` returns (from pi-coding-agent). The format is documented in [System prompt](/concepts/system-prompt#skills) and used in tests:

```text
<available_skills>
  <skill>
    <name>clawhub</name>
    <description>Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com. Use when you need to fetch new skills on the fly, sync installed skills to latest or a specific version, or publish new/updated skill folders with the npm-installed clawhub CLI.</description>
    <location>/path/to/workspace/skills/clawhub/SKILL.md</location>
  </skill>
</available_skills>
```

### Step 3: Resolve skills prompt for the run

**Where:** `src/agents/pi-embedded-runner/run/attempt.ts` → `resolveSkillsPromptForRun` from `src/agents/skills.ts` (re-exported from `src/agents/skills/workspace.ts`).

**What runs:** When building the run params, the code resolves the skills prompt for this run: prefer `skillsSnapshot.prompt` if present, else build from `entries` + config. That string is passed as `skillsPrompt` into the system prompt builder.

**Code:**

```ts
// attempt.ts
const skillsPrompt = resolveSkillsPromptForRun({
  skillsSnapshot: params.skillsSnapshot,
  entries: shouldLoadSkillEntries ? skillEntries : undefined,
  config: params.config,
  workspaceDir: effectiveWorkspace,
});
// ... later, skillsPrompt is passed to buildEmbeddedSystemPrompt (Step 4)
const appendPrompt = buildEmbeddedSystemPrompt({
  // ...
  skillsPrompt,
  tools,
  // ...
});
const systemPromptOverride = createSystemPromptOverride(appendPrompt);
```

```ts
// skills/workspace.ts – resolveSkillsPromptForRun
export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) return snapshotPrompt;
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}
```

**After step 3:** `skillsPrompt` is the same string as in the snapshot (the `<available_skills>...</available_skills>` block from step 2). Still no full system prompt; we only have the skills substring.

### Step 4: Build the full system prompt (including Skills section)

**Where:** `src/agents/system-prompt.ts` → `buildAgentSystemPrompt` → `buildSkillsSection`; called from `src/agents/pi-embedded-runner/system-prompt.ts` → `buildEmbeddedSystemPrompt`.

**What runs:** The embedded runner builds the full system prompt. The **Skills (mandatory)** section is built by `buildSkillsSection`: if `skillsPrompt` is non-empty and prompt mode is not minimal, it adds the fixed instructions plus the `skillsPrompt` string.

**Code:**

```ts
// system-prompt.ts – buildSkillsSection
function buildSkillsSection(params: {
  skillsPrompt?: string;
  isMinimal: boolean;
  readToolName: string;
}) {
  if (params.isMinimal) return [];
  const trimmed = params.skillsPrompt?.trim();
  if (!trimmed) return [];
  return [
    "## Skills (mandatory)",
    "Before replying: scan <available_skills> <description> entries.",
    `- If exactly one skill clearly applies: read its SKILL.md at <location> with \`${params.readToolName}\`, then follow it.`,
    "- If multiple could apply: choose the most specific one, then read/follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Constraints: never read more than one skill up front; only read after selecting.",
    trimmed,
    "",
  ];
}
```

**After step 4:** The **full system prompt** contains a block like this (with the actual `skillsPrompt` from the snapshot):

```text
You are a personal assistant running inside OpenClaw.

## Tooling
...

## Skills (mandatory)
Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read_file`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.

<available_skills>
  <skill>
    <name>clawhub</name>
    <description>Use the ClawHub CLI to search, install, update, and publish agent skills from clawhub.com. ...</description>
    <location>/path/to/workspace/skills/clawhub/SKILL.md</location>
  </skill>
</available_skills>

## Memory Recall
...
```

So at this point the model sees: (1) the rule to scan skills and read at most one SKILL.md, and (2) the list of available skills (here, clawhub) with name, description, and location.

### Step 5: Model picks skill and may call tools (read, exec)

1. **Pick:** It matches "install … from clawhub" to the **clawhub** skill.
2. **Read:** It calls the **read** tool (e.g. `read_file`) for `workspaceDir/skills/clawhub/SKILL.md` (from `<location>`).
3. **Use:** It follows SKILL.md (e.g. run `clawhub search "postgres backups"`, then `clawhub install <slug>` via the **exec** tool).

The model's reply is an **assistant message**: `role: "assistant"`, `content: [...]`, where `content` is an array of blocks — text, and one or more **tool calls** (read, then exec). The system gets this response from the provider API via the SDK and must identify each tool call, match it to a tool by name, and execute it. The next steps trace that flow.

### Step 6: Get LLM response and identify tool calls

The embedded runner uses **pi-coding-agent** and **pi-ai**. The model is invoked via `streamSimple`; the provider API returns a stream or final message. The SDK normalizes the provider format (e.g. Anthropic `tool_use`, OpenAI `function_call`) into a common **agent message**: `role: "assistant"`, `content: [...]` — an array of blocks (text, thinking, **tool calls**, etc.).

**Where:** `src/agents/pi-embedded-runner/run/attempt.ts` — the session's stream function is set to `streamSimple`; the SDK consumes the API response and produces assistant messages.

A **tool call** in that content is a block with **`type`** in `"toolCall"` | `"toolUse"` | `"functionCall"`, **`id`** (string, unique per call), **`name`** (tool name), and **`arguments`** (input for the tool). OpenClaw **identifies** tool calls by scanning the assistant message's `content` for blocks with that `type` and a non-empty `id`. The SDK then looks up the tool by **name** in the registered tools and calls `execute(toolCallId, params, signal, onUpdate)`.

**Code (identification):** `src/agents/session-tool-result-guard.ts` defines `extractAssistantToolCalls` (internal); `src/agents/session-transcript-repair.ts` uses the same logic via `extractToolCallsFromAssistant`:

```ts
function extractAssistantToolCalls(msg: Extract<AgentMessage, { role: "assistant" }>): ToolCall[] {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    if (rec.type === "toolCall" || rec.type === "toolUse" || rec.type === "functionCall") {
      toolCalls.push({ id: rec.id, name: typeof rec.name === "string" ? rec.name : undefined });
    }
  }
  return toolCalls;
}
```

OpenClaw's tools (read, exec, etc.) are registered as **ToolDefinition** via `toToolDefinitions` in `src/agents/pi-tool-definition-adapter.ts` — each has `name`, `parameters`, and `execute` that forwards to `tool.execute(toolCallId, params, signal, onUpdate)`. The SDK uses the block's `name` to find the tool and the block's `id` and parsed `arguments` to call it. So: the system **gets** the LLM output as the normalized assistant message; it **identifies** tool calls by scanning `content` for blocks with that `type` and valid `id`; the SDK **matches** by `name` and **executes** by calling that tool's `execute(toolCallId, params, ...)`.

### Step 7: Skill binaries and exec permission (after Step 6, before Step 8)

Step 7 happens **after** the exec tool has been invoked (Step 6 — the SDK has already called `exec.execute(toolCallId, params, ...)`) and **before** the command is actually run (Step 8). So the order is: Step 6 → Step 7 → Step 8.

- **Gateway path** (`host=sandbox` or `host=gateway`): Inside `exec.execute()` in `src/agents/bash-tools.exec.ts`, the code calls `resolveExecApprovals` then `evaluateShellAllowlist({ allowlist, safeBins, cwd, env })` — no skill bins on the gateway. If the command is not allowed, the tool may request user approval or throw; only if allowed does it call `runExecProcess(...)` (Step 8).
- **Node path** (`host=node`): The exec tool sends the command to the node via `callGatewayTool("node.invoke", ...)`. The **node-host** receives it in `handleInvoke` (in `src/node-host/runner.ts`). There it calls `skillBins.current()` (which may call the gateway's **skills.bins** RPC to get the list of skill-declared binaries), then `evaluateShellAllowlist({ allowlist, safeBins, skillBins: bins, autoAllowSkills, ... })`. So the permission check (including skill bins) happens on the node-host **after** the invoke is received and **before** the node runs the command (Step 8).

Skills declare required binaries in the **same frontmatter** used in step 1: `metadata.openclaw.requires.bins`, `requires.anyBins`, and `install[].bins` (see `src/agents/skills/types.ts` — `OpenClawSkillMetadata`, `SkillInstallSpec`). The gateway collects those names from all workspace skill entries and exposes them via the **skills.bins** RPC; the node-host uses that list (when **autoAllowSkills** is on) to allow those binaries without an explicit allowlist entry.

**Code (collect skill binaries):** `src/gateway/server-methods/skills.ts` — `collectSkillBins` reads each entry's `metadata.requires.bins`, `requires.anyBins`, and `install[].bins`; the `skills.bins` handler returns the union across workspace dirs:

```ts
function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const t = bin.trim();
      if (t) bins.add(t);
    }
    for (const bin of anyBins) {
      /* ... */
    }
    for (const spec of install) {
      for (const bin of spec?.bins ?? []) bins.add(String(bin).trim());
    }
  }
  return [...bins].toSorted();
}
// skills.bins handler: listWorkspaceDirs(cfg), then for each dir loadWorkspaceSkillEntries + collectSkillBins; respond(true, { bins: [...bins].toSorted() }).
```

**Permission** depends on where the command runs: **Gateway** (`host=sandbox` or `host=gateway`): allowlist and **safeBins** from config and exec-approvals; the binary must be in `tools.exec.safeBins` or in the allowlist. **Node** (`host=node`): the node-host fetches **skill bins** from the gateway (`skills.bins` RPC) and **autoAllowSkills** from exec-approvals; if `autoAllowSkills` is true and the executable is in that set, the segment is allowed. **Code:** `src/node-host/runner.ts` — `SkillBinsCache` calls `client.request("skills.bins", {})`; when handling `system.run`, `evaluateShellAllowlist` is called with `skillBins: bins` and `autoAllowSkills`. `src/infra/exec-approvals.ts` — `evaluateSegments` allows a segment if it matches the allowlist, is a safe bin, or (`autoAllowSkills` and the executable is in `skillBins`).

### Step 8: Execute tool and return result to the LLM

For an **exec** call that is allowed (or approved), the exec tool runs the command: **Gateway path:** `src/agents/bash-tools.exec.ts` → `runExecProcess` (spawn directly or in Docker); stdout/stderr are aggregated. **Node path:** exec tool sends the command via `callGatewayTool("node.invoke", ...)` with `command: "system.run"`; the node-host runs it locally and sends back the outcome.

**Code (gateway run to completion):** `src/agents/bash-tools.exec.ts` — after allowlist/approval, `runExecProcess` returns a handle whose `promise` resolves with `{ status, exitCode, durationMs, aggregated }`; the tool then resolves with `{ content: [{ type: "text", text: outcome.aggregated || "(no output)" }], details: { status: "completed", exitCode, durationMs, aggregated, cwd } }`. That return is the **agent tool result**. The pi-coding-agent runtime records it as the tool result for the corresponding tool call (matched by `id`), appends a model turn with the tool call(s) and their results, and calls the model again with the updated history. So the **result** is the `content[].text` (and `details`) the model sees in the next turn — no separate "send to LLM" step; it is part of the normal turn structure.

### Step 9: LLM produces final result (possibly after more tool calls)

The model receives the tool result in the next turn. It can: send a **final** text reply (delivered to the user by the reply pipeline), or issue **further** tool calls (each is executed, the result is appended, and the model is invoked again). This repeats until the model sends a turn without tool calls (or with only a final message). The code that drives this loop is in the embedded runner and the session manager (`streamSimple`, session history, tool result injection). The skill does not implement the loop — it only describes binaries and usage in SKILL.md; the model uses the generic exec (and other) tools over multiple iterations until it is done.

---

## Summary table (walkthrough steps)

| Step | Where                                                                                                                                                                                                                                                                                                         | Outcome                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `loadSkillEntries` in workspace.ts                                                                                                                                                                                                                                                                            | `SkillEntry` for clawhub (and others) in memory; metadata (e.g. `requires.bins`) used later for skill binaries. No system prompt yet.                               |
| 2    | `ensureSkillSnapshot` → `buildWorkspaceSkillSnapshot` in session-updates + workspace                                                                                                                                                                                                                          | Session has `skillsSnapshot.prompt` = formatted skill list (e.g. `<available_skills>...</available_skills>`).                                                       |
| 3    | `resolveSkillsPromptForRun` in attempt.ts                                                                                                                                                                                                                                                                     | `skillsPrompt` string set from snapshot (or built from entries).                                                                                                    |
| 4    | `buildSkillsSection` + `buildAgentSystemPrompt` in system-prompt.ts                                                                                                                                                                                                                                           | Full system prompt includes "## Skills (mandatory)" plus instructions and the `skillsPrompt` block.                                                                 |
| 5    | Model                                                                                                                                                                                                                                                                                                         | Model picks clawhub, may call read then exec; reply is assistant message with content blocks (text + tool calls).                                                   |
| 6    | `streamSimple` (attempt.ts); `extractAssistantToolCalls` (session-tool-result-guard) / `extractToolCallsFromAssistant` (session-transcript-repair); `toToolDefinitions` (pi-tool-definition-adapter)                                                                                                          | System gets LLM output as normalized assistant message; identifies tool calls by `type` + `id`; SDK matches by `name` and calls `execute(toolCallId, params, ...)`. |
| 7    | After exec tool invoked (step 6), before command run (step 8). Gateway: inside `exec.execute()` (bash-tools.exec) — allowlist + safeBins. Node: in node-host `handleInvoke` (runner.ts) — `skillBins.current()` (calls gateway `skills.bins`) + `evaluateShellAllowlist`; `evaluateSegments` (exec-approvals) | Permission check: gateway = allowlist/safeBins (no skill bins); node = skillBins + autoAllowSkills.                                                                 |
| 8    | `runExecProcess` (bash-tools.exec) or `node.invoke` (node-host); tool result returned                                                                                                                                                                                                                         | Exec runs (gateway or node); tool returns `{ content, details }`; SDK records result, appends turn, calls model again.                                              |
| 9    | Embedded runner + session manager (`streamSimple`, session history)                                                                                                                                                                                                                                           | Model sees tool result; may send final reply (delivered to user) or more tool calls (loop until final message).                                                     |

The XML shape of the skills block matches the format from `formatSkillsForPrompt` (pi-coding-agent) and is documented under [System prompt → Skills](/concepts/system-prompt#skills).
