# Miyoria panel — design system

Operate-mode admin UI in the owner's chosen register: Vercel-dashboard minimal, dark only,
Geist, shadcn/ui (new-york, neutral). The owner glances at it beside Discord, OBS and a
terminal on a streaming desk at night. Brand lives in one precise detail — the DeepSeek-blue
accent on focus, selection, "her" and the crescent mark — never in decoration.

Tokens: `src/index.css` (`:root` variables + Tailwind v4 `@theme inline`). Primitives:
`src/components/ui/*` (shadcn, Radix per component). App components: `src/components/*`.

## Rules the owner set

- No subtitle or description under page or section titles. A title, then the data.
- Empty states are one plain line ("佇列是空的"), no jokes, no advice paragraphs.
- No "原因:" / "來源:" prefixes; a column header says what the cell is.
- Every control does something the Core can do; nothing planned, nothing dead.

## Color (OKLCH, neutral, no tint)

| Role | Token | Value |
|---|---|---|
| Page | `--background` | 0.135 (≈ #0a0a0a) |
| Sidebar | `--sidebar` | 0.115, `--sidebar-border` white 8% |
| Card | `--card` | 0.16 |
| Popover / dialog / sheet | `--popover` | 0.175 |
| Hover / selected | `--accent` 0.225, `--muted` 0.20 |
| Lines | `--border` white 9%, `--input` white 13% |
| Text | `--foreground` 0.96, `--muted-foreground` 0.71 (≥ 7:1 on page) |
| Primary button | `--primary` near-white with dark text (Vercel) |
| Brand | `--brand` / `--ring` DeepSeek blue (h 267): focus ring, switch on, "她", brand badge, chart line |
| State | `--success` (h 155), `--warning` (h 78), `--destructive` (h 25) — state only |

Badges are tinted: `bg-<state>/10`, `border-<state>/25`, text in the state hue. No gradients,
no glow, no glass except the sticky header's backdrop blur.

## Type

Geist Variable (`@fontsource-variable/geist`) with a CJK fallback stack: PingFang TC,
Microsoft JhengHei UI, Noto Sans TC. Geist Mono only for ids, topics, JSON, tokens, model
names, latencies and diffs. Scale: 12 / 13 / **14 body** / 16 / 20 (stat values) / 24 (page
title, semibold, tracking-tight). Tables and numbers use `tabular-nums`.

## Layout

- Shell: shadcn `Sidebar` (15 rem, collapses to 3.25 rem icons, `⌘/Ctrl+B`; off-canvas
  sheet below `md`). Nine items: 總覽 · 動態 · 直播 · 角色 · 內心 · 系統 · 權限 · 資料 · 設定. Footer: one
  status dot for Core + event stream (tooltip: version, stream state, host), the Discord user
  (or "Admin token") and logout.
- Sticky 48 px header: sidebar trigger and the ⌘K search button only (no title echo).
- Page: `max-w-6xl`, 32 px padding (16 px on phones), 24 px between blocks. Header row =
  title + actions. Sub-areas are underlined `Tabs` bound to `?tab=`.
- Cards: 1 px border, radius 8 px, header row 48 px with title left, actions right
  (`CardAction`). Tables sit flush in cards; first/last cell 16 px padding.
- Stat row (總覽): four cells in one bordered strip with 1 px gaps — label 13 px muted, value
  20 px semibold. No captions, no sparklines.

## Components

Button (default / outline / secondary / ghost / destructive / link; sizes sm, default, icon,
icon-sm; `busy` spinner; `writes` disables with the read-only hint), Badge (outline, secondary,
success, warning, destructive, brand), StatusBadge / StateBadge / Dot, Meter / Bipolar,
Card, Tabs, Table + `DataTable` (TanStack Table; global filter, sortable headers via
`enableSorting`), `RowActions` (⋯ DropdownMenu at row end), Select, Switch, Checkbox, Slider,
Input / Textarea, Field (label + control + error), Dialog (forms, persona edit → diff →
save), AlertDialog via `ConfirmDialog` (stays open on failure), Sheet (details: event,
decision, person, MCP tools), Command palette (pages, people, modules), Popover + Command
combobox (person picker), Tooltip, Sonner toasts (success / error with the Core's message),
Skeleton rows, `DiffView`, `JsonView`, `Facts`. Icons: lucide 16 px.

## States

`QueryView`: skeleton rows of real row height → error line with retry → one-line empty →
data. Mutations report through Sonner; dialogs close only on success. Disabled controls say
why in a tooltip (read-only account, OBS/VTS not connected, she is not in voice).

## Motion

150–200 ms fades and zooms on overlays (tw-animate-css), sheet slide 300 ms. Pulsing dots
only for live / transitioning states. `prefers-reduced-motion` collapses all durations.
