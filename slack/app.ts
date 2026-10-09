import bolt from "@slack/bolt";
import { join } from "node:path";
import { codeOf, Pac, pacHome } from "../pac/cli.ts";
import { isApproval, type Env } from "../pac/types.ts";
import { answerRequest, decide, type Outcome } from "./decide.ts";
import { ACTION, VIEW, approvalBlocks, contextOf, esc, parseValue, resolved, textModal, type Block } from "./render.ts";
import { loadState, saveState, syncOnce, type SyncState } from "./sync.ts";

const { App, LogLevel } = bolt;

/**
 * Owner mode: one PAC home (PAC_HOME), one Slack user (PAC_SLACK_OWNER),
 * on whatever network that home joined. Every command, click and modal
 * submit is checked against the owner. Runs on the owner's machine:
 * Socket Mode, no public URL, keys never leave the home.
 */

export const HELP = [
  "*PAC in Slack*",
  "`/pac <question>` (or DM me the question): ask PAC",
  "`/pac status`: who you are in PAC and what waits",
  "`/pac asks`: show open questions and approvals again",
  "PAC's questions and approvals arrive here as cards; only you can answer or decide them.",
].join("\n");

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

/** A typed line from the owner: what to do and what to say back. */
export async function command(pac: Pac, text: string, resync: () => Promise<void>): Promise<string> {
  const t = text.trim();
  const word = t.toLowerCase();
  if (!t || word === "help") {
    return HELP;
  }
  if (word === "status") {
    const s = await pac.status();
    const problems = (s.problems ?? []).map((p) => (typeof p === "string" ? p : p.code));
    return `You are *${esc(s.identity?.name ?? "?")}* in PAC ${esc(s.version)} · grant: \`${s.grant?.state ?? "none"}\` · open asks: ${s.asks?.open ?? 0}${problems.length ? ` · problems: ${problems.map((p) => `\`${p}\``).join(", ")}` : ""}`;
  }
  if (word === "asks") {
    await resync();
    return "Open questions and approvals are posted again in our DM.";
  }
  const sent = await pac.goal(t.replace(/^ask\s+/i, ""));
  if (sent.receipt?.status === "rejected") {
    return `PAC refused it: \`${sent.receipt.error ?? "rejected"}\``;
  }
  return `:mag: Sent to PAC${sent.tx ? ` (\`${sent.tx}\`)` : ""}. The answer comes here once everyone involved approves what of theirs it carries.`;
}

export async function startSlack(env: Env = process.env): Promise<void> {
  const config = slackConfig(env);
  const pac = new Pac({ ...env, PAC_HOME: config.home });
  const statePath = join(config.home, "interfaces", "slack", "state.json");
  const app = new App({ token: config.botToken, appToken: config.appToken, socketMode: true, logLevel: LogLevel.WARN });
  const notOwner = "This PAC bot is linked to one person's PAC, and it isn't you.";

  let dm: string | undefined;
  const post = async (message: { text: string; blocks: Block[] }) => {
    if (!dm) {
      const opened = await app.client.conversations.open({ users: config.owner });
      dm = opened.channel?.id;
      if (!dm) {
        throw new Error("no_dm");
      }
    }
    await app.client.chat.postMessage({ channel: dm, text: message.text, blocks: message.blocks as never });
  };

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
          const posted = await syncOnce(pac, state, post);
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

  const say = async (text: string) => post({ text, blocks: resolved(text) });

  app.command("/pac", async ({ command: c, ack, respond }) => {
    await ack();
    if (c.user_id !== config.owner) {
      await respond({ response_type: "ephemeral", text: notOwner });
      return;
    }
    try {
      await respond({ response_type: "ephemeral", text: await command(pac, c.text, resync) });
    } catch (error) {
      await respond({ response_type: "ephemeral", text: `PAC: \`${codeOf(error)}\`` });
    }
  });

  app.message(async ({ message, say: reply }) => {
    const m = message as { channel_type?: string; user?: string; text?: string; subtype?: string; bot_id?: string };
    if (m.channel_type !== "im" || m.subtype || m.bot_id || !m.user || !m.text?.trim()) {
      return;
    }
    if (m.user !== config.owner) {
      await reply(notOwner);
      return;
    }
    try {
      await reply(await command(pac, m.text, resync));
    } catch (error) {
      await reply(`PAC: \`${codeOf(error)}\``);
    }
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
        await say(`PAC: \`${codeOf(error)}\``);
      }
    });
  }

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
