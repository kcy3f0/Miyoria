// The backdrop layer (`?layer=backdrop`): the stream's background under every other source. A
// still picture (`/overlay/backdrop`, the Stage's `overlay_backdrop`), blurred and dimmed so the
// video, her model and the overlay's plates stand out on it, like frosted glass. Without a
// picture, a dark gradient. The `sing` layout adds the glass bezel the song video sits in; its
// place is `--video-*` in style.css, and OBS puts the video at the same rectangle.
import type { Layout } from "./config.js";

/** Served by the Stage next to the overlay's files. */
export const BACKDROP_URL = "backdrop";

function div(className: string, parent: Element): HTMLElement {
  const e = document.createElement("div");
  e.className = className;
  parent.append(e);
  return e;
}

export function mountBackdrop(root: HTMLElement, layout: Layout): void {
  root.replaceChildren();
  const stage = div("backdrop", root);
  const art = document.createElement("img");
  art.className = "backdrop__art";
  art.alt = "";
  art.decoding = "async";
  // No picture configured (404) or a broken file: the gradient alone.
  art.addEventListener("error", () => art.remove(), { once: true });
  art.addEventListener("load", () => stage.classList.add("has-art"), { once: true });
  art.src = BACKDROP_URL;
  stage.append(art);
  div("backdrop__shade", stage);
  if (layout === "sing") div("bezel", stage);
}
