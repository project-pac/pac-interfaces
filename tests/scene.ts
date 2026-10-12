import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pac } from "../pac/cli.ts";
import type { ApprovalBody, Ask, RequestBody, TxEntry } from "../pac/types.ts";

export const ME = "u_me";
export const BOB = "u_bob";
export const QUOTE = "I rent a 1-bedroom in Alfama for 1400 EUR <!channel>";

export const tx = (id: string, extra: Partial<TxEntry["pointer"]> = {}): TxEntry => ({
  pointer: { tx: id, role: "participant", at: "2026-10-09T04:00:00Z", ...extra },
  tx: { id, initiator: BOB, participants: [{ user: BOB, name: "Bob" }, { user: ME, name: "Me" }], intent: { prompt: "What does a 1-bed in Lisbon cost?" }, state: "running", createdAt: "2026-10-09T04:00:00Z" },
});

export const request = (id = "a_req", status: Ask["status"] = "open"): Ask<RequestBody> => ({ id, tx: "tx_1", step: "ask-1", status, body: { kind: "request", question: "Where do you rent?" } });

export const approval = (id = "a_appr", status: Ask["status"] = "open", summary = "Shares your rent with Bob."): Ask<ApprovalBody> => ({
  id,
  tx: "tx_1",
  step: "review-1",
  status,
  body: {
    kind: "approval",
    round: 1,
    resultsSha256: "abc",
    recipients: [{ user: BOB, name: "Bob" }],
    yourFiles: [{ file: "f_1", name: "lisbon.md" }],
    disclosures: [{ to: BOB, items: [{ source: "f_1", quote: QUOTE, how: "The answer.", by: ["execute"] }], overlaps: [], edits: [] }],
    summary,
    whyIncluded: "You live there.",
    unverifiedQuotes: 0,
    revisedFor: [],
  },
});

export interface Scene {
  status?: unknown;
  asks?: Ask[];
  txs?: TxEntry[];
  files?: unknown[];
  cat?: Record<string, unknown>;
  goal?: unknown;
  fail?: Record<string, { code: string; exit?: number }>;
  watch?: unknown[];
  /** `tx show <id>` output by id; null makes it fail. */
  txShow?: Record<string, unknown>;
}

export const STATUS = { version: "0.5.0", identity: { user: ME, name: "Me" }, grant: { state: "granted" }, asks: { open: 2, requests: 1, approvals: 1 }, problems: [] };

/** A fake `pac` on a temp PAC_HOME: `calls()` lists every argv it was run with. */
export async function fakePac(scene: Scene = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fake-pac-"));
  const write = (s: Scene) => writeFile(join(dir, "scene.json"), JSON.stringify({ status: STATUS, asks: [], txs: [], ...s }));
  await write(scene);
  await writeFile(join(dir, "calls.jsonl"), "");
  const env = { PAC_HOME: join(dir, "home"), PAC_BIN: `${process.execPath} ${resolve(import.meta.dirname, "fake-pac.ts")}`, FAKE_PAC_DIR: dir };
  return {
    env,
    pac: new Pac(env),
    scene: write,
    calls: async () =>
      (await readFile(join(dir, "calls.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { args: string[] }).args.filter((x) => x !== "--json")),
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
