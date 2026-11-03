// The backdrop layer (`?layer=backdrop`): the stream's background under every other source. A
// still picture (`/overlay/backdrop`, the Stage's `overlay_backdrop`) under a neutral tint, so the
// video, her model and the overlay's glass plates stand out on it. Without a picture, near-black.
// The `sing` layout adds the song video's screen: grey-black glass between songs, and a 1px edge and
// soft shadow around the video. Its place is `--video-*` in style.css; OBS puts the video there.
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
  if (layout === "sing") div("screen", stage);
}
