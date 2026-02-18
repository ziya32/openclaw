---
summary: "How agents are defined, configured, and used (CLI, channels, Control UI, API)"
read_when:
  - Understanding what an agent is vs session vs model
  - Configuring one or multiple agents
  - Targeting a specific agent from CLI, UI, or API
---

# Agent Use

This doc explains what an agent is in OpenClaw, how to configure one or multiple agents, and how users (or clients) target a specific agent (e.g. "agent 007") from messaging channels, CLI, Control UI, and API.

## What is an agent?

An **agent** is a fully scoped "brain": one identity with its own workspace, state directory, and session store. It is **not** one conversation, one LLM, or one task.

| Term         | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Agent**    | One configured brain: workspace + `agentDir` + session store. Identified by `agentId` (e.g. `main`, `work`, `007`). |
| **Session**  | One conversation/thread: transcript (JSONL), token state. Many sessions per agent (main, groups, cron, etc.).       |
| **Run/turn** | One LLM invocation (and tool use) inside a session.                                                                 |

**Code:** Agent config types and list shape are defined in `src/config/types.agents.ts`; resolution (workspace, agentDir) is in `src/agents/agent-scope.ts`.

```typescript
// src/config/types.agents.ts (excerpt)
export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  memorySearch?: MemorySearchConfig;
  // ... identity, sandbox, tools, subagents
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
```

```typescript
// src/agents/agent-scope.ts — resolve workspace/agentDir for an agentId
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): ResolvedAgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  const entry = resolveAgentEntry(cfg, id);
  // ...
}
```

See [Multi-Agent Routing](/concepts/multi-agent) and [Agent Runtime](/concepts/agent) for full context.

---

## Configuring one or multiple agents

Config lives in **`~/.openclaw/openclaw.json`** (or `OPENCLAW_CONFIG_PATH`).

### One agent (default)

If you omit `agents.list`, OpenClaw runs a single agent with `agentId: "main"`. Use `agents.defaults` for shared defaults.

**Minimal one-agent config:**

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Default session key for main: `agent:main:main`. Built in `src/routing/session-key.ts`:

```typescript
// src/routing/session-key.ts
export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}
```

### Multiple agents

Define each agent in **`agents.list`** and route inbound traffic with **`bindings`**.

**Example: two agents, bindings by channel account**

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      { id: "home", default: true, name: "Home", workspace: "~/.openclaw/workspace-home" },
      { id: "work", name: "Work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: { personal: {}, biz: {} },
    },
  },
}
```

**Binding match order** (first match wins): peer → guildId → teamId → accountId (exact) → accountId `"*"` → default agent. Implemented in `src/routing/resolve-route.ts`:

```typescript
// src/routing/resolve-route.ts — resolveAgentRoute()
export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  // ...
  if (peer) {
    const peerMatch = bindings.find((b) => matchesPeer(b.match, peer));
    if (peerMatch) return choose(peerMatch.agentId, "binding.peer");
  }
  if (guildId) {
    const guildMatch = bindings.find((b) => matchesGuild(b.match, guildId));
    if (guildMatch) return choose(guildMatch.agentId, "binding.guild");
  }
  // ... teamId, accountId, channel-wide, then default
  return choose(resolveDefaultAgentId(input.cfg), "default");
}
```

**CLI to add an agent:** `openclaw agents add <name>` (writes `agents.list[]` and optional bindings). See [Setup](/start/setup) and [Configuration](/gateway/configuration).

---

## How users target a specific agent

Different entry points: messaging channels, CLI, Control UI, HTTP/WebSocket API, and subagents.

### 1. From messaging channels (WhatsApp, Telegram, etc.)

The user does **not** type the agent id (e.g. "007"). Which agent runs is determined by **bindings**: channel + accountId + peer (DM/group). The user "uses" agent 007 by messaging from a number/account/group that is bound to 007.

**Config example:** bind one Telegram DM to agent 007:

```json5
{
  agents: {
    list: [{ id: "007", name: "Bond", workspace: "~/.openclaw/workspace-007" }],
  },
  bindings: [
    { agentId: "007", match: { channel: "telegram", peer: { kind: "dm", id: "123456789" } } },
  ],
}
```

Inbound message context is routed via `resolveAgentRoute()`; the returned `agentId` and `sessionKey` drive which agent and session handle the reply. See [Channels and routing](/concepts/channel-routing).

### 2. From the CLI

Pass **`--agent <id>`** to target that agent. Session can be inferred (e.g. main for that agent) or set with `--session-key`.

**Example: tell agent 007 to do something**

```bash
openclaw agent --agent 007 --message "Summarize the logs"
```

**Code:** CLI option is registered in `src/cli/program/register.agent.ts`; validation and resolution in `src/commands/agent.ts`:

```typescript
// src/cli/program/register.agent.ts
.option("--agent <id>", "Agent id (overrides routing bindings)")
```

```typescript
// src/commands/agent.ts — agentId override and validation
const agentIdOverrideRaw = opts.agentId?.trim();
const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
if (agentIdOverride) {
  const knownAgents = listAgentIds(cfg);
  if (!knownAgents.includes(agentIdOverride)) {
    throw new Error(
      `Unknown agent id "${agentIdOverrideRaw}". Use "openclaw agents list" to see configured agents.`,
    );
  }
}
// ...
const sessionAgentId = agentIdOverride ?? resolveAgentIdFromSessionKey(opts.sessionKey?.trim());
```

### 3. From Control UI or WebSocket/HTTP API

**Control UI** is the browser dashboard at `http://<host>:18789/` (Vite + Lit SPA). It includes a **Chat** view with:

