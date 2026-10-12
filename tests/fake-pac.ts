#!/usr/bin/env node
// A stand-in `pac` (0.6) for tests: reads a scene from $FAKE_PAC_DIR/scene.json,
// records every argv to calls.jsonl, prints what `pac … --json` would.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_PAC_DIR!;
const args = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ args, home: process.env.PAC_HOME }) + "\n");
const scene = JSON.parse(readFileSync(join(dir, "scene.json"), "utf8"));
const out = (v: unknown, code = 0): never => {
  process.stdout.write(JSON.stringify(v) + "\n");
  process.exit(code);
};

if (args.at(-1) !== "--json") {
  out({ error: "fake pac wants --json last", code: "usage" }, 2);
}
const a = args.slice(0, -1);
const key = a[0] === "files" || a[0] === "system" ? `${a[0]} ${a[1]}` : a[0]!;
const fail = scene.fail?.[key];
if (fail) {
  out({ error: fail.error ?? key, code: fail.code }, fail.exit ?? 2);
}
const flag = (name: string) => a.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
const flagValue = (name: string) => {
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : a.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3);
};
type Ask = { id: string; session: string; status: string; body: { kind: string } };
const asks: Ask[] = scene.asks ?? [];
const sessions: { id: string }[] = scene.sessions ?? [];

switch (key) {
  case "status":
    out(scene.ready ?? { ready: true, problems: [], asks: asks.filter((x) => x.status === "open"), sessions: [] });
  case "system status":
    out(scene.status);
  case "system verify":
    out({ checked: 3, problems: [] });
  case "system trust":
    out({ status: "up_to_date", deployment: { name: "PAC", current: ["m".repeat(64)] } });
  case "asks": {
    const session = flagValue("session");
    out((flag("all") ? asks : asks.filter((x) => x.status === "open")).filter((x) => !session || x.session === session));
  }
  case "sessions":
    out(sessions);
  case "session": {
    const found = sessions.filter((s) => s.id === a[1] || s.id.startsWith(a[1]!));
    out(found.length === 1 ? found[0] : { error: "no such session", code: "unknown_session" }, found.length === 1 ? 0 : 2);
  }
  case "people":
    out(scene.people ?? []);
  case "groups":
    out(flag("open") ? (scene.openGroups ?? []) : (scene.groups ?? []));
  case "group": {
    const sub = a[1];
    if (sub === "new") {
      const name = flagValue("name");
      out(flag("yes") ? { status: "accepted", msg: "m_g", group: "g_9999aaaa", session: "s_9999aaaa", receipt: { status: "accepted" } } : { status: "preview", text: `a group, as every member sees it before they submit:\n  group: ${name}`, body: { kind: "group" } });
    }
    const ref = a[2]!;
    const mine = (scene.groups ?? []).filter((g: { id: string }) => g.id.startsWith(ref));
    const listed = (scene.openGroups ?? []).filter((g: { group: string }) => g.group.startsWith(ref));
    const found = mine[0] ?? listed[0];
    if (!found) {
      out({ error: "no such group", code: "unknown_group" }, 2);
    }
    if (sub === "show") {
      out(found);
    }
    out({ status: "accepted", msg: "m_g", group: ref, receipt: { status: "accepted" } });
  }
  case "files ls":
    out(scene.files ?? []);
  case "files cat":
    out(scene.cat?.[a[2]!] ?? { error: "no file", code: "usage" }, scene.cat?.[a[2]!] ? 0 : 2);
  case "files put":
    out({ file: "f_new", name: a[4] });
  case "prompt":
    out(scene.prompt ?? { status: "accepted", msg: "m_1", session: "s_0123456789abcdef0123456789abcdef", receipt: { status: "accepted" } });
  case "abort":
    out({ status: "accepted", msg: "m_3", session: a[1], receipt: { status: "accepted" } });
  case "reply": {
    const ask = asks.find((x) => x.id === a[1]);
    if (!ask) {
      out({ error: "no such ask", code: "unknown_ask" }, 2);
    }
    // Consent is only previewed without --yes: an approval's or access ask's yes, a group submission.
    const consents = a[2] === "yes" || (ask!.body.kind === "data" && !flag("skip"));
    if (consents && !flag("yes")) {
      out({ status: "preview", ask: ask!.id, text: "preview" });
    }
    out({ status: "accepted", msg: "m_2", receipt: { status: "accepted" } });
  }
  case "watch":
    for (const e of scene.watch ?? []) {
      process.stdout.write(JSON.stringify(e) + "\n");
    }
    process.exit(0);
  default:
    out({ error: `unknown ${key}`, code: "usage" }, 2);
}
