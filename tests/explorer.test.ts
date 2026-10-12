import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeObject, loadApp, loadNetwork, PublicSource, type Fetch } from "../explorer/public.ts";
import { startExplorer, WEB, type Explorer } from "../explorer/server.ts";
import { jcs, sha256Hex, verifySig } from "../explorer/verify.ts";
import { fakePac, question, S1, session } from "./scene.ts";

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) {
    await c();
  }
  cleanup = [];
});

// ---- A small PAC network, signed as PAC signs ------------------------------

interface Key {
  id: string;
  key: KeyObject;
}
function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return { id: Buffer.from(x, "base64url").toString("hex"), key: privateKey };
}
const SIG = (k: Key, domain: string, value: unknown) => sign(null, Buffer.from(`pac/v1/${domain}\n${jcs(value)}`), k.key).toString("base64url");

/** A vault object on the wire, signed by `writer`; `tamper` swaps the body after signing. */
function object(writer: Key, ns: string, path: string, body: unknown, tamper = false): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(body));
  const header = { v: 1, ns, path, version: 1, prev: null, deleted: false, enc: "none", readers: [], bodySha256: sha256Hex(bytes), bodySize: bytes.byteLength, writer: writer.id, writtenAt: "2026-10-12T00:00:00.000Z" };
  const meta = Buffer.from(JSON.stringify({ header, sig: SIG(writer, "header", header), seq: 1, storedAt: header.writtenAt, body: true }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.byteLength);
  const served = tamper ? Buffer.from(JSON.stringify({ ...(body as object), name: "Mallory" })) : bytes;
  return Buffer.concat([len, meta, served]);
}

