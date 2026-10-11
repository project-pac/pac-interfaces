import { codeOf, NAME, type Pac } from "../pac/cli.ts";
import { isApproval } from "../pac/types.ts";
import { ACT, command, MODAL, replyModal, show, type Reply } from "./commands.ts";
import { answerRequest, decide, type Outcome } from "./decide.ts";
import type { Message, OwnerEvent, SlackReply, ViewAck } from "./events.ts";
import { ACTION, VIEW, approvalBlocks, contextOf, esc, parseValue, resolved, textModal, type Block } from "./render.ts";
import { loadState, saveState, syncOnce, type SyncState } from "./sync.ts";

/**
 * The Slack interface for one PAC home and one Slack user, its owner, over
 * whatever carries Slack to it: Socket Mode on the owner's machine (app.ts),
 * or the shared relay (connector.ts). Every event is checked against the
 * owner, and every PAC call goes through the owner's own `pac`.
 */

/** What the core may do in Slack outside an event: all of it in the owner's DM. */
export interface Port {
  dm(): Promise<string>;
  post(message: Message, thread?: string): Promise<string | undefined>;
  update(channel: string, ts: string, message: Message): Promise<void>;
}

/** What one event may do back. Commands and actions are acknowledged before `handle`; a form waits for `ack`. */
export interface Io {
  respond(reply: SlackReply): Promise<void>;
  say(message: Message, thread?: string): Promise<void>;
  openView(view: Block): Promise<void>;
  ack(response?: ViewAck): Promise<void>;
}

export type Log = (event: string, extra?: Record<string, unknown>) => void;

export const log: Log = (event, extra = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...extra }));

export const NOT_OWNER = "This PAC bot is linked to one person's PAC, and it isn't you.";

const RESERVED = ["help", "status", "asks", "threads", "show", "abort", "contacts", "files", "file", "remember", "verify", "trust", "link", "unlink"];

