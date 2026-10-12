import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf, type Pac } from "../pac/cli.ts";
import { me, mySession, mySessions } from "./private.ts";
import type { Activity, PublicSource } from "./public.ts";

/**
 * PAC's explorer. `public` is what explorer.projectpac.net runs: the network
 * as anyone can see it, and nothing else. `local` runs on a person's own
 * machine, on 127.0.0.1 only, and adds the sessions they're in, read through
 * their own `pac`; it answers only its own browser tab (a token cookie) at
 * its own address (the Host header), so no other site can read it.
 */

export const WEB = join(dirname(fileURLToPath(import.meta.url)), "web");

const FILES: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/favicon.svg": "favicon.svg",
};
const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml" };

const HEADERS = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

const COOKIE = "pac_explorer";
const SESSION_PATH = /^\/api\/me\/session\/([^/]+)$/;

export interface ExplorerOptions {
  mode: "public" | "local";
  host: string;
  port: number;
  source: PublicSource;
  activity?: Activity;
  /** Local mode: the person's own PAC. */
  pac?: Pac;
  /** Local mode: what the start URL carries; made here if not given. */
  token?: string;
  log?: (event: string, extra?: Record<string, unknown>) => void;
}

export interface Explorer {
  port: number;
  /** Where to open it: in local mode, carrying the token once. */
  url: string;
  close(): Promise<void>;
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) {
      return v.join("=");
    }
  }
  return undefined;
}

export async function startExplorer(o: ExplorerOptions): Promise<Explorer> {
  const local = o.mode === "local";
  if (local && !o.pac) {
    throw new Error("local mode needs a pac");
  }
  const token = local ? (o.token ?? randomBytes(24).toString("base64url")) : undefined;
  const log = o.log ?? (() => {});
  let port = o.port;

  const send = (res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...HEADERS, "content-type": type, ...extra }).end(body);
  };
  const sendJson = (res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extra);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { error: "method" });
    }
    const url = new URL(req.url ?? "/", "http://explorer");
    if (local) {
      // DNS rebinding: a page elsewhere can't borrow this address under its own name.
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return sendJson(res, 421, { error: "host" });
      }
      const t = url.searchParams.get("t");
      if (url.pathname === "/" && t) {
        if (!same(t, token!)) {
          return sendJson(res, 403, { error: "token" });
        }
        return send(res, 302, "", "text/plain", { location: "/", "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
    }
    const authed = local && same(cookieOf(req) ?? "", token!);

    if (url.pathname === "/api/mode") {
      return sendJson(res, 200, { mode: o.mode, private: authed });
    }
    if (url.pathname === "/api/network") {
      try {
        return sendJson(res, 200, await o.source.get(), { "cache-control": "public, max-age=30" });
      } catch (error) {
        log("network_failed", { code: codeOf(error) });
        return sendJson(res, 502, { error: "network_unavailable" });
      }
    }
    if (url.pathname === "/api/activity") {
      return sendJson(res, 200, { samples: o.activity?.samples ?? [] }, { "cache-control": "public, max-age=60" });
    }
    if (url.pathname.startsWith("/api/me")) {
      // What other people wrote: only for the person at this machine, never cached.
      if (!authed) {
        return sendJson(res, local ? 401 : 404, { error: local ? "open the link the explorer printed" : "not_here" });
      }
      const noStore = { "cache-control": "no-store" };
      try {
        if (url.pathname === "/api/me") {
          return sendJson(res, 200, await me(o.pac!), noStore);
        }
        if (url.pathname === "/api/me/sessions") {
          return sendJson(res, 200, await mySessions(o.pac!), noStore);
        }
        const m = url.pathname.match(SESSION_PATH);
        if (m) {
          const detail = await mySession(o.pac!, decodeURIComponent(m[1]!));
          return detail ? sendJson(res, 200, detail, noStore) : sendJson(res, 404, { error: "no_such_session" }, noStore);
        }
      } catch (error) {
        return sendJson(res, 502, { error: codeOf(error) }, noStore);
      }
      return sendJson(res, 404, { error: "not_found" });
    }
    const file = FILES[url.pathname];
    if (file === "index.html") {
      // Asset URLs carry a fingerprint of their content, so a changed file is a new URL.
      const [html, js, css] = await Promise.all(["index.html", "app.js", "style.css"].map((f) => readFile(join(WEB, f), "utf8")));
      const v = createHash("sha256").update(js!).update(css!).digest("hex").slice(0, 12);
      return send(res, 200, html!.replace('src="/app.js"', `src="/app.js?v=${v}"`).replace('href="/style.css"', `href="/style.css?v=${v}"`), TYPES.html!, { "cache-control": "no-cache" });
    }
    if (file) {
      const ext = file.split(".").pop()!;
      return send(res, 200, await readFile(join(WEB, file)), TYPES[ext]!, { "cache-control": url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache" });
    }
    if (url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, mode: o.mode });
    }
    return sendJson(res, 404, { error: "not_found" });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log("request_failed", { code: codeOf(error) });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "failed" });
      }
    });
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(o.port, o.host, done);
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : o.port;

  // Read the network once now, so the first page doesn't wait for it.
  void o.source.get().catch((error) => log("network_failed", { code: codeOf(error) }));

  // The vault's height every 5 minutes: the activity chart's only input.
  let sampler: NodeJS.Timeout | undefined;
  if (o.activity) {
    const sample = () =>
      o.source
        .height()
        .then((h) => o.activity!.record(h))
        .catch((error) => log("sample_failed", { code: codeOf(error) }));
    void sample();
    sampler = setInterval(sample, 5 * 60_000);
  }

  const shown = local ? `http://127.0.0.1:${port}/?t=${token}` : `http://${o.host === "0.0.0.0" ? "localhost" : o.host}:${port}/`;
  return {
    port,
    url: shown,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(sampler);
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
