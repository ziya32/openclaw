# Session Management

How OpenClaw manages sessions: keys, store, transcripts, routing, and lifecycle. This doc summarizes the code and points to the relevant files with samples.

---

## 1. Concepts

- **Session key** — A string that identifies a conversation bucket. Used for persistence, concurrency (lanes), and routing. Examples: `agent:main:main` (single main session), `agent:main:telegram:default:dm:user123`, `agent:main:discord:default:group:guild-id`.
- **Session ID** — A UUID for a specific conversation instance. Stored in the session entry and used as the transcript filename base (`{sessionId}.jsonl`).
- **Session entry** — Metadata for one session key: `sessionId`, `updatedAt`, `sessionFile`, channel/last route, thinking/verbose levels, usage, compaction count, etc. Stored in `sessions.json` (the “session store”).
- **Session store** — A JSON file (by default `~/.openclaw/agents/{agentId}/sessions/sessions.json`) mapping session keys to session entries. One store per agent.
- **Transcript** — A JSONL file (one JSON object per line) holding the conversation: user messages, tool calls, results, assistant messages. Path: `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl` (or `{sessionId}-topic-{topicId}.jsonl` for threads).

### 1.1. Relationship: session key, session ID, and session entry

It's easy to mix these up. Here's how they relate.

| Term              | What it is                                            | Where it lives                                     | Role                                                                                          |
| ----------------- | ----------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Session key**   | String, e.g. `agent:main:telegram:default:dm:user123` | Key in the session store map                       | Identifies the **conversation bucket** (which lane/route). Stable across resets.              |
| **Session ID**    | UUID string, e.g. `a1b2c3d4-...`                      | **Inside** the session entry, as `entry.sessionId` | Identifies the **conversation instance**. Used for transcript filenames. May change on reset. |
| **Session entry** | Object (`SessionEntry`)                               | **Value** in the session store for that key        | Holds `sessionId`, `updatedAt`, and all metadata for that key (channel, levels, usage, etc.). |

**In one line:** the **session store** is a map from **session key** to **session entry**; each **session entry** contains a **session ID** that names its transcript file.

```
Session store (sessions.json)
+-------------------------------------+----------------------------------------+
|  session key (map key)              |  session entry (map value)             |
+-------------------------------------+----------------------------------------+
|  "agent:main:main"                  |  { sessionId: "uuid-1", updatedAt,... }|
|  "agent:main:telegram:default:dm:42"|  { sessionId: "uuid-2", updatedAt,... }|
+-------------------------------------+----------------------------------------+
         |                                        |
         |                                        +-- entry.sessionId -> transcript file
         |                                            e.g. .../sessions/uuid-2.jsonl
         +-- Used for routing, locking, "which conversation"
```

**Code:** the store type is `Record<string, SessionEntry>`. You look up by key; the entry gives you the ID and metadata.

**File:** `src/config/sessions/store.ts`, `src/config/sessions/types.ts`

```typescript
// Store shape: session key -> session entry
let store: Record<string, SessionEntry> = await loadSessionStore(storePath);

const sessionKey = "agent:main:main";
const entry = store[sessionKey]; // session entry (value)
const sessionId = entry?.sessionId; // UUID inside that entry
// Transcript path uses sessionId, not sessionKey:
// ~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

When a session is **reset**, the same **session key** is typically kept (same lane), but the **session entry** may get a new **session ID** and a new transcript file; the old transcript file remains on disk until pruned.

---

## 2. Session key format and routing

Session keys follow a structured format so routing and persistence stay consistent.

### Parsing and building (routing layer)

**File:** `src/routing/session-key.ts`

Session keys for the **store** look like `agent:{agentId}:{rest}`. The “rest” can be `main`, or channel/account/peer (e.g. `telegram:default:dm:user123`). Helpers build and normalize these keys.

```typescript
// Build the canonical "main" session key for an agent (all DMs collapse here unless dmScope is per-peer).
export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

// Build a key for a specific peer (DM or group/channel).
export function buildAgentPeerSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
  channel: string;
  accountId?: string | null;
  peerKind?: "dm" | "group" | "channel" | null;
  peerId?: string | null;
  identityLinks?: Record<string, string[]>;
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
}): string {
  // ... returns e.g. agent:main:telegram:default:dm:user123
}
```

**File:** `src/sessions/session-key-utils.ts`

Parsing extracts `agentId` and the rest of the key (used for “request” keys and subagent/acp checks).

```typescript
export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

