#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codeOf, Pac, pacArgv, pacHome } from "../pac/cli.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `pac-interfaces <command>

  doctor                 does the pac CLI answer for PAC_HOME, and is the grant in place?
  mcp                    PAC as a stdio MCP server (Claude Code, Hermes, Codex)
  slack                  the Slack interface (Socket Mode), for the owner of PAC_HOME
  install <claude-code|hermes>
                         prints how to wire the skill, hook and MCP server into a host
`;

async function main(argv: string[]): Promise<number> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "doctor": {
      try {
        const s = await new Pac().status();
        const problems = (s.problems ?? []).map((p) => (typeof p === "string" ? p : p.code));
        console.log(JSON.stringify({ ok: true, home: pacHome(), pac: pacArgv().join(" "), version: s.version, user: s.identity?.name, grant: s.grant?.state ?? "none", asks: s.asks, problems }, null, 2));
        return 0;
      } catch (error) {
        console.log(JSON.stringify({ ok: false, home: pacHome(), pac: pacArgv().join(" "), code: codeOf(error) }, null, 2));
        return 1;
      }
    }
    case "mcp": {
      const { StdioServerTransport } = await import("@modelcontextprotocol/server/stdio");
      const { createPacServer } = await import("../mcp/server.ts");
      const pac = new Pac();
      await createPacServer({ version: "0.1.0", pac: () => pac }).connect(new StdioServerTransport());
      return -1;
    }
    case "slack": {
      const { startSlack } = await import("../slack/app.ts");
      await startSlack();
      return -1;
    }
    case "install": {
      const home = pacHome();
      const main = join(ROOT, "bin", "main.ts");
      const hook = join(ROOT, "hooks", "deny-pac-decide.ts");
      const skill = join(ROOT, "skills", "pac");
      if (arg === "claude-code") {
        console.log(`# 1. Skill (Claude calls the pac CLI itself)
mkdir -p ~/.claude/skills && cp -R ${skill} ~/.claude/skills/pac

# 2. Hook: no Bash call may run \`pac decide\` (add to ~/.claude/settings.json)
${JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `node ${hook}` }] }] } }, null, 2)}

# 3. MCP server (optional, same PAC through tools)
claude mcp add pac --scope user -e PAC_HOME=${home} -- node ${main} mcp`);
        return 0;
      }
      if (arg === "hermes") {
        console.log(`# 1. Skill
cp -R ${skill} ~/.hermes/skills/pac

# 2. MCP server: add with \`hermes mcp add\` or under mcp_servers in config.yaml.
#    PAC_HOME must be in env: Hermes filters what it passes to stdio servers.
mcp_servers:
  pac:
    command: node
    args: [${main}, mcp]
    env:
      PAC_HOME: ${home}`);
        return 0;
      }
      console.error(USAGE);
      return 2;
    }
    default:
      console.error(USAGE);
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) {
      process.exit(code);
    }
  },
  (error) => {
    console.error(JSON.stringify({ event: "failed", code: codeOf(error) }));
    process.exit(1);
  },
);
