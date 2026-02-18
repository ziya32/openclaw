# Internet Communications and Security/Privacy Review

This document lists outbound internet communications in the OpenClaw codebase, their purpose, main code paths, and major security/privacy considerations. It was produced by scanning the codebase and reviewing the relevant handlers.

**Channels and LLM communication:** All messaging channels (Telegram, Discord, Slack, Signal, WhatsApp, iMessage, and extension channels such as BlueBubbles, Google Chat, Feishu, Matrix, MSTeams) deliver inbound messages into the same agent/LLM pipeline and send replies back. So each channel can be used to communicate with LLMs in the same way; only the transport and third-party endpoints differ.

---

## 1. Agent Tools – Web Fetch

| Aspect        | Details                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **Purpose**   | Fetch web pages (direct HTTP or via Firecrawl) for agent tools.                                 |
| **Main code** | `src/agents/tools/web-fetch.ts`                                                                 |
| **Endpoints** | User-provided HTTP/HTTPS URLs (direct fetch); optional `https://api.firecrawl.dev` (Firecrawl). |
| **Data sent** | URL, optional API key (Bearer) to Firecrawl; User-Agent and request body for direct fetch.      |

**Security/Privacy**

- **SSRF:** Direct fetch path uses `resolvePinnedHostname()` before each request (and on every redirect) via `fetchWithRedirects()`; private IPs, localhost, `.local`, `metadata.google.internal` are blocked. See `src/infra/net/ssrf.ts`.
- **Firecrawl:** User-provided URLs (and optionally cached content) are sent to Firecrawl when enabled; third-party receives the URLs the user asks the agent to fetch (privacy/data sharing).
- **API key:** Firecrawl API key from config/env is sent as Bearer; no key in URL.

---

## 2. Agent Tools – Web Search

| Aspect        | Details                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Web search via Brave Search API or Perplexity (direct or OpenRouter).                                                                 |
| **Main code** | `src/agents/tools/web-search.ts`                                                                                                      |
| **Endpoints** | `https://api.search.brave.com/res/v1/web/search` (Brave); `https://api.perplexity.ai` or `https://openrouter.ai/api/v1` (Perplexity). |
| **Data sent** | Query, API key (Brave: `X-Subscription-Token`; Perplexity: Bearer), country/language/freshness params.                                |

**Security/Privacy**

- Search queries and API keys are sent to third-party providers; base URLs are configurable (e.g. OpenRouter).
- No user-provided arbitrary URLs are fetched; no SSRF on this path.

---

## 3. Media Fetch (Input Files / Store)

| Aspect        | Details                                                                                 |
| ------------- | --------------------------------------------------------------------------------------- |
| **Purpose**   | Download media from URLs (user- or channel-provided) with size and redirect limits.     |
| **Main code** | `src/media/input-files.ts` (`fetchWithGuard`), `src/media/store.ts` (`downloadToFile`). |
| **Endpoints** | User- or channel-provided HTTP/HTTPS URLs.                                              |
| **Data sent** | GET with `User-Agent: OpenClaw-Gateway/1.0`; no tokens in these generic fetches.        |

**Security/Privacy**

- **SSRF:** Both paths use `resolvePinnedHostname(parsedUrl.hostname)` before connecting; same blocklist and private-IP checks as web_fetch. Redirects are followed with a new SSRF check per hop.
- **Size:** `maxBytes` and Content-Length checks limit response size; body is capped in `input-files.ts`.

---

## 4. Telegram

| Aspect        | Details                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Bot API: getFile, download file, setWebhook, send messages, getChat, getUpdates, etc.                                                                                                                |
| **Main code** | `src/telegram/download.ts`, `src/telegram/audit.ts`, `src/telegram/probe.ts`, `src/telegram/bot/delivery.ts`, `src/channels/plugins/onboarding/telegram.ts`, `src/telegram/webhook.ts` (setWebhook). |
| **Endpoints** | `https://api.telegram.org` (bot API and file download).                                                                                                                                              |
| **Data sent** | Bot token (in URL path for getFile/file download: `.../bot${token}/...`); message/content via API.                                                                                                   |

