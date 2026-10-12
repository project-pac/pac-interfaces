import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pac } from "../pac/cli.ts";
import type { AccessBody, ApprovalBody, Ask, DataBody, Member, QuestionBody, Session } from "../pac/types.ts";

export const ME = "u_me";
export const BOB = "u_bob";
export const QUOTE = "I rent a 1-bedroom in Alfama for 1400 EUR <!channel>";
export const S1 = "s_1111aaaa1111aaaa1111aaaa1111aaaa";
const PROMPT = { by: { user: BOB, name: "Bob" }, text: "What does a 1-bed in Lisbon cost?" };

/** A session with Bob and me, one turn, in whatever state. */
export const session = (id = S1, extra: Partial<Session> = {}): Session => ({
  id,
  ref: id.slice(0, 8),
  you: ["asked"],
  people: [
    { user: BOB, name: "Bob" },
    { user: ME, name: "Me" },
  ],
  turns: [{ n: 1, by: BOB, prompt: PROMPT.text, with: [], status: "running", createdAt: "2026-10-12T04:00:00Z", updatedAt: "2026-10-12T04:00:00Z" }],
  asks: [],
  results: [],
  read: [],
  agent: { codeIdentity: "cpu@0.3.1+bb", measurement: "2".repeat(64) },
  ...extra,
});

export const question = (id = "a_q", status: Ask["status"] = "open", body: Partial<QuestionBody> = {}): Ask<QuestionBody> => ({
  id,
  session: S1,
  turn: 1,
  prompt: PROMPT,
  status,
  body: { kind: "question", text: "Where do you rent?", answer: "text", ...body },
});

export const approval = (id = "a_appr", status: Ask["status"] = "open", summary = "Shares your rent with Bob."): Ask<ApprovalBody> => ({
  id,
  session: S1,
  turn: 1,
  prompt: PROMPT,
  status,
  body: {
    kind: "approval",
    batch: "b_1",
    batchSha256: "abc",
    recipients: [{ user: BOB, name: "Bob" }],
    yourMaterial: [{ source: "f_1", name: "lisbon.md", sha256: "d" }],
    disclosures: [{ to: BOB, items: [{ source: "f_1", quote: QUOTE, how: "The answer.", by: ["agent"] }], overlaps: [], edits: [] }],
    summary,
    whyIncluded: "You live there.",
    unverifiedQuotes: 0,
    revisedFor: [],
  },
});

export const access = (id = "a_acc", status: Ask["status"] = "open"): Ask<AccessBody> => ({ id, session: S1, turn: 1, prompt: PROMPT, status, body: { kind: "access", file: "f_2", name: "salary.md", text: "To compare rent with pay <!here>." } });

export const data = (id = "a_data", status: Ask["status"] = "open", answer: QuestionBody["answer"] = "text"): Ask<DataBody> => ({
  id,
  session: S1,
  turn: 1,
  prompt: { by: { user: BOB, name: "Bob" }, text: "Weekly sync" },
  status,
  body: {
    kind: "data",
    group: "g_1",
    run: 3,
    spec: {
      name: "Weekly sync",
      creator: { user: BOB, name: "Bob" },
      run: { prompt: "Summarize what everyone shipped and what blocks them." },
      ask: { text: "What did you ship, and what blocks you?", answer, ...(answer === "choice" ? { choices: ["on track", "blocked"] } : {}), maxChars: 40 },
      members: [
        { user: BOB, name: "Bob" },
        { user: ME, name: "Me" },
      ],
      reads: "submissions",
      files: 0,
      to: "members",
    },
  },
});

export interface Scene {
  status?: unknown;
  ready?: unknown;
  asks?: Ask[];
  sessions?: Session[];
  files?: unknown[];
  cat?: Record<string, unknown>;
  prompt?: unknown;
  people?: Member[];
  fail?: Record<string, { code: string; exit?: number }>;
  watch?: unknown[];
}

/** `pac system status`. */
export const STATUS = { version: "0.6.0", identity: { user: ME, name: "Me" }, grant: { state: "granted" }, problems: [] };

/** A fake `pac` on a temp PAC_HOME: `calls()` lists every argv it was run with. */
export async function fakePac(scene: Scene = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fake-pac-"));
  const write = (s: Scene) => writeFile(join(dir, "scene.json"), JSON.stringify({ status: STATUS, asks: [], sessions: [], ...s }));
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
