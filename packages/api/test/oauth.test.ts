// Discord OAuth login for the panel against a fake Discord: the full login → callback → cookie →
// session flow, PKCE, state handling, open redirects, CSRF, write permission, logout, expiry,
// revocation and session persistence (`tests/oauth.rs`).

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { AuthService, AuthServiceKey } from "@miyoria/auth";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { type AuditEntry, AuditLogKey, AuthStoreKey, SettingsStoreKey } from "@miyoria/store";
import { type AccountRef, AuthorizerKey, type JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule } from "../src/index.js";
import { listenFetchable } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
const OWNER = "111";
const STRANGER = "222";
const VIEWER = "333";
const ADMIN = "444";
const REDIRECT = "http://panel.test/api/auth/oauth/callback";

/** Codes the fake Discord accepts: `code → [id, username, global_name]`. */
const USERS: Record<string, [string, string, string | null]> = {
  "owner-code": [OWNER, "owner", "Owner Name"],
  "stranger-code": [STRANGER, "stranger", null],
  "viewer-code": [VIEWER, "viewer", null],
  "admin-code": [ADMIN, "admin", null],
};

interface FakeDiscord {
  url: string;
  server: Server;
  /** Every form posted to the token endpoint. */
  tokenRequests: Array<Record<string, string>>;
}

async function startFake(): Promise<FakeDiscord> {
  const tokenRequests: Array<Record<string, string>> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/oauth2/token") {
        const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
        tokenRequests.push(form);
        const ok =
          form.grant_type === "authorization_code" &&
          form.client_id === "cid" &&
          form.client_secret === "secret" &&
          form.redirect_uri === REDIRECT &&
          (form.code_verifier ?? "") !== "" &&
          (form.code ?? "") in USERS;
        if (ok) {
          send(200, { access_token: `at-${form.code}`, token_type: "Bearer", expires_in: 604800 });
        } else {
          send(400, { error: "invalid_grant" });
        }
        return;
      }
      if (req.method === "GET" && req.url === "/api/users/@me") {
        const code = (req.headers.authorization ?? "").replace(/^Bearer at-/, "");
        const user = USERS[code];
        if (!user) {
          send(401, { message: "401: Unauthorized" });
          return;
        }
        const [id, username, globalName] = user;
        send(200, {
          id,
          username,
          global_name: globalName,
          avatar: id === OWNER ? "abc123" : null,
        });
        return;
      }
      send(404, { message: "404: Not Found" });
    });
  });
  const port = await listenFetchable(server);
  return { url: `http://127.0.0.1:${port}`, server, tokenRequests };
}

function discord(id: string): AccountRef {
  return { platform: "discord", id };
}

interface Callback {
  location: string;
  cookie: string | null;
  setCookie: string | null;
}

class Harness {
  constructor(
    readonly sup: Supervisor,
    readonly api: ApiModule,
    readonly store: TestStore,
    readonly auth: AuthService,
    readonly fake: FakeDiscord,
  ) {}

  base(): string {
    const url = this.api.url();
    if (!url) throw new Error("api is not running");
    return url;
  }

  /** `GET /api/auth/oauth/login`; returns the Discord authorize URL. */
  async startLogin(next?: string): Promise<URL> {
    const url = new URL(`${this.base()}/api/auth/oauth/login`);
    if (next !== undefined) url.searchParams.append("next", next);
    const response = await fetch(url, { redirect: "manual" });
    await response.arrayBuffer();
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location") ?? "");
  }