export function parseAgentSessionKey(
  sessionKey: string | undefined | null,
): ParsedAgentSessionKey | null {
  const raw = (sessionKey ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(":").filter(Boolean);
  if (parts.length < 3) return null;
  if (parts[0] !== "agent") return null;
  const agentId = parts[1]?.trim();
  const rest = parts.slice(2).join(":");
  if (!agentId || !rest) return null;
  return { agentId, rest };
}
```

### Resolving route → session key (inbound from channel)

**File:** `src/routing/resolve-route.ts`

For an inbound message, the route is resolved first (agent + channel + account + peer). The session key is then built from that route.

```typescript
export type ResolvedAgentRoute = {
  agentId: string;
  channel: string;
  accountId: string;
  /** Internal session key used for persistence + concurrency. */
  sessionKey: string;
  /** Convenience alias for direct-chat collapse. */
  mainSessionKey: string;
  matchedBy:
    | "binding.peer"
    | "binding.guild"
    | "binding.team"
    | "binding.account"
    | "binding.channel"
    | "default";
};

export function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute {
  // ...
  const choose = (agentId: string, matchedBy: ResolvedAgentRoute["matchedBy"]) => {
    const resolvedAgentId = pickFirstExistingAgentId(input.cfg, agentId);
    const sessionKey = buildAgentSessionKey({
      agentId: resolvedAgentId,
      channel,
      accountId,
      peer,
      dmScope,
      identityLinks,
    }).toLowerCase();
    const mainSessionKey = buildAgentMainSessionKey({
      agentId: resolvedAgentId,
      mainKey: DEFAULT_MAIN_KEY,
    }).toLowerCase();
    return { agentId: resolvedAgentId, channel, accountId, sessionKey, mainSessionKey, matchedBy };
  };
  // Bindings: peer → guild → team → account → channel → default
  if (peer) {
    const peerMatch = bindings.find((b) => matchesPeer(b.match, peer));
    if (peerMatch) return choose(peerMatch.agentId, "binding.peer");
  }
  // ...
  return choose(resolveDefaultAgentId(input.cfg), "default");
}
```

Channels call `resolveAgentRoute(cfg, channel, accountId, peer, …)` and attach the returned `sessionKey` (and `agentId`) to the message context. That key is then used for store lookup and transcript path.

---

## 3. Session store (metadata)

The session store is a JSON file: key → session entry. It is read/written with locking and optional in-memory caching.

### Types

**File:** `src/config/sessions/types.ts`

```typescript
export type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile?: string;
  lastChannel?: SessionChannelId;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  thinkingLevel?: string;
  verboseLevel?: string;
  compactionCount?: number;
  deliveryContext?: DeliveryContext;
  // ... many optional fields (usage, overrides, queue mode, etc.)
};

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now());
  if (!existing) return { ...patch, sessionId, updatedAt };
  return { ...existing, ...patch, sessionId, updatedAt };
}
```

### Paths

**File:** `src/config/sessions/paths.ts`

```typescript
// Default store: ~/.openclaw/agents/{agentId}/sessions/sessions.json
export function resolveDefaultSessionStorePath(agentId?: string): string {
  return path.join(resolveAgentSessionsDir(agentId), "sessions.json");
}

// Transcript file for a session (and optional topic/thread).
export function resolveSessionTranscriptPath(
  sessionId: string,
  agentId?: string,
  topicId?: string | number,
): string {
  const fileName =
    safeTopicId !== undefined ? `${sessionId}-topic-${safeTopicId}.jsonl` : `${sessionId}.jsonl`;
  return path.join(resolveAgentSessionsDir(agentId), fileName);
}

// Store path can use {agentId} placeholder; config can override.
export function resolveStorePath(store?: string, opts?: { agentId?: string }) {
  const agentId = normalizeAgentId(opts?.agentId ?? DEFAULT_AGENT_ID);
  if (!store) return resolveDefaultSessionStorePath(agentId);
  if (store.includes("{agentId}")) {
    const expanded = store.replaceAll("{agentId}", agentId);
    // ... resolve ~ and absolute paths
  }
  return path.resolve(store);
}
```

### Load, save, lock, and update

**File:** `src/config/sessions/store.ts`

Store is loaded with optional TTL cache; saves use a file lock so concurrent writers don’t corrupt the file.

```typescript
export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  // Optional in-memory cache (e.g. 45s TTL)
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const cached = SESSION_STORE_CACHE.get(storePath);
    if (cached && isSessionStoreCacheValid(cached)) {
      // Return deep copy
      return structuredClone(cached.store);
    }
  }
  let store: Record<string, SessionEntry> = {};
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    const parsed = JSON5.parse(raw);
    if (isSessionStoreRecord(parsed)) store = parsed as Record<string, SessionEntry>;
  } catch {
    // ignore missing/invalid; we'll recreate
  }
  // Best-effort migrations (provider→channel, room→groupChannel)
  // ...
  return structuredClone(store);
}

