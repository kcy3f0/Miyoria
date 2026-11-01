# Admin API — routes the panel already calls

The panel ships UI for these routes before the Core serves them. Until a route
exists, the Core's fallback answers `404 {"error":"no such endpoint"}` and the
panel shows "尚未提供(core 版本較舊)" for that page. Implement a route with the
shapes below and the page lights up with no panel change.

Conventions (same as the live API in `crates/miyoria-api`):

- Every route requires `Authorization: Bearer <token>`.
- Errors are `{"error": "..."}`. Use **404 with a specific message** (not the
  fallback text) for "this item does not exist", 409 for refused state changes,
  503 when the backing service/module is stopped.
- Timestamps are RFC 3339 (chrono), ids are ULID strings, enums are
  `snake_case`, `Option` is `null` (not omitted) unless noted.
- Lists that can grow use `Page<T>`: `{"items": [...], "next_cursor": "opaque" | null}`.
- All requests act on the **active profile**, like `/api/decisions` and `/api/persona`.

TypeScript mirrors: `src/api/planned-types.ts`; client calls: `src/api/endpoints.ts`.
`Settings → API 支援度` probes every GET below and shows which ones a Core serves.

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

Response: the updated `PersonSummary`.

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
`has_embedding`. `scope` uses `MemoryScope`'s serde (`{"type": "global" | "guild" | "channel" | "dm" | "person", ...}`).
`text_score` / `vector_score` are present only when `q` was given.

### `PATCH /api/memory/{id}`

```json
{ "content": "Owen 喜歡豚骨拉麵,不吃香菜", "kind": "fact", "importance": 0.7, "done": false }
```

All optional. Changing `content` should re-tokenize and re-embed. Response: the updated record (shape above).

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

`scope` uses `AuthScope`'s serde: `{"type":"global"}`, `{"type":"guild","platform","guild"}`, `{"type":"channel","context":{…}}`.

### `POST /api/auth/assignments` → the created `RoleAssignment`

```json
{ "account": { "platform": "discord", "id": "123" }, "role": "moderator", "scope": { "type": "global" } }
```

The server fills `granted_by` (e.g. `"panel"`) and `at`. 404 for an unknown role, 409 if it already exists.

### `DELETE /api/auth/assignments` → `204`

Same body as POST (the assignment's natural key). 404 if absent.

(Not called yet, reserve for later: `GET/PUT /api/auth/roles/{name}`, `GET/PUT /api/auth/mappings` for `RoleMapping`, node overrides.)

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
- `POST /api/stage/say` `{"text": "哼,才不是特地為你唱的。", "emotion": "embarrassed"}` → `{"turn": "<TurnId>" | null}`
  Speaks the text through TTS + lip sync directly, without the LLM. `emotion` optional.

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
The live transcript on that page already works today from SSE (`voice.utterance`, `voice.playback`, `voice.latency`).

---

## Nice to have (not called yet)

- `GET /api/events?since=<event id>`: replay from a ring buffer; the panel already sends `Last-Event-ID` on reconnect.
- Module config schemas (`GET /api/modules/{id}/config` + JSON Schema) for the generated settings forms in ARCHITECTURE §15.1.
- Serving `apps/panel/dist` from the `api` module at `/` (the panel uses hash routing, so no SPA fallback is needed; asset URLs are relative).