**Security/Privacy**

- **Token in URL:** Bot token appears in path (`/bot<token>/getFile`, `/file/bot<token>/...`). HTTPS and no logging of full URL in the reviewed code reduce exposure; any proxy or debug logging that logs URLs could leak the token.
- **Proxy:** Optional `channels.telegram.proxy` can route traffic through a custom proxy (`src/telegram/fetch.ts`, `resolveTelegramFetch`).
- **SSRF:** Not applicable; host is fixed (api.telegram.org).

---

## 5. Discord

| Aspect        | Details                                                            |
| ------------- | ------------------------------------------------------------------ |
| **Purpose**   | REST API for send, channels, etc.                                  |
| **Main code** | `src/discord/api.ts`                                               |
| **Endpoints** | `https://discord.com/api/v10`                                      |
| **Data sent** | Token in `Authorization` header (not URL); request bodies per API. |

**Security/Privacy**

- Token is sent in headers only; retry and error handling use standard patterns. No SSRF (fixed host).

---

## 6. Slack

| Aspect        | Details                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------- |
| **Purpose**   | Fetch files (url_private / url_private_download); API calls via @slack/web-api.                     |
| **Main code** | `src/slack/monitor/media.ts`                                                                        |
| **Endpoints** | `https://files.slack.com` (initial); redirect to CDN (e.g. cdn.slack-edge.com) with pre-signed URL. |
| **Data sent** | Bearer token on initial request; redirect is followed without Authorization (by design).            |

**Security/Privacy**

- **Redirect:** Second request uses `fetch(resolvedUrl, { redirect: "follow" })` with no SSRF re-check. The URL comes from Slack API (`url_private_download`), not arbitrary user input, so risk is low unless Slack is compromised or returns a malicious redirect.
- Token not in URL.

---

## 7. Signal

| Aspect        | Details                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| **Purpose**   | Local signal-cli daemon RPC (HTTP to user-configured baseUrl, typically localhost).      |
| **Main code** | `src/signal/client.ts`, `src/signal/sse-reconnect.ts`, monitor/event-handler.            |
| **Endpoints** | User-configured `baseUrl` (e.g. `http://127.0.0.1:8080`).                                |
| **Data sent** | RPC payloads to local daemon; daemon itself talks to Signal servers (outside this repo). |

**Security/Privacy**

- No direct outbound internet in the main Signal client code; it talks to the local daemon. If `baseUrl` is set to a remote host, traffic goes there (intended for remote signal-cli).

---

## 8. LLM / AI Provider APIs

| Aspect        | Details                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Chat/completions, embeddings (memory vector index), TTS, media understanding (audio/vision), usage/billing.                                                                                                   |
| **Main code** | `src/agents/models-config.providers.ts`, `src/memory/embeddings-openai.ts`, `src/memory/embeddings-gemini.ts`, `src/tts/tts.ts`, `src/media-understanding/providers/`, `src/infra/provider-usage.fetch.*.ts`. |
| **Endpoints** | See tables below. All base URLs are configurable via config or env where documented.                                                                                                                          |
| **Data sent** | API keys (headers); prompts, responses, embeddings input/text, optional usage/telemetry to provider.                                                                                                          |

**Chat / completion (provider base URLs, from this repo)**