function network() {
  const signer = newKey();
  const publisher = newKey();
  const alice = newKey();
  const t1 = newKey();
  const t2 = newKey();
  const bundle = "b".repeat(64);
  const unsigned = {
    type: "pac_deployment",
    v: 1,
    name: "PAC",
    vault: "https://vault.test",
    bulletin: "https://bulletin.test",
    publisher: publisher.id,
    signer: signer.id,
    releases: [
      { measurement: "1".repeat(64), codeIdentity: "cpu@0.2.0+aa", measured: { version: "0.2.0" }, status: "retired", at: "2026-10-06T00:00:00.000Z", commit: "c".repeat(40), events: [] },
      { measurement: "2".repeat(64), codeIdentity: "cpu@0.3.1+bb", measured: { version: "0.3.1" }, status: "current", at: "2026-10-08T00:00:00.000Z", events: [] },
    ],
    pac: [{ sha256: bundle, status: "current", at: "2026-10-08T00:00:00.000Z" }],
    at: "2026-10-08T00:00:00.000Z",
  };
  const descriptor = { ...unsigned, sig: SIG(signer, "pac:deployment", unsigned) };
  const announce = (t: Key, code: string, at: string) => {
    const body = { type: "tee_announcement", tee: t.id, codeIdentity: code, enc: "age1x", measured: {}, quote: { backend: "dstack", platform: "gcp-tdx", quote: Buffer.from("quote bytes").toString("base64url"), events: [{}, {}], collateral: {} }, at };
    return { ...body, sig: SIG(t, "announcement", body) };
  };
  const load = (t: Key, at: string) => {
    const body = { type: "program_loaded", tee: t.id, program: { publisher: publisher.id, name: "pac", sha256: bundle }, log: {}, at };
    return { ...body, sig: SIG(t, "loaded", body) };
  };
  const forged = { ...announce(t2, "cpu@0.2.0+aa", "2026-10-06T00:00:00.000Z"), codeIdentity: "cpu@9.9.9+evil" };
  const posts = [announce(t1, "cpu@0.3.1+bb", "2026-10-08T00:00:01.000Z"), load(t1, "2026-10-08T00:00:02.000Z"), forged];
  const objects: Record<string, Uint8Array> = {
    [`${publisher.id}/profile`]: object(publisher, publisher.id, "profile", { type: "profile", user: publisher.id, name: "Publisher", enc: "age1p", at: "2026-10-06T00:00:00.000Z" }),
    [`${alice.id}/profile`]: object(alice, alice.id, "profile", { type: "profile", user: alice.id, name: "Alice", enc: "age1a", at: "2026-10-07T00:00:00.000Z" }, true),
    [`${t1.id}/handover`]: object(t1, t1.id, "handover", { type: "handover", tee: t1.id, from: t2.id, asOf: 7, at: "2026-10-08T00:00:03.000Z" }),
    [`${t2.id}/handover`]: object(t2, t2.id, "handover", { type: "handover", tee: t2.id, from: null, asOf: 0, at: "2026-10-06T00:00:03.000Z" }),
    [`${publisher.id}/programs/pac/${bundle}/manifest`]: object(publisher, publisher.id, `programs/pac/${bundle}/manifest`, { type: "program_manifest", name: "pac", sha256: bundle, manifest: { egress: ["api.example:443"], build: {} }, content: "d".repeat(64) }),
  };
  const changes = Object.keys(objects).map((k, i) => ({ seq: i + 1, ns: k.slice(0, 64), path: k.slice(65), version: 1, deleted: false }));
  const fetch: Fetch = async (url) => {
    const u = new URL(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    if (url === "https://cdn.test/deployment.json") return json(descriptor);
    if (u.host === "bulletin.test" && u.pathname === "/v1/posts") {
      const since = Number(u.searchParams.get("since") ?? 0);
      const page = posts.slice(since, since + 2);
      return json({ items: page.map((p, i) => ({ index: String(since + i), postedAt: p.at, bytes: Buffer.from(JSON.stringify(p)).toString("base64url") })), more: since + page.length < posts.length });
    }
    if (u.host === "vault.test" && u.pathname === "/v1/health") return json({ ok: true, seq: 42 });
    if (u.host === "vault.test" && u.pathname === "/v1/changes") return json(Number(u.searchParams.get("since")) === 0 ? { items: changes, seq: 42 } : { items: [], seq: 42 });
    const obj = u.host === "vault.test" ? objects[u.pathname.replace("/v1/objects/", "")] : undefined;
    return obj ? new Response(Buffer.from(obj), { status: 200 }) : new Response("{}", { status: 404 });
  };
  return { fetch, signer, publisher, alice, t1, t2, bundle };
}

/** A CDN of app releases, signed with a key of the test's own: `bad` versions are signed by another. */
function cdn(versions: string[], latest: string, bad: string[] = [], listed?: Record<string, { sha256: string; size: number }>) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const other = generateKeyPairSync("ed25519").privateKey;
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const base = `https://cdn.test/releases-${Math.random().toString(36).slice(2)}`;
  const sums = (v: string) => ["darwin-arm64", "linux-x64"].map((p) => `${sha256Hex(`${v}-${p}`)}  pac-${v}-${p}.tar.gz`).join("\n") + "\n";
  const fetch: Fetch = async (url) => {
    const m = url.slice(base.length + 1).match(/^(\d+\.\d+\.\d+)\/(SHA256SUMS(?:\.sig)?)$/);
    if (url === `${base}/latest.json`) {
      return new Response(JSON.stringify({ version: latest, sums: `${latest}/SHA256SUMS`, sig: `${latest}/SHA256SUMS.sig`, files: listed ?? Object.fromEntries(["darwin-arm64", "linux-x64"].map((p) => [p, { path: `${latest}/pac-${latest}-${p}.tar.gz`, sha256: sha256Hex(`${latest}-${p}`), size: 1000 }])) }));
    }
    if (m && versions.includes(m[1]!)) {
      const body = sums(m[1]!);
      return m[2] === "SHA256SUMS" ? new Response(body, { headers: { "last-modified": "Mon, 12 Oct 2026 06:37:56 GMT" } }) : new Response(sign(null, Buffer.from(body), bad.includes(m[1]!) ? other : privateKey).toString("base64"));
    }
    return new Response("missing", { status: 404 });
  };
  return { fetch, base, spki };
}

describe("app releases", () => {
  it("finds every version the CDN keeps, and checks each one's checksums against the release key", async () => {
    const c = cdn(["0.1.0", "0.2.0", "0.2.1"], "0.2.1", ["0.2.0"]);
    const app = await loadApp(c.fetch, c.base, c.spki);
    expect(app.latest).toBe("0.2.1");
    expect(app.releases.map((r) => [r.version, r.latest, r.sigValid])).toEqual([
      ["0.2.1", true, true],
      ["0.2.0", false, false],
      ["0.1.0", false, true],
    ]);
    expect(app.problems).toEqual(["app_signature_0.2.0"]);
    const top = app.releases[0]!;
    expect(top.publishedAt).toBe("2026-10-12T06:37:56.000Z");
    expect(top.files).toEqual([
      { kind: "cli", platform: "darwin-arm64", name: "pac-0.2.1-darwin-arm64.tar.gz", sha256: sha256Hex("0.2.1-darwin-arm64"), size: 1000 },
      { kind: "cli", platform: "linux-x64", name: "pac-0.2.1-linux-x64.tar.gz", sha256: sha256Hex("0.2.1-linux-x64"), size: 1000 },
    ]);
    expect(top.manifestMatches).toBe(true);
  });

  it("flags a latest.json that names other files than its signed checksums", async () => {
    const c = cdn(["0.3.0"], "0.3.0", [], { "darwin-arm64": { sha256: "0".repeat(64), size: 1 }, "linux-x64": { sha256: sha256Hex("0.3.0-linux-x64"), size: 1 } });
    const app = await loadApp(c.fetch, c.base, c.spki);
    expect(app.releases[0]!.manifestMatches).toBe(false);
    expect(app.problems).toContain("app_manifest_mismatch");
  });

  it("says so when there's no latest release to read", async () => {
    const app = await loadApp(async () => new Response("no", { status: 404 }), "https://cdn.test/none", cdn([], "0.0.1").spki);
    expect(app).toMatchObject({ releases: [], problems: ["app_latest_unreadable"] });
  });
});

