import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontMatter, type Pac } from "../pac/cli.ts";
import { isApproval } from "../pac/types.ts";
import { threadButtons } from "./commands.ts";
import { answerBlocks, approvalBlocks, contextOf, requestBlocks, type Block } from "./render.ts";

/** What the bridge already told the owner, so a restart doesn't repeat it. */
export interface SyncState {
  asks: Record<string, true>;
  answers: Record<string, true>;
  /** Slack message ts of an answer card → its PAC tx, so a Slack thread reply continues the PAC thread. */
  threads: Record<string, string>;
  /** Set after the first pass: answers released before the bridge started aren't re-sent. */
  primed: boolean;
}

const THREADS_KEPT = 500;

export async function loadState(path: string): Promise<SyncState> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<SyncState>;
    return { asks: raw.asks ?? {}, answers: raw.answers ?? {}, threads: raw.threads ?? {}, primed: raw.primed ?? false };
  } catch {
    return { asks: {}, answers: {}, threads: {}, primed: false };
  }
}

export async function saveState(path: string, state: SyncState): Promise<void> {
  const threads = Object.entries(state.threads);
  if (threads.length > THREADS_KEPT) {
    state.threads = Object.fromEntries(threads.slice(-THREADS_KEPT));
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await rename(tmp, path);
}

/** Posts to the owner's DM; returns the message ts. */
export type Post = (message: { text: string; blocks: Block[] }) => Promise<string | undefined | void>;

/**
 * One pass: every open ask not yet shown, then every answer released since
 * the bridge started. An item is marked seen only after it was posted.
 */
export async function syncOnce(pac: Pac, state: SyncState, post: Post): Promise<{ requests: number; approvals: number; answers: number }> {
  const posted = { requests: 0, approvals: 0, answers: 0 };
  const [asks, txs] = await Promise.all([pac.asks(), pac.txs()]);
  const byTx = new Map(txs.map((t) => [t.tx.id, t.tx]));
  for (const ask of asks) {
    if (ask.status !== "open" || state.asks[ask.id]) {
      continue;
    }
    const ctx = contextOf(byTx.get(ask.tx));
    if (isApproval(ask)) {
      await post({ text: `PAC wants your approval for: ${ctx.goal}`, blocks: approvalBlocks(ask, ctx).blocks });
      posted.approvals++;
    } else {
      await post({ text: `PAC asks: ${(ask.body as { question: string }).question}`, blocks: requestBlocks(ask as never, ctx) });
      posted.requests++;
    }
    state.asks[ask.id] = true;
  }
  for (const { pointer, tx } of txs) {
    if (!pointer.resultFile || state.answers[tx.id]) {
      continue;
    }
    if (state.primed) {
      const file = await pac.cat(pointer.resultFile);
      const ts = await post({
        text: `PAC answered: ${tx.intent?.prompt ?? ""}`,
        blocks: [...answerBlocks(tx, stripFrontMatter(file.content)), threadButtons(tx.id, tx.state), { type: "context", elements: [{ type: "mrkdwn", text: "Reply in this Slack thread to ask everyone in it a follow-up." }] }],
      });
      if (ts) {
        state.threads[ts] = tx.id;
      }
      posted.answers++;
    }
    state.answers[tx.id] = true;
  }
  state.primed = true;
  return posted;
}
