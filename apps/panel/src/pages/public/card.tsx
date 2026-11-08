// The card she gives someone: an SVG drawn from what the Core issued, the same picture on the page,
// in the PNG they download and on the page that checks its code. Pictures are inlined as data URLs
// and colours resolved to literals, so the SVG stands on its own when it is turned into a PNG.

import { useQuery } from "@tanstack/react-query";
import { forwardRef } from "react";
import { encode } from "uqr";
import type { IssuedCard } from "@/api/types";

/** The Core's bands (`packages/api/src/member.ts`), lowest first. */
export const AFFINITY = ["很差", "不太好", "普通", "不錯", "很好", "非常好"] as const;
export const TRUST = ["還不信任", "有點信任", "信任", "很信任"] as const;
export const FAMILIARITY = ["陌生", "見過幾次", "有點熟", "熟", "很熟"] as const;

const W = 630;
const H = 880;
const PAD = 36;
/** The lower half, where the words sit. */
const INK = "#0c0e16";
const FONT = '"Geist Variable", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", sans-serif';
const MONO = '"Geist Mono", ui-monospace, Consolas, monospace';

/** Her pictures are the owner's renders of her model, kept out of git like the background. */
export const poseUrl = (pose: string) => `/card-${pose.replace(/[^a-z0-9-]/g, "")}.local.webp`;

/** Where the code on a card leads: the page that checks it. */
export const verifyUrl = (serial: string) => `${window.location.origin}/#/card/${encodeURIComponent(serial)}`;

async function dataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** A picture as a data URL, or `null` when it cannot be had (missing, or no CORS). */
export function useInlined(url: string | null) {
  return useQuery({
    queryKey: ["inlined", url],
    queryFn: () => (url ? dataUrl(url) : null),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
  });
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? fallback : v;
}

/** The theme's two accents as literals, for an SVG that leaves the page. */
export function cardColors() {
  return { primary: cssVar("--primary", "#f29dc4"), secondary: cssVar("--secondary", "#7355e8") };
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
  else if (out.length === lines) out[lines - 1] = `${out[lines - 1].slice(0, -1)}…`;
  return out;
}

const issuedDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso.slice(0, 10)
    : `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};

function Qr({ text, x, y, size }: { text: string; x: number; y: number; size: number }) {
  const qr = encode(text, { ecc: "M", border: 0 });
  const cell = size / qr.size;
  let d = "";
  qr.data.forEach((row, r) => {
    row.forEach((on, c) => {
      if (on) d += `M${(x + c * cell).toFixed(2)} ${(y + r * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
    });
  });
  return <path d={d} fill="#0b0d14" shapeRendering="crispEdges" />;
}

function Meter({ x, y, width, at, steps, primary }: { x: number; y: number; width: number; at: number; steps: number; primary: string }) {
  const gap = 3;
  const w = (width - gap * (steps - 1)) / steps;
  return (
    <g>
      {Array.from({ length: steps }, (_, i) => (
        <rect key={i} x={x + i * (w + gap)} y={y} width={w} height={6} rx={2} fill={i <= at ? primary : "rgba(255,255,255,0.16)"} />
      ))}
    </g>
  );
}

function BandColumn({
  x,
  label,
  value,
  scale,
  primary,
}: {
  x: number;
  label: string;
  value: string | null;
  scale: readonly string[];
  primary: string;
}) {
  const at = value === null ? -1 : scale.indexOf(value);
  const width = 170;
  return (
    <g>
      <text x={x} y={636} fontSize={13} fill="rgba(255,255,255,0.6)">
        {label}
      </text>
      <text x={x} y={660} fontSize={18} fontWeight={600} fill="#f1f0f4">
        {value ?? "—"}
      </text>
      {at >= 0 && <Meter x={x} y={672} width={width} at={at} steps={scale.length} primary={primary} />}
    </g>
  );
}

