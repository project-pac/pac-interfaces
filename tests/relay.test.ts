import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_TTL_MS, hashToken, normalizeCode, onboarding, Relay, type SlackApi, type Socket } from "../relay/core.ts";
import { serveConnectors } from "../relay/server.ts";
import { Store } from "../relay/store.ts";
import { runConnector, savedPath, type Connector } from "../slack/connector.ts";
import type { Message, OwnerEvent, SlackReply } from "../slack/events.ts";
import { createOwner, type Io } from "../slack/owner.ts";
import { reviewHash, type Block } from "../slack/render.ts";
import type { ToConnector } from "../slack/wire.ts";
import { approval, fakePac, request } from "./scene.ts";

const U1 = "U_ONE";
const U2 = "U_TWO";
const quiet = () => {};

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) {
    await c();
  }
  cleanup = [];
});

function fakeSlack() {
  const posts: { channel: string; message: Message; thread?: string }[] = [];
  const updates: { channel: string; ts: string; message: Message }[] = [];
  const views: { trigger: string; view: Block }[] = [];
  const responds: { url: string; reply: SlackReply }[] = [];
  const api: SlackApi = {
    openDm: async (user) => `D_${user}`,
    post: async (channel, message, thread) => {
      posts.push({ channel, message, ...(thread ? { thread } : {}) });
      return `ts${posts.length}`;
    },
    update: async (channel, ts, message) => void updates.push({ channel, ts, message }),
    openView: async (trigger, view) => void views.push({ trigger, view }),
    respond: async (url, reply) => void responds.push({ url, reply }),
  };
  return { api, posts, updates, views, responds };
}

function fakeSocket() {
  const sent: ToConnector[] = [];
  let closed: string | undefined;
  const socket: Socket = { send: (text) => void sent.push(JSON.parse(text) as ToConnector), close: (_code, reason) => void (closed = reason ?? "closed") };
  return { socket, sent, closed: () => closed };
}

