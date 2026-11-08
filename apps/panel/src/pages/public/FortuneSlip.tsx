// The fortune slip she writes (今日籤詩): a tall dark slip in the card's craft, read down the way
// a slip is: the rank and the title on the right, the four lines of the poem to their left, then
// her fields and a line of her own. The same SVG is on the page and in the PNG they download, so
// colours are resolved to literals and nothing in it leans on the page.

import { Download } from "lucide-react";
import { forwardRef, useRef, useState } from "react";
import type { FortuneField, IssuedFortune } from "@/api/types";
import { Button } from "@/components/ui/button";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { cardColors } from "./card";

const W = 420;
const H = 860;
const PAD = 36;
// The card's type (card.tsx), kept literal because this SVG leaves the page as a PNG.
const FONT =
  '"Geist Variable", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const MONO = '"Geist Mono", ui-monospace, Consolas, monospace';

/** The six ranks, best first (`packages/api/src/fortune.ts`). */
export const FORTUNE_RANKS = ["大吉", "吉", "中吉", "小吉", "末吉", "凶"] as const;

/** What the Core limits, repeated so a long text cannot break the slip. */
const MAX_TITLE = 8;
const MAX_POEM_LINE = 7;
const MAX_FIELDS = 3;

const cut = (text: string, max: number) => [...text.trim()].slice(0, max).join("");

/** The ink a rank is written in: gold for 大吉, her colour for the good, quieter down to 凶. */
export function rankInk(rank: string, primary: string): string {
  switch (rank) {
    case "大吉":
      return "#f3d77d";
    case "吉":
    case "中吉":
      return primary;
    case "凶":
      return "#8c9cc9";
    default:
      return "#d8dcec";
  }
}

/** CJK runs about one em per character, Latin about half: enough to break lines by hand. */
function wrap(text: string, em: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  let width = 0;
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    const w = /[\u0000-ɏ]/.test(ch) ? 0.55 : 1;
    if (width + w > em) {
      out.push(line);
      line = "";
      width = 0;
      if (out.length === lines) break;
    }
    line += ch;
    width += w;
  }
  if (out.length < lines && line !== "") out.push(line);
  else if (out.length === lines) out[lines - 1] = `${(out[lines - 1] ?? "").slice(0, -1)}…`;
  return out;
}

/** One character per line, top to bottom, centred on `x`. */
function Vertical({
  text,
  x,
  y,
  size,
  step,
  fill,
  weight = 400,
  opacity = 1,
}: {
  text: string;
  x: number;
  y: number;
  size: number;
  step: number;
  fill: string;
  weight?: number;
  opacity?: number;
}) {
  return (
    <g fontSize={size} fontWeight={weight} fill={fill} opacity={opacity} textAnchor="middle">
      {[...text].map((ch, i) => (
        <text key={i} x={x} y={y + i * step}>
          {ch}
        </text>
      ))}
    </g>
  );
}

const dotted = (date: string) => date.replace(/-/g, ".");

export interface FortuneFaceProps {
  fortune: IssuedFortune;
  colors: { primary: string; secondary: string };
  className?: string;
}