  async callback(query: Array<[string, string]>): Promise<Callback> {
    const url = new URL(`${this.base()}/api/auth/oauth/callback`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    const response = await fetch(url, { redirect: "manual" });
    await response.arrayBuffer();
    expect(response.status).toBe(302);
    const setCookie = response.headers.get("set-cookie");
    let cookie: string | null = null;
    if (setCookie !== null) {
      const first = setCookie.split(";")[0] ?? "";
      expect(first.startsWith("miyoria_session="), "the session cookie").toBe(true);
      cookie = first.slice("miyoria_session=".length);
    }
    return { location: response.headers.get("location") ?? "", cookie, setCookie };
  }

  /** Logs in as the user behind `code`, as a browser would. */
  async login(code: string, next?: string): Promise<Callback> {
    const authorize = await this.startLogin(next);
    return this.callback([
      ["code", code],
      ["state", param(authorize, "state")],
    ]);
  }

  async loginCookie(code: string): Promise<string> {
    const done = await this.login(code);
    if (done.cookie === null) throw new Error("not logged in");
    return done.cookie;
  }

  async withCookie(
    method: string,
    path: string,
    cookie: string,
    csrf: boolean,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      cookie: `theme=dark; miyoria_session=${cookie}`,
    };
    if (csrf) headers["X-Miyoria-Request"] = "1";
    const response = await fetch(`${this.base()}${path}`, { method, headers, redirect: "manual" });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  }

  auditBy(actor: string): Promise<AuditEntry[]> {
    return this.store.audit.recent(100, actor);
  }

  async persisted(): Promise<Array<[string, JsonValue]>> {
    return [...(await this.store.settings.list("_global", "panel_session:"))];
  }
}

function param(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) throw new Error(`no \`${name}\` in ${url.href}`);
  return value;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.sup.stopAll();
    await new Promise<void>((resolve) => h.fake.server.close(() => resolve()));
  }
});

async function harnessWith(withOauth: boolean): Promise<Harness> {
  const fake = await startFake();
  const sup = new Supervisor();
  const store = new TestStore();
  const s = sup.services;
  const k = "kernel";
  s.provide(k, SupervisorKey, sup);
  s.provide(k, ActiveProfileKey, "test-chan");
  s.provide(k, AuthStoreKey, store.auth);
  s.provide(k, AuditLogKey, store.audit);
  s.provide(k, SettingsStoreKey, store.settings);
  s.provide("queue", RequestQueueKey, new RequestQueue());
  const auth = await AuthService.load(store.auth, store.audit, [discord(OWNER)], "user");
  s.provide("auth", AuthServiceKey, auth);
  s.provide("auth", AuthorizerKey, auth);

  const config: Record<string, JsonValue> = {
    bind: "127.0.0.1:0",
    token: TOKEN,
    panel_dir: "",
  };
  if (withOauth) {
    config.discord_oauth = {
      client_id: "cid",
      client_secret: "secret",
      redirect_uri: REDIRECT,
      recheck_secs: 0,
      discord_url: fake.url,
    };
  }
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, config, true);
  await sup.startAll();
  const h = new Harness(sup, api, store, auth, fake);
  harnesses.push(h);
  return h;
}

