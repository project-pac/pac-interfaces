import { stripFrontMatter, type Pac } from "../pac/cli.ts";
import type { Ask, TxEntry } from "../pac/types.ts";

/**
 * The txs this PAC home is in, every detail it may read, through its own
 * `pac`. Served only by the local explorer, on 127.0.0.1, to its own person:
 * what other people wrote is in here, so none of it is ever hosted.
 */

export const TX_ID = /^tx_[A-Za-z0-9]{1,128}$/;

export interface Me {
  id: string;
  name: string;
  version: string;
}

export interface TxDetail {
  /** `pac tx show` as printed: the tx, its pointer, rounds, and who built on it. */
  shown: Record<string, unknown>;
  /** Asks of this tx put to this person, each with PAC's own text. */
  asks: Ask[];
  /** This person's released version, front matter removed. */
  result?: string;
}

export async function me(pac: Pac): Promise<Me> {
  const s = await pac.status();
  return { id: s.identity?.user ?? "", name: s.identity?.name ?? "", version: s.version };
}

export async function myTxs(pac: Pac): Promise<TxEntry[]> {
  return (await pac.txs()).sort((a, b) => (b.tx.updatedAt ?? b.tx.createdAt).localeCompare(a.tx.updatedAt ?? a.tx.createdAt));
}

export async function myTx(pac: Pac, id: string): Promise<TxDetail | undefined> {
  if (!TX_ID.test(id)) {
    return undefined;
  }
  const [shown, asks] = await Promise.all([pac.tx(id).catch(() => undefined) as Promise<Record<string, unknown> | undefined>, pac.run<Ask[]>(["asks", "--all", "--tx", id]).catch(() => [] as Ask[])]);
  if (!shown || typeof shown !== "object" || !shown.tx) {
    return undefined;
  }
  const resultFile = (shown.pointer as { resultFile?: string } | undefined)?.resultFile;
  const result = resultFile ? await pac.cat(resultFile).then((f) => stripFrontMatter(f.content).trim(), () => undefined) : undefined;
  return { shown, asks, ...(result !== undefined ? { result } : {}) };
}
