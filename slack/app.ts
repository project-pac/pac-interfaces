import bolt from "@slack/bolt";
import { join } from "node:path";
import { codeOf, NAME, Pac, pacHome } from "../pac/cli.ts";
import { isApproval, type Env } from "../pac/types.ts";
import { ACT, command, MODAL, remember, replyModal, show, type Reply } from "./commands.ts";
import { answerRequest, decide, type Outcome } from "./decide.ts";
import { ACTION, VIEW, approvalBlocks, contextOf, esc, parseValue, resolved, textModal, type Block } from "./render.ts";
import { loadState, saveState, syncOnce, type SyncState } from "./sync.ts";

const { App, LogLevel, SocketModeReceiver } = bolt;

export { command, HELP } from "./commands.ts";

/**
 * Owner mode: one PAC home (PAC_HOME), one Slack user (PAC_SLACK_OWNER),
 * on whatever network that home joined. Every command, click and modal
 * submit is checked against the owner. Runs on the owner's machine:
 * Socket Mode, no public URL, keys never leave the home.
 */

export interface SlackConfig {
  botToken: string;
  appToken: string;
  owner: string;
  home: string;
  pollMs: number;
}

export function slackConfig(env: Env = process.env): SlackConfig {
  const need = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`missing ${name}`);
    }
    return value;
  };
  return { botToken: need("SLACK_BOT_TOKEN"), appToken: need("SLACK_APP_TOKEN"), owner: need("PAC_SLACK_OWNER"), home: pacHome(env), pollMs: Math.max(15_000, Number(env.PAC_SLACK_POLL_MS ?? 60_000) || 60_000) };
}

const log = (event: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

/** Whether a `/pac` line asks PAC something (kept as a record in the DM when typed elsewhere). */
export function isQuestion(text: string): boolean {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return word !== "" && !["help", "status", "asks", "threads", "show", "abort", "contacts", "files", "file", "remember", "verify", "trust"].includes(word);
}

/** The owner's own `/pac` line and PAC's reply, kept in our DM. */
export function transcript(question: string, reply: string): Block[] {
  const q = esc(question.trim().replace(/^ask\s+/i, ""))
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    { type: "section", text: { type: "mrkdwn", text: `*You asked PAC:*\n${q}`.slice(0, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: reply.slice(0, 2900) }] },
  ];
}