/** Her stamp: a seal pressed at a tilt beside the title, in the primary colour. */
function Stamp({ text, x, y, primary }: { text: string; x: number; y: number; primary: string }) {
  const size = 19;
  const width = [...text].reduce((w, ch) => w + (/[\u0000-ɏ]/.test(ch) ? 0.6 : 1), 0) * size + 26;
  return (
    <g transform={`translate(${x - width / 2} ${y}) rotate(-8)`} opacity={0.94}>
      <rect x={-width / 2} y={-22} width={width} height={44} rx={7} fill="rgba(12,14,22,0.35)" stroke={primary} strokeWidth={2.5} />
      <rect x={-width / 2 + 4} y={-18} width={width - 8} height={36} rx={4} fill="none" stroke={primary} strokeOpacity={0.55} />
      <text y={7} fontSize={size} fontWeight={700} textAnchor="middle" letterSpacing={2} fill={primary}>
        {text}
      </text>
    </g>
  );
}

/** Lines of words the lower half holds above the footer, and how far the rest moves up for them. */
const QUOTE_Y = 718;
const QUOTE_STEP = 25;
const FIELD_STEP = 26;
const FIELDS_END = 784;

/**
 * Frames they can buy: a colour per id for the little swatch in the shop. The card draws the
 * real thing in `Frame`. An id the panel does not know falls back to the plain border.
 */
export const FRAME_SWATCH: Record<string, string> = { sakura: "#f4b6cf", abyss: "#2f8fb5", gold: "#d9aa3c" };

const PETAL = "M0 0C5-7 15-5 13 4C11 11 2 9 0 0Z";

/** Four petals fanned around a corner, so it reads as blown there. */
function Petals({ x, y, flip }: { x: number; y: number; flip: [number, number] }) {
  const spec: [number, number, number, number][] = [
    [0, 0, 20, 1],
    [11, 5, 70, 0.8],
    [4, 14, 120, 0.9],
    [18, 16, 40, 0.6],
  ];
  return (
    <g transform={`translate(${x} ${y}) scale(${flip[0]} ${flip[1]})`} fill="#f7c6da" opacity={0.92}>
      {spec.map(([dx, dy, rot, k], i) => (
        <path key={i} d={PETAL} transform={`translate(${dx} ${dy}) rotate(${rot}) scale(${k})`} />
      ))}
    </g>
  );
}

