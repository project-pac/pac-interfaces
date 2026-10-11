import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Message, OwnerEvent, SlackReply, ViewAck } from "../slack/events.ts";
import type { Block } from "../slack/render.ts";
import { esc } from "../slack/render.ts";
import { parseFrame, type Refusal, type ToConnector, type ToRelay } from "../slack/wire.ts";
import type { Store } from "./store.ts";

/**
 * The shared Slack app's relay, without Slack: it routes each Slack user's
 * events to the connector they linked, and does in Slack only what that
 * connector may do there: post and update in that user's DM with the bot,
 * respond to and open forms on that user's own events. It holds no PAC keys
 * and runs no PAC command. Logs carry codes and counts, never content.
 */

export interface SlackApi {
  openDm(user: string): Promise<string>;
  post(channel: string, message: Message, thread?: string): Promise<string | undefined>;
  update(channel: string, ts: string, message: Message): Promise<void>;
  openView(trigger: string, view: Block): Promise<void>;
  respond(url: string, reply: SlackReply): Promise<void>;
}

/** A connector's WebSocket, as the relay uses it. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** What a Slack event carried that only the relay keeps. */
export interface Delivery {
  responseUrl?: string;
  trigger?: string;
}

export type Log = (event: string, extra?: Record<string, unknown>) => void;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_TTL_MS = 10 * 60_000;
/** Slack's response URLs last 30 minutes. */
const EVENT_TTL_MS = 30 * 60_000;
const EVENTS_KEPT = 5_000;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** `abcd efgh`, `ABCD-EFGH` and `abcdefgh` are the same code. */
export const normalizeCode = (code: string): string => {
  const plain = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return plain.length === 8 ? `${plain.slice(0, 4)}-${plain.slice(4)}` : plain;
};

interface Conn {
  socket: Socket;
  user?: string;
}

interface EventRecord {
  user: string;
  at: number;
  responseUrl?: string;
  trigger?: string;
  /** Where a command was typed: PAC's words go `in_channel` only in the person's DM. */
  channel?: string;
}

export interface RelayOptions {
  store: Store;
  slack: SlackApi;
  log?: Log;
  now?: () => number;
  /** How long a form waits for its connector's ack. Slack allows 3 s in all. */
  ackMs?: number;
}

export class Relay {
  readonly #store: Store;
  readonly #slack: SlackApi;
  readonly #log: Log;
  readonly #now: () => number;
  readonly #ackMs: number;
  readonly #codes = new Map<string, { user: string; at: number }>();
  readonly #live = new Map<string, Conn>();
  readonly #events = new Map<string, EventRecord>();
  readonly #acks = new Map<string, (response: ViewAck | undefined) => void>();
  readonly #dms = new Map<string, string>();

  constructor(o: RelayOptions) {
    this.#store = o.store;
    this.#slack = o.slack;
    this.#log = o.log ?? (() => {});
    this.#now = o.now ?? Date.now;
    this.#ackMs = o.ackMs ?? 2_500;
  }

