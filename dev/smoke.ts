// Smoke against a real PAC home (read-only): the stdio MCP server as a host
// spawns it, and the Slack cards built from the home's real asks and results.
// Usage: PAC_HOME=<home> node dev/smoke.ts
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { Pac, stripFrontMatter } from "../pac/cli.ts";
import { isApproval } from "../pac/types.ts";
import { answerBlocks, approvalBlocks, askBlocks } from "../slack/render.ts";

const root = resolve(import.meta.dirname, "..");
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, "bin/main.ts"), "mcp"], env: { PAC_HOME: process.env.PAC_HOME ?? "", PATH: process.env.PATH ?? "" } }));
const { tools } = await client.listTools();
console.log("mcp tools:", tools.map((t) => t.name).join(", "));
for (const name of ["pac_status", "pac_sessions", "pac_questions", "pac_decisions", "pac_people", "pac_files"]) {
  const r = (await client.callTool({ name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };
  console.log(name, r.isError ? "ERROR" : "ok", r.content[0]!.text.length, "chars");
}
await client.close();

const pac = new Pac();
const [asks, sessions] = await Promise.all([pac.asks(true), pac.sessions()]);
for (const a of asks) {
  const blocks = isApproval(a) ? approvalBlocks(a).blocks : askBlocks(a);
  console.log(`${a.body.kind} card`, a.id.slice(0, 10), a.status, "blocks", blocks.length, "bytes", JSON.stringify(blocks).length);
}
const released = sessions.find((s) => s.results.length > 0);
if (released) {
  const r = released.results.at(-1)!;
  const blocks = answerBlocks(released, r.turn, stripFrontMatter((await pac.cat(r.file)).content));
  console.log("answer card blocks", blocks.length);
}
console.log(`${sessions.length} sessions, ${asks.length} asks`);