export async function startSlack(env: Env = process.env): Promise<void> {
  const config = slackConfig(env);
  const pac = new Pac({ ...env, PAC_HOME: config.home });
  const statePath = join(config.home, "interfaces", "slack", "state.json");
  // Laptops sleep and Wi-Fi blips: wider ping windows, and Bolt reconnects by itself.
  const receiver = new SocketModeReceiver({ appToken: config.appToken, logLevel: LogLevel.ERROR, clientPingTimeout: 15_000, serverPingTimeout: 60_000 });
  const app = new App({ token: config.botToken, receiver, logLevel: LogLevel.WARN });
  const notOwner = "This PAC bot is linked to one person's PAC, and it isn't you.";

  let dm: string | undefined;
  const dmId = async (): Promise<string> => {
    if (!dm) {
      const opened = await app.client.conversations.open({ users: config.owner });
      dm = opened.channel?.id;
      if (!dm) {
        throw new Error("no_dm");
      }
    }
    return dm;
  };
  const post = async (message: { text: string; blocks: Block[] }, thread?: string): Promise<string | undefined> => {
    const r = await app.client.chat.postMessage({ channel: await dmId(), text: message.text, blocks: message.blocks as never, ...(thread ? { thread_ts: thread } : {}) });
    return r.ts;
  };
  const blocksOf = (reply: Reply): Block[] => reply.blocks ?? resolved(reply.text);

  // --- Sync: one pass at a time, triggered by `pac watch` and a slow poll ----
  let state: SyncState = await loadState(statePath);
  let running: Promise<void> | undefined;
  let again = false;
  const sync = async (): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          const posted = await syncOnce(pac, state, (m) => post(m));
          await saveState(statePath, state);
          if (posted.requests + posted.approvals + posted.answers) {
            log("synced", posted);
          }
        } catch (error) {
          log("sync_failed", { code: codeOf(error) });
        }
      } while (again);
    })().finally(() => (running = undefined));
    return running;
  };
  const resync = async () => {
    const open = new Set((await pac.asks()).filter((a) => a.status === "open").map((a) => a.id));
    state = { ...state, asks: Object.fromEntries(Object.entries(state.asks).filter(([id]) => !open.has(id))) };
    await sync();
  };
  const run = async (text: string): Promise<Reply> => {
    try {
      return await command(pac, text, resync);
    } catch (error) {
      return { text: `PAC: \`${esc(codeOf(error))}\`` };
    }
  };

  // --- Typed: /pac anywhere, or the owner's DM -------------------------------
  app.command("/pac", async ({ command: c, ack, respond, client }) => {
    await ack();
    if (c.user_id !== config.owner) {
      await respond({ response_type: "ephemeral", text: notOwner });
      return;
    }
    const reply = await run(c.text);
    if (reply.modal) {
      await client.views.open({ trigger_id: c.trigger_id, view: reply.modal as never });
      return;
    }
    const inDm = c.channel_id === (await dmId().catch(() => undefined));
    if (inDm) {
      // In our DM, a normal (in_channel) reply: Slack then keeps the owner's `/pac …` line too.
      await respond({ response_type: "in_channel", text: reply.text, blocks: blocksOf(reply) as never });
      return;
    }
    // Elsewhere nobody else may see PAC's words: a private note here, the record in our DM.
    await respond({ response_type: "ephemeral", text: reply.text, blocks: blocksOf(reply) as never });
    if (isQuestion(c.text)) {
      await post({ text: `You asked PAC: ${c.text}`, blocks: transcript(c.text, reply.text) }).catch((error) => log("dm_failed", { code: codeOf(error) }));
    }
  });

  app.message(async ({ message, say }) => {
    const m = message as { channel_type?: string; user?: string; text?: string; subtype?: string; bot_id?: string; thread_ts?: string; ts?: string };
    if (m.channel_type !== "im" || m.subtype || m.bot_id || !m.user || !m.text?.trim()) {
      return;
    }
    if (m.user !== config.owner) {
      await say(notOwner);
      return;
    }
    // A reply in an answer card's Slack thread is the PAC thread's next turn.
    const tx = m.thread_ts ? state.threads[m.thread_ts] : undefined;
    const reply = tx ? await run(`reply ${tx} ${m.text}`) : await run(m.text);
    if (reply.modal) {
      await say("That opens a form: use `/pac remember <name.md>`, or put the text on the lines after the name.");
      return;
    }
    await say({ text: reply.text, blocks: blocksOf(reply) as never, ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}) });
  });

  // --- Buttons and modals: the owner's click alone ---------------------------
  type Body = { user: { id: string }; trigger_id: string; actions: { value?: string }[]; channel?: { id: string }; message?: { ts: string } };

  const finish = async (channel: string | undefined, ts: string | undefined, outcome: Outcome, askId: string) => {
    if (channel && ts) {
      await app.client.chat.update({ channel, ts, text: outcome.text, blocks: resolved(outcome.text) as never });
    }
    if (!outcome.ok && outcome.reason === "changed") {
      const ask = await pac.ask(askId);
      if (isApproval(ask) && ask.status === "open") {
        const ctx = contextOf((await pac.txs()).find((t) => t.tx.id === ask.tx)?.tx);
        await post({ text: `PAC wants your approval for: ${ctx.goal}`, blocks: approvalBlocks(ask, ctx).blocks });
      }
    }
  };

  for (const [actionId, choice] of [
    [ACTION.approve, "yes"],
    [ACTION.decline, "no"],
  ] as const) {
    app.action(actionId, async ({ ack, body, respond }) => {
      await ack();
      const b = body as unknown as Body;
      const value = parseValue(b.actions[0]?.value);
      if (b.user.id !== config.owner || !value) {
        await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
        return;
      }
      try {
        await finish(b.channel?.id, b.message?.ts, await decide(pac, value, choice), value.ask);
      } catch (error) {
        await respond({ response_type: "ephemeral", replace_original: false, text: `PAC: \`${codeOf(error)}\`` });
      }
    });
  }

  app.action(ACTION.skip, async ({ ack, body, respond }) => {
    await ack();
    const b = body as unknown as Body;
    const value = parseValue(b.actions[0]?.value);
    if (b.user.id !== config.owner || !value) {
      await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
      return;
    }
    try {
      await finish(b.channel?.id, b.message?.ts, await answerRequest(pac, value, "skip"), value.ask);
    } catch (error) {
      await respond({ response_type: "ephemeral", replace_original: false, text: `PAC: \`${codeOf(error)}\`` });
    }
  });

  for (const [actionId, callback, title, label] of [
    [ACTION.answer, VIEW.answer, "Answer PAC", "Your answer"],
    [ACTION.edit, VIEW.edit, "Ask for a change", "What should change about your material?"],
  ] as const) {
    app.action(actionId, async ({ ack, body, client, respond }) => {
      await ack();
      const b = body as unknown as Body;
      if (b.user.id !== config.owner) {
        await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
        return;
      }
      const meta = JSON.stringify({ value: b.actions[0]?.value ?? "", channel: b.channel?.id, ts: b.message?.ts });
      await client.views.open({ trigger_id: b.trigger_id, view: textModal(callback, meta, title, label) as never });
    });
  }

  for (const callback of [VIEW.answer, VIEW.edit]) {
    app.view(callback, async ({ ack, body, view }) => {
      const text = (view.state.values.text?.value?.value ?? "").trim();
      if (body.user.id !== config.owner) {
        await ack();
        return;
      }
      if (!text) {
        await ack({ response_action: "errors", errors: { text: "Write something first." } });
        return;
      }
      await ack();
      const meta = JSON.parse(view.private_metadata) as { value: string; channel?: string; ts?: string };
      const value = parseValue(meta.value);
      if (!value) {
        return;
      }
      try {
        const outcome = callback === VIEW.answer ? await answerRequest(pac, value, "answer", text) : await decide(pac, value, "edit", text);
        await finish(meta.channel, meta.ts, outcome, value.ask);
      } catch (error) {
        await post({ text: `PAC: ${codeOf(error)}`, blocks: resolved(`PAC: \`${codeOf(error)}\``) });
      }
    });
  }

  // Threads: Show, Reply (modal), Abort (Slack's own confirm dialog first).
  app.action(ACT.show, async ({ ack, body, respond }) => {
    await ack();
    const b = body as unknown as Body;
    if (b.user.id !== config.owner) {
      await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
      return;
    }
    const reply = await show(pac, b.actions[0]?.value ?? "").catch((error) => ({ text: `PAC: \`${codeOf(error)}\``, blocks: undefined }));
    await respond({ response_type: "ephemeral", replace_original: false, text: reply.text, blocks: blocksOf(reply) as never });
  });

  app.action(ACT.reply, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as unknown as Body;
    if (b.user.id !== config.owner) {
      await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
      return;
    }
    await client.views.open({ trigger_id: b.trigger_id, view: replyModal(b.actions[0]?.value ?? "") as never });
  });

  app.view(MODAL.reply, async ({ ack, body, view }) => {
    const text = (view.state.values.text?.value?.value ?? "").trim();
    if (body.user.id !== config.owner) {
      await ack();
      return;
    }
    if (!text) {
      await ack({ response_action: "errors", errors: { text: "Write something first." } });
      return;
    }
    await ack();
    const reply = await run(`reply ${view.private_metadata} ${text}`);
    await post({ text: reply.text, blocks: [...transcript(text, reply.text)] }).catch((error) => log("dm_failed", { code: codeOf(error) }));
  });

  app.action(ACT.abort, async ({ ack, body, respond }) => {
    await ack();
    const b = body as unknown as Body;
    const tx = b.actions[0]?.value ?? "";
    if (b.user.id !== config.owner) {
      await respond({ response_type: "ephemeral", replace_original: false, text: notOwner });
      return;
    }
    try {
      await pac.abort(tx);
      await respond({ response_type: "ephemeral", replace_original: false, text: `:octagonal_sign: Aborted \`${esc(tx)}\`. Nothing is released.` });
    } catch (error) {
      await respond({ response_type: "ephemeral", replace_original: false, text: `PAC: \`${codeOf(error)}\`` });
    }
  });

  app.view(MODAL.remember, async ({ ack, body, view }) => {
    const name = (view.state.values.name?.value?.value ?? "").trim();
    const text = (view.state.values.text?.value?.value ?? "").trim();
    if (body.user.id !== config.owner) {
      await ack();
      return;
    }
    if (!NAME.test(name)) {
      await ack({ response_action: "errors", errors: { name: "Letters, digits, . _ - only, e.g. travel-preferences.md" } });
      return;
    }
    if (!text) {
      await ack({ response_action: "errors", errors: { text: "Write something first." } });
      return;
    }
    await ack();
    try {
      await pac.put(name, text);
      await post({ text: `Saved ${name} in PAC`, blocks: resolved(`:floppy_disk: Saved \`${esc(name)}\` in PAC.`) });
    } catch (error) {
      await post({ text: `PAC: ${codeOf(error)}`, blocks: resolved(`PAC: \`${codeOf(error)}\``) });
    }
  });

  await app.start();
  const s = await pac.status();
  log("slack_started", { pac: s.version, grant: s.grant?.state ?? "none" });
  await sync();

  // `pac watch` says when something changed; the poll covers a watch that died.
  const follow = () => {
    let timer: NodeJS.Timeout | undefined;
    pac.watch(
      (event) => {
        if (event.event === "ask" || event.event === "tx" || event.event === "pointer") {
          clearTimeout(timer);
          timer = setTimeout(() => void sync(), 1_000);
        }
      },
      (code) => {
        log("watch_exited", { code });
        setTimeout(follow, 5_000);
      },
    );
  };
  follow();
  setInterval(() => void sync(), config.pollMs);
}

export { remember };
