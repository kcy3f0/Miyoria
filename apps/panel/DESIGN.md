# Miyoria panel — design system

Operate-mode admin UI: the owner glances at it beside Discord, OBS and a terminal
on a streaming desk at night. Dark only, quiet, dense where data is dense. Brand
lives in small precise details (the DeepSeek-blue accent, the crescent mark),
not decoration. Tokens live in `src/styles/tokens.css`; components in
`src/styles/app.css` + `src/components/`.

## Color (OKLCH, neutrals tinted toward hue 265)

| Role | Token | Use |
|---|---|---|
| Rail / inputs | `--c-rail` 0.145 | sidebar, input wells, code blocks |
| Page | `--c-bg` 0.168 | body |
| Raised | `--c-raised` 0.198 | panels, dialogs |
| Hover / active | `--c-hover` 0.232, `--c-active` 0.262 | row hover, selected nav, toggles |
| Lines | `--c-line`, `--c-line-strong` | dividers, control borders |
| Text | `--c-text`, `--c-text-2`, `--c-text-3` | primary, secondary, meta/placeholder (≥4.5:1 on page) |
| Accent | `--c-accent` (text/icons), `--c-accent-fill` (buttons, white text) | primary action, selection, "her" |
| Semantic | `--c-ok`, `--c-warn`, `--c-danger` + `-soft` tints | module state, budgets, diffs |

Strategy: Restrained. Accent only for primary actions, current selection and
state; semantic colors only for state. No gradients, glows or glass.

## Type

One family: Segoe UI Variable / system UI with Microsoft JhengHei UI / PingFang TC /
Noto Sans TC for Traditional Chinese. Mono (Cascadia Mono) only for ids, topics,
JSON, token fields and diffs. Fixed rem scale 12 / 13 / **14 body** / 16 / 19 / 23.
Numbers in tables and stats use `tabular-nums`.

## Layout

- Shell: 240 px rail (grouped nav: 監控 / 角色 / 直播 / 系統, settings + live
  connection status at the foot) + content column, max 88 rem.
- ≤ 760 px: rail becomes an off-canvas drawer behind a top bar (Esc / scrim closes).
- Pages: header (title, one-line purpose, actions) → toolbar (search, segmented
  filters) → panels. Overview uses a 4-cell status strip (grid with 1 px dividers),
  not metric cards.
- Spacing on a 4 px grid (`--s-*`); radius 4 / 6 / 8.

## Components

`Button` (default, primary, danger, ghost; sm; icon-only with `aria-label`; busy
spinner), `Badge` / `StateBadge`, `Segmented` (radio group), `Field`, `Panel`,
row lists (`.rows/.row`), `.table`, `EventFeed`, `DiffView`, `JsonView`,
`ConfirmDialog` / `Modal` / `Drawer` (native `<dialog>`: focus trap, Esc, backdrop
click), toasts (`aria-live`). Icons: lucide-react at 16 px, stroke 1.75.

## States

Every data view goes through `QueryView`: skeleton rows of real row height →
"尚未提供(core 版本較舊)" for routes this Core lacks → error with retry →
empty state that says what will appear and how → data. Destructive or disruptive
actions confirm in a dialog that names the consequence. Empty states may carry a
light DeepSeek-chan tsundere line; everything else stays plain.

## Motion

120–200 ms ease-out for hover/press, dialog/drawer entrance, new-event highlight.
Pulsing dots only for live / transitioning states. `prefers-reduced-motion`
zeroes durations and stops shimmer, pulse and spin.