/** Whether a `/pac` line asks PAC something (kept as a record in the DM when typed elsewhere). */
export function isQuestion(text: string): boolean {
  const word = text.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return word !== "" && !RESERVED.includes(word);
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

export interface OwnerOptions {
  pac: Pac;
  owner: string;
  statePath: string;
  port: Port;
  pollMs: number;
  log?: Log;
}

export interface Owner {
  handle(event: OwnerEvent, io: Io): Promise<void>;
  /** First sync, then `pac watch` and a slow poll. */
  start(): Promise<void>;
  stop(): void;
}

export function createOwner(o: OwnerOptions): Owner {
  const { pac, owner, port } = o;
  const say = o.log ?? log;
  const blocksOf = (reply: Reply): Block[] => reply.blocks ?? resolved(reply.text);
  const failed = (error: unknown) => `PAC: \`${esc(codeOf(error))}\``;
  const aside = (text: string): SlackReply => ({ response_type: "ephemeral", replace_original: false, text });

  // --- Sync: one pass at a time, triggered by `pac watch` and a slow poll ----
  let state: SyncState = { asks: {}, answers: {}, threads: {}, primed: false };
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
          const posted = await syncOnce(pac, state, (m) => port.post(m));
          await saveState(o.statePath, state);
          if (posted.requests + posted.approvals + posted.answers) {
            say("synced", posted);
          }
        } catch (error) {
          say("sync_failed", { code: codeOf(error) });
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
      return { text: failed(error) };
    }
  };

  /** A decided card becomes its outcome; a card whose ask changed is posted again as it is now. */
  const finish = async (channel: string | undefined, ts: string | undefined, outcome: Outcome, askId: string) => {
    if (channel && ts) {
      await port.update(channel, ts, { text: outcome.text, blocks: resolved(outcome.text) });
    }
    if (!outcome.ok && outcome.reason === "changed") {
      const ask = await pac.ask(askId);
      if (isApproval(ask) && ask.status === "open") {
        const ctx = contextOf((await pac.txs()).find((t) => t.tx.id === ask.tx)?.tx);
        await port.post({ text: `PAC wants your approval for: ${ctx.goal}`, blocks: approvalBlocks(ask, ctx).blocks });
      }
    }
  };

  const onCommand = async (e: Extract<OwnerEvent, { kind: "command" }>, io: Io) => {
    const reply = await run(e.text);
    if (reply.modal) {
      await io.openView(reply.modal);
      return;
    }
    if (e.channel === (await port.dm().catch(() => undefined))) {
      // In our DM, a normal (in_channel) reply: Slack then keeps the owner's `/pac …` line too.
      await io.respond({ response_type: "in_channel", text: reply.text, blocks: blocksOf(reply) });
      return;
    }
    // Elsewhere nobody else may see PAC's words: a private note here, the record in our DM.
    await io.respond({ response_type: "ephemeral", text: reply.text, blocks: blocksOf(reply) });
    if (isQuestion(e.text)) {
      await port.post({ text: `You asked PAC: ${e.text}`, blocks: transcript(e.text, reply.text) }).catch((error) => say("dm_failed", { code: codeOf(error) }));
    }
  };

  const onMessage = async (e: Extract<OwnerEvent, { kind: "message" }>, io: Io) => {
    // A reply in an answer card's Slack thread is the PAC thread's next turn.
    const tx = e.thread ? state.threads[e.thread] : undefined;
    const reply = tx ? await run(`reply ${tx} ${e.text}`) : await run(e.text);
    if (reply.modal) {
      await io.say({ text: "That opens a form", blocks: resolved("That opens a form: use `/pac remember <name.md>`, or put the text on the lines after the name.") });
      return;
    }
    await io.say({ text: reply.text, blocks: blocksOf(reply) }, e.thread);
  };

  const onAction = async (e: Extract<OwnerEvent, { kind: "action" }>, io: Io) => {
    try {
      switch (e.action) {
        case ACTION.approve:
        case ACTION.decline:
        case ACTION.skip: {
          const value = parseValue(e.value);
          if (!value) {
            return;
          }
          const outcome = e.action === ACTION.skip ? await answerRequest(pac, value, "skip") : await decide(pac, value, e.action === ACTION.approve ? "yes" : "no");
          await finish(e.channel, e.ts, outcome, value.ask);
          return;
        }
        case ACTION.answer:
        case ACTION.edit: {
          const meta = JSON.stringify({ value: e.value ?? "", channel: e.channel, ts: e.ts });
          await io.openView(e.action === ACTION.answer ? textModal(VIEW.answer, meta, "Answer PAC", "Your answer") : textModal(VIEW.edit, meta, "Ask for a change", "What should change about your material?"));
          return;
        }
        // Threads: Show, Reply (modal), Abort (Slack's own confirm dialog first).
        case ACT.show: {
          const reply = await show(pac, e.value ?? "");
          await io.respond({ ...aside(reply.text), blocks: blocksOf(reply) });
          return;
        }
        case ACT.reply:
          await io.openView(replyModal(e.value ?? ""));
          return;
        case ACT.abort:
          await pac.abort(e.value ?? "");
          await io.respond(aside(`:octagonal_sign: Aborted \`${esc(e.value ?? "")}\`. Nothing is released.`));
          return;
      }
    } catch (error) {
      await io.respond(aside(failed(error)));
    }
  };

  const onView = async (e: Extract<OwnerEvent, { kind: "view" }>, io: Io) => {
    const text = (e.values.text ?? "").trim();
    if (e.callback === MODAL.remember) {
      const name = (e.values.name ?? "").trim();
      if (!NAME.test(name)) {
        await io.ack({ response_action: "errors", errors: { name: "Letters, digits, . _ - only, e.g. travel-preferences.md" } });
        return;
      }
      if (!text) {
        await io.ack({ response_action: "errors", errors: { text: "Write something first." } });
        return;
      }
      await io.ack();
      try {
        await pac.put(name, text);
        await port.post({ text: `Saved ${name} in PAC`, blocks: resolved(`:floppy_disk: Saved \`${esc(name)}\` in PAC.`) });
      } catch (error) {
        await port.post({ text: `PAC: ${codeOf(error)}`, blocks: resolved(failed(error)) });
      }
      return;
    }
    if (e.callback !== VIEW.answer && e.callback !== VIEW.edit && e.callback !== MODAL.reply) {
      await io.ack();
      return;
    }
    if (!text) {
      await io.ack({ response_action: "errors", errors: { text: "Write something first." } });
      return;
    }
    await io.ack();
    if (e.callback === MODAL.reply) {
      const reply = await run(`reply ${e.meta} ${text}`);
      await port.post({ text: reply.text, blocks: transcript(text, reply.text) }).catch((error) => say("dm_failed", { code: codeOf(error) }));
      return;
    }
    let meta: { value?: string; channel?: string; ts?: string };
    try {
      meta = JSON.parse(e.meta) as typeof meta;
    } catch {
      return;
    }
    const value = parseValue(meta.value);
    if (!value) {
      return;
    }
    try {
      const outcome = e.callback === VIEW.answer ? await answerRequest(pac, value, "answer", text) : await decide(pac, value, "edit", text);
      await finish(meta.channel, meta.ts, outcome, value.ask);
    } catch (error) {
      await port.post({ text: `PAC: ${codeOf(error)}`, blocks: resolved(failed(error)) });
    }
  };

  let watcher: { stop: () => void } | undefined;
  let poll: NodeJS.Timeout | undefined;
  let stopped = false;

  return {
    async handle(event, io) {
      if (event.user !== owner) {
        // Only the owner's events reach PAC. A form is acknowledged and dropped.
        if (event.kind === "view") {
          await io.ack();
        } else if (event.kind === "message") {
          await io.say({ text: NOT_OWNER, blocks: resolved(NOT_OWNER) });
        } else {
          await io.respond(aside(NOT_OWNER));
        }
        return;
      }
      switch (event.kind) {
        case "command":
          return onCommand(event, io);
        case "message":
          return onMessage(event, io);
        case "action":
          return onAction(event, io);
        case "view":
          return onView(event, io);
      }
    },

    async start() {
      state = await loadState(o.statePath);
      const s = await pac.status().catch(() => undefined);
      say("owner_started", { pac: s?.version, grant: s?.grant?.state ?? "none" });
      await sync();
      // `pac watch` says when something changed; the poll covers a watch that died.
      const follow = () => {
        let timer: NodeJS.Timeout | undefined;
        watcher = pac.watch(
          (event) => {
            if (event.event === "ask" || event.event === "tx" || event.event === "pointer") {
              clearTimeout(timer);
              timer = setTimeout(() => void sync(), 1_000);
            }
          },
          (code) => {
            if (stopped) {
              return;
            }
            say("watch_exited", { code });
            setTimeout(follow, 5_000);
          },
        );
      };
      follow();
      poll = setInterval(() => void sync(), o.pollMs);
    },

    stop() {
      stopped = true;
      watcher?.stop();
      clearInterval(poll);
    },
  };
}