/** The slip. `ref` reaches the `<svg>`, for turning it into a PNG. */
export const FortuneFace = forwardRef<SVGSVGElement, FortuneFaceProps>(function FortuneFace(
  { fortune, colors, className },
  ref,
) {
  const id = fortune.id.replace(/[^A-Za-z0-9]/g, "").slice(-12) || "slip";
  const ink = rankInk(fortune.rank, colors.primary);
  const title = cut(fortune.title, MAX_TITLE);
  const poem = fortune.poem.slice(0, 4).map((l) => cut(l, MAX_POEM_LINE));
  const fields: FortuneField[] = fortune.fields.slice(0, MAX_FIELDS);
  const line = fortune.line ? wrap(`「${fortune.line}」`, 15, 3) : [];
  const label = [
    `${dotted(fortune.date)} 今日籤`,
    `${fortune.rank}「${title}」`,
    poem.join(","),
    ...fields.map((f) => `${f.label}:${f.text}`),
    fortune.line ? `她說「${fortune.line}」` : null,
  ]
    .filter((s): s is string => s !== null && s !== "")
    .join(",");
  // The poem reads right to left: the first line is the rightmost of the four.
  const poemX = (i: number) => 214 - i * 46;
  const top = 128;
  const rankChars = [...fortune.rank];
  const rankSize = rankChars.length > 1 ? 54 : 64;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={label}
      className={className}
      fontFamily={FONT}
    >
      <defs>
        <clipPath id={`clip-${id}`}>
          <rect width={W} height={H} rx={24} />
        </clipPath>
        <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1f36" />
          <stop offset="1" stopColor="#0b0d14" />
        </linearGradient>
        <radialGradient id={`glow-a-${id}`}>
          <stop offset="0" stopColor={colors.secondary} stopOpacity="0.4" />
          <stop offset="1" stopColor={colors.secondary} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`glow-b-${id}`}>
          <stop offset="0" stopColor={ink} stopOpacity="0.16" />
          <stop offset="1" stopColor={ink} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`rule-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={ink} stopOpacity="0" />
          <stop offset="0.5" stopColor={ink} stopOpacity="0.7" />
          <stop offset="1" stopColor={ink} stopOpacity="0" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#clip-${id})`}>
        <rect width={W} height={H} fill={`url(#bg-${id})`} />
        <circle cx={W * 0.85} cy={150} r={300} fill={`url(#glow-a-${id})`} />
        <circle cx={W * 0.15} cy={520} r={260} fill={`url(#glow-b-${id})`} />

        <text x={PAD} y={58} fontSize={14} fontWeight={600} letterSpacing={5} fill="#ffffff" opacity={0.9}>
          MIYORIA
        </text>
        <text x={W - PAD} y={58} fontSize={14} fontFamily={MONO} textAnchor="end" fill="#ffffff" opacity={0.8}>
          {dotted(fortune.date)}
        </text>
        <text x={PAD} y={84} fontSize={12} letterSpacing={6} fill="rgba(255,255,255,0.5)">
          今日籤詩
        </text>

        {/* the rank, large, at the right edge; the title beside it */}
        <Vertical text={fortune.rank} x={W - PAD - 28} y={top + 36} size={rankSize} step={rankSize + 12} fill={ink} weight={700} />
        <Vertical text={title} x={W - PAD - 100} y={top + 14} size={28} step={38} fill="#f1f0f4" weight={600} />
        <rect x={W - PAD - 130} y={top - 4} width={1} height={364} fill="#ffffff" opacity={0.1} />

        {poem.map((l, i) => (
          <Vertical key={i} text={l} x={poemX(i)} y={top + 12} size={25} step={40} fill="rgba(255,255,255,0.88)" />
        ))}

        <rect x={PAD} y={520} width={W - PAD * 2} height={1.5} fill={`url(#rule-${id})`} />

        {fields.map((f, i) => (
          <text key={i} x={PAD} y={566 + i * 34} fontSize={16}>
            <tspan fill="rgba(255,255,255,0.55)" fontSize={13}>
              {cut(f.label, 4)}
            </tspan>
            <tspan x={PAD + 66} fill="#f1f0f4">
              {wrap(f.text, 17, 1)[0]}
            </tspan>
          </text>
        ))}

        {line.map((l, i) => (
          <text key={i} x={PAD} y={704 + i * 26} fontSize={17} fill="rgba(255,255,255,0.84)">
            {l}
          </text>
        ))}

        <text x={PAD} y={H - 40} fontSize={12} fontFamily={MONO} fill="rgba(255,255,255,0.5)">
          MIYORIA · {fortune.rank}
        </text>
        <rect x={W - PAD - 26} y={H - 58} width={26} height={26} rx={5} fill="none" stroke={ink} strokeWidth={1.6} opacity={0.85} />
        <text x={W - PAD - 13} y={H - 39} fontSize={15} fontWeight={700} textAnchor="middle" fill={ink}>
          {[...fortune.rank][0]}
        </text>
      </g>
      <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={23} fill="none" stroke={ink} strokeOpacity={0.75} strokeWidth={2.5} />
      <rect x={10} y={10} width={W - 20} height={H - 20} rx={16} fill="none" stroke="#ffffff" strokeOpacity={0.1} />
    </svg>
  );
});

/** The slip as a PNG, twice its size: what is downloaded and shared. */
export async function fortunePng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const markup = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("沒辦法產生圖片");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("沒辦法產生圖片"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const fortuneFileName = (f: IssuedFortune) => `miyoria-fortune-${f.date}.png`;

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A slip with a button to download it as a picture. */
export function FortuneSlip({ fortune, className }: { fortune: IssuedFortune; className?: string }) {
  const svg = useRef<SVGSVGElement>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    if (!svg.current) return;
    setBusy(true);
    try {
      save(await fortunePng(svg.current), fortuneFileName(fortune));
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "沒辦法產生圖片");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("flex flex-col items-center gap-3", className)}>
      <FortuneFace ref={svg} fortune={fortune} colors={cardColors()} className="h-auto w-full max-w-[360px] rounded-3xl" />
      <Button variant="outline" busy={busy} onClick={() => void download()}>
        <Download aria-hidden />
        下載
      </Button>
    </div>
  );
}