export async function updateSessionStore<T>(
  storePath: string,
  mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
): Promise<T> {
  return await withSessionStoreLock(storePath, async () => {
    const store = loadSessionStore(storePath, { skipCache: true });
    const result = await mutator(store);
    await saveSessionStoreUnlocked(storePath, store);
    return result;
  });
}
```

Lock is implemented with a `.lock` file and optional stale eviction (e.g. 30s) for crashed processes.

```typescript
async function withSessionStoreLock<T>(storePath: string, fn: () => Promise<T>, opts): Promise<T> {
  const lockPath = `${storePath}.lock`;
  // Poll until we can create lockPath with wx, or timeout (e.g. 10s)
  // If EEXIST and lock is older than staleMs, unlink and retry
  // ...
  try {
    return await fn();
  } finally {
    await fs.promises.unlink(lockPath).catch(() => undefined);
  }
}
```

---

## 4. Resolving session for CLI / gateway (no channel context)

When the caller is the CLI or a gateway request (e.g. WebSocket `agent`), there is no channel message context. Session is resolved from config, optional `to`, `sessionId`, `sessionKey`, and `agentId`.

**File:** `src/commands/agent/session.ts`

```typescript
export function resolveSessionKeyForRequest(opts: {
  cfg: OpenClawConfig;
  to?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
}): SessionKeyResolution {
  const sessionCfg = opts.cfg.session;
  const scope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const explicitSessionKey =
    opts.sessionKey?.trim() ||
    resolveExplicitAgentSessionKey({ cfg: opts.cfg, agentId: opts.agentId });
  const storeAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
  const storePath = resolveStorePath(sessionCfg?.store, { agentId: storeAgentId });
  const sessionStore = loadSessionStore(storePath);

  const ctx: MsgContext | undefined = opts.to?.trim() ? { From: opts.to } : undefined;
  let sessionKey: string | undefined =
    explicitSessionKey ?? (ctx ? resolveSessionKey(scope, ctx, mainKey) : undefined);

  // If sessionId was provided, find store key that has that sessionId
  if (
    !explicitSessionKey &&
    opts.sessionId &&
    (!sessionKey || sessionStore[sessionKey]?.sessionId !== opts.sessionId)
  ) {
    const foundKey = Object.keys(sessionStore).find(
      (key) => sessionStore[key]?.sessionId === opts.sessionId,
    );
    if (foundKey) sessionKey = foundKey;
  }

  return { sessionKey, sessionStore, storePath };
}

