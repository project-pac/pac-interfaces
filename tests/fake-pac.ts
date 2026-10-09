#!/usr/bin/env node
// A stand-in `pac` for tests: reads a scene from $FAKE_PAC_DIR/scene.json,
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
const key = a[0] === "tx" || a[0] === "files" ? `${a[0]} ${a[1]}` : a[0]!;
const fail = scene.fail?.[key];
if (fail) {
  out({ error: fail.error ?? key, code: fail.code }, fail.exit ?? 2);
}
switch (key) {
  case "status":
    out(scene.status);
  case "asks":
    out(a.includes("--all") ? scene.asks : scene.asks.filter((x: { status: string }) => x.status === "open"));
  case "tx ls":
    out(scene.txs ?? []);
  case "tx show":
    out({ id: a[2], rounds: [] });
  case "files ls":
    out(scene.files ?? []);
  case "files cat":
    out(scene.cat?.[a[2]!] ?? { error: "no file", code: "usage" }, scene.cat?.[a[2]!] ? 0 : 2);
  case "files put":
    out({ file: "f_new", name: a[4] });
  case "goal":
    out(scene.goal ?? { msg: "m_1", receipt: { status: "accepted" }, tx: "tx_new" });
  case "answer":
  case "decide":
    out({ msg: "m_2" });
  case "watch":
    for (const e of scene.watch ?? []) {
      process.stdout.write(JSON.stringify(e) + "\n");
    }
    process.exit(0);
  default:
    out({ error: `unknown ${key}`, code: "usage" }, 2);
}
