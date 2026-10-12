import { afterEach, describe, expect, it } from "vitest";
import { command, HELP, isQuestion, transcript } from "../slack/app.ts";
import { access, answerQuestion, decide, submitData } from "../slack/decide.ts";
import { accessBlocks, approvalBlocks, dataBlocks, esc, questionBlocks, reviewHash, type Block } from "../slack/render.ts";
import { syncOnce, type SyncState } from "../slack/sync.ts";
import { access as accessAsk, approval, data, fakePac, question, S1, session } from "./scene.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const fresh = (): SyncState => ({ asks: {}, answers: {}, threads: {}, primed: false });
const recorder = () => {
  const posts: { text: string; blocks: Block[] }[] = [];
  return { posts, post: async (m: { text: string; blocks: Block[] }) => `ts${posts.push(m)}` };
};
const h = (ask: { body: Parameters<typeof reviewHash>[0] }) => reviewHash(ask.body);
const actions = (blocks: Block[]) => JSON.stringify(blocks.filter((b) => b.type === "actions"));

describe("cards", () => {
  it("an approval shows every passage, escaped, with buttons bound to the ask", () => {
    const ask = approval();
    const { blocks, decidable } = approvalBlocks(ask);
    const all = JSON.stringify(blocks);
    expect(decidable).toBe(true);
    expect(all).toContain(esc("I rent a 1-bedroom in Alfama for 1400 EUR"));
    expect(all).not.toContain("<!channel>");
    expect(all).toContain(h(ask));
    expect(all).toContain("lisbon.md");
  });

  it("an approval too big for Slack offers no buttons", () => {
    const ask = approval();
    ask.body.disclosures = Array.from({ length: 60 }, (_, i) => ({ to: `u_${i}`, items: [{ source: "f", quote: `q${i}`, how: "h", by: ["agent" as const] }] }));
    const { blocks, decidable } = approvalBlocks(ask);
    expect(decidable).toBe(false);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("marks passages the agent didn't cite and ones from an index entry, and explains [withheld]", () => {
    const ask = approval("a", "open", "Shares [withheld] with Bob.");
    ask.body.disclosures[0]!.items[0] = { ...ask.body.disclosures[0]!.items[0]!, by: ["view"], index: true };
    const all = JSON.stringify(approvalBlocks(ask).blocks);
    expect(all).toContain("not cited");
    expect(all).toContain("index entry");
    expect(all).toContain("someone else's material");
  });

  it("a question offers what its form takes: text, yes/no, or its choices", () => {
    expect(actions(questionBlocks(question()))).toContain("pac_answer");
    const yn = actions(questionBlocks(question("a_q", "open", { answer: "yes_no" })));
    expect(yn).toContain('\\"c\\":\\"yes\\"');
    expect(yn).not.toContain("pac_answer\"");
    const choice = actions(questionBlocks(question("a_q", "open", { answer: "choice", choices: ["Alfama", "Baixa"] })));
    expect(choice).toContain("Baixa");
    expect(actions(questionBlocks(question()))).toContain("pac_pass");
  });

  it("an access ask names the file and why, escaped", () => {
    const all = JSON.stringify(accessBlocks(accessAsk()));
    expect(all).toContain("salary.md");
    expect(all).not.toContain("<!here>");
    expect(all).toContain("pac_allow");
  });

  it("a group's data ask shows the whole group a submission consents to", () => {
    const all = JSON.stringify(dataBlocks(data()));
    for (const part of ["Weekly sync", "Summarize what everyone shipped", "What did you ship", "every member", "consent to exactly this"]) {
      expect(all).toContain(part);
    }
    expect(all).toContain("pac_submit");
  });
});

describe("decisions", () => {
  it("sends an approval's yes with --yes when the ask is unchanged and open", async () => {
    const f = await fakePac({ asks: [approval()] });
    close = f.close;
    expect(await decide(f.pac, { ask: "a_appr", h: h(approval()) }, "yes")).toMatchObject({ ok: true });
    expect((await f.calls()).at(-1)).toEqual(["reply", "a_appr", "yes", "--yes", "--wait"]);
  });

  it("refuses a click on a card whose ask changed, a closed one, and an edit without text", async () => {
    const f = await fakePac({ asks: [approval("a_appr", "open", "A new round."), approval("a_done", "answered")] });
    close = f.close;
    const old = h(approval());
    expect(await decide(f.pac, { ask: "a_appr", h: old }, "yes")).toMatchObject({ ok: false, reason: "changed" });
    expect(await decide(f.pac, { ask: "a_appr" }, "yes")).toMatchObject({ reason: "changed" });
    expect(await decide(f.pac, { ask: "a_done", h: h(approval("a_done", "answered")) }, "yes")).toMatchObject({ reason: "closed" });
    expect(await decide(f.pac, { ask: "a_appr", h: h(approval("a_appr", "open", "A new round.")) }, "edit", " ")).toMatchObject({ reason: "text_required" });
    expect((await f.calls()).some((c) => c[0] === "reply")).toBe(false);
  });

  it("sends an edit's text, and a no", async () => {
    const f = await fakePac({ asks: [approval()] });
    close = f.close;
    await decide(f.pac, { ask: "a_appr", h: h(approval()) }, "edit", "drop the price");
    await decide(f.pac, { ask: "a_appr", h: h(approval()) }, "no");
    const sent = (await f.calls()).filter((c) => c[0] === "reply");
    expect(sent).toEqual([
      ["reply", "a_appr", "edit", "--text=drop the price", "--wait"],
      ["reply", "a_appr", "no", "--wait"],
    ]);
  });

  it("answers, chooses, skips and declines questions, never other kinds", async () => {
    const yn = question("a_yn", "open", { answer: "yes_no" });
    const f = await fakePac({ asks: [question(), yn, approval()] });
    close = f.close;
    expect(await answerQuestion(f.pac, { ask: "a_appr", h: h(approval()) }, { text: "yes" })).toMatchObject({ reason: "wrong_kind" });
    await answerQuestion(f.pac, { ask: "a_q", h: h(question()) }, { text: "yes, in Alfama" });
    await answerQuestion(f.pac, { ask: "a_yn", h: h(yn) }, { choice: "yes" });
    expect(await answerQuestion(f.pac, { ask: "a_yn", h: h(yn) }, { choice: "maybe" })).toMatchObject({ reason: "bad_choice" });
    await answerQuestion(f.pac, { ask: "a_q", h: h(question()) }, "skip");
    await answerQuestion(f.pac, { ask: "a_q", h: h(question()) }, "decline");
    expect((await f.calls()).filter((c) => c[0] === "reply")).toEqual([
      ["reply", "a_q", "--text=yes, in Alfama", "--wait"],
      ["reply", "a_yn", "--choice=yes", "--wait"],
      ["reply", "a_q", "--skip", "--wait"],
      ["reply", "a_q", "--decline", "--wait"],
    ]);
  });

  it("lets PAC read a file only on a yes with --yes, and sends a no's reason", async () => {
    const f = await fakePac({ asks: [accessAsk()] });
    close = f.close;
    await access(f.pac, { ask: "a_acc", h: h(accessAsk()) }, "yes");
    await access(f.pac, { ask: "a_acc", h: h(accessAsk()) }, "no", "private");
    expect((await f.calls()).filter((c) => c[0] === "reply")).toEqual([
      ["reply", "a_acc", "yes", "--yes", "--wait"],
      ["reply", "a_acc", "no", "--text=private", "--wait"],
    ]);
  });

  it("submits to a group with --yes, within its bound, and skips a run", async () => {
    const f = await fakePac({ asks: [data()] });
    close = f.close;
    expect(await submitData(f.pac, { ask: "a_data", h: h(data()) }, { text: "x".repeat(41) })).toMatchObject({ reason: "too_long" });
    await submitData(f.pac, { ask: "a_data", h: h(data()) }, { text: "Shipped the relay." });
    await submitData(f.pac, { ask: "a_data", h: h(data()) }, "skip");
    expect((await f.calls()).filter((c) => c[0] === "reply")).toEqual([
      ["reply", "a_data", "--text=Shipped the relay.", "--yes", "--wait"],
      ["reply", "a_data", "--skip", "--wait"],
    ]);
  });
});

describe("sync", () => {
  it("posts each open ask once, of every kind, and only results released after it started", async () => {
    const released = session(S1, { results: [{ turn: 1, file: "f_old", batch: "b_1" }] });
    const f = await fakePac({ asks: [question(), approval(), accessAsk(), data()], sessions: [released] });
    close = f.close;
    const state = fresh();
    const r = recorder();
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ asks: 4, answers: 0 });
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ asks: 0, answers: 0 });
    const s2 = "s_2222bbbb2222bbbb2222bbbb2222bbbb";
    await f.scene({ asks: [], sessions: [released, session(s2, { results: [{ turn: 1, file: "f_new", batch: "b_2" }] })], cat: { f_new: { name: "n.result.md", content: "---\na: 1\n---\nAbout 1400 EUR." } } });
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ asks: 0, answers: 1 });
    const last = JSON.stringify(r.posts.at(-1));
    expect(last).toContain("About 1400 EUR.");
    expect(last).not.toContain("a: 1");
    expect(Object.values(state.threads)).toEqual([s2]);
  });

  it("doesn't mark an ask seen when posting it failed", async () => {
    const f = await fakePac({ asks: [question()] });
    close = f.close;
    const state = fresh();
    await expect(syncOnce(f.pac, state, async () => Promise.reject(new Error("slack down")))).rejects.toThrow();
    expect(state.asks).toEqual({});
  });
});

