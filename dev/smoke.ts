// Smoke against a real PAC home (read-only): the stdio MCP server as a host
// spawns it, and the Slack cards built from the home's real asks and results.
// Usage: PAC_HOME=<home> node dev/smoke.ts
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { Pac, stripFrontMatter } from "../pac/cli.ts";
import { isApproval } from "../pac/types.ts";
import { answerBlocks, approvalBlocks, contextOf } from "../slack/render.ts";

const root = resolve(import.meta.dirname, "..");
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, "bin/main.ts"), "mcp"], env: { PAC_HOME: process.env.PAC_HOME ?? "", PATH: process.env.PATH ?? "" } }));
const { tools } = await client.listTools();
console.log("mcp tools:", tools.map((t) => t.name).join(", "));
for (const name of ["pac_status", "pac_threads", "pac_files", "pac_approvals"]) {
  const r = (await client.callTool({ name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };
  console.log(name, r.isError ? "ERROR" : "ok", r.content[0]!.text.length, "chars");
}
await client.close();

const pac = new Pac();
const [asks, txs] = await Promise.all([pac.asks(true), pac.txs()]);
const byTx = new Map(txs.map((t) => [t.tx.id, t.tx]));
for (const a of asks.filter(isApproval)) {
  const { blocks, decidable } = approvalBlocks(a, contextOf(byTx.get(a.tx)));
  console.log("approval card", a.id.slice(0, 10), "blocks", blocks.length, "decidable", decidable, "bytes", JSON.stringify(blocks).length);
}
const released = txs.find((t) => t.pointer.resultFile);
if (released) {
  const blocks = answerBlocks(released.tx, stripFrontMatter((await pac.cat(released.pointer.resultFile!)).content));
  console.log("answer card blocks", blocks.length);
}