async function until(check: () => boolean | Promise<boolean>, ms = 4_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function relayWith(now = () => Date.now()) {
  const slack = fakeSlack();
  const store = await Store.open();
  const relay = new Relay({ store, slack: slack.api, now, ackMs: 300 });
  /** A connector signed in as `user` over a fake socket. */
  const join = async (user: string, name = "Me") => {
    const s = fakeSocket();
    const conn = relay.open(s.socket);
    await conn.receive(JSON.stringify({ t: "link", code: relay.issueCode(user), name }));
    return { ...s, conn, token: (s.sent[0] as { token?: string }).token! };
  };
  return { relay, slack, store, join };
}

const event = (user: string, extra: Partial<OwnerEvent> = {}): OwnerEvent => ({ kind: "command", user, text: "status", channel: `D_${user}`, ...extra }) as OwnerEvent;

describe("relay: linking", () => {
  it("links with a code, keeps only the token's hash, and tells the person whose PAC it is", async () => {
    const { store, slack, join } = await relayWith();
    const a = await join(U1, "<!channel> Me");
    expect(a.sent[0]).toMatchObject({ t: "welcome", user: U1, dm: `D_${U1}` });
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(store.get(U1)?.tokenHash).toBe(hashToken(a.token));
    expect(JSON.stringify(store.get(U1))).not.toContain(a.token);
    const notice = JSON.stringify(slack.posts.at(-1));
    expect(notice).toContain("/pac unlink");
    expect(notice).not.toContain("<!channel>");
  });

  it("takes a code once, and not after it expires", async () => {
    let t = 1_000;
    const { relay } = await relayWith(() => t);
    const code = relay.issueCode(U1);
    const first = fakeSocket();
    await relay.open(first.socket).receive(JSON.stringify({ t: "link", code: code.toLowerCase().replace("-", " ") }));
    expect(first.sent[0]?.t).toBe("welcome");
    const again = fakeSocket();
    await relay.open(again.socket).receive(JSON.stringify({ t: "link", code }));
    expect(again.sent[0]).toEqual({ t: "refused", code: "bad_code" });

    const late = relay.issueCode(U2);
    t += CODE_TTL_MS + 1;
    const slow = fakeSocket();
    await relay.open(slow.socket).receive(JSON.stringify({ t: "link", code: late }));
    expect(slow.sent[0]).toEqual({ t: "refused", code: "bad_code" });
  });

  it("signs in again with the token, and refuses an unknown one", async () => {
    const { relay, join } = await relayWith();
    const a = await join(U1);
    a.conn.close();
    const back = fakeSocket();
    await relay.open(back.socket).receive(JSON.stringify({ t: "hello", token: a.token }));
    expect(back.sent[0]).toMatchObject({ t: "welcome", user: U1 });
    expect(back.sent[0]).not.toHaveProperty("token");
    const stranger = fakeSocket();
    await relay.open(stranger.socket).receive(JSON.stringify({ t: "hello", token: "nope" }));
    expect(stranger.sent[0]).toEqual({ t: "refused", code: "bad_token" });
  });

  it("refuses anything but link or hello before signing in", async () => {
    const { relay } = await relayWith();
    const s = fakeSocket();
    await relay.open(s.socket).receive(JSON.stringify({ t: "call", id: "1", method: "post", message: { text: "x", blocks: [] } }));
    expect(s.sent[0]).toEqual({ t: "refused", code: "bad_frame" });
    expect(s.closed()).toBe("bad_frame");
  });

  it("lets a newer connector replace an older one, and unlink stops it", async () => {
    const { relay, join } = await relayWith();
    const old = await join(U1);
    const fresh = await join(U1);
    expect(old.sent.at(-1)).toEqual({ t: "refused", code: "replaced" });
    expect(relay.connected(U1)).toBe(true);
    await relay.unlink(U1);
    expect(fresh.sent.at(-1)).toEqual({ t: "refused", code: "unlinked" });
    expect(relay.linked(U1)).toBe(false);
    expect(relay.connected(U1)).toBe(false);
  });

  it("shows how to connect, with the code and the relay", () => {
    const text = onboarding("ABCD-EFGH", "wss://relay.example/connect", "git clone x");
    expect(text).toContain("slack connect ABCD-EFGH --relay wss://relay.example/connect");
    expect(text).toContain("install.sh");
    expect(normalizeCode("abcd efgh")).toBe("ABCD-EFGH");
  });
});

describe("relay: routing", () => {
  it("delivers a person's events to their connector only", async () => {
    const { relay, join } = await relayWith();
    const a = await join(U1);
    const b = await join(U2);
    const before = b.sent.length;
    expect(await relay.deliver(event(U1))).toEqual({ delivered: true });
    expect(a.sent.at(-1)).toMatchObject({ t: "event", event: { user: U1 } });
    expect(b.sent.length).toBe(before);
    expect((await relay.deliver(event("U_NOBODY"))).delivered).toBe(false);
  });

  it("posts only in the person's DM, and updates nothing outside it", async () => {
    const { slack, join } = await relayWith();
    const a = await join(U1);
    await a.conn.receive(JSON.stringify({ t: "call", id: "p", method: "post", message: { text: "hi", blocks: [] } }));
    expect(slack.posts.at(-1)?.channel).toBe(`D_${U1}`);
    expect(a.sent.at(-1)).toMatchObject({ t: "result", id: "p", ok: true });
    await a.conn.receive(JSON.stringify({ t: "call", id: "u", method: "update", channel: "C_GENERAL", ts: "1", message: { text: "x", blocks: [] } }));
    expect(a.sent.at(-1)).toEqual({ t: "result", id: "u", ok: false, code: "not_your_dm" });
    expect(slack.updates).toEqual([]);
  });

  it("responds and opens forms only on the person's own events, and keeps PAC's words out of channels", async () => {
    const { relay, slack, join } = await relayWith();
    const a = await join(U1);
    const b = await join(U2);
    await relay.deliver(event(U1, { channel: "C_GENERAL" }), { responseUrl: "https://hooks/1", trigger: "trig1" });
    const id = (a.sent.at(-1) as { id: string }).id;

    await b.conn.receive(JSON.stringify({ t: "call", id: "x", method: "respond", event: id, reply: { response_type: "ephemeral", text: "stolen" } }));
    expect(b.sent.at(-1)).toEqual({ t: "result", id: "x", ok: false, code: "unknown_event" });
    await b.conn.receive(JSON.stringify({ t: "call", id: "y", method: "open_view", event: id, view: { type: "modal" } }));
    expect(b.sent.at(-1)).toMatchObject({ ok: false, code: "unknown_event" });

    await a.conn.receive(JSON.stringify({ t: "call", id: "r", method: "respond", event: id, reply: { response_type: "in_channel", text: "PAC's words" } }));
    expect(slack.responds).toEqual([{ url: "https://hooks/1", reply: { response_type: "ephemeral", text: "PAC's words" } }]);
    await a.conn.receive(JSON.stringify({ t: "call", id: "v", method: "open_view", event: id, view: { type: "modal" } }));
    expect(slack.views).toEqual([{ trigger: "trig1", view: { type: "modal" } }]);
  });

  it("passes a form's field errors back from the connector, and gives up after the ack window", async () => {
    const { relay, join } = await relayWith();
    const a = await join(U1);
    const form: OwnerEvent = { kind: "view", user: U1, callback: "pac_answer_view", values: { text: "" }, meta: "" };
    const pending = relay.deliver(form);
    await until(() => a.sent.at(-1)?.t === "event");
    const id = (a.sent.at(-1) as { id: string }).id;
    await a.conn.receive(JSON.stringify({ t: "ack", id, response: { response_action: "errors", errors: { text: "Write something first." } } }));
    expect(await pending).toEqual({ delivered: true, ack: { response_action: "errors", errors: { text: "Write something first." } } });
    expect(await relay.deliver(form)).toEqual({ delivered: true });
  });
});

describe("owner core", () => {
  it("never runs pac for anyone but its owner", async () => {
    const f = await fakePac({ asks: [approval()] });
    cleanup.push(f.close);
    const said: string[] = [];
    const io: Io = { respond: async (r) => void said.push(r.text), say: async (m) => void said.push(m.text), openView: async () => {}, ack: async () => {} };
    const owner = createOwner({ pac: f.pac, owner: U1, statePath: join(f.env.PAC_HOME, "s.json"), port: { dm: async () => "D", post: async () => "ts", update: async () => {} }, pollMs: 60_000, log: quiet });
    await owner.handle({ kind: "action", user: U2, action: "pac_approve", value: JSON.stringify({ ask: "a_appr", h: reviewHash(approval().body) }) }, io);
    await owner.handle({ kind: "message", user: U2, text: "What do you know?" }, io);
    await owner.handle({ kind: "command", user: U2, text: "files", channel: "C" }, io);
    expect(await f.calls()).toEqual([]);
    expect(said).toHaveLength(3);
  });
});

describe("relay + connector, end to end", () => {
  it("links, posts PAC's asks to the DM, and decides only on the owner's click", async () => {
    const f = await fakePac({ asks: [request(), approval()] });
    cleanup.push(f.close);
    const { relay, slack } = await relayWith();
    const served = await serveConnectors(relay, 0);
    cleanup.push(served.close);
    const relayUrl = `ws://127.0.0.1:${served.port}/connect`;

    let connector: Connector | undefined;
    connector = runConnector({ pac: f.pac, home: f.env.PAC_HOME, relay: relayUrl, code: relay.issueCode(U1), pollMs: 60_000, log: quiet });
    cleanup.push(() => connector?.stop());

    // Linked: the token is saved, private to the person.
    await until(() => relay.connected(U1));
    const saved = JSON.parse(await readFile(savedPath(f.env.PAC_HOME), "utf8")) as { relay: string; user: string; token: string };
    expect(saved).toMatchObject({ relay: relayUrl, user: U1 });
    expect((await stat(savedPath(f.env.PAC_HOME))).mode & 0o777).toBe(0o600);

    // The first sync posts the question and the approval to the person's DM.
    await until(() => slack.posts.filter((p) => p.message.text.startsWith("PAC")).length >= 2);
    const card = slack.posts.find((p) => p.message.text.startsWith("PAC wants your approval"))!;
    expect(card.channel).toBe(`D_${U1}`);
    const ts = `ts${slack.posts.indexOf(card) + 1}`;

    // Someone else's click never reaches this PAC.
    expect((await relay.deliver({ kind: "action", user: U2, action: "pac_approve", value: JSON.stringify({ ask: "a_appr", h: reviewHash(approval().body) }), channel: `D_${U1}`, ts })).delivered).toBe(false);

    // The owner's click on the card as shown decides, and the card becomes its outcome.
    await relay.deliver({ kind: "action", user: U1, action: "pac_approve", value: JSON.stringify({ ask: "a_appr", h: reviewHash(approval().body) }), channel: `D_${U1}`, ts }, { responseUrl: "https://hooks/a" });
    await until(async () => (await f.calls()).some((c) => c[0] === "decide"));
    expect((await f.calls()).filter((c) => c[0] === "decide")).toEqual([["decide", "a_appr", "yes"]]);
    await until(() => slack.updates.length === 1);
    expect(slack.updates[0]).toMatchObject({ channel: `D_${U1}`, ts });
    expect(slack.updates[0]!.message.text).toContain("Approved");

    // A command answers where it was typed.
    await relay.deliver({ kind: "command", user: U1, text: "status", channel: `D_${U1}` }, { responseUrl: "https://hooks/s" });
    await until(() => slack.responds.some((r) => r.url === "https://hooks/s"));
    expect(slack.responds.find((r) => r.url === "https://hooks/s")!.reply.text).toContain("grant: `granted`");

    // An empty form comes back with a field error, without running pac.
    const n = (await f.calls()).length;
    expect(await relay.deliver({ kind: "view", user: U1, callback: "pac_answer_view", values: { text: "  " }, meta: JSON.stringify({ value: JSON.stringify({ ask: "a_req" }) }) })).toEqual({
      delivered: true,
      ack: { response_action: "errors", errors: { text: "Write something first." } },
    });
    expect((await f.calls()).length).toBe(n);

    // Unlinked: the connector stops for good.
    await relay.unlink(U1);
    expect(await connector.stopped).toBe("unlinked");
  }, 20_000);
});
