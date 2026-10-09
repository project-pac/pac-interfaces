import { afterEach, describe, expect, it } from "vitest";
import { command, HELP, isQuestion, transcript } from "../slack/app.ts";
import { answerRequest, decide } from "../slack/decide.ts";
import { approvalBlocks, contextOf, esc, reviewHash, type Block } from "../slack/render.ts";
import { syncOnce, type SyncState } from "../slack/sync.ts";
import { approval, fakePac, QUOTE, request, tx } from "./scene.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const fresh = (): SyncState => ({ asks: {}, answers: {}, threads: {}, primed: false });
const recorder = () => {
  const posts: { text: string; blocks: Block[] }[] = [];
  return { posts, post: async (m: { text: string; blocks: Block[] }) => void posts.push(m) };
};

describe("approval card", () => {
  it("shows every passage, escaped, with buttons bound to the review", () => {
    const ask = approval();
    const { blocks, decidable } = approvalBlocks(ask, contextOf(tx("tx_1").tx));
    const all = JSON.stringify(blocks);
    expect(decidable).toBe(true);
    expect(all).toContain(esc("I rent a 1-bedroom in Alfama for 1400 EUR"));
    expect(all).not.toContain("<!channel>");
    expect(all).toContain(reviewHash(ask.body));
  });

  it("offers no buttons when the review can't be shown whole", () => {
    const ask = approval();
    ask.body.disclosures = Array.from({ length: 60 }, (_, i) => ({ to: `u_${i}`, items: [{ source: "f", quote: `q${i}`, how: "h", by: ["execute"] }] }));
    const { blocks, decidable } = approvalBlocks(ask, contextOf(undefined));
    expect(decidable).toBe(false);
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
  });

  it("explains [withheld]", () => {
    const { blocks } = approvalBlocks(approval("a", "open", "Shares [withheld] with Bob."), contextOf(undefined));
    expect(JSON.stringify(blocks)).toContain("someone else's material");
  });
});

describe("decisions", () => {
  it("sends the click when the review is unchanged and open", async () => {
    const f = await fakePac({ asks: [approval()] });
    close = f.close;
    expect(await decide(f.pac, { ask: "a_appr", h: reviewHash(approval().body) }, "yes")).toMatchObject({ ok: true });
    expect((await f.calls()).at(-1)).toEqual(["decide", "a_appr", "yes"]);
  });

  it("refuses a click on a card whose review changed", async () => {
    const f = await fakePac({ asks: [approval("a_appr", "open", "A new round.")] });
    close = f.close;
    expect(await decide(f.pac, { ask: "a_appr", h: reviewHash(approval().body) }, "yes")).toMatchObject({ ok: false, reason: "changed" });
    expect((await f.calls()).some((c) => c[0] === "decide")).toBe(false);
  });

  it("refuses a closed approval, a missing hash, and an edit without text", async () => {
    const f = await fakePac({ asks: [approval("a_done", "answered"), approval()] });
    close = f.close;
    const h = reviewHash(approval().body);
    expect(await decide(f.pac, { ask: "a_done", h }, "yes")).toMatchObject({ reason: "closed" });
    expect(await decide(f.pac, { ask: "a_appr" }, "yes")).toMatchObject({ reason: "changed" });
    expect(await decide(f.pac, { ask: "a_appr", h }, "edit", " ")).toMatchObject({ reason: "text_required" });
    expect((await f.calls()).some((c) => c[0] === "decide")).toBe(false);
  });

  it("sends an edit with --text", async () => {
    const f = await fakePac({ asks: [approval()] });
    close = f.close;
    await decide(f.pac, { ask: "a_appr", h: reviewHash(approval().body) }, "edit", "drop the price");
    expect((await f.calls()).at(-1)).toEqual(["decide", "a_appr", "edit", "--text", "drop the price"]);
  });

  it("answers and skips requests, never approvals", async () => {
    const f = await fakePac({ asks: [request(), approval()] });
    close = f.close;
    expect(await answerRequest(f.pac, { ask: "a_appr" }, "answer", "yes")).toMatchObject({ reason: "not_request" });
    await answerRequest(f.pac, { ask: "a_req" }, "answer", "Alfama");
    await answerRequest(f.pac, { ask: "a_req" }, "skip");
    const sent = (await f.calls()).filter((c) => c[0] === "answer");
    expect(sent).toEqual([
      ["answer", "a_req", "Alfama"],
      ["answer", "a_req", "--skip"],
    ]);
  });
});