  stats(): { linked: number; connected: number } {
    return { linked: this.#store.count, connected: this.#live.size };
  }

  linked(user: string): boolean {
    return this.#store.get(user) !== undefined;
  }

  connected(user: string): boolean {
    return this.#live.has(user);
  }

  /** A one-time code that links whichever connector shows it to this Slack user. Replaces any earlier code of theirs. */
  issueCode(user: string): string {
    const now = this.#now();
    for (const [code, c] of this.#codes) {
      if (c.user === user || now - c.at > CODE_TTL_MS) {
        this.#codes.delete(code);
      }
    }
    let code: string;
    do {
      code = normalizeCode(Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""));
    } while (this.#codes.has(code));
    this.#codes.set(code, { user, at: now });
    this.#log("code_issued");
    return code;
  }

  async unlink(user: string): Promise<boolean> {
    const had = await this.#store.remove(user);
    const conn = this.#live.get(user);
    if (conn) {
      this.#refuse(conn, "unlinked");
    }
    this.#log("unlinked", { had });
    return had;
  }

  async dm(user: string): Promise<string> {
    let dm = this.#dms.get(user);
    if (!dm) {
      dm = await this.#slack.openDm(user);
      this.#dms.set(user, dm);
    }
    return dm;
  }

  /**
   * One Slack event of `event.user`'s, to their connector. A form waits up to
   * `ackMs` for the connector's ack (it may carry field errors).
   */
  async deliver(event: OwnerEvent, d: Delivery = {}): Promise<{ delivered: boolean; ack?: ViewAck }> {
    const conn = this.#live.get(event.user);
    if (!conn) {
      return { delivered: false };
    }
    const id = randomBytes(12).toString("base64url");
    this.#remember(id, { user: event.user, at: this.#now(), ...(d.responseUrl ? { responseUrl: d.responseUrl } : {}), ...(d.trigger ? { trigger: d.trigger } : {}), ...(event.kind === "command" ? { channel: event.channel } : {}) });
    const frame: ToConnector = { t: "event", id, event };
    if (event.kind !== "view") {
      this.#send(conn, frame);
      return { delivered: true };
    }
    const ack = new Promise<ViewAck | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#acks.delete(id);
        resolve(undefined);
      }, this.#ackMs);
      this.#acks.set(id, (response) => {
        clearTimeout(timer);
        this.#acks.delete(id);
        resolve(response);
      });
    });
    this.#send(conn, frame);
    const response = await ack;
    return { delivered: true, ...(response ? { ack: response } : {}) };
  }

  /** A new connector WebSocket: it must link or say hello first. */
  open(socket: Socket): { receive(text: string): Promise<void>; close(): void } {
    const conn: Conn = { socket };
    return {
      receive: (text) => this.#receive(conn, text),
      close: () => {
        if (conn.user && this.#live.get(conn.user) === conn) {
          this.#live.delete(conn.user);
          this.#log("connector_left", this.stats());
        }
      },
    };
  }

  async #receive(conn: Conn, text: string): Promise<void> {
    const frame = parseFrame<ToRelay>(text);
    if (!frame) {
      this.#refuse(conn, "bad_frame");
      return;
    }
    if (!conn.user) {
      if (frame.t === "link" && typeof frame.code === "string") {
        await this.#link(conn, frame.code, frame.name);
      } else if (frame.t === "hello" && typeof frame.token === "string") {
        const linked = this.#store.byTokenHash(hashToken(frame.token));
        if (!linked) {
          this.#refuse(conn, "bad_token");
          return;
        }
        await this.#bind(conn, linked.user);
      } else {
        this.#refuse(conn, "bad_frame");
      }
      return;
    }
    if (this.#live.get(conn.user) !== conn) {
      return;
    }
    if (frame.t === "ack" && typeof frame.id === "string") {
      if (this.#events.get(frame.id)?.user === conn.user) {
        this.#acks.get(frame.id)?.(viewAckOf(frame.response));
      }
      return;
    }
    if (frame.t === "call" && typeof frame.id === "string") {
      await this.#call(conn, conn.user, frame);
    }
  }

  async #link(conn: Conn, raw: string, name: unknown): Promise<void> {
    const code = normalizeCode(raw);
    const issued = this.#codes.get(code);
    this.#codes.delete(code);
    if (!issued || this.#now() - issued.at > CODE_TTL_MS) {
      this.#log("link_refused");
      this.#refuse(conn, "bad_code");
      return;
    }
    const token = randomBytes(32).toString("base64url");
    const named = typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : undefined;
    await this.#store.put({ user: issued.user, tokenHash: hashToken(token), ...(named ? { name: named } : {}), linkedAt: new Date(this.#now()).toISOString() });
    if (!(await this.#bind(conn, issued.user, token))) {
      return;
    }
    this.#log("linked", this.stats());
    const said = `:link: Linked. This Slack account now talks to the PAC of *${esc(named ?? "an unnamed PAC user")}*, on the machine you ran \`slack connect\` on. If that isn't you, run \`/pac unlink\`.`;
    await this.#slack.post(await this.dm(issued.user), { text: "Linked to PAC", blocks: [{ type: "section", text: { type: "mrkdwn", text: said } }] }).catch(() => {});
  }

  /** Signs a connector in as `user`, replacing any other connector of theirs. */
  async #bind(conn: Conn, user: string, token?: string): Promise<boolean> {
    let dm: string;
    try {
      dm = await this.dm(user);
    } catch {
      conn.socket.close(1011, "slack_unavailable");
      return false;
    }
    const before = this.#live.get(user);
    if (before && before !== conn) {
      this.#refuse(before, "replaced");
    }
    conn.user = user;
    this.#live.set(user, conn);
    this.#send(conn, { t: "welcome", user, dm, ...(token ? { token } : {}) });
    this.#log("connector_joined", this.stats());
    return true;
  }

  async #call(conn: Conn, user: string, frame: Extract<ToRelay, { t: "call" }>): Promise<void> {
    const fail = (code: string) => this.#send(conn, { t: "result", id: frame.id, ok: false, code });
    const record = (event: unknown): EventRecord | undefined => {
      const r = typeof event === "string" ? this.#events.get(event) : undefined;
      return r && r.user === user && this.#now() - r.at <= EVENT_TTL_MS ? r : undefined;
    };
    try {
      const dm = await this.dm(user);
      switch (frame.method) {
        case "post": {
          if (!isMessage(frame.message)) {
            return fail("bad_call");
          }
          const ts = await this.#slack.post(dm, frame.message, typeof frame.thread === "string" ? frame.thread : undefined);
          this.#send(conn, { t: "result", id: frame.id, ok: true, ...(ts ? { value: ts } : {}) });
          return;
        }
        case "update": {
          if (!isMessage(frame.message) || typeof frame.ts !== "string") {
            return fail("bad_call");
          }
          if (frame.channel !== dm) {
            return fail("not_your_dm");
          }
          await this.#slack.update(dm, frame.ts, frame.message);
          break;
        }
        case "respond": {
          const r = record(frame.event);
          if (!r?.responseUrl || !isReply(frame.reply)) {
            return fail(r ? "bad_call" : "unknown_event");
          }
          // PAC's words show to a channel only in the person's own DM.
          const reply: SlackReply = frame.reply.response_type === "in_channel" && r.channel !== dm ? { ...frame.reply, response_type: "ephemeral" } : frame.reply;
          await this.#slack.respond(r.responseUrl, reply);
          break;
        }
        case "open_view": {
          const r = record(frame.event);
          if (!r?.trigger || !frame.view || typeof frame.view !== "object") {
            return fail(r ? "bad_call" : "unknown_event");
          }
          await this.#slack.openView(r.trigger, frame.view);
          break;
        }
        default:
          return fail("bad_call");
      }
      this.#send(conn, { t: "result", id: frame.id, ok: true });
    } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error ?? (error instanceof Error ? error.message : "slack_failed");
      this.#log("call_failed", { method: frame.method, code });
      fail(code);
    }
  }

  #remember(id: string, record: EventRecord): void {
    this.#events.set(id, record);
    for (const [key, r] of this.#events) {
      if (this.#events.size <= EVENTS_KEPT && record.at - r.at <= EVENT_TTL_MS) {
        break;
      }
      this.#events.delete(key);
    }
  }

  #send(conn: Conn, frame: ToConnector): void {
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {
      // A closed socket: its close handler cleans up.
    }
  }

  #refuse(conn: Conn, code: Refusal): void {
    this.#send(conn, { t: "refused", code });
    if (conn.user && this.#live.get(conn.user) === conn) {
      this.#live.delete(conn.user);
    }
    conn.socket.close(4000, code);
  }
}

