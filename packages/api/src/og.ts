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
import {
  CARD_IMAGE_WIDTH,
  cardMeta,
  injectMeta,
  OG_HEIGHT,
  OG_WIDTH,
  originOf,
  pageMeta,
} from "./meta.js";
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

/** The SVG as a PNG of the given width, on a background, or clear when it is null. */
async function toPng(svg: string, width: number, background: string | null): Promise<Buffer> {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    ...(background === null ? {} : { background }),
    font: { loadSystemFonts: true, defaultFontFamily: FONT_FAMILY },
  });
  return resvg.render().asPng();
}
// The site's picture borrows the panel's glass (`apps/panel/DESIGN.md`, `.glass-dock` and
// `.glass-float`): the owner's backdrop picture dimmed to `brightness(.66)`, and translucent plates
// over it with a hairline edge and a lit top lip. resvg has no `backdrop-filter`, so the blur is
// made here: the backdrop is blurred once for the whole picture and more for the part a plate
// covers, which is cut out to the plate's shape. A card's picture is the card and nothing else.

const BASE = "#0b0d12";
const TEXT = "#f1f0f4";
const MUTED = "#dedce4";

/** The panel's 暮色 gradient, for a machine without the owner's picture. */
const DUSK = `<defs><linearGradient id="og-dusk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1b1b33"/><stop offset="0.55" stop-color="#2a2140"/><stop offset="1" stop-color="#3a2438"/></linearGradient></defs>
<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="url(#og-dusk)"/>`;

/** The owner's backdrop as a data URL at the picture's size, blurred by `sigma`; `null` without it. */
async function backdropArt(dir: string | null, sigma: number): Promise<string | null> {
  if (dir === null) return null;
  try {
    const file = await readFile(join(dir, "background.local.jpg"));
    const jpeg = await sharp(file)
      .resize(OG_WIDTH, OG_HEIGHT, { fit: "cover", position: "centre" })
      .blur(sigma)
      .modulate({ brightness: 0.66, saturation: 1.15 })
      .jpeg({ quality: 88 })
      .toBuffer();
    return toDataUrl("image/jpeg", jpeg);
  } catch {
    return null;
  }
}

/** A frosted plate: the more blurred backdrop cut to the plate, a wash, a hairline and a lit lip. */
function plate(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  frost: string | null,
): string {
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>
<linearGradient id="${id}-lip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/><stop offset="0.12" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
<linearGradient id="${id}-wash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14151f" stop-opacity="0.34"/><stop offset="1" stop-color="#090a10" stop-opacity="0.5"/></linearGradient></defs>
<g clip-path="url(#${id})">
${frost ? `<image href="${frost}" width="${OG_WIDTH}" height="${OG_HEIGHT}"/>` : ""}
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id}-wash)"/>
<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id}-lip)"/>
</g>
<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.2"/>`;
}

/**
 * The card as the whole picture, at its own 630×880 ratio and clear around its rounded corners.
 * `og:image:width` and `height` say the same size (`CARD_IMAGE_WIDTH`, `CARD_IMAGE_HEIGHT`).
 */
export async function renderCardImage(card: IssuedCard, panelDir: string | null): Promise<Buffer> {
  const [art, avatar] = await Promise.all([
    poseArt(panelDir, card.pose),
    avatarArt(card.avatar_url),
  ]);
  const svg = renderCardSvg({
    card,
    art,
    avatar,
    colors: COLORS,
    verifyUrl: `https://miyoria.invalid/card/${card.serial}`,
  });
  return toPng(svg, CARD_IMAGE_WIDTH, null);
}

/** The site's own picture: her name and a line on a frosted plate, her picture on another. */
export async function renderDefaultImage(panelDir: string | null): Promise<Buffer> {
  const [art, back, frost] = await Promise.all([
    poseArt(panelDir, "calm"),
    backdropArt(panelDir, 14),
    backdropArt(panelDir, 36),
  ]);
  const px = 64;
  const py = 64;
  const ph = OG_HEIGHT - py * 2;
  const leftW = 592;
  const artX = px + leftW + 32;
  const artW = OG_WIDTH - px - artX;
  const hero = art
    ? `<defs><clipPath id="og-hero"><rect x="${artX}" y="${py}" width="${artW}" height="${ph}" rx="22"/></clipPath></defs>
<g clip-path="url(#og-hero)"><image href="${art}" x="${artX}" y="${py}" width="${artW}" height="${ph}" preserveAspectRatio="xMidYMin slice"/></g>
<rect x="${artX + 0.5}" y="${py + 0.5}" width="${artW - 1}" height="${ph - 1}" rx="22" fill="none" stroke="#ffffff" stroke-opacity="0.2"/>`
    : "";
  const body = `${back ? `<image href="${back}" width="${OG_WIDTH}" height="${OG_HEIGHT}"/>` : DUSK}
${plate("og-plate", px, py, leftW, ph, 22, frost)}
<g transform="translate(${px + 48} ${py + 48}) scale(2)" fill="none">
<path d="M15.5 3.5a8 8 0 1 0 5 14.2A6.5 6.5 0 0 1 15.5 3.5Z" fill="${COLORS.primary}" opacity="0.95"/>
<path d="M3 21h18" stroke="${COLORS.primary}" stroke-width="1.75" stroke-linecap="round" opacity="0.6"/>
</g>
<text x="${px + 48}" y="${py + ph - 150}" font-size="92" font-weight="700" fill="${TEXT}">Miyoria</text>
<text x="${px + 48}" y="${py + ph - 86}" font-size="30" fill="${MUTED}">住在 Discord 和直播裡的 AI VTuber</text>
${hero}`;
  return toPng(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}" font-family="${FONT_FAMILY}, sans-serif">
<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="${BASE}"/>
${body}
</svg>`,
    OG_WIDTH,
    BASE,
  );
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