/** The border of the card, drawn over the picture. Literal colours only: it is exported to PNG. */
function Frame({ frame, id }: { frame: string | null | undefined; id: string }) {
  const corners: [number, number, [number, number]][] = [
    [6, 6, [1, 1]],
    [W - 6, 6, [-1, 1]],
    [6, H - 6, [1, -1]],
    [W - 6, H - 6, [-1, -1]],
  ];
  if (frame === "sakura") {
    return (
      <g>
        <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={25} fill="none" stroke="#f4b6cf" strokeWidth={3} />
        <rect x={10} y={10} width={W - 20} height={H - 20} rx={19} fill="none" stroke="#f9d3e2" strokeOpacity={0.35} />
        {corners.map(([x, y, f], i) => (
          <Petals key={i} x={x} y={y} flip={f} />
        ))}
      </g>
    );
  }
  if (frame === "abyss") {
    return (
      <g>
        <defs>
          <linearGradient id={`abyss-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#4fd1d9" />
            <stop offset="0.55" stopColor="#1d6f9a" />
            <stop offset="1" stopColor="#0f2f66" />
          </linearGradient>
        </defs>
        <rect x={2} y={2} width={W - 4} height={H - 4} rx={24} fill="none" stroke={`url(#abyss-${id})`} strokeWidth={4} />
        <rect x={11} y={11} width={W - 22} height={H - 22} rx={18} fill="none" stroke="#7fe3ea" strokeOpacity={0.3} />
        <rect x={15} y={15} width={W - 30} height={H - 30} rx={15} fill="none" stroke="#7fe3ea" strokeOpacity={0.14} strokeDasharray="2 9" strokeLinecap="round" />
        {[
          [W - 30, 32, 4],
          [W - 44, 46, 2.5],
          [W - 26, 58, 2],
        ].map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="none" stroke="#a6f0f4" strokeOpacity={0.75} />
        ))}
      </g>
    );
  }
  if (frame === "gold") {
    return (
      <g>
        <defs>
          <linearGradient id={`gold-${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f8e49a" />
            <stop offset="0.45" stopColor="#c8942a" />
            <stop offset="0.7" stopColor="#f3d77d" />
            <stop offset="1" stopColor="#a8741c" />
          </linearGradient>
        </defs>
        <rect x={2} y={2} width={W - 4} height={H - 4} rx={24} fill="none" stroke={`url(#gold-${id})`} strokeWidth={4.5} />
        <rect x={11} y={11} width={W - 22} height={H - 22} rx={18} fill="none" stroke="#e9c766" strokeOpacity={0.55} />
        {corners.map(([x, y, f], i) => (
          <path
            key={i}
            d="M0-9L9 0 0 9-9 0Z"
            transform={`translate(${x + f[0] * 14} ${y + f[1] * 14})`}
            fill={`url(#gold-${id})`}
            stroke="#fff4c2"
            strokeOpacity={0.5}
          />
        ))}
      </g>
    );
  }
  return (
    <g>
      <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={25} fill="none" stroke={`url(#foil-${id})`} strokeWidth={3} />
      <rect x={10} y={10} width={W - 20} height={H - 20} rx={19} fill="none" stroke="#ffffff" strokeOpacity={0.12} />
    </g>
  );
}

export interface CardFaceProps {
  card: IssuedCard;
  /** Her picture, inlined; `null` draws the card without it. */
  art: string | null;
  /** Their avatar, inlined; `null` draws their initial. */
  avatar: string | null;
  colors: { primary: string; secondary: string };
  className?: string;
}

/** The card. `ref` reaches the `<svg>`, for turning it into a PNG. */
export const CardFace = forwardRef<SVGSVGElement, CardFaceProps>(function CardFace(
  { card, art, avatar, colors, className },
  ref,
) {
  const known = card.relationship !== null;
  const title = card.relationship ?? "初次見面";
  // What she wrote as she issued it; older cards carry the line her reflection wrote instead.
  const feeling = card.line ?? card.public_feeling ?? (known ? null : "她還不認識你");
  const lines = feeling ? wrap(`「${feeling}」`, 26, 3) : [];
  const fields = (card.fields ?? []).slice(0, 3);
  // Her fields sit under the quote and end above the footer; what is above moves up to make room.
  const quoteBlock = lines.length > 0 ? (lines.length - 1) * QUOTE_STEP + 34 : 0;
  const lift =
    fields.length === 0
      ? 0
      : Math.max(0, quoteBlock + (fields.length - 1) * FIELD_STEP - (FIELDS_END - QUOTE_Y));
  const fieldsTop = QUOTE_Y - lift + quoteBlock;
  const titleY = (known && card.call_name ? 566 : 590) - lift;
  const initial = [...card.name.trim()][0] ?? "?";
  const id = card.serial.replace(/[^A-Z0-9]/gi, "");
  const label = [
    `${card.name} 的卡,${title}`,
    card.call_name ? `她叫你${card.call_name}` : null,
    card.stamp ? `蓋了「${card.stamp}」` : null,
    feeling ? `她說「${feeling}」` : null,
    ...fields.map((f) => `${f.label}:${f.text}`),
    `編號 ${card.serial}`,
  ]
    .filter((s): s is string => s !== null)
    .join(",");
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
          <rect width={W} height={H} rx={26} />
        </clipPath>
        <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#1a1f36" />
          <stop offset="1" stopColor="#0b0d14" />
        </linearGradient>
        <linearGradient id={`fade-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={INK} stopOpacity="0" />
          <stop offset="0.5" stopColor={INK} stopOpacity="0.7" />
          <stop offset="0.85" stopColor={INK} stopOpacity="0.97" />
          <stop offset="1" stopColor={INK} stopOpacity="1" />
        </linearGradient>
        <radialGradient id={`glow-a-${id}`}>
          <stop offset="0" stopColor={colors.secondary} stopOpacity="0.45" />
          <stop offset="1" stopColor={colors.secondary} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`glow-b-${id}`}>
          <stop offset="0" stopColor={colors.primary} stopOpacity="0.28" />
          <stop offset="1" stopColor={colors.primary} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`foil-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={colors.primary} />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.7" />
          <stop offset="1" stopColor={colors.secondary} />
        </linearGradient>
        <linearGradient id={`sheen-${id}`} x1="0" y1="0" x2="1" y2="0.6">
          <stop offset="0.3" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0.09" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={`avatar-${id}`}>
          <circle cx={PAD + 18} cy={820} r={18} />
        </clipPath>
      </defs>
      <g clipPath={`url(#clip-${id})`}>
        <rect width={W} height={H} fill={`url(#bg-${id})`} />
        <circle cx={W * 0.8} cy={170} r={330} fill={`url(#glow-a-${id})`} />
        <circle cx={W * 0.1} cy={440} r={300} fill={`url(#glow-b-${id})`} />
        {art && <image href={art} x={-15} y={-6} width={W + 30} height={(W + 30) * (4 / 3)} preserveAspectRatio="xMidYMin slice" />}
        <rect y={340 - lift} width={W} height={270} fill={`url(#fade-${id})`} />
        <rect y={609 - lift} width={W} height={H - 609 + lift} fill={INK} />
        <rect width={W} height={H} fill={`url(#sheen-${id})`} />

        <text x={PAD} y={56} fontSize={15} fontWeight={600} letterSpacing={5} fill="#ffffff" opacity={0.9}>
          MIYORIA
        </text>
        <text x={W - PAD} y={56} fontSize={15} fontFamily={MONO} textAnchor="end" fill="#ffffff" opacity={0.85}>
          No.{String(card.number).padStart(3, "0")}
        </text>

        <text x={PAD} y={titleY} fontSize={46} fontWeight={700} fill="#ffffff" letterSpacing={1}>
          {title}
        </text>
        {known && card.call_name && (
          <text x={PAD} y={600 - lift} fontSize={18} fill="rgba(255,255,255,0.72)">
            她叫你 <tspan fill="#ffffff" fontWeight={600}>{card.call_name}</tspan>
          </text>
        )}
        {card.stamp && <Stamp text={card.stamp} x={W - PAD} y={titleY - 16} primary={colors.primary} />}

        <g transform={`translate(0 ${-lift})`}>
          <BandColumn x={PAD} label="好感" value={card.affinity} scale={AFFINITY} primary={colors.primary} />
          <BandColumn x={PAD + 194} label="信任" value={card.trust} scale={TRUST} primary={colors.primary} />
          <BandColumn x={PAD + 388} label="熟悉" value={card.familiarity} scale={FAMILIARITY} primary={colors.primary} />
        </g>

        {lines.map((l, i) => (
          <text key={i} x={PAD} y={QUOTE_Y - lift + i * QUOTE_STEP} fontSize={16} fill="rgba(255,255,255,0.86)">
            {l}
          </text>
        ))}
        {fields.map((f, i) => (
          <text key={i} x={PAD} y={fieldsTop + i * FIELD_STEP} fontSize={15}>
            <tspan fill="rgba(255,255,255,0.6)" fontSize={13}>
              {wrap(f.label, 6, 1)[0]}
            </tspan>
            <tspan x={PAD + 84} fill="#f1f0f4">
              {wrap(f.text, 24, 1)[0]}
            </tspan>
          </text>
        ))}

        {avatar ? (
          <image href={avatar} x={PAD} y={802} width={36} height={36} clipPath={`url(#avatar-${id})`} preserveAspectRatio="xMidYMid slice" />
        ) : (
          <g>
            <circle cx={PAD + 18} cy={820} r={18} fill="rgba(255,255,255,0.14)" />
            <text x={PAD + 18} y={826} fontSize={16} fontWeight={600} textAnchor="middle" fill="#ffffff">
              {initial}
            </text>
          </g>
        )}
        <text x={PAD + 48} y={816} fontSize={15} fontWeight={600} fill="#ffffff">
          {wrap(card.name, 16, 1)[0]}
        </text>
        <text x={PAD + 48} y={836} fontSize={12} fontFamily={MONO} fill="rgba(255,255,255,0.6)">
          {issuedDate(card.issued_at)} · {card.serial}
        </text>

        <rect x={W - PAD - 104} y={742} width={104} height={104} rx={10} fill="#ffffff" />
        <Qr text={verifyUrl(card.serial)} x={W - PAD - 96} y={750} size={88} />
      </g>
      <Frame frame={card.frame} id={id} />
    </svg>
  );
});

/** The card as a PNG, twice its size: what is downloaded and shared. */
export async function cardPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
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

export const cardFileName = (card: IssuedCard) => `miyoria-card-${card.serial}.png`;
