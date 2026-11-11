import type { ReactNode } from "react";

/**
 * The magazine's printed ornaments. Each is drawn once and printed twice: the aqua plate a little
 * off, the pink plate on top, laid with `screen` like the rest of the page.
 */
function Plates({ box, className, children }: { box: string; className?: string; children: ReactNode }) {
  return (
    <svg className={`mz-orn ${className ?? ""}`} viewBox={box} aria-hidden>
      <g className="mz-orn-a">{children}</g>
      <g className="mz-orn-p">{children}</g>
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
  // a speech bubble with three dots
  聊天: (
    <>
      <path d="M8 14 Q8 6 16 6 H48 Q56 6 56 14 V36 Q56 44 48 44 H28 L16 56 V44 Q8 44 8 36 Z" />
      <circle cx="22" cy="25" r="3.5" className="mz-orn-cut" />
      <circle cx="32" cy="25" r="3.5" className="mz-orn-cut" />
      <circle cx="42" cy="25" r="3.5" className="mz-orn-cut" />
    </>
  ),
  // headphones
  語音: (
    <path d="M10 38 V32 Q10 10 32 10 Q54 10 54 32 V38 H48 V32 Q48 16 32 16 Q16 16 16 32 V38 Z M8 38 H20 V56 H14 Q8 56 8 50 Z M44 38 H56 V50 Q56 56 50 56 H44 Z" />
  ),
  // two beamed notes
  唱歌: (
    <path d="M22 12 L54 6 V44 Q54 52 46 52 Q38 52 38 46 Q38 40 46 40 Q48 40 49 41 V18 L27 22 V50 Q27 58 19 58 Q11 58 11 52 Q11 46 19 46 Q21 46 22 47 Z" />
  ),
  // a camera with signal arcs
  直播: (
    <>
      <path d="M6 22 Q6 18 10 18 H40 Q44 18 44 22 V48 Q44 52 40 52 H10 Q6 52 6 48 Z M46 28 L58 20 V50 L46 42 Z" />
      <path d="M16 10 Q25 4 34 10" className="mz-orn-line" />
      <path d="M20 14 Q25 11 30 14" className="mz-orn-line" />
      <circle cx="16" cy="28" r="3" className="mz-orn-cut" />
    </>
  ),
  // a pickaxe
  遊戲: (
    <path d="M8 22 Q30 2 56 14 L54 18 Q40 12 34 16 L56 54 Q58 58 54 58 Q51 58 50 56 L28 20 Q20 22 12 28 Z" />
  ),
};

export function Icon({ name, className }: { name: string; className?: string }) {
  const art = ICONS[name];
  if (!art) return null;
  return (
    <Plates box="0 0 64 64" className={`mz-icon ${className ?? ""}`}>
      {art}
    </Plates>
  );
}

/** A whale, filled with a dot screen: she is a whale girl. */
export function Whale({ className }: { className?: string }) {
  return (
    <svg className={`mz-whale ${className ?? ""}`} viewBox="0 0 400 180" aria-hidden>
      <defs>
        <pattern id="mz-dots" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">
          <circle cx="3.5" cy="3.5" r="2.1" />
        </pattern>
      </defs>
      <path
        className="mz-whale-body"
        d="M20 96 Q34 40 120 34 Q210 28 268 66 Q296 84 318 88 Q338 62 372 52 Q362 80 352 96 Q366 112 384 132 Q348 126 324 112 Q300 128 262 138 Q170 160 96 148 Q30 138 20 96 Z"
      />
      <path className="mz-whale-line" d="M40 112 Q120 128 230 118" />
      <path className="mz-whale-line" d="M52 122 Q130 138 220 128" />
      <circle className="mz-whale-eye" cx="70" cy="86" r="5" />
      <path className="mz-whale-spout" d="M118 30 Q112 12 100 6 M118 30 Q120 10 128 2 M118 30 Q126 14 140 10" />
    </svg>
  );
}

/** A round rubber stamp, its words on the ring. */
export function Stamp({ ring, mid, className }: { ring: string; mid: string; className?: string }) {
  return (
    <svg className={`mz-stamp ${className ?? ""}`} viewBox="0 0 120 120" aria-hidden>
      <defs>
        <path id={`mz-ring-${mid}`} d="M60 60 m-42 0 a42 42 0 1 1 84 0 a42 42 0 1 1 -84 0" />
      </defs>
      <circle cx="60" cy="60" r="56" className="mz-stamp-edge" />
      <circle cx="60" cy="60" r="32" className="mz-stamp-edge" />
      <text className="mz-stamp-ring">
        <textPath href={`#mz-ring-${mid}`}>{ring}</textPath>
      </text>
      <text x="60" y="68" textAnchor="middle" className="mz-stamp-mid">
        {mid}
      </text>
    </svg>
  );
}

/** A starburst sticker with a word or two on it. */
export function Burst({ children, className }: { children: ReactNode; className?: string }) {
  const pts: string[] = [];
  for (let i = 0; i < 28; i++) {
    const r = i % 2 ? 44 : 58;
    const a = (i / 28) * Math.PI * 2;
    pts.push(`${(60 + Math.cos(a) * r).toFixed(1)},${(60 + Math.sin(a) * r).toFixed(1)}`);
  }
  return (
    <div className={`mz-burst ${className ?? ""}`} aria-hidden>
      <svg viewBox="0 0 120 120">
        <polygon points={pts.join(" ")} />
      </svg>
      <span>{children}</span>
    </div>
  );
}

/** Wavy rules, like a printer's border, between sections. */
export function Waves({ className }: { className?: string }) {
  let d = "M0 10";
  for (let x = 0; x < 1200; x += 40) d += ` q10 -8 20 0 t20 0`;
  return (
    <svg className={`mz-waves ${className ?? ""}`} viewBox="0 0 1200 20" preserveAspectRatio="none" aria-hidden>
      <path d={d} />
    </svg>
  );
}