describe("owner commands", () => {
  const noop = async () => {};

  it("asks PAC with plain text, reports status, shows help", async () => {
    const f = await fakePac();
    close = f.close;
    expect((await command(f.pac, "", noop)).text).toBe(HELP);
    expect((await command(f.pac, "status", noop)).text).toContain("grant: `granted`");
    expect((await command(f.pac, "ask What does rent cost?", noop)).text).toContain("s_0123456789");
    expect((await f.calls()).at(-1)).toEqual(["prompt", "What does rent cost?", "--wait"]);
  });

  it("treats `pac status` typed in a DM as the command, not a question", async () => {
    const f = await fakePac();
    close = f.close;
    expect((await command(f.pac, "pac status", noop)).text).toContain("grant: `granted`");
    expect((await f.calls()).some((c) => c[0] === "prompt")).toBe(false);
  });

  it("says when PAC refused a prompt", async () => {
    const f = await fakePac({ prompt: { status: "rejected", msg: "m_1", receipt: { status: "rejected", error: "rate_limited" } } });
    close = f.close;
    expect((await command(f.pac, "What does rent cost?", noop)).text).toContain("rate_limited");
  });

  it("keeps the owner's own question, escaped, in the DM record", () => {
    expect(isQuestion("status")).toBe(false);
    expect(isQuestion(" sessions ")).toBe(false);
    expect(isQuestion("What do teams use instead of syncs?")).toBe(true);
    const all = JSON.stringify(transcript("ask What about <!channel>?", "Sent"));
    expect(all).toContain("What about &lt;!channel&gt;?");
    expect(all).not.toContain("ask What");
  });

  it("involves the people named, or only them", async () => {
    const f = await fakePac();
    close = f.close;
    await command(f.pac, "with Dhrumil,me What do you use instead of syncs?", noop);
    await command(f.pac, "only Dhrumil Can we meet Friday?", noop);
    expect((await f.calls()).filter((c) => c[0] === "prompt")).toEqual([
      ["prompt", "What do you use instead of syncs?", "--with=Dhrumil,me", "--wait"],
      ["prompt", "Can we meet Friday?", "--with=Dhrumil", "--only", "--wait"],
    ]);
  });

  it("replies in a session with --session, and refuses a bad session id", async () => {
    const f = await fakePac();
    close = f.close;
    await command(f.pac, `reply ${S1} and for 2 bedrooms?`, noop);
    expect((await f.calls()).at(-1)).toEqual(["prompt", "and for 2 bedrooms?", `--session=${S1}`, "--wait"]);
    const n = (await f.calls()).length;
    await command(f.pac, "reply nope hi", noop);
    expect((await f.calls()).length).toBe(n);
  });

  it("never aborts from a typed command: it shows a confirm button", async () => {
    const f = await fakePac();
    close = f.close;
    const r = await command(f.pac, `abort ${S1}`, noop);
    expect(JSON.stringify(r.blocks)).toContain("pac_abort");
    expect(JSON.stringify(r.blocks)).toContain("confirm");
    expect((await f.calls()).some((c) => c[0] === "abort")).toBe(false);
  });

  it("opens a form for remember without text, saves with text", async () => {
    const f = await fakePac();
    close = f.close;
    expect((await command(f.pac, "remember travel.md", noop)).modal).toBeTruthy();
    await command(f.pac, "remember travel.md\nI prefer window seats.", noop);
    expect((await f.calls()).at(-1)?.slice(0, 2)).toEqual(["files", "put"]);
    expect((await command(f.pac, "remember ../keys", noop)).text).toContain("remember");
  });

  it("lists sessions, shows one, and lists people, without leaking markup", async () => {
    const s = session(S1, { results: [{ turn: 1, file: "f_r", batch: "b_1" }], turns: [{ n: 1, by: "u_bob", prompt: "Rent <!here>?", with: [], status: "answered", createdAt: "2026-10-12T04:00:00Z", updatedAt: "2026-10-12T05:00:00Z" }] });
    const f = await fakePac({ sessions: [s], cat: { f_r: { name: "r.md", content: "About 1400 EUR." } }, people: [{ user: "u_bob", name: "Bob <!channel>", handle: "bob" }] });
    close = f.close;
    const list = JSON.stringify((await command(f.pac, "sessions", noop)).blocks);
    expect(list).toContain("answer released");
    expect(list).not.toContain("<!here>");
    const shown = JSON.stringify((await command(f.pac, `show ${S1.slice(0, 10)}`, noop)).blocks);
    expect(shown).toContain("About 1400 EUR.");
    expect((await command(f.pac, "people", noop)).text).not.toContain("<!channel>");
  });

  it("never offers keys, grants, upgrade or delete", async () => {
    const f = await fakePac();
    close = f.close;
    for (const w of ["keys backup x", "system tee grant --current", "upgrade", "files rm f_1", "uninstall"]) {
      await command(f.pac, w, noop); // falls through to a prompt for PAC, never to those commands
    }
    expect((await f.calls()).every((c) => c[0] === "prompt")).toBe(true);
  });
});
