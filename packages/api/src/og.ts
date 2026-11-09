// Link previews: the picture a member card unfurls with (`GET /og/card/{serial}.png`), the site's
// own (`GET /og/default.png`), and the rewrite that puts each page's tags into the HTML.
//
// The card is the panel's own drawing (`@miyoria/card-face`) rendered to a PNG with resvg, so no
// browser is needed. Pictures come from the panel's folder (her poses) and Discord's CDN (their
// avatar), through sharp, which reads the formats resvg does not. A rendered image is kept per
// serial and version of the card's data, so a card that changes (a new frame, a voiding) is drawn
// again, and the page's tags carry that version in the image URL so a cache upstream lets go too.
//
// Only what the public card page already shows is drawn. A malformed, unknown, voided or
// unreadable serial gets the site's picture.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCardSvg } from "@miyoria/card-face/render";
import { errorMessage, getLogger } from "@miyoria/kernel";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { publicCard } from "./card.js";
import { cardMeta, injectMeta, OG_HEIGHT, OG_WIDTH, originOf, pageMeta } from "./meta.js";
import { clientKey, tooMany } from "./public.js";
import { param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";
import type { IssuedCard } from "./types.js";

const log = getLogger("api.og");

/** Bump to draw every cached image again after the layout changes. */
const RENDER_VERSION = "1";
const COLORS = { primary: "#f29dc4", secondary: "#7355e8" };
const CACHED_IMAGES = 64;
const AVATAR_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const MAX_AVATAR_BYTES = 2_000_000;
const PNG = "image/png";
const FONT_FAMILY = "Microsoft JhengHei";

/** What a card's picture depends on: its data and this layout. */
export function cardVersion(card: IssuedCard): string {
  return createHash("sha1")
    .update(RENDER_VERSION)
    .update(JSON.stringify(card))
    .digest("hex")
    .slice(0, 10);
}

/** Where a card's preview picture is, with the version that busts caches when the card changes. */
export function cardImagePath(card: IssuedCard): string {
  return `/og/card/${encodeURIComponent(card.serial)}.png?v=${cardVersion(card)}`;
}

// ---- pictures -------------------------------------------------------------------------------

const toDataUrl = (type: string, bytes: Uint8Array): string =>
  `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;

const arts = new Map<string, string | null>();

/** Her picture on a card, as a data URL; `null` without the panel folder or the file. */
async function poseArt(dir: string | null, pose: string): Promise<string | null> {
  const name = pose.replace(/[^a-z0-9-]/g, "");
  if (dir === null || name === "") return null;
  const key = `${dir}\0${name}`;
  if (arts.has(key)) return arts.get(key) ?? null;
  let art: string | null = null;
  try {
    const file = await readFile(join(dir, `card-${name}.local.webp`));
    const jpeg = await sharp(file).resize({ width: 560 }).jpeg({ quality: 86 }).toBuffer();
    art = toDataUrl("image/jpeg", jpeg);
  } catch {
    // No renders on this machine: the card is drawn without her.
  }
  arts.set(key, art);
  return art;
}

/** Their avatar as a small PNG data URL; `null` when it is not Discord's or cannot be had. */
async function avatarArt(url: string | null): Promise<string | null> {
  if (url === null) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !AVATAR_HOSTS.has(u.hostname)) return null;
    const res = await fetch(u, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) return null;
    const png = await sharp(bytes).resize(72, 72, { fit: "cover" }).png().toBuffer();
    return toDataUrl(PNG, png);
  } catch (error) {
    log.debug({ error: errorMessage(error) }, "cannot fetch an avatar for a preview");
    return null;
  }
}

// ---- drawing --------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Cuts `text` to about `em` ems (CJK one each, Latin about half), with an ellipsis. */
function clip(text: string, em: number): string {
  let width = 0;
  let out = "";
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    const w = (ch.codePointAt(0) ?? 0) < 0x250 ? 0.55 : 1;
    if (width + w > em) return `${out.slice(0, -1)}…`;
    out += ch;
    width += w;
  }
  return out;
}

async function toPng(svg: string): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OG_WIDTH },
    background: "#0b0d12",
    font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}

/** The backdrop both pictures share: the panel's dark with its two glows. */
const BACKDROP = `<defs>
<linearGradient id="og-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141829"/><stop offset="1" stop-color="#0b0d12"/></linearGradient>
<radialGradient id="og-a"><stop offset="0" stop-color="${COLORS.secondary}" stop-opacity="0.42"/><stop offset="1" stop-color="${COLORS.secondary}" stop-opacity="0"/></radialGradient>
<radialGradient id="og-b"><stop offset="0" stop-color="${COLORS.primary}" stop-opacity="0.26"/><stop offset="1" stop-color="${COLORS.primary}" stop-opacity="0"/></radialGradient>
<filter id="og-shadow" x="-20%" y="-10%" width="140%" height="130%"><feGaussianBlur stdDeviation="18"/></filter>
</defs>
<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#og-bg)"/>
<circle cx="1010" cy="120" r="470" fill="url(#og-a)"/>
<circle cx="120" cy="560" r="420" fill="url(#og-b)"/>`;

/** `1200×630`: the card on the left at its own ratio, what the page says about it on the right. */
export async function renderCardImage(card: IssuedCard, panelDir: string | null): Promise<Buffer> {
  const [art, avatar] = await Promise.all([
    poseArt(panelDir, card.pose),
    avatarArt(card.avatar_url),
  ]);
  const inner = renderCardSvg({
    card,
    art,
    avatar,
    colors: COLORS,
    verifyUrl: `https://miyoria.invalid/card/${card.serial}`,
  });
  // The card keeps its 630×880: 30 px above and below leave 570, so it is 408 wide.
  const h = 570;
  const w = Math.round((h * 630) / 880);
  const x = 96;
  const y = 30;
  const title = card.relationship ?? "初次見面";
  const no = `No.${String(card.number).padStart(3, "0")}`;
  const tx = x + w + 80;
  const body = inner.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" font-family="${FONT_FAMILY}, sans-serif">
