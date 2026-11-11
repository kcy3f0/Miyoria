import { type RefObject, useEffect, useRef } from "react";

/** Mask pixels per CSS pixel: the fog is soft, so a quarter is plenty and keeps the PNG small. */
const SCALE = 0.25;
/** How much fog grows back each frame (alpha of a black fill over the mask). */
const REFOG = 0.009;
/** Stop drawing once nobody has wiped for this long and the glass has fogged over again. */
const SETTLE_MS = 9000;

export interface Writing {
  text: string;
  /** Where the writing starts, as fractions of the glass. */
  x: number;
  y: number;
  /** Cap size as a fraction of the glass height. */
  size: number;
}

/**
 * Condensation on the tank's acrylic. The fog is a `backdrop-filter` layer whose mask is a small
 * canvas: opaque where the glass is fogged, cleared where a finger or the cursor wiped it. What was
 * written into the fog before anyone came (a word and one swipe across her face) stays until the
 * first wipe; after that every cleared spot slowly fogs over again.
 */
export function FogGlass({
  surface,
  writing,
  swipe,
  className,
}: {
  /** The element whose pointer movement wipes the glass (the whole tank, not just the fog). */
  surface: RefObject<HTMLElement | null>;
  writing: Writing;
  /** A cleared streak already on the glass: centre and radii as fractions of the glass. */
  swipe: { x: number; y: number; rx: number; ry: number };
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const area = surface.current;
    if (!el || !area) return;
    const mask = document.createElement("canvas");
    const ctx = mask.getContext("2d");
    if (!ctx) return;

    let touched = false;
    let lastWipe = -Infinity;
    let raf = 0;
    let last: { x: number; y: number } | null = null;

    const paintWriting = () => {
      const { width: w, height: h } = mask;
      ctx.save();
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "#000";
      ctx.strokeStyle = "#000";
      const size = writing.size * h;
      ctx.font = `400 ${size}px "LXGW WenKai TC", serif`;
      ctx.textBaseline = "alphabetic";
      ctx.filter = `blur(${Math.max(0.5, size * 0.018)}px)`;
      ctx.fillText(writing.text, writing.x * w, writing.y * h);
      ctx.filter = `blur(${Math.max(2, h * 0.02)}px)`;
      ctx.beginPath();
      ctx.ellipse(swipe.x * w, swipe.y * h, swipe.rx * w, swipe.ry * h, -0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    const apply = () => {
      el.style.maskImage = `url(${mask.toDataURL()})`;
      el.style.webkitMaskImage = el.style.maskImage;
    };

    const reset = () => {
      const w = Math.max(8, Math.round(el.clientWidth * SCALE));
      const h = Math.max(8, Math.round(el.clientHeight * SCALE));
      mask.width = w;
      mask.height = h;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      if (!touched) paintWriting();
      apply();
    };

    const frame = (ms: number) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgba(0,0,0,${REFOG})`;
      ctx.fillRect(0, 0, mask.width, mask.height);
      apply();
      if (ms - lastWipe < SETTLE_MS) raf = requestAnimationFrame(frame);
      else raf = 0;
    };

    const wipeTo = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      const x = (cx - r.left) * SCALE;
      const y = (cy - r.top) * SCALE;
      const radius = Math.max(10, Math.min(mask.width, mask.height) * 0.09);
      const from = last ?? { x, y };
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (radius * 0.35)));
      ctx.globalCompositeOperation = "destination-out";
      for (let i = 1; i <= steps; i++) {
        const px = from.x + ((x - from.x) * i) / steps;
        const py = from.y + ((y - from.y) * i) / steps;
        const g = ctx.createRadialGradient(px, py, 0, px, py, radius);
        g.addColorStop(0, "rgba(0,0,0,0.55)");
        g.addColorStop(0.6, "rgba(0,0,0,0.25)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(px - radius, py - radius, radius * 2, radius * 2);
      }
      last = { x, y };
      touched = true;
      lastWipe = performance.now();
      if (!raf) raf = requestAnimationFrame(frame);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" && e.buttons === 0) return;
      wipeTo(e.clientX, e.clientY);
    };
    const onDown = (e: PointerEvent) => {
      last = null;
      wipeTo(e.clientX, e.clientY);
    };
    const onLeave = () => {
      last = null;
    };

    reset();
    void document.fonts?.load(`400 32px "LXGW WenKai TC"`, writing.text).then(() => {
      if (!touched) reset();
    });
    const ro = new ResizeObserver(reset);
    ro.observe(el);
    area.addEventListener("pointermove", onMove);
    area.addEventListener("pointerdown", onDown);
    area.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      area.removeEventListener("pointermove", onMove);
      area.removeEventListener("pointerdown", onDown);
      area.removeEventListener("pointerleave", onLeave);
    };
  }, [surface, writing, swipe]);

  return <div ref={ref} className={className} aria-hidden />;
}
