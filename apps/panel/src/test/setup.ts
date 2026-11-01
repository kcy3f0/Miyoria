import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup } from "@testing-library/react";
import { afterEach, expect } from "vitest";

// Registered on this package's own Vitest: `@testing-library/jest-dom/vitest` would import
// whichever `vitest` pnpm hoists in the workspace, which is not the one running these tests.
expect.extend(matchers);

// jsdom has <dialog> but not its modal methods.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}

// jsdom does not implement scrolling; the router's scroll restoration calls it.
window.scrollTo = (() => {}) as typeof window.scrollTo;

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