const isMessage = (m: unknown): m is Message => !!m && typeof (m as Message).text === "string" && Array.isArray((m as Message).blocks);

const isReply = (r: unknown): r is SlackReply => !!r && typeof (r as SlackReply).text === "string" && ((r as SlackReply).response_type === "ephemeral" || (r as SlackReply).response_type === "in_channel");

function viewAckOf(response: unknown): ViewAck | undefined {
  const r = response as ViewAck | undefined;
  if (r?.response_action !== "errors" || !r.errors || typeof r.errors !== "object") {
    return undefined;
  }
  const errors = Object.fromEntries(Object.entries(r.errors).filter(([, v]) => typeof v === "string"));
  return { response_action: "errors", errors };
}

/** What someone who hasn't linked sees: how to connect the PAC on their own machine. */
export function onboarding(code: string, relayUrl: string, get: string): string {
  return [
    "*Connect your PAC to Slack.* Your keys stay on your machine; this app only carries messages between Slack and it.",
    "1. PAC installed and joined? If not: `curl -fsSL https://cdn.projectpac.net/install.sh | sh`, then `~/.pac/bin/pac init --name \"<your name>\" --grant`",
    `2. Get the Slack connector: \`${get}\``,
    `3. In that folder: \`node bin/main.ts slack connect ${code} --relay ${relayUrl}\``,
    `The code works once, for ${CODE_TTL_MS / 60_000} minutes. Then \`node bin/main.ts slack service install\` keeps it running at login.`,
  ].join("\n");
}

export const OFFLINE = "Your PAC connector isn't running, so PAC can't hear you. On your machine, in your pac-interfaces folder: `node bin/main.ts slack connector` (or `slack service install` to keep it running at login).";