${BACKDROP}
<rect x="${x + 6}" y="${y + 22}" width="${w}" height="${h}" rx="17" fill="#000000" opacity="0.6" filter="url(#og-shadow)"/>
<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 630 880" font-family="${FONT_FAMILY}, sans-serif">${body}</svg>
<text x="${tx}" y="150" font-size="22" font-weight="600" letter-spacing="9" fill="#ffffff" opacity="0.85">MIYORIA</text>
<text x="${tx}" y="250" font-size="64" font-weight="700" fill="#ffffff">${esc(clip(card.name, 11))}</text>
<text x="${tx}" y="322" font-size="40" font-weight="600" fill="${COLORS.primary}">${esc(title)}</text>
<text x="${tx}" y="400" font-size="26" fill="#ffffff" opacity="0.7">${esc(no)}${card.foil ? " · 閃卡" : ""}</text>
<text x="${tx}" y="440" font-size="22" fill="#ffffff" opacity="0.5" font-family="Consolas, monospace">${esc(card.serial)}</text>
</svg>`;
  return toPng(svg);
}

/** The site's own picture: her wordmark and the dark of the panel, with her calm picture if the folder has it. */
export async function renderDefaultImage(panelDir: string | null): Promise<Buffer> {
  const art = await poseArt(panelDir, "calm");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" font-family="${FONT_FAMILY}, sans-serif">
${BACKDROP}
${
  art
    ? `<image href="${art}" x="660" y="-20" width="520" height="693" preserveAspectRatio="xMidYMin slice"/>
<defs><linearGradient id="og-l" x1="0" x2="1"><stop offset="0" stop-color="#0b0d12"/><stop offset="1" stop-color="#0b0d12" stop-opacity="0"/></linearGradient><linearGradient id="og-r" x1="1" x2="0"><stop offset="0" stop-color="#0b0d12"/><stop offset="1" stop-color="#0b0d12" stop-opacity="0"/></linearGradient></defs>
<rect x="640" width="200" height="${OG_HEIGHT}" fill="url(#og-l)"/><rect x="1000" width="200" height="${OG_HEIGHT}" fill="url(#og-r)"/>`
    : ""
}
<text x="96" y="250" font-size="30" font-weight="600" letter-spacing="12" fill="#ffffff" opacity="0.7">AI VTUBER</text>
<text x="92" y="380" font-size="124" font-weight="700" fill="#ffffff" letter-spacing="2">Miyoria</text>
<text x="96" y="452" font-size="32" fill="${COLORS.primary}">住在 Discord 和直播裡的她</text>
</svg>`;
  return toPng(svg);
}

