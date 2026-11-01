# Admin API — routes the panel calls

`@miyoria/api` (`packages/api`) serves every route below (wire types in
`src/types.ts`, typed client in `src/client.ts`). An older Core answers unknown
routes with its fallback `404 {"error":"no such endpoint"}` and the panel shows
"尚未提供(core 版本較舊)" for that page. Notes marked **Served as** describe
where the live shape differs from the first proposal.

Conventions (same as the live API in `packages/api`):

- Every route requires `Authorization: Bearer <token>` **or** the panel's
  Discord session cookie (see [Panel login](#panel-login)). The Core also serves
  the built panel (`[modules.api] panel_dir`, default `apps/panel/dist`,
  `MIYORIA_PANEL_DIR` overrides) at `/` without a token.
- The panel sends `X-Miyoria-Request: 1` and `credentials: "same-origin"` on
  every request (SSE included). Cookie-authenticated non-GET requests without
  that header get `403` (CSRF guard); session users without
  `admin.panel.write` get `403` on every non-GET route.
- Errors are `{"error": "..."}`. Use **404 with a specific message** (not the
  fallback text) for "this item does not exist", 409 for refused state changes,
  503 when the backing service/module is stopped.
- Timestamps are RFC 3339, ids are ULID strings, enums are
  `snake_case`, optional fields are `null` (not omitted) unless noted.
- Lists that can grow use `Page<T>`: `{"items": [...], "next_cursor": "opaque" | null}`.
- All requests act on the **active profile**, like `/api/decisions` and `/api/persona`.
- Every change is written to the audit log (actor `"api"` for the token,
  `discord:<id>` for a session).

TypeScript mirrors: `src/api/planned-types.ts`; client calls: `src/api/endpoints.ts`.
`Settings → API 支援度` probes every GET below and shows which ones a Core serves.

---

## Panel login

Live in `packages/api/src/oauth.ts` / `session.ts`. Discord login is on
only when `[modules.api.discord_oauth]` has `client_id`, `client_secret` and
`redirect_uri`; the token always works.

### `GET /api/auth/methods` (public) → `AuthMethods`

```json
{ "token": true, "discord": true }
```

### `GET /api/auth/oauth/login?next=/%23/people` (public) → `302`

Redirects to `https://discord.com/oauth2/authorize` (`response_type=code`,
`scope=identify`, random `state`, PKCE `S256`). The state and verifier live on
the Core for 10 minutes. `next` must be a same-origin path (`/…`, not `//…`,
ASCII, no `\`); anything else becomes `/#/`. The panel links here (a plain
`<a>`, not `fetch`) only when its API base URL is its own origin.

### `GET /api/auth/oauth/callback?code=&state=` (public) → `302`

Discord redirects here. On success the Core sets
`miyoria_session=<token>; Max-Age=…; Path=/; HttpOnly; SameSite=Lax[; Secure]`
and redirects to `next`. On failure it redirects to `/#/login?error=<code>`:

| `error` | Meaning |
|---|---|
| `disabled` | Discord login is not configured |
| `cancelled` | the user declined on Discord |
| `state` | unknown, reused or expired (10 min) state |
| `exchange` | Discord refused the code |
| `discord` | fetching `users/@me` failed |
| `denied` | the account lacks `admin.panel.access` |
| `unavailable` | no permission service (`auth` module stopped) |

### `GET /api/auth/session` → `SessionInfo`

```json
{
  "method": "discord",
  "user": { "id": "80351110224678912", "name": "Owen", "avatar_url": "https://cdn.discordapp.com/avatars/…/….png?size=64" },
  "permissions": { "write": false }
}
```

With the token: `{"method": "token", "user": null, "permissions": {"write": true}}`.
`401` without valid credentials, or once the account lost
`admin.panel.access` (re-checked every few seconds).

### `POST /api/auth/logout` (public) → `204`

Deletes the session and clears the cookie. Needs `X-Miyoria-Request: 1` when a
session cookie is sent.

---

## LLM cost

### `GET /api/llm/cost`

Serialize `miyoria_llm::cost::CostReport` as-is.

```json
{
  "state": "ok",
  "daily_usd": 2.0,
  "monthly_usd": 30.0,
  "degrade_at": 0.8,
  "today": {
    "period": "2026-11-01",
    "total_usd": 0.4213,
    "calls": 128,
    "models": {
      "deepseek:deepseek-chat": {
        "calls": 120, "prompt_tokens": 512000, "completion_tokens": 30100,
        "cached_prompt_tokens": 410000, "cost_usd": 0.3801
      }
    }
  },
  "month": { "period": "2026-11", "total_usd": 0.4213, "calls": 128, "models": {} }
}
```

Used by: Overview (today's spend, per-model cost column). `state` is `ok | degraded | exhausted`.

---

## People & relationships

### `GET /api/people?q=&limit=100&cursor=`

`q` matches display names and account ids (case-insensitive substring). Order:
most recent interaction first.

```json
{
  "items": [
    {
      "person": {
        "id": "01JBX3V6Q2T8ZK7W9C4N5M1P0R",
        "display_name": "Owen",
        "created_at": "2026-03-02T12:00:00Z",
        "accounts": [
          {
            "account": { "platform": "discord", "id": "123456789012345678" },
            "display_name": "Owen",
            "first_seen": "2026-03-02T12:00:00Z",
            "last_seen": "2026-11-01T09:58:12Z"
          }
        ]
      },
      "relationship": {
        "profile": "deepseek-chan",
        "person": "01JBX3V6Q2T8ZK7W9C4N5M1P0R",
        "affinity": 62.5, "trust": 70.0, "familiarity": 88.0,
        "tags": ["常客", "Minecraft"],
        "notes": "喜歡拉麵",
        "call_name": "歐文",
        "interactions": 1432,
        "last_interaction": "2026-11-01T09:58:12Z",
        "updated_at": "2026-11-01T09:58:12Z"
      },
      "label": "朋友",
      "blocked": false
    }
  ],
  "next_cursor": null
}
```

`person` = `miyoria_store::Person`, `relationship` = `miyoria_store::Relationship`
(or `null` before the first interaction), `label` / `blocked` = `Attitude.label` / `Attitude.blocked`.

**Served as:** only people with a relationship to the active profile are listed
(the people store cannot enumerate everyone yet). `next_cursor` is an offset.

### `GET /api/people/{id}`

A `PersonSummary` (above) plus:

```json
{
  "person": { "...": "..." },
  "relationship": { "...": "..." },
  "label": "朋友",
  "blocked": false,
  "history": [
    { "at": "2026-10-30T20:01:00Z", "affinity": 58.0, "trust": 69.0, "familiarity": 86.0, "reason": "一起打 Minecraft" },
    { "at": "2026-11-01T09:58:12Z", "affinity": 62.5, "trust": 70.0, "familiarity": 88.0, "reason": "稱讚她的歌" }
  ],
  "memory_count": 37
}
```

`history` = `RelationshipDelta[]`, **oldest first**, values are the resulting
absolute levels (not deltas) so the panel can plot them directly. Cap at ~500.
404 `{"error":"unknown person `…`"}` for an unknown id.

### `PATCH /api/people/{id}`

Every field optional; omitted = unchanged. `call_name: null` clears it.

```json
{ "tags": ["常客"], "notes": "…", "call_name": "歐文", "blocked": true }
```

Response: the updated `PersonSummary`. `tags` replaces every tag except
`blocked`, which only `blocked` changes. Needs the `social` module (503 otherwise).

### `POST /api/people/{id}/adjust`

`{ "affinity": 5.0 }` is added to the affinity directly (ignoring the daily
caps, -200..200). Response: the updated `PersonSummary`.

---

## Memory

### `GET /api/memory?q=&kind=&subject=&before=&include_superseded=false&limit=50`

- Without `q`: list newest first (`MemoryFilter`), `before` paginates by `created_at`.
- With `q`: run the recall search (`MemoryQuery`, full-text + vector) across
  **all scopes** of the profile and include the scores.
- `kind` ∈ `episode | fact | self_note | followup`; `subject` is a person id.
- `next_cursor`: when listing, the `created_at` of the last item if more exist (the panel currently re-requests with a larger `limit`; either works).

```json
{
  "items": [
    {
      "record": {
        "id": "01JC0Q4B8E6Y2F3H5K7M9N1P2R",
        "profile": "deepseek-chan",
        "kind": "fact",
        "scope": { "type": "person", "person": "01JBX3V6Q2T8ZK7W9C4N5M1P0R" },
        "subjects": ["01JBX3V6Q2T8ZK7W9C4N5M1P0R"],
        "content": "Owen 喜歡豚骨拉麵",
        "importance": 0.6,
        "confidence": 0.9,
        "created_at": "2026-10-12T14:03:00Z",
        "updated_at": "2026-10-12T14:03:00Z",
        "last_accessed": "2026-11-01T09:58:00Z",
        "access_count": 4,
        "source_context": { "platform": "discord", "scope": "1100", "channel": "1200", "kind": "channel" },
        "due": null,
        "done": false,
        "superseded_by": null,
        "has_embedding": true
      },
      "text_score": 0.42,
      "vector_score": 0.81
    }
  ],
  "next_cursor": null
}
```

`record` is `MemoryRecord` **without** `tokens` and `embedding`, plus
`has_embedding`. `scope` is a `MemoryScope` (`{"type": "global" | "guild" | "channel" | "dm" | "person", ...}`).
`text_score` / `vector_score` are present only when `q` was given.

### `PATCH /api/memory/{id}`

```json
{ "content": "Owen 喜歡豚骨拉麵,不吃香菜", "kind": "fact", "importance": 0.7, "done": false }
```

All optional. Changing `content` should re-tokenize and re-embed. Response: the updated record (shape above).

**Served as:** changing `content` re-tokenizes and **drops** the stale
embedding (`has_embedding: false`) because the memory module does not expose
its embedder yet; search is full-text only, so `vector_score` is `null`.

### `DELETE /api/memory/{id}` → `204`

Hard delete (the panel confirms first). Should write an audit entry.

---

## Roles & permissions

### `GET /api/auth/roles` → `RoleDefinition[]`

```json
[
  { "name": "owner", "rank": 100, "grants": ["*"], "denies": [], "builtin": true },
  { "name": "moderator", "rank": 50, "grants": ["persona.view", "queue.*"], "denies": ["persona.edit"], "builtin": false }
]
```

### `GET /api/auth/assignments` → `RoleAssignment[]`

```json
[
  {
    "account": { "platform": "discord", "id": "123456789012345678" },
    "role": "moderator",
    "scope": { "type": "guild", "platform": "discord", "guild": "1100000000000000001" },
    "granted_by": "panel",
    "at": "2026-10-01T08:00:00Z"
  }
]
```

`scope` is an `AuthScope`: `{"type":"global"}`, `{"type":"guild","platform","guild"}`, `{"type":"channel","context":{…}}`.

### `POST /api/auth/assignments` → the created `RoleAssignment`

```json
{ "account": { "platform": "discord", "id": "123" }, "role": "moderator", "scope": { "type": "global" } }
```

The server fills `granted_by` (e.g. `"panel"`) and `at`. 404 for an unknown role, 409 if it already exists.

### `DELETE /api/auth/assignments` → `204`

Same body as POST (the assignment's natural key). 404 if absent.

### Also served (not called by the panel yet)

- `GET /api/auth/roles/{name}`; `PUT /api/auth/roles/{name}` with
  `{"rank": 30, "grants": ["queue.*"], "denies": []}` → the `RoleDefinition`
  (400 for invalid nodes); `DELETE /api/auth/roles/{name}` → `204` (409 for
  built-in / default roles).
- `GET /api/auth/mappings?platform=discord&guild=110…` → `RoleMapping[]`
  (`{platform, guild, platform_role, role}`); `PUT /api/auth/mappings` with a
  `RoleMapping` → it; `DELETE /api/auth/mappings` with
  `{platform, guild, platform_role}` → `204`.
- Node overrides: reserved.

---

## Extensions

### `GET /api/extensions` → `ExtensionInfo[]`

```json
[
  {
    "id": "song-request",
    "name": "點歌",
    "version": "0.2.1",
    "description": "Lets chat queue songs for her to sing",
    "source": "extensions/song-request",
    "enabled": true,
    "state": "running",
    "reason": null,
    "permissions": ["platform.send", "queue.push"]
  }
]
```

`state` uses `ModuleStateKind` (`disabled | starting | running | degraded | stopping | stopped | failed`).

**Served as:** also `"module": "ext.song-request"`; `source` is the extension
directory; `permissions` are the granted ones as `"tools"`, `"commands"`,
`"events:<topic>"`, `"network:<host>"`, `"input:<kind>"`.

### `POST /api/extensions/{id}/enable|disable|restart` → the updated `ExtensionInfo`

Same semantics and errors as `/api/modules/{id}/{action}`.

---

## MCP servers

### `GET /api/mcp` → `McpServerInfo[]`

```json
[
  {
    "name": "filesystem",
    "transport": "stdio",
    "target": "npx -y @modelcontextprotocol/server-filesystem ./shared",
    "enabled": true,
    "state": "ready",
    "error": null,
    "tools": [{ "name": "read_file", "description": "Read a file from the shared folder" }]
  }
]
```

`transport` ∈ `stdio | http`; `target` is the command line or URL (redact secrets);
`state` ∈ `connecting | ready | failed | disabled`.

### `POST /api/mcp/{name}/enable|disable|restart` → the updated `McpServerInfo`

**Served as:** `target` is `null` (the MCP module does not report it yet);
extra fields `remote_tool_count`, `permission`, `reconnects`. Only `restart`
works at runtime (it restarts the whole `mcp` module); `enable` / `disable`
answer 409 because servers are switched in `miyoria.toml`.

---

## Request queue

### `GET /api/queue` → `QueueState`

```json
{
  "paused": false,
  "items": [
    {
      "id": "01JC1A2B3C4D5E6F7G8H9J0K1M",
      "kind": "request",
      "context": { "platform": "discord", "scope": "1100", "channel": "1200", "kind": "channel" },
      "author": { "account": { "platform": "discord", "id": "5678" }, "display_name": "Mika" },
      "text": "唱一首〈千本櫻〉",
      "priority": 0,
      "enqueued_at": "2026-11-01T10:02:00Z"
    }
  ]
}
```

`items` are in processing order. `kind` ∈ `message | voice | initiative | request`; `author` is `null` for system items.

**Served as** (`miyoria_queue::RequestQueue`): `id` is the queue's numeric id
as a string (`"3"`); `kind` is free-form (`chat`, `song`, `game_goal`, …);
`context` may be `null`; plus `"state": "active" | "pending"` (active items
first) and `"votes"`. Only pending items can be moved or reordered (409).

### Mutations — each returns the new `QueueState`

- `POST /api/queue/{id}/skip`
- `POST /api/queue/{id}/move` with `{"position": 0}` (0-based target index, clamped)
- `POST /api/queue/pause`, `POST /api/queue/resume`

The panel polls `GET /api/queue` every 3 s; a `queue.changed` custom event would let it stop polling later.

---

## Stage / stream control

### `GET /api/stage` → `StageState`

```json
{
  "vts": { "connected": true, "error": null },
  "obs": { "connected": false, "error": "connection refused (127.0.0.1:4455)" },
  "scene": "Just Chatting",
  "scenes": ["Starting Soon", "Just Chatting", "Gaming", "BRB"],
  "expression": "smile",
  "expressions": ["neutral", "smile", "angry", "blush", "surprised"],
  "overlay_url": "http://127.0.0.1:7880/overlay",
  "speaking": false
}
```

### Mutations

- `POST /api/stage/scene` `{"scene": "Gaming"}` → `StageState` (409 if OBS is not connected)
- `POST /api/stage/expression` `{"expression": "blush"}` → `StageState` (409 if VTS is not connected)
- `POST /api/stage/stream` `{"action": "start" | "stop"}` → `StageState` (409 if OBS is not connected)
- `POST /api/stage/say` `{"text": "哼,才不是特地為你唱的。", "emotion": "embarrassed"}` → `{"turn": "<TurnId>" | null}`
  Speaks the text through TTS + lip sync directly, without the LLM. `emotion` optional.

**Served as:** plus `"node": "<stage node name>" | null` and `"streaming": bool`.
`scenes`, `expressions` are `[]` and `overlay_url` is `null` until the Stage
node reports them; `expression` is the last one triggered through the API (a
VTube Studio hotkey); `speaking` follows `voice.playback`. A failure on the
node is `502`. `say` speaks in the voice channel she joined first (409 when
she is in none; 503 without the `voice` module).

---

## Voice monitor

### `GET /api/voice` → `VoiceState`

```json
{
  "sessions": [
    {
      "context": { "platform": "discord", "scope": "1100", "channel": "1300", "kind": "voice" },
      "label": "Miyoria 的家 / 閒聊語音",
      "participants": [
        { "account": { "platform": "discord", "id": "999" }, "display_name": "DeepSeek-chan", "is_self": true, "muted": false, "deafened": false },
        { "account": { "platform": "discord", "id": "5678" }, "display_name": "Mika", "is_self": false, "muted": false, "deafened": false }
      ],
      "speaking": [{ "platform": "discord", "id": "5678" }],
      "joined_at": "2026-11-01T09:30:00Z",
      "latency": {
        "asr": { "p50_ms": 210, "p95_ms": 420, "samples": 64 },
        "llm_first_token": { "p50_ms": 640, "p95_ms": 1200, "samples": 30 },
        "tts_first_audio": { "p50_ms": 380, "p95_ms": 700, "samples": 30 }
      },
      "last_turn": "01JC1A2B3C4D5E6F7G8H9J0K1N"
    }
  ]
}
```

`participants` = `VoiceParticipant[]`. Latency stats over a recent window (e.g. last 15 min); `null` when no samples.

**Served as:** built from bus events since the `api` module started
(`voice.joined/left/participants/speaking/playback`, `voice.latency`), so a
channel joined before that appears with its next participants update. `label`
is `null`; `llm_first_token` comes from the `voice.latency` events with `stage: "llm"` and
`first_token_ms` the agent publishes for the first model response of each voice turn.
The live transcript on that page already works today from SSE (`voice.utterance`, `voice.playback`, `voice.latency`).

---

## Nice to have (not called yet)

- `GET /api/events?since=<event id>`: replay from a ring buffer; the panel already sends `Last-Event-ID` on reconnect.
- Module config schemas (`GET /api/modules/{id}/config` + JSON Schema) for the generated settings forms in ARCHITECTURE §15.1.
- ~~Serving `apps/panel/dist` from the `api` module at `/`~~ — done (`index.html`
  is `no-cache`, `assets/*` are immutable).