// ---- Signatures --------------------------------------------------------------

describe("signatures", () => {
  it("canonicalizes as RFC 8785 does for PAC's values", () => {
    expect(jcs({ b: 1, a: [true, null, "x"], c: { z: "é", y: -2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":-2,"z":"é"}}');
    expect(jcs({ u: undefined, a: 1 })).toBe('{"a":1}');
  });

  it("verifies PAC's signature, and nothing tampered or malformed", () => {
    const k = newKey();
    const value = { type: "x", n: 1 };
    const sig = SIG(k, "header", value);
    expect(verifySig(k.id, "header", value, sig)).toBe(true);
    expect(verifySig(k.id, "header", { ...value, n: 2 }, sig)).toBe(false);
    expect(verifySig(k.id, "announcement", value, sig)).toBe(false);
    expect(verifySig(newKey().id, "header", value, sig)).toBe(false);
    expect(verifySig("not-hex", "header", value, sig)).toBe(false);
    expect(verifySig(k.id, "header", value, "short")).toBe(false);
  });

  it("decodes a vault object frame", () => {
    const k = newKey();
    const { meta, body } = decodeObject(object(k, k.id, "profile", { type: "profile", name: "A" }));
    expect(meta.header.path).toBe("profile");
    expect(JSON.parse(Buffer.from(body!).toString())).toEqual({ type: "profile", name: "A" });
    expect(() => decodeObject(new Uint8Array([0, 0, 9, 9, 1]))).toThrow();
  });
});

// ---- The public network --------------------------------------------------------

describe("public network", () => {
  it("reads every public thing and checks every signature", async () => {
    const n = network();
    const net = await loadNetwork(n.fetch, "https://cdn.test/deployment.json");
    expect(net.height).toBe(42);
    expect(net.deployment.sigValid).toBe(true);
    expect(net.posts.map((p) => [p.index, p.type, p.sigValid])).toEqual([
      [0, "tee_announcement", true],
      [1, "program_loaded", true],
      [2, "tee_announcement", false],
    ]);
    expect(net.problems).toContain("bulletin_signature_2");

    const t1 = net.tees.find((t) => t.id === n.t1.id)!;
    expect(t1).toMatchObject({ current: true, sigValid: true, version: "0.3.1", releaseStatus: "current", release: "2".repeat(64) });
    expect(t1.quote).toMatchObject({ backend: "dstack", platform: "gcp-tdx", bytes: 11, events: 2, collateral: true });
    expect(t1.handover).toMatchObject({ from: n.t2.id, asOf: 7, sigValid: true });
    expect(t1.loads).toEqual([{ program: `${n.publisher.id.slice(0, 12)}/pac@${n.bundle.slice(0, 12)}`, at: "2026-10-08T00:00:02.000Z", postIndex: 1, sigValid: true }]);
    const t2 = net.tees.find((t) => t.id === n.t2.id)!;
    expect(t2).toMatchObject({ current: false, sigValid: false });

    expect(net.profiles.find((p) => p.id === n.publisher.id)).toMatchObject({ name: "Publisher", sigValid: true });
    // A body the vault swapped no longer matches its signed header.
    expect(net.profiles.find((p) => p.id === n.alice.id)?.sigValid).toBe(false);
    expect(net.programs).toEqual([expect.objectContaining({ name: "pac", sha256: n.bundle, status: "current", sigValid: true, egress: ["api.example:443"] })]);
  });

  it("flags a descriptor whose signature doesn't hold", async () => {
    const n = network();
    const tampered: Fetch = async (url) => {
      const r = await n.fetch(url);
      if (url !== "https://cdn.test/deployment.json") return r;
      return new Response(JSON.stringify({ ...((await r.json()) as object), name: "Not PAC" }), { status: 200 });
    };
    const net = await loadNetwork(tampered, "https://cdn.test/deployment.json");
    expect(net.deployment.sigValid).toBe(false);
    expect(net.problems).toContain("descriptor_signature");
  });

  it("serves the last good read when a refresh fails", async () => {
    const n = network();
    let up = true;
    const source = new PublicSource({ fetch: (url) => (up ? n.fetch(url) : Promise.reject(new Error("down"))), descriptorUrl: "https://cdn.test/deployment.json", ttlMs: 0 });
    expect((await source.get()).problems).not.toContain("stale");
    up = false;
    expect((await source.get()).problems).toContain("stale");
  });
});

// ---- The server ----------------------------------------------------------------

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

async function explorer(mode: "public" | "local", scene: Parameters<typeof fakePac>[0] = {}): Promise<Explorer & { calls: () => Promise<string[][]> }> {
  const n = network();
  const f = await fakePac(scene);
  cleanup.push(f.close);
  const e = await startExplorer({ mode, host: "127.0.0.1", port: 0, source: new PublicSource({ fetch: n.fetch, descriptorUrl: "https://cdn.test/deployment.json" }), ...(mode === "local" ? { pac: f.pac, token: "tok" } : {}) });
  cleanup.push(() => e.close());
  return { ...e, calls: f.calls };
}

describe("explorer server", () => {
  it("public: serves the network with a strict CSP, and nothing of anyone's txs", async () => {
    const e = await explorer("public");
    const page = await get(e.port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.body).toMatch(/app\.js\?v=[0-9a-f]{12}/);
    expect(JSON.parse((await get(e.port, "/api/network")).body).height).toBe(42);
    expect(JSON.parse((await get(e.port, "/api/mode")).body)).toEqual({ mode: "public", private: false });
    for (const path of ["/api/me", "/api/me/sessions", `/api/me/session/${S1}`]) {
      expect((await get(e.port, path)).status).toBe(404);
    }
    expect(await e.calls()).toEqual([]);
  });

  it("local: answers only its own address, and only the browser holding the token", async () => {
    const e = await explorer("local", { sessions: [session()] });
    expect((await get(e.port, "/api/network", { host: `evil.example:${e.port}` })).status).toBe(421);
    expect((await get(e.port, "/api/me/sessions")).status).toBe(401);
    expect((await get(e.port, "/?t=wrong")).status).toBe(403);
    expect(await e.calls()).toEqual([]);

    const signin = await get(e.port, "/?t=tok");
    expect(signin.status).toBe(302);
    const cookie = String(signin.headers["set-cookie"]).split(";")[0]!;
    expect(String(signin.headers["set-cookie"])).toContain("HttpOnly");
    expect(String(signin.headers["set-cookie"])).toContain("SameSite=Strict");
    const sessions = await get(e.port, "/api/me/sessions", { cookie });
    expect(sessions.status).toBe(200);
    expect(sessions.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(sessions.body)[0].id).toBe(S1);
    expect(JSON.parse((await get(e.port, "/api/mode", { cookie })).body)).toEqual({ mode: "local", private: true });
  });

  it("local: a session's detail through the person's own pac, and nothing for one they aren't in", async () => {
    const mine = session(S1, { results: [{ turn: 1, file: "f_r", batch: "b_1" }] });
    const e = await explorer("local", { sessions: [mine], asks: [{ ...question("a_1", "answered"), text: "PAC asks: Where?" }, { ...question("a_other"), session: "s_9999" }], cat: { f_r: { name: "r.result.md", content: "---\nk: v\n---\nAbout 1400 EUR." } } });
    const cookie = String((await get(e.port, "/?t=tok")).headers["set-cookie"]).split(";")[0]!;
    const d = JSON.parse((await get(e.port, `/api/me/session/${S1}`, { cookie })).body);
    expect(d.session.agent.codeIdentity).toBe("cpu@0.3.1+bb");
    expect(d.asks.map((a: { id: string }) => a.id)).toEqual(["a_1"]);
    expect(d.results).toEqual([{ turn: 1, file: "f_r", text: "About 1400 EUR." }]);
    expect((await get(e.port, "/api/me/session/s_deadbeef", { cookie })).status).toBe(404);
    expect((await get(e.port, "/api/me/session/not-a-session", { cookie })).status).toBe(404);
    const calls = await e.calls();
    expect(calls).toContainEqual(["session", S1]);
    expect(calls.some((c) => c.includes("not-a-session"))).toBe(false);
  });
});

describe("explorer page", () => {
  it("puts other people's words on the page only as text", async () => {
    const js = await readFile(join(WEB, "app.js"), "utf8");
    // Every way to turn a string into markup or code (names split so this file holds none of them).
    const sinks = [["inner", "HTML"], ["outer", "HTML"], ["insertAdjacent", "HTML"], ["document.", "write"], ["ev", "al("], ["new ", "Func", "tion"]].map((p) => p.join(""));
    for (const sink of sinks) {
      expect(js).not.toContain(sink);
    }
    // Inline styles would be refused by the CSP anyway: none are made.
    expect(js).not.toMatch(/style:\s*"/);
  });
});