// ---- cache ----------------------------------------------------------------------------------

/** Renders kept by serial and version; the least recently used go first. */
class ImageCache {
  readonly #items = new Map<string, Buffer>();

  get(key: string): Buffer | undefined {
    const hit = this.#items.get(key);
    if (hit) {
      this.#items.delete(key);
      this.#items.set(key, hit);
    }
    return hit;
  }

  set(key: string, png: Buffer): void {
    this.#items.delete(key);
    this.#items.set(key, png);
    while (this.#items.size > CACHED_IMAGES) {
      const oldest = this.#items.keys().next().value;
      if (oldest === undefined) break;
      this.#items.delete(oldest);
    }
  }
}

const caches = new WeakMap<ApiState, ImageCache>();
function cacheOf(state: ApiState): ImageCache {
  let cache = caches.get(state);
  if (!cache) {
    cache = new ImageCache();
    caches.set(state, cache);
  }
  return cache;
}

/** Draws one image at a time: a crawler asking for many must not take the CPU the stage needs. */
const drawing = new WeakMap<ApiState, Promise<unknown>>();
function oneAtATime<T>(state: ApiState, run: () => Promise<T>): Promise<T> {
  const before = drawing.get(state) ?? Promise.resolve();
  const next = before.then(run, run);
  drawing.set(
    state,
    next.catch(() => undefined),
  );
  return next;
}

const SITE_CACHE = "public, max-age=3600";
const SHORT_CACHE = "public, max-age=300";
const VERSIONED_CACHE = "public, max-age=86400, immutable";

function image(png: Buffer, cacheControl: string): Response {
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: {
      "content-type": PNG,
      "content-length": String(png.length),
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
}

async function defaultImage(state: ApiState, cacheControl = SITE_CACHE): Promise<Response> {
  const cache = cacheOf(state);
  const key = `default:${RENDER_VERSION}`;
  let png = cache.get(key);
  if (!png) {
    png = await oneAtATime(state, () => renderDefaultImage(state.panelDir));
    cache.set(key, png);
  }
  return image(png, cacheControl);
}

async function cardImage(state: ApiState, c: ApiContext): Promise<Response> {
  const file = param(c, "file");
  const serial = file.endsWith(".png") ? file.slice(0, -4) : "";
  const card = await publicCard(state, serial);
  if (card === null) return defaultImage(state, SHORT_CACHE);
  const version = cardVersion(card);
  const cache = cacheOf(state);
  const key = `${card.serial}:${version}`;
  let png = cache.get(key);
  if (!png) {
    const wait = state.publicSide.admitCardCheck(clientKey(c));
    if (wait !== null) return tooMany(wait);
    try {
      png = await oneAtATime(state, () => renderCardImage(card, state.panelDir));
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot draw a card preview");
      return defaultImage(state, "no-store");
    }
    cache.set(key, png);
  }
  const asked = new URL(c.req.url).searchParams.get("v");
  return image(png, asked === version ? VERSIONED_CACHE : SHORT_CACHE);
}

/** `GET /og/default.png` and `GET /og/card/{serial}.png`: open to anyone, like the page they preview. */
export function ogRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    { method: "GET", path: "/og/default.png", public: true, handler: () => defaultImage(state) },
    { method: "GET", path: "/og/card/:file", public: true, handler: (c) => cardImage(state, c) },
  ];
}

// ---- the HTML -------------------------------------------------------------------------------

/** The serial in a `/card/<serial>` page path, or `null`. */
function cardSerialIn(path: string): string | null {
  const m = /^\/card\/([^/?#]+)\/?$/.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? "");
  } catch {
    return null;
  }
}

/** The panel's `index.html` for `request`, with the tags of the page it asks for. */
export async function rewriteHtml(
  state: ApiState,
  html: string,
  request: Request,
): Promise<string> {
  const path = new URL(request.url).pathname;
  const origin = originOf(request);
  const serial = cardSerialIn(path);
  if (serial !== null && state.publicSide.config.enabled) {
    const card = await publicCard(state, serial);
    if (card) return injectMeta(html, cardMeta(card, origin, `${origin}${cardImagePath(card)}`));
  }
  return injectMeta(html, pageMeta(path, origin));
}
