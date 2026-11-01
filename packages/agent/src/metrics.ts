// Prometheus metrics of the agent (served by the `api` module at `GET /metrics`).

import { metrics } from "@miyoria/kernel";

/** `agent_decision`s by outcome (`responded` / `ignored`). */
export const agentTurns = metrics.counter("miyoria_agent_turns_total", {
  help: "Attention decisions of the agent; decision is responded or ignored.",
  labels: ["decision"],
});
