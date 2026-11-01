// Miyoria self-account voice node. Entry point.
//
//   SELF_TOKEN / VOICE_LINK_URL / VOICE_LINK_TOKEN / LOG_LEVEL   (env or .env)
import { ConfigError, loadConfig, type Config } from "./config.js";
import { loginSelf } from "./discord.js";
import { LevelsClient } from "./levels/client.js";
import { LevelPublisher } from "./levels/publisher.js";
import { CoreLink } from "./link.js";
import { createLogger, setLogLevel } from "./log.js";
import { VoiceNode } from "./node.js";

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  const log = createLogger("main");

  let client;
  try {
    client = await loginSelf(cfg.selfToken, createLogger("discord"));
  } catch (err) {
    log.error("Discord login failed (is SELF_TOKEN valid?):", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  const link = new CoreLink({
    url: cfg.voiceLinkUrl,
    token: cfg.voiceLinkToken,
    selfAccountId: client.user.id,
    log: createLogger("link"),
  });
  let levelsClient: LevelsClient | undefined;
  let levels: LevelPublisher | undefined;
  if (cfg.stageLevelsUrl) {
    levelsClient = new LevelsClient({ url: cfg.stageLevelsUrl, log: createLogger("levels") });
    levels = new LevelPublisher({ sink: levelsClient, gain: cfg.stageLevelsGain });
  }
  const node = new VoiceNode(client, link, cfg, createLogger("node"), levels ? { levels } : {});

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down...");
    const force = setTimeout(() => {
      log.warn("shutdown timed out, forcing exit");
      process.exit(code);
    }, 8000);
    force.unref();
    try {
      await node.shutdown(); // leave voice (and tell Core)
      await link.stop(); // close the socket
      levelsClient?.stop();
      client.destroy();
    } catch (err) {
      log.warn("error during shutdown:", err);
    }
    process.exit(code);
  };

  process.on("SIGINT", () => {
    if (shuttingDown) process.exit(130); // second Ctrl+C: don't wait
    void shutdown(0);
  });
  process.on("SIGTERM", () => void shutdown(0));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception:", err);
    void shutdown(1);
  });

  client.on("error", (err) => log.warn("discord client error:", err.message));
  client.on("invalidated", () => {
    log.error("Discord session was invalidated (token revoked or account logged out)");
    void shutdown(1);
  });
  link.on("fatal", (err) => {
    log.error(`Core link fatal: ${err.message}`);
    void shutdown(1);
  });

  node.start();
  link.start();
  levelsClient?.start();
  log.info("voice node running; Ctrl+C to stop");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
