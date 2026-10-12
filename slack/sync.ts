import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripFrontMatter, type Pac } from "../pac/cli.ts";
import { ended, latest } from "../pac/types.ts";
import { sessionButtons } from "./commands.ts";
import { answerBlocks, askBlocks, askSummary, type Block } from "./render.ts";

/** What the bridge already told the owner, so a restart doesn't repeat it. */
export interface SyncState {
  asks: Record<string, true>;
  /** Results posted, by `<session>:<turn>`. */
  answers: Record<string, true>;
  /** Slack message ts of an answer card → its PAC session, so a Slack thread reply is the session's next turn. */
  threads: Record<string, string>;
  /** Set after the first pass: results released before the bridge started aren't re-sent. */
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
 * One pass: every open ask not yet shown, of any kind, then every result
 * released since the bridge started. An item is marked seen only after it
 * was posted.
 */
export async function syncOnce(pac: Pac, state: SyncState, post: Post): Promise<{ asks: number; answers: number }> {
  const posted = { asks: 0, answers: 0 };
  const [asks, sessions] = await Promise.all([pac.asks(), pac.sessions()]);
  for (const ask of asks) {
    if (ask.status !== "open" || state.asks[ask.id]) {
      continue;
    }
    await post({ text: askSummary(ask), blocks: askBlocks(ask) });
    state.asks[ask.id] = true;
    posted.asks++;
  }
  for (const session of sessions) {
    for (const result of session.results ?? []) {
      const key = `${session.id}:${result.turn}`;
      if (state.answers[key]) {
        continue;
      }
      if (state.primed) {
        const file = await pac.cat(result.file);
        const ts = await post({
          text: `PAC answered: ${session.turns.find((t) => t.n === result.turn)?.prompt ?? ""}`,
          blocks: [...answerBlocks(session, result.turn, stripFrontMatter(file.content)), sessionButtons(session.id, ended(latest(session)?.status ?? "answered")), { type: "context", elements: [{ type: "mrkdwn", text: "Reply in this Slack thread to ask everyone in it a follow-up." }] }],
        });
        if (ts) {
          state.threads[ts] = session.id;
        }
        posted.answers++;
      }
      state.answers[key] = true;
    }
  }
  state.primed = true;
  return posted;
}
