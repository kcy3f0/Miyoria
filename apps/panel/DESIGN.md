# Miyoria panel — design system

Operate-mode admin UI in the owner's chosen register: Vercel-dashboard minimal, dark only,
Geist, shadcn/ui (new-york, neutral). The owner glances at it beside Discord, OBS and a
terminal on a streaming desk at night. Brand lives in one precise detail — the DeepSeek-blue
accent on focus, selection, "her", her chart series and the crescent mark — never in decoration.

Minimal here means restrained chrome around dense, real data, not bare pages: every page leads
with state, then trends drawn as charts, then the controls that change them.

Tokens: `src/index.css` (`:root` variables + Tailwind v4 `@theme inline`). Primitives:
`src/components/ui/*` (shadcn, Radix per component). App components: `src/components/*`.
Charts: `src/components/charts/*` (hand-drawn SVG, no chart library). Chart blocks over the
Core's telemetry: `src/components/trends.tsx`.

## Rules the owner set

- No subtitle or description under page or section titles. A title, then the data.
- Empty states are one plain line ("佇列是空的"), no jokes, no advice paragraphs.
- No "原因:" / "來源:" prefixes; a column header says what the cell is.
- Every control does something the Core can do; nothing planned, nothing dead. Live controls
  go through the Core's actuator gate as the panel (principal `panel`), never around it.

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
| Brand | `--brand` / `--ring` DeepSeek blue (h 267): focus ring, switch on, "她", selected scene, chart series 1 |
| State | `--success` (h 155), `--warning` (h 78), `--destructive` (h 25) — state only |

Badges are tinted: `bg-<state>/10`, `border-<state>/25`, text in the state hue. No gradients,
no glow, no glass except the sticky header's and the chart tooltip's backdrop blur.

### Chart colors

Series take `--chart-1..5` in this fixed order, never cycled: her blue (= brand), orange
`#d95926`, aqua `#199e70`, yellow `#c98500`, magenta `#d55181`. Validated with the dataviz
validator on the card surface: adjacent pairs pass CVD (worst ΔE 8.4) and normal vision
(worst 19.3); the first three pass for all pairs, so scatter-like charts stop at three.
`--chart-quiet` (gray 0.42) is "nothing came of it" / "other". Gridlines `--chart-grid`
(white 6%), baselines and crosshairs `--chart-axis` (white 16%). Status colors appear in a
chart only when the value is a state (module states, intent outcomes), always with a label.

## Type

Geist Variable (`@fontsource-variable/geist`) with a CJK fallback stack: PingFang TC,
Microsoft JhengHei UI, Noto Sans TC. Geist Mono only for ids, topics, JSON, tokens, model
names, latencies, axis ticks and diffs. Scale: 11 (ticks) / 12 / 13 / **14 body** / 16 (section
heading) / 24 (page title and chart headline values, semibold, tracking-tight). Columns of
numbers use `tabular-nums`; standalone headline values keep proportional figures.

## Layout

- Shell: shadcn `Sidebar` (15 rem, collapses to 3.25 rem icons, `⌘/Ctrl+B`; off-canvas
  sheet below `md`). Nine items: 總覽 · 動態 · 直播 · 角色 · 內心 · 系統 · 權限 · 資料 · 設定. A pulsing red
  dot on 直播 while she is live, a count on 內心 while approvals wait. Footer: one status dot
  for Core + event stream (tooltip: version, stream state, host), the Discord user (or "Admin
  token") and logout.
- Sticky 48 px header: sidebar trigger, a "自主行動已暫停" pill while her autonomy is stopped,
  and the ⌘K search button (no title echo).
- Page: `max-w-6xl`, 32 px padding (16 px on phones), 24 px between blocks. Header row =
  title + actions (緊急停止 lives here on 總覽 and 直播). Sub-areas are underlined `Tabs` bound
  to `?tab=`. A section heading (16 px semibold) sits on its own row with the range toggle.
- Cards: 1 px border, radius 8 px, header row 48 px with title left, actions right
  (`CardAction`). Tables sit flush in cards; first/last cell 16 px padding.
- Now strip (總覽): seven cells in one bordered strip with 1 px gaps — 她 · 語音 · 直播 · 場景 ·
  唱歌 · 遊戲 · 佇列, label 12 px muted, value 14 px medium with a state dot.
- Chart blocks (`ChartBlock`): title 13 px muted, headline value 24 px semibold with its unit
  and one muted aside, legend, then the plot. Two per row from `lg`, one below.
- Small multiples (`Facets`): one 56 px line per measure in a 1 px-gap grid (5 columns on
  `xl`, 3 on `sm`, 2 on phones), one shared crosshair, the hovered value in each header.
- 直播: a two-column control deck — 畫面 (OBS stream, scenes as a radio grid, expressions as
  chips), 歌單, 請求佇列, 場景用途 on the left; 語音 (join / leave / Go Live), 讓她說, 遊戲,
  聊天等級 (with a per-channel mute) on the right.

## Charts

`TimeChart` (lines, optional 10% area wash, crosshair + one tooltip listing every series,
arrow keys move it), `ColumnChart` (stacked columns ≤ 24 px with a 4 px rounded data end, 2 px
surface gaps between segments, hovered column stays, others dim to 45%), `Facets`,
`SegmentBar` (one 100% bar with counts in the legend), `BarList` (horizontal bars, largest
first). Every chart has a legend from two series up, never colors text, and carries a
visually hidden table of its values. Time axes tick on round local times. Ranges: 1 小時 /
6 小時 / 24 小時 (`Segmented`), remembered per browser. Telemetry comes from
`GET /api/telemetry` (one sample a minute, a day in memory); a Core without it shows one line
at the chart's height instead.

## Components

Button (default / outline / secondary / ghost / destructive / link; sizes sm, default, icon,
icon-sm; `busy` spinner; `writes` disables with the read-only hint), Badge (outline, secondary,
success, warning, destructive, brand), StatusBadge / StateBadge / Dot, Meter / Bipolar,
`Segmented` (radio group of short options), Card, Tabs, Table + `DataTable` (TanStack Table;
global filter, sortable headers via `enableSorting`), `RowActions` (⋯ DropdownMenu at row
end), Select, Switch, Checkbox, Slider, Input / Textarea, Field (label + control + error),
Dialog (forms, persona edit → diff → save), AlertDialog via `ConfirmDialog` (stays open on
failure), Sheet (details: event, decision, person, MCP tools), Command palette (pages,
people, modules), Popover + Command combobox (person picker), Tooltip, Sonner toasts (success
/ error with the Core's message), Skeleton rows, `DiffView`, `JsonView`, `Facts`,
`EmergencyStop`, `NowStrip`. Icons: lucide 16 px.

## States

`QueryView`: skeleton rows of real row height → error line with retry → one-line empty →
data. Charts: a skeleton at the chart's height → one line ("這個 Core 還沒有趨勢資料") →
plot; refetches keep the previous render. Mutations report through Sonner; dialogs close only
on success. Disabled controls say why in a tooltip (read-only account, OBS/VTS not connected,
she is not in voice). Disruptive controls confirm (stop streaming, leave voice, Go Live, stop
the game, cancel every song); routine ones act at once (scene, expression, queue order,
mute a channel), and so does 緊急停止.

## Motion

150–200 ms fades and zooms on overlays (tw-animate-css), sheet slide 300 ms, 120 ms column
dimming on hover. Pulsing dots only for live / transitioning states. `prefers-reduced-motion`
collapses all durations.
