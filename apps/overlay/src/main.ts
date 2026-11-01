import "./style.css";
import { parseConfig } from "./config.js";
import { connectFeed } from "./connection.js";
import { startDemo } from "./demo.js";
import { Overlay } from "./view.js";

const cfg = parseConfig(window.location.search, window.location);
document.documentElement.style.setProperty("--scale", String(cfg.scale));

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing");
const overlay = new Overlay(root, cfg);

if (cfg.demo) {
  overlay.dispatch({ type: "connection", connected: true });
  startDemo((m) => overlay.dispatch(m));
} else {
  connectFeed({
    url: cfg.ws,
    onMessage: (m) => overlay.dispatch(m),
    onConnection: (connected) => overlay.dispatch({ type: "connection", connected }),
  });
}

const tick = (now: number): void => {
  overlay.frame(now);
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
