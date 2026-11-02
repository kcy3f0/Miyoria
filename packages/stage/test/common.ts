// A fake VTube Studio and a fake OBS.

import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import type { Obs, ObsConnector } from "../src/index.js";

export const WAIT_MS = 5_000;

export async function waitUntil(cond: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!cond()) {
    if (Date.now() >= deadline) throw new Error(`${what} not met`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fresh directory under the system temp dir. */
export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "miyoria-stage-"));
}

// biome-ignore lint/suspicious/noExplicitAny: test JSON
export type Json = any;

export interface VtsState {
  /** Every request received, in order. */
  requests: Json[];
  /** The token `AuthenticationRequest` accepts. */
  validToken: string | null;
  tokensIssued: number;
  /** Answer `AuthenticationTokenRequest` with "user denied". */
  deny: boolean;
  /** Custom parameters created with `ParameterCreationRequest`. */
  custom: string[];
}

const DEFAULT_PARAMS = [
  "MouthOpen",
  "MouthSmile",
  "FaceAngleX",
  "FaceAngleY",
  "FaceAngleZ",
  "EyeLeftX",
  "EyeLeftY",
  "EyeRightX",
  "EyeRightY",
];

function respond(st: VtsState, req: Json): Json {
  st.requests.push(req);
  const kind: string = req.messageType ?? "";
  const data = req.data ?? {};
  let messageType = `${kind.replace(/Request$/, "")}Response`;
  let out: Json;
  switch (kind) {
    case "AuthenticationTokenRequest":
      if (st.deny) {
        messageType = "APIError";
        out = { errorID: 50, message: "User has denied API access for your plugin." };
      } else {
        st.tokensIssued += 1;
        st.validToken = `tok-${st.tokensIssued}`;
        out = { authenticationToken: st.validToken };
      }
      break;
    case "AuthenticationRequest": {
      const good = st.validToken === data.authenticationToken && data.pluginName === "Miyoria";
      out = { authenticated: good, reason: good ? "Token valid." : "Token invalid." };
      break;
    }
    case "CurrentModelRequest":
      out = { modelLoaded: true, modelName: "DeepSeek-chan", modelID: "m1" };
      break;
    case "HotkeysInCurrentModelRequest":
      out = {
        modelLoaded: true,
        availableHotkeys: [
          { name: "Wave", type: "TriggerAnimation", hotkeyID: "hk-wave" },
          { name: "Clear", type: "RemoveAllExpressions", hotkeyID: "hk-clear" },
        ],
      };
      break;
    case "HotkeyTriggerRequest":
      out = { hotkeyID: data.hotkeyID };
      break;
    case "ExpressionStateRequest":
      out = {
        modelLoaded: true,
        expressions: [{ name: "happy", file: "happy.exp3.json", active: false }],
      };
      break;
    case "ExpressionActivationRequest":
    case "InjectParameterDataRequest":
      out = {};
      break;
    case "InputParameterListRequest":
      out = {
        defaultParameters: DEFAULT_PARAMS.map((name) => ({ name })),
        customParameters: ["MouthSmile", ...st.custom].map((name) => ({ name })),
      };
      break;
    case "ParameterCreationRequest":
      if (DEFAULT_PARAMS.includes(data.parameterName)) {
        messageType = "APIError";
        out = { errorID: 352, message: "default parameter" };
      } else {
        if (!st.custom.includes(data.parameterName)) st.custom.push(data.parameterName);
        out = { parameterName: data.parameterName };
      }
      break;
    default:
      messageType = "APIError";
      out = { errorID: 2, message: `unknown request ${kind}` };
  }
  return {
    apiName: "VTubeStudioPublicAPI",
    apiVersion: "1.0",
    timestamp: 0,
    requestID: req.requestID,
    messageType,
    data: out,
  };
}

/** Speaks the VTS Public API envelope on a local port. */
export class FakeVts {
  readonly state: VtsState = {
    requests: [],
    validToken: null,
    tokensIssued: 0,
    deny: false,
    custom: [],
  };

  private constructor(
    readonly wss: WebSocketServer,
    readonly port: number,
  ) {}

  static async start(): Promise<FakeVts> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const vts = new FakeVts(wss, (wss.address() as AddressInfo).port);
    wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        const req = JSON.parse(data.toString());
        ws.send(JSON.stringify(respond(vts.state, req)));
      });
    });
    return vts;
  }

  url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  requests(): Json[] {
    return [...this.state.requests];
  }

  types(): string[] {
    return this.requests()
      .map((r) => r.messageType as string)
      .filter((t) => t !== "InjectParameterDataRequest");
  }

  injections(): Json[] {
    return this.requests()
      .filter((r) => r.messageType === "InjectParameterDataRequest")
      .map((r) => r.data);
  }

  clear(): void {
    this.state.requests.length = 0;
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

export interface FakeObsState {
  scene: string;
  /** What `sceneList` answers. */
  scenes: string[];
  streaming: boolean;
  texts: [string, string][];
  calls: string[];
  connected: boolean;
  failConnect: boolean;
}

/** In-memory OBS. */
export class FakeObs implements Obs, ObsConnector {
  readonly state: FakeObsState;

  constructor(scene = "") {
    this.state = {
      scene,
      scenes: ["Talk", "Game"],
      streaming: false,
      texts: [],
      calls: [],
      connected: false,
      failConnect: false,
    };
  }

  async currentScene(): Promise<string> {
    return this.state.scene;
  }

  async sceneList(): Promise<string[]> {
    return [...this.state.scenes];
  }

  async setScene(name: string): Promise<void> {
    this.state.calls.push(`scene ${name}`);
    if (name === "Missing") throw new Error("No source was found by the name of `Missing`.");
    this.state.scene = name;
  }

  async streaming(): Promise<boolean> {
    return this.state.streaming;
  }

  async startStream(): Promise<void> {
    this.state.calls.push("start");
    this.state.streaming = true;
  }

  async stopStream(): Promise<void> {
    this.state.calls.push("stop");
    this.state.streaming = false;
  }

  async setText(source: string, text: string): Promise<void> {
    this.state.texts.push([source, text]);
  }

  async ensureTextSource(source: string): Promise<boolean> {
    this.state.calls.push(`ensure ${source}`);
    return true;
  }

  async connect(): Promise<Obs> {
    if (this.state.failConnect) throw new Error("connection refused");
    this.state.connected = true;
    return this;
  }
}
