import bolt from "@slack/bolt";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { Env } from "../pac/types.ts";
import { actionEvent, commandEvent, messageEvent, viewEvent, type SlackReply } from "../slack/events.ts";
import { log } from "../slack/owner.ts";
import { MAX_FRAME, PATH } from "../slack/wire.ts";
import { OFFLINE, onboarding, Relay, type SlackApi } from "./core.ts";
import { Store } from "./store.ts";

const { App, LogLevel, SocketModeReceiver } = bolt;

/**
 * The shared PAC Slack app: one bot for the whole workspace, in Socket Mode,
 * and a WebSocket endpoint (`/connect`) where each person's connector signs in.
 * Runs anywhere connectors can reach (Railway); keeps only who is linked.
 */

export interface RelayConfig {
  botToken: string;
  appToken: string;
  port: number;
  data: string;
  /** Where connectors reach this relay, as people paste it: `wss://…/connect`. */
  publicUrl: string;
  /** How people get the connector, shown when they link. */
  get: string;
}

export function relayConfig(env: Env = process.env): RelayConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`missing ${name}`);
    }
    return value;
  };
  const port = Number(env.PORT ?? 8080) || 8080;
  return {
    botToken: need("SLACK_BOT_TOKEN"),
    appToken: need("SLACK_APP_TOKEN"),
    port,
    data: resolve(env.PAC_RELAY_DATA?.trim() || "relay-data"),
    publicUrl: env.PAC_RELAY_URL?.trim() || `ws://localhost:${port}${PATH}`,
    get: env.PAC_RELAY_GET?.trim() || "git clone https://github.com/project-pac/pac-interfaces && cd pac-interfaces && npm install",
  };
}

const ephemeral = (text: string): SlackReply => ({ response_type: "ephemeral", replace_original: false, text });

export async function startRelay(env: Env = process.env): Promise<void> {
  const config = relayConfig(env);
  const store = await Store.open(join(config.data, "links.json"));
  const receiver = new SocketModeReceiver({ appToken: config.appToken, logLevel: LogLevel.ERROR, clientPingTimeout: 15_000, serverPingTimeout: 60_000 });
  const app = new App({ token: config.botToken, receiver, logLevel: LogLevel.WARN });

  const slack: SlackApi = {
    async openDm(user) {
      const dm = (await app.client.conversations.open({ users: user })).channel?.id;
      if (!dm) {
        throw new Error("no_dm");
      }
      return dm;
    },
    async post(channel, message, thread) {
      return (await app.client.chat.postMessage({ channel, text: message.text, blocks: message.blocks as never, ...(thread ? { thread_ts: thread } : {}) })).ts;
    },
    async update(channel, ts, message) {
      await app.client.chat.update({ channel, ts, text: message.text, blocks: message.blocks as never });
    },
    async openView(trigger, view) {
      await app.client.views.open({ trigger_id: trigger, view: view as never });
    },
    async respond(url, reply) {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(reply) });
      if (!r.ok) {
        throw new Error(`respond_${r.status}`);
      }
    },
  };
  const relay = new Relay({ store, slack, log });

  /** For someone whose connector isn't here: how to link, or that it's offline. */
  const notHere = (user: string) => (relay.linked(user) ? OFFLINE : onboarding(relay.issueCode(user), config.publicUrl, config.get));
  const linkWords = async (user: string, text: string): Promise<string | undefined> => {
    const word = text.trim().split(/\s+/)[0]?.toLowerCase();
    if (word === "link") {
      return onboarding(relay.issueCode(user), config.publicUrl, config.get) + (relay.linked(user) ? "\nLinking again replaces the connector you linked before." : "");
    }
    if (word === "unlink") {
      return (await relay.unlink(user)) ? ":broken_chain: Unlinked. PAC no longer hears this Slack account. `/pac link` connects it again." : "This Slack account isn't linked to any PAC.";
    }
    return undefined;
  };

  app.command("/pac", async ({ command: c, ack, respond }) => {
    await ack();
    const own = await linkWords(c.user_id, c.text);
    if (own) {
      await respond(ephemeral(own));
      return;
    }
    const r = await relay.deliver(commandEvent(c), { responseUrl: c.response_url, trigger: c.trigger_id });
    if (!r.delivered) {
      await respond(ephemeral(notHere(c.user_id)));
    }
  });

  app.message(async ({ message, say }) => {
    const event = messageEvent(message);
    if (!event || event.kind !== "message") {
      return;
    }
    const own = await linkWords(event.user, event.text);
    const text = own ?? ((await relay.deliver(event)).delivered ? undefined : notHere(event.user));
    if (text) {
      await say({ text, ...(event.thread ? { thread_ts: event.thread } : {}) });
    }
  });

  app.action(/^pac_/, async ({ ack, body, respond }) => {
    await ack();
    const event = actionEvent(body);
    if (!event) {
      return;
    }
    const b = body as { response_url?: string; trigger_id?: string };
    const r = await relay.deliver(event, { ...(b.response_url ? { responseUrl: b.response_url } : {}), ...(b.trigger_id ? { trigger: b.trigger_id } : {}) });
    if (!r.delivered) {
      await respond(ephemeral(notHere(event.user)) as never);
    }
  });

  app.view(/^pac_/, async ({ ack, body, view }) => {
    const r = await relay.deliver(viewEvent(body.user.id, view));
    await ack(r.ack as never);
    if (!r.delivered) {
      await slack.post(await relay.dm(body.user.id), { text: OFFLINE, blocks: [{ type: "section", text: { type: "mrkdwn", text: OFFLINE } }] }).catch(() => {});
    }
  });

  await app.start();
  await serveConnectors(relay, config.port);
  log("relay_started", { port: config.port, ...relay.stats() });
}

/** `/health`, and connectors' WebSockets at `/connect`. Resolves once listening; `close` stops it. */
export async function serveConnectors(relay: Relay, port: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, ...relay.stats() }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const alive = new WeakMap<WebSocket, boolean>();
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://relay").pathname !== PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = relay.open({ send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) });
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("message", (data, binary) => (binary ? ws.close(1003, "text_only") : void conn.receive(data.toString())));
      ws.on("close", () => conn.close());
      ws.on("error", () => ws.terminate());
    });
  });
  // Proxies drop idle sockets, and a sleeping laptop never says goodbye: ping, and drop the silent.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 25_000);

  await new Promise<void>((done) => server.listen(port, done));
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    close: () =>
      new Promise<void>((done) => {
        clearInterval(pinger);
        for (const ws of wss.clients) {
          ws.terminate();
        }
        server.close(() => done());
      }),
  };
}
