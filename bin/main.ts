#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { codeOf, Pac, pacArgv, pacHome } from "../pac/cli.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = `pac-interfaces <command>

  doctor                 does the pac CLI answer for PAC_HOME, and is the grant in place?
  mcp                    PAC as a stdio MCP server (Claude Code, Hermes, Codex)
  slack                  Slack with an app of your own (Socket Mode), for the owner of PAC_HOME
  slack connect <code> [--relay <wss://…/connect>]
                         link PAC_HOME to the shared PAC Slack app (code from \`/pac link\`), and run
  slack connector        run the linked connector (what the login service runs)
  slack service install|uninstall|status
                         the connector as a launchd agent, started at login
  relay                  the shared PAC Slack app's relay: SLACK_BOT_TOKEN, SLACK_APP_TOKEN,
                         PORT, PAC_RELAY_URL (public wss URL), PAC_RELAY_DATA (where links are kept)
  install <claude-code|hermes>
                         prints how to wire the skill, hook and MCP server into a host
`;

/** `slack connect <code>` links first; `slack connector` signs in with what linking saved. */
async function connector(argv: string[]): Promise<number> {
  const { loadSaved, runConnector, savedPath, STOPPED } = await import("../slack/connector.ts");
  const { pollMsOf } = await import("../slack/app.ts");
  const home = pacHome();
  const saved = await loadSaved(savedPath(home));
  const [sub, code] = argv;
  const flag = argv.indexOf("--relay");
  const relay = sub === "connect" ? (flag > 0 ? argv[flag + 1] : undefined) ?? process.env.PAC_RELAY_URL ?? saved?.relay : saved?.relay;
  if (sub === "connect" && (!code || code.startsWith("--"))) {
    console.error("Get a code with `/pac link` in Slack, then: slack connect <code> --relay <wss://…/connect>");
    return 2;
  }
  if (sub === "connector" && !saved) {
    console.error("Not linked yet. Get a code with `/pac link` in Slack, then: slack connect <code> --relay <wss://…/connect>");
    return 2;
  }
  if (!relay || !/^wss?:\/\//.test(relay)) {
    console.error("Which relay? Pass --relay wss://…/connect (the `/pac link` message shows it).");
    return 2;
  }
  const pac = new Pac();
  try {
    const s = await pac.status();
    if (s.grant?.state && s.grant.state !== "granted") {
      console.error(`Note: this PAC home's grant is "${s.grant.state}"; PAC can't answer until it's granted (\`pac status\`).`);
    }
  } catch (error) {
    console.error(`PAC doesn't answer for ${home}: ${codeOf(error)}. Run \`node bin/main.ts doctor\`.`);
    return 1;
  }
  const c = runConnector({
    pac,
    home,
    relay,
    ...(sub === "connect" ? { code } : { token: saved!.token }),
    pollMs: pollMsOf(process.env),
    onWelcome: (user, linkedNow) => {
      if (linkedNow) {
        console.error(`Linked: Slack user ${user} now talks to the PAC in ${home}. Keep this running, or (re)install the login service: node bin/main.ts slack service install`);
      }
    },
  });
  const why = await c.stopped;
  if (why !== "stopped") {
    console.error(STOPPED[why]);
  }
  // A refusal is for good: exit 0, so the login service doesn't restart into it.
  return 0;
}

async function service(sub: string | undefined): Promise<number> {
  const svc = await import("../slack/service.ts");
  switch (sub) {
    case "install": {
      try {
        const log = await svc.install({ root: ROOT, home: pacHome() });
        console.log(JSON.stringify({ ok: true, label: svc.LABEL, log, ...(await svc.status()) }, null, 2));
        return 0;
      } catch (error) {
        const code = codeOf(error);
        const hint = code === "guarded_folder" ? "macOS won't let a login agent read Desktop, Documents or Downloads: move this checkout elsewhere." : undefined;
        console.log(JSON.stringify({ ok: false, code, ...(hint ? { hint } : {}) }, null, 2));
        return 1;
      }
    }
    case "uninstall":
      await svc.uninstall();
      console.log(JSON.stringify({ ok: true, label: svc.LABEL, installed: false }, null, 2));
      return 0;
    case "status":
      console.log(JSON.stringify({ label: svc.LABEL, ...(await svc.status()) }, null, 2));
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

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
        const code = codeOf(error);
        const hint =
          code === "no_pac"
            ? `No pac CLI at ${join(pacHome(), "bin", "pac")} or on PATH. Set PAC_BIN to the CLI this home uses, e.g. PAC_BIN=~/.pac/bin/pac`
            : code === "not_set_up"
              ? "This PAC_HOME has no keys or joined no deployment."
              : undefined;
        console.log(JSON.stringify({ ok: false, home: pacHome(), pac: pacArgv().join(" "), code, ...(hint ? { hint } : {}) }, null, 2));
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
    case "relay": {
      const { startRelay } = await import("../relay/server.ts");
      await startRelay();
      return -1;
    }
    case "slack": {
      if (arg === "connect" || arg === "connector") {
        return connector(argv.slice(1));
      }
      if (arg === "service") {
        return service(argv[2]);
      }
      // Tokens live in $PAC_HOME/interfaces/slack/.env (0600). The file wins over
      // the shell, so a stale exported token can't shadow a rotated one.
      const file = join(pacHome(), "interfaces", "slack", ".env");
      if (existsSync(file)) {
        process.env = { ...process.env, ...parseEnv(readFileSync(file, "utf8")) };
      }
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
