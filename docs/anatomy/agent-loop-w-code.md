---
summary: "Agent loop lifecycle with code locations and sample code"
read_when:
  - You need to find the code that implements each step of the agent loop
---

# Agent Loop with Code (OpenClaw)

This doc maps each step of the [Agent Loop](/concepts/agent-loop) to the code that implements it, with sample snippets and file locations.

## Entry points

| Entry                    | Code location                                                             | Sample                                                        |
| ------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Gateway RPC `agent`      | `src/gateway/server-methods/agent.ts`                                     | `agentHandlers.agent` handler                                 |
| Gateway RPC `agent.wait` | `src/gateway/server-methods/agent.ts`                                     | `agentHandlers["agent.wait"]` handler                         |
| CLI `agent` command      | `src/cli/program/register.agent.ts` → `src/commands/agent-via-gateway.ts` | Registers `openclaw agent`; gateway path calls `agentCommand` |

**CLI wiring:** `register.agent.ts` defines the `agent` command; `agent-via-gateway.ts` calls `callGateway({ method: "agent", params: {...} })` for remote, or `agentCommand(localOpts, runtime, deps)` for local.

---

## Step 1: `agent` RPC validates params, resolves session, returns `{ runId, acceptedAt }`

**Location:** `src/gateway/server-methods/agent.ts`

- **Validate params:** `validateAgentParams(p)`; on failure, `respond(false, ..., errorShape(ErrorCodes.INVALID_REQUEST, ...))`.
- **Resolve session:** `loadSessionEntry`, `resolveAgentDeliveryPlan`, `resolveAgentOutboundTarget`, etc. Session key/id resolved from `sessionKey`, `sessionId`, `to`, `agentId`.
- **Persist session metadata / dedupe:** `context.dedupe.set(\`agent:${idem}\`, { ts, ok: true, payload: accepted })`.
- **Respond immediately:** `respond(true, { runId, status: "accepted", acceptedAt: Date.now() }, undefined, { runId })`.

```ts
// src/gateway/server-methods/agent.ts (simplified)
if (!validateAgentParams(p)) {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `invalid agent params: ...`));
  return;
}
// ... resolve session, delivery plan, runId ...
const accepted = { runId, status: "accepted" as const, acceptedAt: Date.now() };
context.dedupe.set(`agent:${idem}`, { ts: Date.now(), ok: true, payload: accepted });
respond(true, accepted, undefined, { runId });
void agentCommand({ ... }, defaultRuntime, context.deps).then(...).catch(...);
```

---

## Step 2: `agentCommand` runs the agent

**Location:** `src/commands/agent.ts`

- **Resolve model + thinking/verbose:** `resolveConfiguredModelRef`, `normalizeThinkLevel`, `normalizeVerboseLevel`, `resolveAgentTimeoutMs`.
- **Load skills snapshot:** `buildWorkspaceSkillSnapshot` (or reuse); `getSkillsSnapshotVersion`.
- **Call embedded runtime:** `runWithModelFallback` → `runEmbeddedPiAgent(...)` or `runCliAgent(...)` for CLI backends.
- **Emit lifecycle end/error if loop did not:** After `runEmbeddedPiAgent` returns, if `!lifecycleEnded`, `emitAgentEvent({ runId, stream: "lifecycle", data: { phase: "end", ... } })`; in catch, `emitAgentEvent(..., phase: "error")`.

```ts
// src/commands/agent.ts (excerpt)
const workspace = await ensureAgentWorkspace({
  dir: workspaceDirRaw,
  ensureBootstrapFiles: !agentCfg?.skipBootstrap,
});
const sessionResolution = resolveSession({
  cfg,
  to: opts.to,
  sessionId: opts.sessionId,
  sessionKey: opts.sessionKey,
  agentId: agentIdOverride,
});
// ...
return runEmbeddedPiAgent({
  sessionId,
  sessionKey,
  sessionFile,
  workspaceDir,
  config: cfg,
  skillsSnapshot,
  prompt: body,
  provider: providerOverride,
  model: modelOverride,
  thinkLevel: resolvedThinkLevel,
  timeoutMs,
  runId,
  onAgentEvent: (evt) => {
    if (evt.stream === "lifecycle" && (evt.data?.phase === "end" || evt.data?.phase === "error"))
      lifecycleEnded = true;
  },
});
// ...
if (!lifecycleEnded) {
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt, endedAt: Date.now(), aborted: result.meta.aborted ?? false },
  });
}
```