export function resolveSession(opts: { ... }): SessionResolution {
  const { sessionKey, sessionStore, storePath } = resolveSessionKeyForRequest(opts);
  const sessionEntry = sessionKey ? sessionStore[sessionKey] : undefined;
  const resetPolicy = resolveSessionResetPolicy({ sessionCfg, resetType, resetOverride: channelReset });
  const fresh = sessionEntry
    ? evaluateSessionFreshness({ updatedAt: sessionEntry.updatedAt, now, policy: resetPolicy }).fresh
    : false;
  const sessionId =
    opts.sessionId?.trim() || (fresh ? sessionEntry?.sessionId : undefined) || crypto.randomUUID();
  const isNewSession = !fresh && !opts.sessionId;
  return {
    sessionId,
    sessionKey,
    sessionEntry,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
  };
}
```

So: **session key** selects the bucket (and store path); **session ID** is either reused from the entry (if “fresh”) or a new UUID. Freshness is decided by reset policy (daily or idle).

---

## 5. Resolving session for channel messages (auto-reply)

For inbound channel messages, the context already has `SessionKey` and `AgentId` from routing. Session state is initialized in one place, including reset triggers and thread/group handling.

**File:** `src/auto-reply/reply/session.ts`

```typescript
export async function initSessionState(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): Promise<SessionInitResult> {
  const { ctx, cfg, commandAuthorized } = params;
  // Slash commands (Telegram/Discord/Slack) may target a different session than the slash key
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;

  const sessionCfg = cfg.session;
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);
  const agentId = resolveSessionAgentId({ sessionKey: sessionCtxForState.SessionKey, config: cfg });
  const groupResolution = resolveGroupSessionKey(sessionCtxForState) ?? undefined;
  const resetTriggers = sessionCfg?.resetTriggers?.length ? sessionCfg.resetTriggers : DEFAULT_RESET_TRIGGERS;
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });

  const sessionStore = loadSessionStore(storePath);
  sessionKey = resolveSessionKey(sessionScope, sessionCtxForState, mainKey);
  const entry = sessionStore[sessionKey];
  // ...
  // Check reset triggers (e.g. "/new", "/reset") — if body matches, isNewSession = true, resetTriggered = true
  // Evaluate freshness (daily or idle reset policy)
  if (!isNewSession && freshEntry) {
    sessionId = entry.sessionId;
    systemSent = entry.systemSent ?? false;
    // ... carry over persisted thinking/verbose/etc.
  } else {
    sessionId = crypto.randomUUID();
    isNewSession = true;
    // ... optionally fork from parent for threads, or create new transcript path
  }
  // ... persist new/updated entry to store, ensure transcript file exists
  return { sessionCtx, sessionEntry, sessionKey, sessionId, isNewSession, resetTriggered, ... };
}
```

`resolveSessionKey` (from config/sessions) uses scope and mainKey: for `per-sender` it uses group key or normalized `From`; for `global` it returns `"global"`. With `mainKey`, direct (non-group) chats collapse to the agent’s main session key.

**File:** `src/config/sessions/session-key.ts` (config layer, not routing)

```typescript
export function resolveSessionKey(scope: SessionScope, ctx: MsgContext, mainKey?: string) {
  const explicit = ctx.SessionKey?.trim();
  if (explicit) return explicit.toLowerCase();
  const raw = deriveSessionKey(scope, ctx);
  if (scope === "global") return raw;
  const canonicalMainKey = normalizeMainKey(mainKey);
  const canonical = buildAgentMainSessionKey({
    agentId: DEFAULT_AGENT_ID,
    mainKey: canonicalMainKey,
  });
  const isGroup = raw.includes(":group:") || raw.includes(":channel:");
  if (!isGroup) return canonical;
  return `agent:${DEFAULT_AGENT_ID}:${raw}`;
}
```

So for channel messages, the **routing** layer has already set `ctx.SessionKey` (and `ctx.AgentId`) via `resolveAgentRoute`. Auto-reply then uses that (or the slash target) and `resolveSessionKey`/store to get or create the session entry and transcript path.

---

## 6. Session freshness and reset

Sessions can be treated as “stale” and reset (new session ID) either by **time** (daily at 4am or idle timeout) or by **trigger** (e.g. `/new`).

**File:** `src/config/sessions/reset.ts`

```typescript
export type SessionResetPolicy = {
  mode: SessionResetMode; // "daily" | "idle"
  atHour: number;
  idleMinutes?: number;
};