| Provider        | Default base URL                                 |
| --------------- | ------------------------------------------------ |
| MiniMax         | `https://api.minimax.chat/v1`                    |
| Xiaomi MiMo     | `https://api.xiaomimimo.com/anthropic`           |
| Moonshot (Kimi) | `https://api.moonshot.ai/v1`                     |
| Kimi Code       | `https://api.kimi.com/coding/v1`                 |
| Qwen Portal     | `https://portal.qwen.ai/v1`                      |
| Ollama          | `http://127.0.0.1:11434/v1`                      |
| Synthetic       | `https://api.synthetic.new/anthropic`            |
| Venice          | `https://api.venice.ai/api/v1`                   |
| OpenCode Zen    | `https://opencode.ai/zen/v1`                     |
| GitHub Copilot  | `https://api.individual.githubcopilot.com`       |
| Amazon Bedrock  | `https://bedrock-runtime.{region}.amazonaws.com` |
| Z.AI (GLM)      | `https://api.z.ai/v1`                            |

OpenAI, Anthropic, Google, Groq, etc. are supplied by pi-ai/model config; base URLs come from `models.providers[].baseUrl` when set. Z.AI is supported as an LLM provider (default model `zai/glm-4.7`); auth via `ZAI_API_KEY` or `Z_AI_API_KEY`.

**Embeddings (memory / SQLite vector index)**

| Provider | Default base URL                                   |
| -------- | -------------------------------------------------- |
| OpenAI   | `https://api.openai.com/v1`                        |
| Gemini   | `https://generativelanguage.googleapis.com/v1beta` |

Overridable via `agents.defaults.memorySearch.remote.baseUrl`. Default embedding model for the vector DB: **OpenAI** `text-embedding-3-small` or **Gemini** `gemini-embedding-001` depending on `agents.defaults.memorySearch.provider` (and optional `model` override).

**Media understanding (audio/vision)**

| Provider             | Default base URL                                   |
| -------------------- | -------------------------------------------------- |
| OpenAI audio         | `https://api.openai.com/v1`                        |
| Groq audio           | `https://api.groq.com/openai/v1`                   |
| Deepgram             | `https://api.deepgram.com/v1`                      |
| Google (audio/video) | `https://generativelanguage.googleapis.com/v1beta` |

**Security/Privacy**

- Prompts, completions, and embedding text are sent to the configured provider; keys in headers. Custom baseUrl (e.g. proxy) is supported; ensure proxy is trusted.
- No SSRF in provider client code (host comes from config, not from end-user URL input).

---

## 9. TTS (Text-to-Speech)

| Aspect        | Details                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| **Purpose**   | ElevenLabs and OpenAI TTS.                                                             |
| **Main code** | `src/tts/tts.ts`                                                                       |
| **Endpoints** | `https://api.elevenlabs.io`, `https://api.openai.com/v1` (overridable via env/config). |
| **Data sent** | Text, voice id, API key; audio returned from provider.                                 |

**Security/Privacy**

- Text and keys sent to provider; base URLs are configurable. Same trust model as other LLM providers.

---

## 10. Provider Usage / Billing

| Aspect        | Details                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Fetch usage/quota (Claude web, Anthropic OAuth, GitHub Copilot, Google Antigravity, Z.AI).                                                                                                                                         |
| **Main code** | `src/infra/provider-usage.fetch.claude.ts`, `src/infra/provider-usage.fetch.antigravity.ts`, `src/infra/provider-usage.fetch.copilot.ts`, `src/infra/provider-usage.fetch.zai.ts`, Anthropic OAuth usage.                          |
| **Endpoints** | `https://claude.ai/api/organizations`, `https://cloudcode-pa.googleapis.com`, `https://api.github.com/copilot_internal/...`, `https://api.anthropic.com/api/oauth/usage`, `https://api.z.ai/api/monitor/usage/quota/limit` (Z.AI). |
| **Data sent** | Session key/cookies (Claude web), OAuth tokens, API tokens; Z.AI: Bearer API key.                                                                                                                                                  |

**Security/Privacy**

- Sensitive auth (session keys, cookies, tokens) sent to these endpoints; ensure env/config for these keys is protected and only used in trusted environments.

---

## 11. OAuth / Auth Flows