---

## Step 3: `runEmbeddedPiAgent` — queueing, model, session, timeout

**Location:** `src/agents/pi-embedded-runner/run.ts`

- **Serialize runs (per-session + global lane):** `resolveSessionLane(sessionKey || sessionId)`, `resolveGlobalLane(params.lane)`, `enqueueCommandInLane(sessionLane, ...)` then `enqueueGlobal(...)`. Lane helpers in `src/agents/pi-embedded-runner/lanes.ts`.
- **Resolve model + auth:** `resolveModel(provider, modelId, agentDir, config)`, auth profile order and cooldown in `src/agents/pi-embedded-runner/run.ts`.
- **Subscribe to pi events / stream:** `runEmbeddedAttempt` in `src/agents/pi-embedded-runner/run/attempt.ts` calls `subscribeEmbeddedPiSession({ session: activeSession, runId, onAgentEvent, ... })`.
- **Timeout → abort:** In `run/attempt.ts`, `setTimeout(() => { log.warn(...); abortRun(true); }, params.timeoutMs)`; `abortRun` aborts the pi session.

```ts
// src/agents/pi-embedded-runner/run.ts
const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
const globalLane = resolveGlobalLane(params.lane);
const enqueueSession =
  params.enqueue ?? ((task, opts) => enqueueCommandInLane(sessionLane, task, opts));
const enqueueGlobal =
  params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
return enqueueSession(() =>
  enqueueGlobal(async () => {
    // resolve model, auth, then runEmbeddedAttempt(...) which subscribes and sets abort timer
  }),
);
```

**Lanes:** `src/agents/pi-embedded-runner/lanes.ts` — `resolveSessionLane(key)`, `resolveGlobalLane(lane)`.

---

## Step 4: `subscribeEmbeddedPiSession` — bridge pi events to OpenClaw streams

**Location:** `src/agents/pi-embedded-subscribe.ts` (subscription setup); handlers in `src/agents/pi-embedded-subscribe.handlers.*.ts`.

- **Tool events → `stream: "tool"`:** `src/agents/pi-embedded-subscribe.handlers.tools.ts` — `handleToolExecutionStart`, `handleToolExecutionUpdate`, `handleToolExecutionEnd` call `emitAgentEvent({ runId, stream: "tool", data: { phase: "start"|"update"|"end", name, toolCallId, ... } })` and `ctx.params.onAgentEvent?.({ stream: "tool", ... })`.
- **Assistant deltas → `stream: "assistant"`:** `src/agents/pi-embedded-subscribe.handlers.messages.ts` — `handleMessageUpdate` / text handling calls `emitAgentEvent({ runId, stream: "assistant", data: { text, delta, mediaUrls } })` and `onAgentEvent` / `onPartialReply`.
- **Lifecycle → `stream: "lifecycle"`:** `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts` — `handleAgentStart` emits `phase: "start"`, `handleAgentEnd` emits `phase: "end"`; both use `emitAgentEvent` and `ctx.params.onAgentEvent?.({ stream: "lifecycle", data: { phase } })`.

```ts
// src/agents/pi-embedded-subscribe.handlers.lifecycle.ts
export function handleAgentStart(ctx: EmbeddedPiSubscribeContext) {
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: { phase: "start", startedAt: Date.now() },
  });
  void ctx.params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
}
export function handleAgentEnd(ctx: EmbeddedPiSubscribeContext) {
  emitAgentEvent({
    runId: ctx.params.runId,
    stream: "lifecycle",
    data: { phase: "end", endedAt: Date.now() },
  });
  void ctx.params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "end" } });
}

// src/agents/pi-embedded-subscribe.handlers.tools.ts (tool start)
emitAgentEvent({
  runId: ctx.params.runId,
  stream: "tool",
  data: { phase: "start", name: toolName, toolCallId, args },
});
void ctx.params.onAgentEvent?.({
  stream: "tool",
  data: { phase: "start", name: toolName, toolCallId },
});

// src/agents/pi-embedded-subscribe.handlers.messages.ts (assistant delta)
emitAgentEvent({
  runId: ctx.params.runId,
  stream: "assistant",
  data: { text: cleanedText, delta: deltaText, mediaUrls },
});
void ctx.params.onAgentEvent?.({
  stream: "assistant",
  data: { text: cleanedText, delta: deltaText, mediaUrls },
});
```