export function evaluateSessionFreshness(params: {
  updatedAt: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness {
  const dailyResetAt =
    params.policy.mode === "daily"
      ? resolveDailyResetAtMs(params.now, params.policy.atHour)
      : undefined;
  const idleExpiresAt =
    params.policy.idleMinutes != null
      ? params.updatedAt + params.policy.idleMinutes * 60_000
      : undefined;
  const staleDaily = dailyResetAt != null && params.updatedAt < dailyResetAt;
  const staleIdle = idleExpiresAt != null && params.now > idleExpiresAt;
  return {
    fresh: !(staleDaily || staleIdle),
    dailyResetAt,
    idleExpiresAt,
  };
}
```

Reset policy can be overridden per channel (`resetByChannel`) or per type (`resetByType`: dm, group, thread). Default reset triggers are `["/new", "/reset"]` (see `DEFAULT_RESET_TRIGGERS` in types).

---

## 7. Transcripts (conversation history)

Transcripts are JSONL files managed by Pi’s `SessionManager`. OpenClaw resolves the path from session entry and agent config.

**File:** `src/config/sessions/transcript.ts`

```typescript
export async function appendAssistantMessageToSessionTranscript(params: {
  agentId?: string;
  sessionKey: string;
  text?: string;
  mediaUrls?: string[];
  storePath?: string;
}): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
  const storePath = params.storePath ?? resolveDefaultSessionStorePath(params.agentId);
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[params.sessionKey];
  if (!entry?.sessionId) return { ok: false, reason: `unknown sessionKey: ${params.sessionKey}` };

  const sessionFile =
    entry.sessionFile?.trim() || resolveSessionTranscriptPath(entry.sessionId, params.agentId);
  await ensureSessionHeader({ sessionFile, sessionId: entry.sessionId });

  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: mirrorText }],
    // ...
  });
  // ...
}
```

The agent runtime (Pi) reads and appends to the same transcript file; OpenClaw only needs to know the path (from entry or `resolveSessionTranscriptPath`).

---

## 8. Gateway: resolving session key from a run ID

When the gateway only has a run ID (e.g. for abort or status), it can look up the session key from the store by matching `sessionId` to the run.

**File:** `src/gateway/server-session-key.ts`

```typescript
export function resolveSessionKeyForRun(runId: string) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) return cached;
  const cfg = loadConfig();
  const storePath = resolveStorePath(cfg.session?.store);
  const store = loadSessionStore(storePath);
  const found = Object.entries(store).find(([, entry]) => entry?.sessionId === runId);
  const storeKey = found?.[0];
  if (storeKey) {
    const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
    registerAgentRunContext(runId, { sessionKey });
    return sessionKey;
  }
  return undefined;
}
```

---

## 9. Main session key and config

For “default” or “main” session key (e.g. CLI with no `to`), config and agent list determine the main key.

**File:** `src/config/sessions/main-session.ts`

```typescript
export function resolveMainSessionKey(cfg?: {
  session?: { scope?: SessionScope; mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
}): string {
  if (cfg?.session?.scope === "global") return "global";
  const defaultAgentId =
    agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? DEFAULT_AGENT_ID;
  const agentId = normalizeAgentId(defaultAgentId);
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  return buildAgentMainSessionKey({ agentId, mainKey });
}

export function resolveExplicitAgentSessionKey(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId?: string | null;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) return undefined;
  return resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
}
```

---

## 10. File and call summary

| Area                | Path                                  | Purpose                                                                                                          |
| ------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Types               | `src/config/sessions/types.ts`        | `SessionEntry`, `SessionScope`, `mergeSessionEntry`                                                              |
| Store               | `src/config/sessions/store.ts`        | `loadSessionStore`, `saveSessionStore`, `updateSessionStore`, `updateSessionStoreEntry`, lock                    |
| Paths               | `src/config/sessions/paths.ts`        | `resolveStorePath`, `resolveSessionTranscriptPath`, `resolveSessionFilePath`                                     |
| Reset               | `src/config/sessions/reset.ts`        | `evaluateSessionFreshness`, `resolveSessionResetPolicy`, `resolveChannelResetConfig`                             |
| Config session key  | `src/config/sessions/session-key.ts`  | `resolveSessionKey`, `deriveSessionKey` (scope + ctx)                                                            |
| Main session        | `src/config/sessions/main-session.ts` | `resolveMainSessionKey`, `resolveExplicitAgentSessionKey`                                                        |
| Group key           | `src/config/sessions/group.ts`        | `resolveGroupSessionKey`                                                                                         |
| Metadata            | `src/config/sessions/metadata.ts`     | `deriveSessionMetaPatch` for inbound context                                                                     |
| Transcript          | `src/config/sessions/transcript.ts`   | `appendAssistantMessageToSessionTranscript`, Pi SessionManager                                                   |
| Routing keys        | `src/routing/session-key.ts`          | `buildAgentMainSessionKey`, `buildAgentPeerSessionKey`, `toAgentStoreSessionKey`, `resolveAgentIdFromSessionKey` |
| Routing route       | `src/routing/resolve-route.ts`        | `resolveAgentRoute` → `sessionKey`, `mainSessionKey`, `agentId`                                                  |
| Key utils           | `src/sessions/session-key-utils.ts`   | `parseAgentSessionKey`, `isSubagentSessionKey`, `isAcpSessionKey`                                                |
| CLI/gateway resolve | `src/commands/agent/session.ts`       | `resolveSessionKeyForRequest`, `resolveSession`                                                                  |
| Auto-reply init     | `src/auto-reply/reply/session.ts`     | `initSessionState` for channel messages                                                                          |
| Gateway run → key   | `src/gateway/server-session-key.ts`   | `resolveSessionKeyForRun`                                                                                        |

Session management is split between **config/sessions** (store, paths, freshness, config-scoped key resolution), **routing** (route → session key and agent id), **commands/agent** (CLI/gateway resolution), and **auto-reply/reply** (channel init and reset triggers). Transcript content is delegated to Pi’s `SessionManager`; OpenClaw only wires paths and appends delivery-mirror lines when needed.