| Aspect        | Details                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | GitHub device flow (Copilot), Qwen portal OAuth.                                                                                   |
| **Main code** | `src/providers/github-copilot-auth.ts`, `src/providers/qwen-portal-oauth.ts`                                                       |
| **Endpoints** | `https://github.com/login/device/code`, `https://github.com/login/oauth/access_token`, `https://chat.qwen.ai/api/v1/oauth2/token`. |
| **Data sent** | Client ID, device code, grant types; tokens in response.                                                                           |

**Security/Privacy**

- Standard OAuth/device flows; client ID is hardcoded for GitHub Copilot. Tokens are exchanged over HTTPS.

---

## 12. Signal CLI Install

| Aspect        | Details                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Purpose**   | Download signal-cli binary from GitHub releases.                                                                         |
| **Main code** | `src/commands/signal-install.ts`                                                                                         |
| **Endpoints** | `https://api.github.com/repos/AsamK/signal-cli/releases/latest`; then `assetUrl` from response (`browser_download_url`). |
| **Data sent** | GET with User-Agent; no auth.                                                                                            |

**Security/Privacy**

- **Redirect / SSRF:** Local `downloadToFile` follows redirects without resolving hostname through SSRF checks. The download URL comes from GitHub’s API response, so in practice it’s GitHub-controlled; if that response were malicious, a redirect to an internal host could be followed. Consider using the same `resolvePinnedHostname` pattern before downloading the asset.

---

## 13. Gateway Discovery (mDNS / Bonjour)

| Aspect        | Details                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Let nodes (iOS, Android, macOS, CLI) discover an active Gateway on the LAN or over Tailscale so they can connect via WebSocket.                                                                                                                                                                                                                                                                               |
| **Main code** | Gateway: `src/infra/bonjour.ts` (`startGatewayBonjourAdvertiser`), `src/gateway/server-discovery-runtime.ts`. Wide-area: `src/infra/widearea-dns.ts`. Clients browse only (e.g. iOS `GatewayDiscoveryModel.swift`, macOS/Android discovery).                                                                                                                                                                  |
| **Endpoints** | **Standard:** None. Discovery uses **LAN multicast** (mDNS/DNS-SD, UDP 5353) on the `local.` domain; no third-party or internet endpoint. **Wide-area:** Gateway writes DNS-SD zone files under `~/.openclaw/dns/`; a DNS server on the gateway host (e.g. CoreDNS) serves that zone; clients on Tailscale use split DNS to resolve the discovery domain — no outbound call to an external discovery service. |
| **Data sent** | Gateway **advertises** (sends mDNS announcements) with service type `_openclaw-gw._tcp`, port, and TXT record: `role`, `gatewayPort`, `lanHost`, `displayName`, optional `tailnetDns`, `canvasPort`, `gatewayTls` (and in full mode `cliPath`, `sshPort`). No secrets in TXT. Clients only browse and receive these hints.                                                                                    |

**Mechanism (summary)**

- **Gateway:** Uses **@homebridge/ciao** (RFC 6762/6763). On startup, creates one service and calls `advertise()`; Ciao sends multicast packets and answers mDNS queries on the LAN. A watchdog re-advertises if the service leaves the announced state (e.g. after sleep/wake).
- **Clients:** Browse for `_openclaw-gw._tcp` on `local.` (and optionally a wide-area domain via `OPENCLAW_WIDE_AREA_DOMAIN`). They do not advertise; they only discover and then connect to the chosen gateway (see §14).

**Security/Privacy**