---

## Step 5: `agent.wait` and `waitForAgentJob`

**Location:** `src/gateway/server-methods/agent.ts` (`"agent.wait"` handler), `src/gateway/server-methods/agent-job.ts` (`waitForAgentJob`).

- **Validate params:** `validateAgentWaitParams(p)`; on failure respond with error.
- **Wait for lifecycle end/error:** `waitForAgentJob({ runId, timeoutMs })` subscribes via `onAgentEvent` and resolves when `stream === "lifecycle"` and `phase === "end"` or `phase === "error"`, or on timeout.
- **Response:** `respond(true, { runId, status: snapshot.status | "timeout", startedAt, endedAt, error })`.

```ts
// src/gateway/server-methods/agent.ts
"agent.wait": async ({ params, respond }) => {
  if (!validateAgentWaitParams(params)) { respond(false, ...); return; }
  const snapshot = await waitForAgentJob({ runId: p.runId.trim(), timeoutMs: p.timeoutMs ?? 30_000 });
  if (!snapshot) respond(true, { runId, status: "timeout" });
  else respond(true, { runId, status: snapshot.status, startedAt: snapshot.startedAt, endedAt: snapshot.endedAt, error: snapshot.error });
}

// src/gateway/server-methods/agent-job.ts
export async function waitForAgentJob(params: { runId: string; timeoutMs: number }): Promise<AgentRunSnapshot | null> {
  ensureAgentRunListener();
  const cached = getCachedAgentRun(runId); if (cached) return cached;
  return await new Promise((resolve) => {
    const unsubscribe = onAgentEvent((evt) => {
      if (!evt || evt.stream !== "lifecycle" || evt.runId !== runId) return;
      if (evt.data?.phase !== "end" && evt.data?.phase !== "error") return;
      // build snapshot from evt.data, recordAgentRunSnapshot(snapshot), resolve(snapshot);
    });
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
  });
}
```

---

## Queueing + concurrency

- **Per-session lane:** `src/agents/pi-embedded-runner/lanes.ts` — `resolveSessionLane(key)` → `session:${key}` (or `CommandLane.Main`).
- **Global lane:** `resolveGlobalLane(lane)`; default `CommandLane.Main`; callers pass `lane` (e.g. subagent lane) from RPC/CLI.
- **Enqueue:** `src/process/command-queue.ts` — `enqueueCommandInLane(lane, task, opts)`; used in `run.ts` as `enqueueSession(() => enqueueGlobal(async () => { ... }))`.
- **Queue message during run:** `src/agents/pi-embedded-runner/runs.ts` — `queueEmbeddedPiMessage(sessionId, text)` uses active run handle to `queueMessage(text)`.

---

## Session + workspace preparation

- **Workspace:** `src/agents/workspace.ts` — `ensureAgentWorkspace({ dir, ensureBootstrapFiles })`; used in `src/commands/agent.ts`.
- **Bootstrap/context files:** `src/agents/bootstrap-files.ts` — `resolveBootstrapFilesForRun` (loads workspace bootstrap files, filters for session), then `applyBootstrapHookOverrides` (runs `agent:bootstrap` hook); `resolveBootstrapContextForRun` returns `bootstrapFiles` and `contextFiles` (built via `buildBootstrapContextFiles` in `src/agents/pi-embedded-helpers/bootstrap.ts`). Used in `src/agents/pi-embedded-runner/run/attempt.ts` and `compact.ts`.
- **Session write lock:** `src/agents/session-write-lock.ts` — `acquireSessionWriteLock({ sessionFile })`; used in `src/agents/pi-embedded-runner/run/attempt.ts` before opening `SessionManager` / creating pi session.
- **SessionManager / pi session:** Built and opened in `runEmbeddedAttempt` in `src/agents/pi-embedded-runner/run/attempt.ts` after lock and workspace/bootstrap are ready.

---

## Prompt assembly + system prompt

