import { stripFrontMatter, type Pac } from "../pac/cli.ts";
import type { Ask, Session } from "../pac/types.ts";

/**
 * The sessions this PAC home is in, every detail it may read, through its
 * own `pac`. Served only by the local explorer, on 127.0.0.1, to its own
 * person: what other people wrote is in here, so none of it is ever hosted.
 */

export const SESSION_ID = /^s_[0-9a-f]{4,32}$/;

export interface Me {
  id: string;
  name: string;
  version: string;
}

export interface SessionDetail {
  /** `pac session` as printed: its turns, people, asks, results, files read, and the agent's code. */
  session: Session;
  /** Every ask of this session put to this person, each with PAC's own text. */
  asks: Ask[];
  /** This person's released results, by turn, front matter removed. */
  results: { turn: number; file: string; text: string }[];
}

export async function me(pac: Pac): Promise<Me> {
  const s = await pac.status();
  return { id: s.identity?.user ?? "", name: s.identity?.name ?? "", version: s.version };
}

export async function mySessions(pac: Pac): Promise<Session[]> {
  return pac.sessions();
}

export async function mySession(pac: Pac, ref: string): Promise<SessionDetail | undefined> {
  if (!SESSION_ID.test(ref)) {
    return undefined;
  }
  const session = await pac.session(ref).catch(() => undefined);
  if (!session?.id) {
    return undefined;
  }
  const asks = (await pac.asks(true).catch(() => [] as Ask[])).filter((a) => a.session === session.id);
  const results = await Promise.all(
    (session.results ?? []).map(async (r) => ({ turn: r.turn, file: r.file, text: await pac.cat(r.file).then((f) => stripFrontMatter(f.content).trim(), () => "") })),
  );
  return { session, asks, results };
}