- **Not outbound internet:** Standard discovery is LAN multicast only; no traffic to the public internet. Wide-area discovery uses Tailscale DNS (your own zone on the gateway); no third-party discovery server.
- **Information disclosure:** TXT records can expose hostname, CLI path, SSH port (in full mode). See [Gateway security – mDNS/Bonjour](/gateway/security#041-mdnsbonjour-discovery-information-disclosure). Use `discovery.mdns.mode: "minimal"` (default) or `"off"`, or `OPENCLAW_DISABLE_BONJOUR=1` to reduce or disable advertising.

---

## 14. Gateway / WebSocket

| Aspect        | Details                                                            |
| ------------- | ------------------------------------------------------------------ |
| **Purpose**   | CLI/app to gateway: health, send, config, etc.                     |
| **Main code** | `src/gateway/client.ts`, `src/gateway/call.ts`                     |
| **Endpoints** | User-configured `ws://` or `wss://` (e.g. localhost or Tailscale). |
| **Data sent** | Optional password/token in auth; RPC payloads.                     |

**Security/Privacy**

- URL and auth are user-configured; TLS fingerprint option for `wss://`. No SSRF (gateway is a chosen endpoint).

---

## 15. Browser Control (CDP)

| Aspect        | Details                                                       |
| ------------- | ------------------------------------------------------------- |
| **Purpose**   | Fetch JSON from CDP/base URL (local or remote Chrome).        |
| **Main code** | `src/browser/server-context.ts`, `src/browser/cdp.helpers.ts` |
| **Endpoints** | User-configured CDP URL (often `http://localhost:...`).       |
| **Data sent** | `getHeadersWithAuth(url, ...)`; fetch to that URL.            |

**Security/Privacy**

- If CDP base URL is set to a remote or malicious host, requests go there without SSRF checks. Typically CDP is local; remote CDP is a supported scenario. Operators should only use trusted CDP endpoints.

---

## 16. Diagnostics / OpenTelemetry

| Aspect        | Details                                                                                                                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Optional export of traces/metrics/logs to user-configured endpoint.                                                                                                                                   |
| **Main code** | Config: `src/config/types.base.ts`, `src/config/schema.ts`, `src/config/zod-schema.ts`.                                                                                                               |
| **Endpoints** | `diagnostics.otel.endpoint` (user-configured).                                                                                                                                                        |
| **Data sent** | None in the scanned code; only schema and types for OTEL are present. No runtime exporter implementation was found; if added later, traces/metrics could include sensitive data (e.g. prompts, URLs). |

**Security/Privacy**

- Currently config-only; any future export should sanitize and restrict sensitive data and validate the endpoint (e.g. avoid sending to internal or private hosts if that’s not intended).

---

## 17. WhatsApp (Web)

| Aspect        | Details                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| **Purpose**   | Messaging via WhatsApp Web (Baileys/library).                             |
| **Main code** | Web channel and outbound in `src/web/`; actual network is in the library. |
| **Endpoints** | Handled by the WhatsApp library (not direct fetch in app code).           |

**Security/Privacy**

- Credentials and messages are handled by the library; ensure library is up to date and configured in a trusted environment.

---

## 18. iMessage (imsg)

| Aspect        | Details                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Messaging via Apple iMessage using the `imsg` CLI (JSON-RPC over stdio). Inbound messages are dispatched to the same agent/LLM pipeline as other channels; replies are sent back over iMessage.                                                                                       |
| **Main code** | `src/imessage/monitor/monitor-provider.ts`, `src/imessage/send.ts`, `src/imessage/client.ts`, `src/imessage/probe.ts`.                                                                                                                                                                |
| **Endpoints** | No direct outbound HTTP from OpenClaw: gateway spawns `imsg rpc` (local subprocess). If `channels.imessage.cliPath` points to an SSH wrapper, outbound traffic goes to the user-configured SSH host. Optional SCP to `channels.imessage.remoteHost` when fetching remote attachments. |
| **Data sent** | RPC payloads to local imsg (or via SSH to remote Mac); message text and optional file paths. When `remoteHost` is set, attachment files are fetched over SCP from that host.                                                                                                          |

**Security/Privacy**

- No fixed third-party API; traffic is local (stdio) or to a user-configured host. Messages and attachments stay between the gateway and the Mac running Messages (local or remote).
- Full Disk Access (and optionally Automation) is required for the process that runs `imsg` (OpenClaw or the remote Mac) to read the Messages database and send messages.
- When using an SSH wrapper or `remoteHost`, ensure the SSH/SCP target is trusted; credentials and message content traverse that connection.

---

## 19. Feishu (Lark)

| Aspect        | Details                                                                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Purpose**   | Messaging and APIs (tenant token, card kit, message download, docs) for Feishu/Lark.                                                                                                                                                |
| **Main code** | `src/feishu/` (e.g. `streaming-card.ts`, `probe.ts`, `download.ts`, `domain.ts`, `docs.ts`).                                                                                                                                        |
| **Endpoints** | `https://open.feishu.cn` (Feishu CN) or `https://open.larksuite.com` (Lark global); configurable via domain. Paths include `/open-apis/auth/v3/tenant_access_token/internal`, `/open-apis/cardkit/v1/cards`, message and docs APIs. |
| **Data sent** | App ID, app secret (tenant access token); message content, card payloads; file download URLs from Feishu.                                                                                                                           |

**Security/Privacy**

- Tokens and message content are sent to Feishu/Lark; domain is configurable (fixed hosts per tenant). No SSRF in the reviewed paths (host from config).
- Keep app credentials secure; same trust model as other provider APIs.

---

## 20. Other communication channels (extensions)

Extension channels (e.g. BlueBubbles, Google Chat, Matrix, MSTeams, Line, Mattermost, Nextcloud Talk, Nostr, Twitch, Tlon, Zalo, Zalouser, voice-call) perform their own outbound communications to user-configured or provider endpoints. They are not enumerated in full here; when enabled, refer to each extension’s code and docs for endpoints and data sent.

---

## Summary of Major Security and Privacy Issues

1. **Token in URL (Telegram):** Bot token appears in path for getFile and file download. Prefer header-based auth if Telegram supports it; otherwise avoid logging or forwarding full URLs.
2. **Firecrawl / third-party URL exposure:** When Firecrawl is enabled, user-provided URLs (and optionally cached content) are sent to Firecrawl; users should be aware of this data sharing.
3. **Slack redirect not re-checked:** Following redirects from `files.slack.com` without a second SSRF check is low risk (Slack-controlled) but could be hardened by validating redirect target.
4. **Signal CLI install:** Download URL from GitHub is followed without host validation; adding `resolvePinnedHostname` (or equivalent) before downloading would align with other download paths.
5. **Provider usage / Claude web:** Session keys and cookies are sent to claude.ai; protect these credentials and limit to trusted environments.
6. **Browser CDP:** Remote CDP URLs are not validated for SSRF; only configure trusted CDP endpoints.
7. **OpenTelemetry:** No active export in codebase; future implementation should avoid exporting sensitive data (prompts, tokens, PII) and restrict endpoint to intended destinations.

---

## SSRF and Redirect Handling Summary

| Path                           | SSRF / redirect handling                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Web fetch (direct)             | `resolvePinnedHostname` before each request and on each redirect in `fetchWithRedirects`. |
| Media (input-files, store)     | `resolvePinnedHostname` before connect; redirects re-checked in loop.                     |
| Telegram, Discord, Slack (API) | Fixed hosts; no user-controlled URL fetch.                                                |
| Slack media redirect           | Redirect followed without SSRF re-check (Slack-controlled URL).                           |
| Signal install                 | No host validation on download URL from GitHub response.                                  |
| Firecrawl                      | User URL sent to Firecrawl; Firecrawl server is fixed host.                               |
| iMessage                       | No direct HTTP; local imsg subprocess or user-configured SSH/SCP host.                    |
| Feishu                         | Fixed hosts (open.feishu.cn / open.larksuite.com); no user-controlled URL fetch.          |

Blocked hostnames (in `src/infra/net/ssrf.ts`): `localhost`, `metadata.google.internal`, and hostnames ending with `.localhost`, `.local`, `.internal`. All private IPv4 ranges and common private IPv6 prefixes are blocked; DNS resolution is checked so that hostnames that resolve to private IPs are rejected.
