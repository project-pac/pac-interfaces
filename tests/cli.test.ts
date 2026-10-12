import { afterEach, describe, expect, it } from "vitest";
import { PacError, stripFrontMatter } from "../pac/cli.ts";
import { decides } from "../hooks/deny-pac-decide.ts";
import { fakePac, question } from "./scene.ts";

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe("pac CLI client", () => {
  it("runs the CLI with --json last, arguments before flags, PAC_HOME set", async () => {
    const f = await fakePac({ asks: [question()] });
    close = f.close;
    await f.pac.asks(true);
    await f.pac.prompt("How much is rent?");
    await f.pac.prompt("-5% or more?", { with: ["Kate", "me"], only: true });
    await f.pac.decide("a_q", "edit", "drop the price");
    expect(await f.calls()).toEqual([
      ["asks", "--all"],
      ["prompt", "How much is rent?", "--wait"],
      ["prompt", " -5% or more?", "--with=Kate,me", "--only", "--wait"],
      ["reply", "a_q", "edit", "--text=drop the price", "--wait"],
    ]);
  });

  it("surfaces PAC's error code from the last stdout line", async () => {
    const f = await fakePac({ fail: { "system status": { code: "not_set_up", exit: 2 } } });
    close = f.close;
    await expect(f.pac.status()).rejects.toMatchObject({ code: "not_set_up", exit: 2 });
    await expect(f.pac.status()).rejects.toBeInstanceOf(PacError);
  });

  it("says no_pac when the binary isn't there", async () => {
    const { Pac } = await import("../pac/cli.ts");
    await expect(new Pac({ PAC_HOME: "/nonexistent", PAC_BIN: "/nonexistent/pac" }).status()).rejects.toMatchObject({ code: "no_pac" });
  });

  it("refuses a file name PAC wouldn't take, before running anything", async () => {
    const f = await fakePac();
    close = f.close;
    await expect(f.pac.put("../keys.json", "x")).rejects.toMatchObject({ code: "bad_name" });
    expect(await f.calls()).toEqual([]);
  });

  it("follows watch with --no-auto-grant, one event per line", async () => {
    const f = await fakePac({ watch: [{ event: "watching", user: "u" }, { event: "ask", id: "a_1" }] });
    close = f.close;
    const events: string[] = [];
    await new Promise<void>((done) => f.pac.watch((e) => events.push(e.event), () => done()));
    expect(events).toEqual(["watching", "ask"]);
    expect((await f.calls())[0]).toEqual(["watch", "--no-auto-grant"]);
  });

  it("strips a result's front matter", () => {
    expect(stripFrontMatter("---\ntx: 1\n---\n\nHello")).toBe("Hello");
  });
});

describe("Claude Code hook", () => {
  it.each([
    "pac reply a_1 yes",
    "~/.pac/bin/pac reply a_1 yes --yes --json",
    '"$PAC" reply a_1 no',
    "${PAC} reply a edit --text 'less'",
    "cd x && /Users/me/.pac/bin/pac reply a yes",
    "pac --json reply a yes",
    "pac reply a_data --text 'shipped' --yes",
    "pac decide a_1 yes",
  ])("blocks %s", (c) => expect(decides(c)).toBe(true));
  it.each(["pac asks --json", "pac reply a_1 'I decide later'", "pac reply a_1 --choice yes", "pac reply a_1 --text no", "pac reply a_1 --skip", "echo yes", "pac sessions"])("allows %s", (c) => expect(decides(c)).toBe(false));
});