- **Build system prompt:** `src/agents/pi-embedded-runner/run/attempt.ts` calls `buildEmbeddedSystemPrompt` (in `src/agents/pi-embedded-runner/system-prompt.ts` or embedded helpers) with workspace, think level, skills prompt, bootstrap context files, runtime info, etc. Core prompt builder: `src/agents/system-prompt.ts` — `buildAgentSystemPrompt`.
- **Bootstrap injection:** Context files from `resolveBootstrapContextForRun` (after `agent:bootstrap` hook) are passed into the system prompt builder.
- **Model limits / compaction reserve:** Context window and compaction are applied in embedded runner and compaction pipeline; see `src/agents/context-window-guard.ts` and `src/agents/pi-embedded-runner/compact.ts`.

---

## Hook points

- **Internal `agent:bootstrap`:** `src/agents/bootstrap-hooks.ts` — `applyBootstrapHookOverrides` creates `AgentBootstrapHookContext` and calls `triggerInternalHook(event)` for `"agent"`, `"bootstrap"`. Used from `resolveBootstrapFilesForRun` in `src/agents/bootstrap-files.ts`.
- **Plugin `before_agent_start`:** `src/plugins/hooks.ts` — `runBeforeAgentStart`; called from `src/agents/pi-embedded-runner/run/attempt.ts` before building final system prompt and starting the run.
- **Plugin `agent_end` / `before_compaction` / `after_compaction` / `before_tool_call` / `after_tool_call`:** Same plugin runner in `src/plugins/hooks.ts`; used from pi-embedded-runner and compaction/tool paths as documented in [Plugins](/plugin#plugin-hooks).

---

## Streaming + partial replies

- **Assistant deltas:** Emitted in `src/agents/pi-embedded-subscribe.handlers.messages.ts` — `handleMessageUpdate` (text_delta / text_start / text_end) pushes to buffers and emits `stream: "assistant"` with `text`, `delta`, `mediaUrls`; `onPartialReply` called when configured.
- **Block reply flush:** `EmbeddedBlockChunker` and `onBlockReply` / `onBlockReplyFlush` in `src/agents/pi-embedded-subscribe.ts` and handlers; block replies emitted on `text_end` or `message_end` depending on `blockReplyBreak`.
- **Reasoning stream:** Handled in subscribe layer; can be separate stream or block replies; see `reasoningMode` and `onReasoningStream` in `src/agents/pi-embedded-subscribe.types.ts`.

---

## Tool execution + messaging tools

- **Tool start/update/end:** `src/agents/pi-embedded-subscribe.handlers.tools.ts` — `handleToolExecutionStart`, `handleToolExecutionUpdate`, `handleToolExecutionEnd`; each emits `stream: "tool"` and optionally calls `onToolResult`.
- **Sanitize tool results / images:** Sanitization and size caps applied in tool result formatting and in `src/agents/pi-embedded-subscribe.tools.ts` (e.g. `sanitizeToolResult`, `extractToolResultText`).
- **Messaging tool sends tracked:** State in `subscribeEmbeddedPiSession` (e.g. `messagingToolSentTexts`, `pendingMessagingTexts`) and helpers in `src/agents/pi-embedded-helpers.js` / `pi-embedded-messaging.js` (e.g. `isMessagingTool`, `isMessagingToolSendAction`) to suppress duplicate confirmations.

---

## Reply shaping + suppression

- **Payload assembly:** `src/agents/pi-embedded-runner/run/payloads.ts` — `buildEmbeddedRunPayloads` builds reply items from assistant text, optional reasoning, inline tool summaries (when verbose), and assistant error text; then maps to payloads with `text`, `mediaUrl`, `mediaUrls`, etc.
- **NO_REPLY filtering:** `src/auto-reply/tokens.ts` — `SILENT_REPLY_TOKEN = "NO_REPLY"`, `isSilentReplyText`. In `src/agents/pi-embedded-runner/run/payloads.ts`, payloads are filtered: `if (p.text && isSilentReplyText(p.text, SILENT_REPLY_TOKEN)) return false`.
- **Messaging tool duplicates:** Removed in reply pipeline; e.g. `src/auto-reply/reply/reply-payloads.ts` — `payloads.filter(... !isMessagingToolDuplicate(...))`.
- **Fallback tool error reply:** When no renderable payloads remain and a tool errored, fallback logic in delivery/payload code (e.g. in `buildEmbeddedRunPayloads` or delivery layer) can emit a generic error message unless a messaging tool already sent a user-visible reply.

---

## Compaction + retries

- **Compaction events:** `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts` — `handleAutoCompactionStart` / `handleAutoCompactionEnd` emit `stream: "compaction"` with `phase: "start"` / `phase: "end"`, `willRetry`.
- **Compaction implementation:** `src/agents/pi-embedded-runner/compact.ts` — `compactEmbeddedPiSessionDirect`, acquires session lock, resolves context, runs compaction; can trigger retry; `run/attempt.ts` uses `waitForCompactionRetry` and resets in-memory state on retry.
- **Retry reset:** In subscribe layer, `resetForCompactionRetry` and related state resets to avoid duplicate output after compaction.

---

## Event streams (summary)

- **`lifecycle`:** Emitted in `pi-embedded-subscribe.handlers.lifecycle.ts` and fallback in `src/commands/agent.ts` when the embedded loop does not emit.
- **`assistant`:** Emitted in `pi-embedded-subscribe.handlers.messages.ts` for assistant text deltas.
- **`tool`:** Emitted in `pi-embedded-subscribe.handlers.tools.ts` for tool start/update/end.
- **Global emitter:** `src/infra/agent-events.ts` — `emitAgentEvent`, `onAgentEvent`.

---

## Chat channel handling

- **Buffering deltas / final:** Chat gateway or webchat layer buffers assistant deltas into `delta` messages and emits a chat `final` on lifecycle end/error; implementation is in gateway chat handlers and auto-reply paths that consume `onAgentEvent` / stream events.

---

## Timeouts

- **`agent.wait` default 30s:** `src/gateway/server-methods/agent.ts` — `timeoutMs = typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) ? Math.max(0, Math.floor(p.timeoutMs)) : 30_000`.
- **Agent runtime default 600s:** Config `agents.defaults.timeoutSeconds`; `src/agents/timeout.ts` — `resolveAgentTimeoutMs`; enforced in `src/agents/pi-embedded-runner/run/attempt.ts` with `setTimeout(..., params.timeoutMs)` calling `abortRun(true)`.

---

## Where things can end early

- **Agent timeout:** Abort timer in `run/attempt.ts` calls `abortRun(true)`.
- **AbortSignal:** `params.abortSignal.addEventListener("abort", onAbort)` in `run/attempt.ts`; `onAbort` calls `abortRun(timeout, reason)`.
- **Gateway disconnect / RPC timeout:** Handled by the transport; agent may keep running until timeout or completion.
- **`agent.wait` timeout:** Only the wait promise resolves with `status: "timeout"`; it does not stop the agent run.

---

## Reference: key files

| Area                                   | File(s)                                                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway agent RPC                      | `src/gateway/server-methods/agent.ts`                                                                                                          |
| agent.wait job wait                    | `src/gateway/server-methods/agent-job.ts`                                                                                                      |
| Agent command (CLI entry → run)        | `src/commands/agent.ts`, `src/commands/agent-via-gateway.ts`                                                                                   |
| Embedded run (queue, attempt, timeout) | `src/agents/pi-embedded-runner/run.ts`, `src/agents/pi-embedded-runner/run/attempt.ts`                                                         |
| Lanes / queueing                       | `src/agents/pi-embedded-runner/lanes.ts`, `src/process/command-queue.ts`                                                                       |
| Subscribe (stream bridge)              | `src/agents/pi-embedded-subscribe.ts`, `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts`, `.handlers.tools.ts`, `.handlers.messages.ts` |
| Bootstrap / hooks                      | `src/agents/bootstrap-files.ts`, `src/agents/bootstrap-hooks.ts`                                                                               |
| System prompt                          | `src/agents/system-prompt.ts`, `src/agents/pi-embedded-runner/run/attempt.ts` (buildEmbeddedSystemPrompt)                                      |
| Session lock / workspace               | `src/agents/session-write-lock.ts`, `src/agents/workspace.ts`                                                                                  |
| Payloads / NO_REPLY                    | `src/agents/pi-embedded-runner/run/payloads.ts`, `src/auto-reply/tokens.ts`                                                                    |
| Compaction                             | `src/agents/pi-embedded-runner/compact.ts`                                                                                                     |
| Agent events                           | `src/infra/agent-events.ts`                                                                                                                    |
