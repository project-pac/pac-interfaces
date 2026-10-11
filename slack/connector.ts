import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codeOf, type Pac } from "../pac/cli.ts";
import type { Message } from "./events.ts";
import { createOwner, log as defaultLog, type Io, type Log, type Owner, type Port } from "./owner.ts";
import { parseFrame, type Call, type Refusal, type ToConnector, type ToRelay } from "./wire.ts";

/**
 * This machine's PAC in the shared PAC Slack app. It signs in to the relay
 * over one outgoing WebSocket, takes its owner's Slack events from it, and
 * runs the same owner core as Socket Mode does, through this home's `pac`.
 * It holds no Slack token; the relay holds no PAC key.
 */

export interface Saved {
  relay: string;
  token: string;
  user: string;
}

export const savedPath = (home: string): string => join(home, "interfaces", "slack", "connector.json");

export async function loadSaved(path: string): Promise<Saved | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<Saved>;
    return typeof raw.relay === "string" && typeof raw.token === "string" && typeof raw.user === "string" ? { relay: raw.relay, token: raw.token, user: raw.user } : undefined;
  } catch {
    return undefined;
  }
}

async function save(path: string, saved: Saved): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
  await rename(tmp, path);
}

/** Why a connector stopped for good, as its person should read it. */
export const STOPPED: Record<Refusal, string> = {
  bad_code: "That code didn't work: it's mistyped, used, or older than 10 minutes. Get a new one with `/pac link` in Slack.",
  bad_token: "The relay doesn't know this connector any more (unlinked, or linked from another machine). Get a code with `/pac link` in Slack, then `slack connect <code>`.",
  replaced: "Another connector signed in for your Slack account, so this one stopped.",
  unlinked: "This Slack account was unlinked (`/pac unlink`), so the connector stopped.",
  bad_frame: "The relay didn't understand this connector. Update pac-interfaces, then try again.",
};

export interface ConnectorOptions {
  pac: Pac;
  home: string;
  relay: string;
  /** First run: a code from `/pac link`. */
  code?: string;
  /** Later runs: the token the relay gave at linking. */
  token?: string;
  pollMs: number;
  log?: Log;
  /** Called once signed in. */
  onWelcome?: (user: string, linkedNow: boolean) => void;
}

export interface Connector {
  /** Settles when the relay refuses this connector for good (or `stop`). */
  stopped: Promise<Refusal | "stopped">;
  stop(): void;
}

const CALL_MS = 20_000;

export function runConnector(o: ConnectorOptions): Connector {
  const say = o.log ?? defaultLog;
  let token = o.token;
  let code = o.code;
  let name: string | undefined;
  let ws: WebSocket | undefined;
  let signedIn = false;
  let dm: string | undefined;
  let owner: Owner | undefined;
  let finished = false;
  let backoff = 1_000;
  let next = 0;
  const pending = new Map<string, { done: (value: string | undefined) => void; fail: (error: Error) => void; timer: NodeJS.Timeout }>();
  let finish!: (why: Refusal | "stopped") => void;
  const stopped = new Promise<Refusal | "stopped">((done) => (finish = done));

  const send = (frame: ToRelay): boolean => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(frame));
    return true;
  };

  const call = (c: Call): Promise<string | undefined> =>
    new Promise((done, fail) => {
      const id = `c${++next}`;
      if (!signedIn || !send({ t: "call", id, ...c })) {
        fail(new Error("relay_offline"));
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(id);
        fail(new Error("relay_timeout"));
      }, CALL_MS);
      pending.set(id, { done, fail, timer });
    });

  const port: Port = {
    async dm() {
      if (!dm) {
        throw new Error("relay_offline");
      }
      return dm;
    },
    post: (message: Message, thread?: string) => call({ method: "post", message, ...(thread ? { thread } : {}) }),
    update: async (channel, ts, message) => void (await call({ method: "update", channel, ts, message })),
  };

  const ioFor = (id: string): Io => ({
    respond: async (reply) => void (await call({ method: "respond", event: id, reply })),
    say: async (message, thread) => void (await port.post(message, thread)),
    openView: async (view) => void (await call({ method: "open_view", event: id, view })),
    ack: async (response) => void send({ t: "ack", id, ...(response ? { response } : {}) }),
  });

  const end = (why: Refusal | "stopped") => {
    if (finished) {
      return;
    }
    finished = true;
    owner?.stop();
    ws?.close();
    finish(why);
  };

  const onFrame = async (frame: ToConnector) => {
    switch (frame.t) {
      case "welcome": {
        const linkedNow = frame.token !== undefined;
        if (frame.token) {
          token = frame.token;
          code = undefined;
          await save(savedPath(o.home), { relay: o.relay, token, user: frame.user });
        }
        signedIn = true;
        dm = frame.dm;
        backoff = 1_000;
        say("connector_signed_in", { linked: linkedNow });
        if (!owner) {
          owner = createOwner({ pac: o.pac, owner: frame.user, statePath: join(o.home, "interfaces", "slack", "connector-state.json"), port, pollMs: o.pollMs, log: say });
          o.onWelcome?.(frame.user, linkedNow);
          await owner.start();
        }
        return;
      }
      case "refused":
        say("connector_refused", { code: frame.code });
        end(frame.code);
        return;
      case "event":
        if (owner) {
          await owner.handle(frame.event, ioFor(frame.id)).catch((error) => say("event_failed", { kind: frame.event.kind, code: codeOf(error) }));
        }
        return;
      case "result": {
        const p = pending.get(frame.id);
        if (p) {
          pending.delete(frame.id);
          clearTimeout(p.timer);
          if (frame.ok) {
            p.done(frame.value);
          } else {
            p.fail(new Error(frame.code));
          }
        }
        return;
      }
    }
  };

  const open = () => {
    if (finished) {
      return;
    }
    const socket = new WebSocket(o.relay);
    ws = socket;
    socket.addEventListener("open", () => {
      if (code) {
        send({ t: "link", code, ...(name ? { name } : {}) });
      } else if (token) {
        send({ t: "hello", token, ...(name ? { name } : {}) });
      } else {
        end("bad_token");
      }
    });
    socket.addEventListener("message", (e) => {
      const frame = parseFrame<ToConnector>(e.data);
      if (frame) {
        void onFrame(frame).catch((error) => say("frame_failed", { code: codeOf(error) }));
      }
    });
    socket.addEventListener("close", () => {
      if (ws !== socket) {
        return;
      }
      signedIn = false;
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.fail(new Error("relay_offline"));
        pending.delete(id);
      }
      if (finished) {
        return;
      }
      say("relay_disconnected", { retryMs: backoff });
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
    // An error is followed by close, which retries.
    socket.addEventListener("error", () => {});
  };

  // The relay shows the PAC name to its person when linking, so a stranger's code can be noticed.
  void o.pac
    .status()
    .then((s) => (name = s.identity?.name))
    .catch(() => undefined)
    .finally(open);

  return { stopped, stop: () => end("stopped") };
}
