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
  const feeling = card.public_feeling ?? (known ? null : "她還不認識你");
  const lines = feeling ? wrap(`「${feeling}」`, 26, 3) : [];
  const initial = [...card.name.trim()][0] ?? "?";
  const id = card.serial.replace(/[^A-Z0-9]/gi, "");
  const label = `${card.name} 的卡,${title}${card.call_name ? `,她叫你${card.call_name}` : ""},編號 ${card.serial}`;
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
        <rect y={340} width={W} height={270} fill={`url(#fade-${id})`} />
        <rect y={609} width={W} height={H - 609} fill={INK} />
        <rect width={W} height={H} fill={`url(#sheen-${id})`} />

        <text x={PAD} y={56} fontSize={15} fontWeight={600} letterSpacing={5} fill="#ffffff" opacity={0.9}>
          MIYORIA
        </text>
        <text x={W - PAD} y={56} fontSize={15} fontFamily={MONO} textAnchor="end" fill="#ffffff" opacity={0.85}>
          No.{String(card.number).padStart(3, "0")}
        </text>

        <text x={PAD} y={known && card.call_name ? 566 : 590} fontSize={46} fontWeight={700} fill="#ffffff" letterSpacing={1}>
          {title}
        </text>
        {known && card.call_name && (
          <text x={PAD} y={600} fontSize={18} fill="rgba(255,255,255,0.72)">
            她叫你 <tspan fill="#ffffff" fontWeight={600}>{card.call_name}</tspan>
          </text>
        )}

        <BandColumn x={PAD} label="好感" value={card.affinity} scale={AFFINITY} primary={colors.primary} />
        <BandColumn x={PAD + 194} label="信任" value={card.trust} scale={TRUST} primary={colors.primary} />
        <BandColumn x={PAD + 388} label="熟悉" value={card.familiarity} scale={FAMILIARITY} primary={colors.primary} />

        {lines.map((l, i) => (
          <text key={i} x={PAD} y={718 + i * 25} fontSize={16} fill="rgba(255,255,255,0.86)">
            {l}
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
      <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={25} fill="none" stroke={`url(#foil-${id})`} strokeWidth={3} />
      <rect x={10} y={10} width={W - 20} height={H - 20} rx={19} fill="none" stroke="#ffffff" strokeOpacity={0.12} />
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