describe("sync", () => {
  it("posts each open ask once and only answers released after it started", async () => {
    const f = await fakePac({ asks: [request(), approval()], txs: [tx("tx_old", { resultFile: "f_old" })], cat: { f_new: { name: "n.result.md", content: "---\na: 1\n---\nAbout 1400 EUR." } } });
    close = f.close;
    const state = fresh();
    const r = recorder();
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ requests: 1, approvals: 1, answers: 0 });
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ requests: 0, approvals: 0, answers: 0 });
    await f.scene({ asks: [], txs: [tx("tx_old", { resultFile: "f_old" }), tx("tx_new", { resultFile: "f_new" })], cat: { f_new: { name: "n.result.md", content: "---\na: 1\n---\nAbout 1400 EUR." } } });
    expect(await syncOnce(f.pac, state, r.post)).toEqual({ requests: 0, approvals: 0, answers: 1 });
    const last = JSON.stringify(r.posts.at(-1));
    expect(last).toContain("About 1400 EUR.");
    expect(last).not.toContain("a: 1");
  });

  it("doesn't mark an ask seen when posting it failed", async () => {
    const f = await fakePac({ asks: [request()] });
    close = f.close;
    const state = fresh();
    await expect(syncOnce(f.pac, state, async () => Promise.reject(new Error("slack down")))).rejects.toThrow();
    expect(state.asks).toEqual({});
  });
});

describe("owner commands", () => {
  it("asks PAC with plain text, reports status, shows help", async () => {
    const f = await fakePac();
    close = f.close;
    const noop = async () => {};
    expect((await command(f.pac, "", noop)).text).toBe(HELP);
    expect((await command(f.pac, "status", noop)).text).toContain("grant: `granted`");
    expect((await command(f.pac, "ask What does rent cost?", noop)).text).toContain("tx_new");
    expect((await f.calls()).at(-1)).toEqual(["goal", "What does rent cost?", "--wait"]);
  });

  it("shows the tx id when 0.5 prints the tx as an object", async () => {
    const f = await fakePac({ goal: { msg: "m_1", receipt: { status: "accepted" }, tx: { id: "tx_obj", state: "running" } } });
    close = f.close;
    const reply = (await command(f.pac, "What does rent cost?", async () => {})).text;
    expect(reply).toContain("`tx_obj`");
    expect(reply).not.toContain("[object Object]");
  });

  it("keeps the owner's own question, escaped, in the DM record", () => {
    expect(isQuestion("status")).toBe(false);
    expect(isQuestion(" asks ")).toBe(false);
    expect(isQuestion("What do teams use instead of syncs?")).toBe(true);
    const all = JSON.stringify(transcript("ask What about <!channel>?", "Sent"));
    expect(all).toContain("You asked PAC");
    expect(all).toContain("What about &lt;!channel&gt;?");
    expect(all).not.toContain("ask What");
  });

  it("escapes PAC's words in status", async () => {
    const f = await fakePac({ status: { version: "0.5.0", identity: { user: "u", name: "<!channel>" }, grant: { state: "granted" } } });
    close = f.close;
    expect((await command(f.pac, "status", async () => {})).text).not.toContain("<!channel>");
  });
});

void QUOTE;

describe("more pac features", () => {
  const noop = async () => {};
  it("asks the people named, with --with per name", async () => {
    const f = await fakePac();
    close = f.close;
    await command(f.pac, "with Dhrumil,me What do you use instead of syncs?", noop);
    expect((await f.calls()).at(-1)).toEqual(["goal", "What do you use instead of syncs?", "--with", "Dhrumil", "--with", "me", "--wait"]);
  });

  it("replies in a thread with --reply-to, and refuses a bad tx id", async () => {
    const f = await fakePac();
    close = f.close;
    await command(f.pac, "reply tx_1 and for 2 bedrooms?", noop);
    expect((await f.calls()).at(-1)).toEqual(["goal", "and for 2 bedrooms?", "--reply-to", "tx_1", "--wait"]);
    const n = (await f.calls()).length;
    await command(f.pac, "reply nope hi", noop);
    expect((await f.calls()).length).toBe(n);
  });

  it("never aborts from a typed command: it shows a confirm button", async () => {
    const f = await fakePac();
    close = f.close;
    const r = await command(f.pac, "abort tx_1", noop);
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

  it("lists threads, files, contacts without leaking markup", async () => {
    const f = await fakePac({ txs: [tx("tx_1", { resultFile: "f_r" })], files: [{ file: "f_1", name: "<!here>.md", version: 1, writtenAt: "2026-10-09T00:00:00Z" }] });
    close = f.close;
    expect(JSON.stringify((await command(f.pac, "threads", noop)).blocks)).toContain("answer released");
    expect(JSON.stringify((await command(f.pac, "files", noop)).blocks)).not.toContain("<!here>");
  });

  it("never offers keys, grants, upgrade or delete", async () => {
    const f = await fakePac();
    close = f.close;
    for (const w of ["keys backup x", "tee grant --current", "upgrade", "files rm f_1", "uninstall"]) {
      await command(f.pac, w, noop); // falls through to a question for PAC, never to those commands
    }
    const calls = await f.calls();
    expect(calls.every((c) => c[0] === "goal")).toBe(true);
  });
});
