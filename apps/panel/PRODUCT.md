# Product

<!-- impeccable:product-schema 1 -->

<!-- Inferred from the owner's redesign brief and the repository (no interview round was possible
in this session); confirm or correct with `/impeccable init`. -->

## Platform

web

## Users

One owner (writes Traditional Chinese) who runs the AI VTuber DeepSeek-chan, glancing at the
panel on a streaming desk at night beside Discord, OBS, VTube Studio and a terminal. Optional
Discord-login moderators, some read-only (no `admin.panel.write`).

## Product Purpose

The admin panel of the Miyoria Core: see whether she is healthy, what she heard and decided,
steer the live show (scene, expression, stream, queue, say a line), and edit who she is
(persona, memories, relationships) and who may do what (roles).

## Operating Context

Served by the Core from `apps/panel/dist` on `127.0.0.1:7878` (hash routes). One SSE stream of
bus events feeds live views. Login by admin bearer token or Discord OAuth (cookie + CSRF header).

## Capabilities and Constraints

- UI copy is zh-TW. Ids, topics, JSON and tokens stay in their original form.
- Every write is audited by the Core; read-only accounts see changes disabled, not hidden.
- Live services run elsewhere; the panel must tolerate stopped modules (503) and a missing stage node.

## Brand Commitments

- Owner's binding direction: Vercel-dashboard minimal dark (Geist), shadcn/ui; no subtitles or
  descriptions under page and section titles, no joke or advice copy in empty states.
- Character name DeepSeek-chan; "她" refers to her in the UI.

## Product Principles

1. State first: what is wrong, and what is live, is visible without reading prose.
2. Every control does something real; nothing is shown that the Core cannot do.
3. Quiet chrome, dense data, one line where one line is enough.