- A **session dropdown** (session keys like `agent:main:main` or `agent:007:main`)
- A **Message** textarea to type requests and Send/Queue

To talk to agent 007: select a session that belongs to 007 (e.g. `agent:007:main`) in the dropdown, then type in the text box. The UI sends `chat.send` with that `sessionKey`; the session key encodes the agent.

**Code:** Chat controller sends `chat.send` with `sessionKey` (no separate `agentId`; agent is implied by session key):

```typescript
// ui/src/ui/controllers/chat.ts
await state.client.request("chat.send", {
  sessionKey: state.sessionKey,
  message: msg,
  deliver: false,
  idempotencyKey: runId,
  attachments: apiAttachments,
});
```

Session dropdown and session-key handling (including parsing `agentId` from key for identity/avatar):

```typescript
// ui/src/ui/app-render.helpers.ts — session selector
<select
  .value=${state.sessionKey}
  @change=${(e: Event) => {
    const next = (e.target as HTMLSelectElement).value;
    state.sessionKey = next;
    // ... load history, sync URL
  }}
>
  ${repeat(sessionOptions, (entry) => entry.key, (entry) =>
    html`<option value=${entry.key}>${entry.displayName ?? entry.key}</option>`)}
</select>
```

```typescript
// ui/src/ui/app-render.ts — agentId from session key for identity
const parsed = parseAgentSessionKey(state.sessionKey);
const agentId = parsed?.agentId ?? state.agentsList?.defaultId ?? "main";
```

**WebSocket `agent` (or `chat`) with explicit agentId:** Clients that call the gateway `agent` method can send **`agentId`** in the params. The handler in `src/gateway/server-methods/agent.ts` validates and uses it:

```typescript
// src/gateway/server-methods/agent.ts
const agentIdRaw = typeof request.agentId === "string" ? request.agentId.trim() : "";
const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
if (agentId) {
  const knownAgents = listAgentIds(cfg);
  if (!knownAgents.includes(agentId)) {
    respond(false, undefined, errorShape(/* ... */ `unknown agent id "${request.agentId}"`));
    return;
  }
}
// requestedSessionKey can be derived from agentId if not provided
```

**Schema for agent request params** (`agentId` optional):

```typescript
// src/gateway/protocol/schema/agent.ts
export const AgentParamsSchema = Type.Object({
  message: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(Type.String()),
  // ... to, replyTo, thinking, deliver, idempotencyKey, etc.
});
```

**OpenAI-compat HTTP** (`/v1/chat/completions`): Use model name `openclaw:007` or `agent:007`, or header `x-openclaw-agent-id: 007` (or `x-openclaw-agent: 007`). Resolved in `src/gateway/http-utils.ts`:

```typescript
// src/gateway/http-utils.ts
export function resolveAgentIdFromHeader(req: IncomingMessage): string | undefined {
  const raw =
    getHeader(req, "x-openclaw-agent-id")?.trim() ||
    getHeader(req, "x-openclaw-agent")?.trim() ||
    "";
  if (!raw) return undefined;
  return normalizeAgentId(raw);
}

export function resolveAgentIdFromModel(model: string | undefined): string | undefined {
  const m =
    raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ??
    raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i);
  return m?.groups?.agentId ? normalizeAgentId(m.groups.agentId) : undefined;
}

export function resolveAgentIdForRequest(params: {
  req: IncomingMessage;
  model: string | undefined;
}): string {
  const fromHeader = resolveAgentIdFromHeader(params.req);
  if (fromHeader) return fromHeader;
  const fromModel = resolveAgentIdFromModel(params.model);
  return fromModel ?? "main";
}
```

### 4. From another agent (subagents)

One agent can spawn a run on agent 007 via the **sessions_spawn** tool, passing **`agentId: "007"`**, if `agents.list[].subagents.allowAgents` allows it (e.g. includes `"007"` or `["*"]`). See [Subagents](/tools/subagents).

---

## Summary: how to "tell agent 007 to do something"

| Who is "the user"               | How they use agent 007                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Person on WhatsApp/Telegram** | Message from a number/group **bound** to 007 in `bindings`. No text like "007" in the message.                                         |
| **You at the terminal**         | `openclaw agent --agent 007 --message "Do X"`.                                                                                         |
| **Control UI**                  | Select a session for 007 (e.g. `agent:007:main`) in the session dropdown, then type in the Message text box and send.                  |
| **API client (WS/HTTP)**        | Send request with `agentId: "007"` (WS `agent` params) or, for OpenAI HTTP, model `openclaw:007` or header `x-openclaw-agent-id: 007`. |
| **Another agent**               | Call `sessions_spawn` with `agentId: "007"` (if allowed by `subagents.allowAgents`).                                                   |

---

## Related docs

- [Multi-Agent Routing](/concepts/multi-agent) — bindings, multiple workspaces, routing rules
- [Agent Runtime](/concepts/agent) — workspace, bootstrap files, pi-mono
- [Session Management](/concepts/session) — session keys, store, lifecycle
- [Channels and routing](/concepts/channel-routing) — how channel messages get an agentId
- [Control UI](/web/control-ui) — browser dashboard and chat
- [Configuration](/gateway/configuration) — full config schema and examples
