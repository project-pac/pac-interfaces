import bolt from "@slack/bolt";
import { join } from "node:path";
import { Pac, pacHome } from "../pac/cli.ts";
import type { Env } from "../pac/types.ts";
import { actionEvent, commandEvent, messageEvent, viewEvent } from "./events.ts";
import { createOwner, type Io, type Port } from "./owner.ts";

const { App, LogLevel, SocketModeReceiver } = bolt;

export { command, HELP, remember } from "./commands.ts";
export { isQuestion, transcript } from "./owner.ts";

/**
 * Owner mode: one PAC home (PAC_HOME), one Slack user (PAC_SLACK_OWNER), and
 * a Slack app of the owner's own. Runs on the owner's machine: Socket Mode,
 * no public URL, keys never leave the home. For one shared Slack app that
 * anyone can connect to, see relay/ and connector.ts.
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  owner: string;
  home: string;
  pollMs: number;
}

export const pollMsOf = (env: Env): number => Math.max(15_000, Number(env.PAC_SLACK_POLL_MS ?? 60_000) || 60_000);

export function slackConfig(env: Env = process.env): SlackConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`missing ${name}`);
    }
    return value;
  };
  return { botToken: need("SLACK_BOT_TOKEN"), appToken: need("SLACK_APP_TOKEN"), owner: need("PAC_SLACK_OWNER"), home: pacHome(env), pollMs: pollMsOf(env) };
}

export async function startSlack(env: Env = process.env): Promise<void> {
  const config = slackConfig(env);
  // Laptops sleep and Wi-Fi blips: wider ping windows, and Bolt reconnects by itself.
  const receiver = new SocketModeReceiver({ appToken: config.appToken, logLevel: LogLevel.ERROR, clientPingTimeout: 15_000, serverPingTimeout: 60_000 });
  const app = new App({ token: config.botToken, receiver, logLevel: LogLevel.WARN });

  let dm: string | undefined;
  const port: Port = {
    async dm() {
      if (!dm) {
        dm = (await app.client.conversations.open({ users: config.owner })).channel?.id;
        if (!dm) {
          throw new Error("no_dm");
        }
      }
      return dm;
    },
    async post(message, thread) {
      const r = await app.client.chat.postMessage({ channel: await port.dm(), text: message.text, blocks: message.blocks as never, ...(thread ? { thread_ts: thread } : {}) });
      return r.ts;
    },
    async update(channel, ts, message) {
      await app.client.chat.update({ channel, ts, text: message.text, blocks: message.blocks as never });
    },
  };
  const owner = createOwner({ pac: new Pac({ ...env, PAC_HOME: config.home }), owner: config.owner, statePath: join(config.home, "interfaces", "slack", "state.json"), port, pollMs: config.pollMs });
  const none = async () => {};

  app.command("/pac", async ({ command: c, ack, respond, client }) => {
    await ack();
    const io: Io = { respond: async (r) => void (await respond(r as never)), say: none, openView: async (view) => void (await client.views.open({ trigger_id: c.trigger_id, view: view as never })), ack: none };
    await owner.handle(commandEvent(c), io);
  });

  app.message(async ({ message, say }) => {
    const event = messageEvent(message);
    if (!event) {
      return;
    }
    const io: Io = { respond: none, say: async (m, thread) => void (await say({ text: m.text, blocks: m.blocks as never, ...(thread ? { thread_ts: thread } : {}) })), openView: none, ack: none };
    await owner.handle(event, io);
  });

  app.action(/^pac_/, async ({ ack, body, respond, client }) => {
    await ack();
    const event = actionEvent(body);
    if (!event) {
      return;
    }
    const trigger = (body as { trigger_id?: string }).trigger_id ?? "";
    const io: Io = { respond: async (r) => void (await respond(r as never)), say: none, openView: async (view) => void (await client.views.open({ trigger_id: trigger, view: view as never })), ack: none };
    await owner.handle(event, io);
  });

  app.view(/^pac_/, async ({ ack, body, view }) => {
    let acked = false;
    const io: Io = {
      respond: none,
      say: none,
      openView: none,
      ack: async (response) => {
        acked = true;
        await ack(response as never);
      },
    };
    await owner.handle(viewEvent(body.user.id, view), io);
    if (!acked) {
      await ack();
    }
  });

  await app.start();
  await owner.start();
}