describe("oauth", () => {
  it("full_login_flow_with_pkce", async () => {
    const h = await harnessWith(true);
    const client = new ApiClient(h.base(), TOKEN);
    const methods = await client.authMethods();
    expect(methods.token && methods.discord).toBe(true);

    const authorize = await h.startLogin("/#/people");
    expect(authorize.href.split("?")[0]).toBe(`${h.fake.url}/oauth2/authorize`);
    expect(param(authorize, "response_type")).toBe("code");
    expect(param(authorize, "client_id")).toBe("cid");
    expect(param(authorize, "scope")).toBe("identify");
    expect(param(authorize, "redirect_uri")).toBe(REDIRECT);
    expect(param(authorize, "code_challenge_method")).toBe("S256");
    const challenge = param(authorize, "code_challenge");
    const state = param(authorize, "state");
    expect(state.length, "state has 256 bits").toBeGreaterThanOrEqual(43);

    const done = await h.callback([
      ["code", "owner-code"],
      ["state", state],
    ]);
    expect(done.location).toBe("/#/people");
    const setCookie = done.setCookie ?? "";
    for (const attr of ["HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=604800"]) {
      expect(setCookie, `${setCookie} lacks ${attr}`).toContain(attr);
    }
    expect(setCookie, "plain-http redirect_uri").not.toContain("Secure");
    const cookie = done.cookie ?? "";

    // The PKCE verifier went to the token endpoint and matches the challenge.
    const form = h.fake.tokenRequests[0] ?? {};
    const verifier = form.code_verifier ?? "";
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(form.code).toBe("owner-code");

    // The cookie authenticates, as the Discord user.
    let r = await h.withCookie("GET", "/api/auth/session", cookie, false);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      method: "discord",
      user: {
        id: OWNER,
        name: "Owner Name",
        avatar_url: "https://cdn.discordapp.com/avatars/111/abc123.png?size=64",
      },
      permissions: { write: true },
    });
    expect((await h.withCookie("GET", "/api/queue", cookie, false)).status).toBe(200);

    // Changes need the CSRF header, and are audited as the account.
    r = await h.withCookie("POST", "/api/queue/pause", cookie, false);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("x-miyoria-request");
    r = await h.withCookie("POST", "/api/queue/pause", cookie, true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const audit = await h.auditBy("discord:111");
    expect(audit.some((e) => e.action === "queue.pause")).toBe(true);
    expect(audit.some((e) => e.action === "panel.login" && e.ok)).toBe(true);

    // The bearer token keeps working, as `"api"`.
    const me = await client.session();
    expect(me.method).toBe("token");
    expect(me.user === null && me.permissions.write).toBe(true);
    await client.queuePause(false);
    expect((await h.auditBy("api")).some((e) => e.action === "queue.resume")).toBe(true);
    // A wrong bearer token is not rescued by a valid cookie.
    const response = await fetch(`${h.base()}/api/queue`, {
      headers: { authorization: "Bearer wrong", cookie: `miyoria_session=${cookie}` },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(401);
  });

  it("bad_state_cancel_exchange_failure_and_open_redirects", async () => {
    const h = await harnessWith(true);

    const bogus = await h.callback([
      ["code", "owner-code"],
      ["state", "bogus"],
    ]);
    expect(bogus.location).toBe("/#/login?error=state");
    expect(bogus.setCookie).toBeNull();
    const missing = await h.callback([["code", "owner-code"]]);
    expect(missing.location).toBe("/#/login?error=state");

    // A state works once.
    let authorize = await h.startLogin();
    let state = param(authorize, "state");
    const first = await h.callback([
      ["code", "owner-code"],
      ["state", state],
    ]);
    expect(first.location, "default next").toBe("/#/");
    expect(first.cookie).not.toBeNull();
    const replay = await h.callback([
      ["code", "owner-code"],
      ["state", state],
    ]);
    expect(replay.location).toBe("/#/login?error=state");

    // The user pressed Cancel on Discord.
    authorize = await h.startLogin();
    state = param(authorize, "state");
    const cancelled = await h.callback([
      ["error", "access_denied"],
      ["state", state],
    ]);
    expect(cancelled.location).toBe("/#/login?error=cancelled");

    // Discord refused the code: no details leak.
    const bad = await h.login("forged-code");
    expect(bad.location).toBe("/#/login?error=exchange");
    expect(bad.cookie).toBeNull();

    for (const evil of [
      "//evil.example/x",
      "https://evil.example",
      "/\\evil.example",
      "/ok\r\nSet-Cookie: x=1",
    ]) {
      const done = await h.login("owner-code", evil);
      expect(done.location, JSON.stringify(evil)).toBe("/#/");
    }
  });

  it("denied_and_read_only_users", async () => {
    const h = await harnessWith(true);

    const denied = await h.login("stranger-code");
    expect(denied.location).toBe("/#/login?error=denied");
    expect(denied.setCookie).toBeNull();
    expect(await h.persisted()).toEqual([]);
    const audit = await h.auditBy("discord:222");
    expect(audit.some((e) => e.action === "panel.login" && !e.ok)).toBe(true);

    // A role with panel access but not write: reads only.
    await h.auth.upsertRole("test", {
      name: "viewer",
      rank: 50,
      grants: ["admin.panel.access"],
      denies: [],
      builtin: false,
    });
    await h.auth.assign("test", discord(VIEWER), "viewer", { type: "global" });
    const cookie = await h.loginCookie("viewer-code");
    const session = await h.withCookie("GET", "/api/auth/session", cookie, false);
    expect(session.status).toBe(200);
    const user = session.body.user as { name: string; avatar_url: string };
    expect(user.name).toBe("viewer");
    expect(user.avatar_url).toContain("/embed/avatars/");
    expect((session.body.permissions as { write: boolean }).write).toBe(false);
    expect((await h.withCookie("GET", "/api/queue", cookie, false)).status).toBe(200);
    const r = await h.withCookie("POST", "/api/queue/pause", cookie, true);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain("admin.panel.write");
  });

  it("logout_and_revocation", async () => {
    const h = await harnessWith(true);

    await h.auth.assign("test", discord(ADMIN), "admin", { type: "global" });
    let cookie = await h.loginCookie("admin-code");
    const session = await h.withCookie("GET", "/api/auth/session", cookie, false);
    expect(session.status).toBe(200);
    expect((session.body.permissions as { write: boolean }).write, "admin has admin.*").toBe(true);
    await h.auth.revoke("test", discord(ADMIN), "admin", { type: "global" });
    const revoked = await h.withCookie("GET", "/api/queue", cookie, false);
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(401);

    cookie = await h.loginCookie("owner-code");
    expect(await h.persisted()).toHaveLength(2);
    let response = await fetch(`${h.base()}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: `miyoria_session=${cookie}` },
    });
    await response.arrayBuffer();
    expect(response.status, "CSRF guard").toBe(403);
    response = await fetch(`${h.base()}/api/auth/logout`, {
      method: "POST",
      headers: { cookie: `miyoria_session=${cookie}`, "X-Miyoria-Request": "1" },
    });
    await response.arrayBuffer();
    expect(response.status).toBe(204);
    const cleared = response.headers.get("set-cookie") ?? "";
    expect(cleared.startsWith("miyoria_session=;")).toBe(true);
    expect(cleared).toContain("Max-Age=0");
    expect((await h.withCookie("GET", "/api/auth/session", cookie, false)).status).toBe(401);
    expect(await h.persisted(), "only the revoked admin's left").toHaveLength(1);
  });

  it("sessions_persist_hashed_and_expire", async () => {
    const h = await harnessWith(true);
    const cookie = await h.loginCookie("owner-code");

    const persisted = await h.persisted();
    expect(persisted).toHaveLength(1);
    const [key, value] = persisted[0] ?? ["", null];
    expect(key).toBe(`panel_session:${sha256Hex(cookie)}`);
    expect(JSON.stringify(value), "only the hash is stored").not.toContain(cookie);
    expect((value as { account: unknown }).account).toEqual({ platform: "discord", id: OWNER });

    // A restart forgets the in-memory map; the store brings the session back.
    await h.sup.restart("api");
    const session = await h.withCookie("GET", "/api/auth/session", cookie, false);
    expect(session.status).toBe(200);
    expect((session.body.user as { id: string }).id).toBe(OWNER);

    // An expired session is refused and deleted.
    const stale = "A".repeat(43);
    const record = {
      ...(value as Record<string, JsonValue>),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const staleKey = `panel_session:${sha256Hex(stale)}`;
    await h.store.settings.set("_global", staleKey, record);
    expect((await h.withCookie("GET", "/api/auth/session", stale, false)).status).toBe(401);
    const keys = (await h.persisted()).map(([k]) => k);
    expect(keys).not.toContain(staleKey);
    expect(keys).toHaveLength(1);
  });

  it("without_oauth_config_only_the_token_works", async () => {
    const h = await harnessWith(false);
    const client = new ApiClient(h.base(), TOKEN);
    const methods = await client.authMethods();
    expect(methods.token && !methods.discord).toBe(true);
    const response = await fetch(`${h.base()}/api/auth/oauth/login`, { redirect: "manual" });
    await response.arrayBuffer();
    expect(response.headers.get("location")).toBe("/#/login?error=disabled");
    expect((await h.withCookie("GET", "/api/queue", "A".repeat(43), false)).status).toBe(401);
    expect((await client.session()).method).toBe("token");
  });
});
