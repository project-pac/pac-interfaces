import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { command } from "../slack/commands.ts";
import { viewEvent, type Message } from "../slack/events.ts";
import { draftOf, GACT, GMODAL, groupCommand, groupShow } from "../slack/groups.ts";
import { createOwner, type Io } from "../slack/owner.ts";
import { fakePac, group, listing, ME } from "./scene.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

const G = "g_1234abcd1234abcd1234abcd1234abcd";
const json = (v: unknown) => JSON.stringify(v);
const actionIds = (blocks: unknown) => [...json(blocks).matchAll(/"action_id":"(pac_group_[a-z_]+)"/g)].map((m) => m[1]);

describe("group cards", () => {
  it("offers what the person's part allows: join, leave, run now, the next run, close", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const cases: [Parameters<typeof fakePac>[0], string[]][] = [
      [{ openGroups: [listing()] }, [GACT.join]],
      [{ groups: [group("member")] }, [GACT.leave]],
      [{ groups: [group("left")] }, [GACT.join]],
      [{ groups: [group("creator")] }, [GACT.runNow, GACT.close]],
      [{ groups: [group("creator", { runs: [{ n: 2, session: "s_1", deadline: past, createdAt: past }] })] }, [GACT.runNext, GACT.close]],
      [{ groups: [group("creator", { status: "closed" })] }, []],
    ];
    for (const [scene, want] of cases) {
      const f = await fakePac(scene);
      const ref = scene!.openGroups ? "g_5678" : "g_1234";
      expect(actionIds((await groupShow(f.pac, ref)).blocks)).toEqual(want);
      await f.close();
    }
  });

  it("asks Slack to confirm leaving and closing", async () => {
    const f = await fakePac({ groups: [group("creator")] });
    close = f.close;
    const card = json((await groupShow(f.pac, "g_1234")).blocks);
    expect(card).toContain("Close this group?");
  });

  it("shows the whole group, escaped", async () => {
    const g = group("member");
    g.spec = { ...g.spec, name: "Sync <!channel>", run: { prompt: "Summarize <@U123>" } };
    const f = await fakePac({ groups: [g] });
    close = f.close;
    const blocks = (await groupShow(f.pac, "g_1234")).blocks;
    const card = json(blocks);
    // Slack reads markup only in mrkdwn: there, nothing anyone wrote may ping or link. (plain_text headers are shown as typed.)
    const mrkdwn = [...card.matchAll(/"type":"mrkdwn","text":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join("\n");
    expect(mrkdwn).not.toContain("<!channel>");
    expect(mrkdwn).not.toContain("<@U123>");
    expect(mrkdwn).toContain("&lt;@U123&gt;");
    expect(card).toContain("What did you ship");
    expect(card).toContain("every member");
  });
});

describe("group commands", () => {
  it("lists your groups and the open ones", async () => {
    const f = await fakePac({ groups: [group("member", { needsYou: true })], openGroups: [listing()] });
    close = f.close;
    expect(json((await command(f.pac, "groups", async () => {})).blocks)).toContain("waits on you");
    expect(json((await command(f.pac, "groups open", async () => {})).blocks)).toContain("Open book club");
    expect((await f.calls()).map((c) => c.join(" "))).toEqual(["groups", "groups --open"]);
  });

  it("joins and runs straight from a typed line, but leaving and closing only show a confirm", async () => {
    const f = await fakePac({ groups: [group("creator")], openGroups: [listing()] });
    close = f.close;
    await groupCommand(f.pac, "group", "join g_5678");
    await groupCommand(f.pac, "group", `run ${G} now`);
    await groupCommand(f.pac, "group", `run ${G}`);
    const shown = await groupCommand(f.pac, "group", `close ${G}`);
    expect(actionIds(shown.blocks)).toContain(GACT.close);
    const calls = (await f.calls()).map((c) => c.join(" "));
    expect(calls).toEqual(["group join g_5678 --wait", `group run ${G} --now --wait`, `group run ${G} --wait`, `group show ${G}`]);
  });

  it("opens a form for a new group, and refuses a bad id without running pac", async () => {
    const f = await fakePac();
    close = f.close;
    expect((await groupCommand(f.pac, "group", "new")).modal).toMatchObject({ callback_id: GMODAL.create });
    expect((await groupCommand(f.pac, "group", "join nope")).text).toContain("/pac group join");
    expect(await f.calls()).toEqual([]);
  });
});

describe("making a group", () => {
  it("reads the form, and names each field that needs fixing", () => {
    expect(draftOf({ name: "", ask: "", prompt: "", answer: "choice", choices: "one" })).toEqual({ errors: { name: expect.any(String), ask: expect.any(String), prompt: expect.any(String), choices: expect.any(String) } });
    expect(draftOf({ name: "N", ask: "A", prompt: "P", answer: "text", open: "open", invite: "kate", to: "members" })).toEqual({ errors: { invite: expect.any(String), to: expect.any(String) } });
    expect(draftOf({ name: " Weekly sync ", ask: "What shipped?", prompt: "Summarize.", answer: "choice", choices: "on track, blocked", invite: "Dhrumil, @kate", to: "each", by: "2d", read: "members" })).toEqual({
      draft: { name: "Weekly sync", ask: "What shipped?", prompt: "Summarize.", answer: "choice", choices: ["on track", "blocked"], invite: ["Dhrumil", "@kate"], to: "each", by: "2d", pacMayRead: true },
    });
  });

  it("previews PAC's own text first, and makes the group only on Create", async () => {
    const f = await fakePac();
    close = f.close;
    const posts: Message[] = [];
    const updates: Message[] = [];
    const port = { dm: async () => "D1", post: async (m: Message) => (posts.push(m), "ts1"), update: async (_c: string, _t: string, m: Message) => void updates.push(m) };
    const owner = createOwner({ pac: f.pac, owner: ME, statePath: join(f.env.PAC_HOME, "s.json"), port, pollMs: 60_000, log: () => {} });
    let acked: unknown = "none";
    const io: Io = { respond: async () => {}, say: async () => {}, openView: async () => {}, ack: async (r) => void (acked = r) };

    // A form with a missing field comes back to the form, without running pac.
    await owner.handle({ kind: "view", user: ME, callback: GMODAL.create, values: { name: "Weekly sync", ask: "", prompt: "Summarize.", answer: "text", to: "members", invite: "kate" }, meta: "" }, io);
    expect(acked).toMatchObject({ response_action: "errors", errors: { ask: expect.any(String) } });
    expect(await f.calls()).toEqual([]);

    await owner.handle({ kind: "view", user: ME, callback: GMODAL.create, values: { name: "Weekly sync", ask: "What shipped?", prompt: "Summarize.", answer: "text", to: "members", invite: "kate", open: "" }, meta: "" }, io);
    expect(acked).toBeUndefined();
    expect((await f.calls()).at(-1)).toEqual(["group", "new", "--name=Weekly sync", "--ask=What shipped?", "--answer=text", "--prompt=Summarize.", "--invite=kate", "--to=members", "--wait"]);
    const card = json(posts.at(-1));
    expect(card).toContain("as every member sees it");
    const draft = card.match(/"action_id":"pac_group_create","text":\{[^}]*\},"value":"([^"]+)"/)![1]!;

    // Someone else's click never makes it.
    await owner.handle({ kind: "action", user: "u_someone", action: GACT.create, value: draft, channel: "D1", ts: "ts1" }, io);
    expect((await f.calls()).filter((c) => c.includes("--yes"))).toEqual([]);

    await owner.handle({ kind: "action", user: ME, action: GACT.create, value: draft, channel: "D1", ts: "ts1" }, io);
    expect((await f.calls()).at(-1)).toEqual(["group", "new", "--name=Weekly sync", "--ask=What shipped?", "--answer=text", "--prompt=Summarize.", "--invite=kate", "--to=members", "--yes", "--wait"]);
    expect(updates.at(-1)?.text).toContain("Made *Weekly sync*");

    // A draft is made once.
    await owner.handle({ kind: "action", user: ME, action: GACT.create, value: draft, channel: "D1", ts: "ts1" }, io);
    expect(updates.at(-1)?.text).toContain("expired");
    expect((await f.calls()).filter((c) => c.includes("--yes"))).toHaveLength(1);
  });
});

describe("form values", () => {
  it("reads text, a selected option and ticked boxes", () => {
    const e = viewEvent("U1", {
      callback_id: GMODAL.create,
      private_metadata: "",
      state: { values: { name: { value: { value: "N" } }, answer: { value: { selected_option: { value: "yes_no" } } }, open: { value: { selected_options: [{ value: "open" }] } }, read: { value: { selected_options: [] } } } },
    });
    expect(e).toMatchObject({ kind: "view", values: { name: "N", answer: "yes_no", open: "open", read: "" } });
  });
});
