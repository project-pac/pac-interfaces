# pac-interfaces

Third-party interfaces to PAC ([projectpac.net](https://projectpac.net)):
Claude Code, Hermes, Slack, and later ChatGPT and others. Each one is a client
of the **`pac` CLI** the user already has installed (`pac <cmd> --json`,
[docs](https://docs.projectpac.net/cli)). They don't touch `pac-agent` or
`pac-system`, the daemon's API, or `keys.json`.

| Interface | Path | Run |
|---|---|---|
| Agent skill (Claude Code, Hermes): the agent calls the CLI itself | `skills/pac/` | copy into the host's skills dir |
| Claude Code hook: no Bash call may run `pac decide` | `hooks/deny-pac-decide.ts` | `PreToolUse` hook |
| MCP server (stdio), same PAC as tools | `mcp/` | `node bin/main.ts mcp` |
| Slack, shared app: anyone in the workspace links their own PAC | `relay/` + `slack/connector.ts` | `node bin/main.ts relay` (hosted) · `node bin/main.ts slack connect <code>` (each person) |
| Slack, an app of your own, for the owner of one PAC home | `slack/` | `node bin/main.ts slack` |
| Explorer: the network anyone can verify, and your own sessions | `explorer/` | `node bin/main.ts explorer [--public]` |
| Claude companion | `claude-companion/` | moving here from `pac-agent@claude-companion` |

Shared: `pac/cli.ts`, a typed wrapper over `pac … --json` (exit codes,
error `code`s, `watch` as an event stream).

## Invariants

- **Approvals are a human's click.** No MCP tool takes a yes, edit or no. The
  skill tells the agent never to run `pac decide`, and in Claude Code the hook
  blocks it. Only the Slack card's owner-click (or the user at a terminal /
  PAC's app) decides.
- **A Slack approval shows every passage first.** If the review can't be shown
  whole, the card has no buttons. Buttons carry a hash of the review; if the
  ask changed, the click is refused and the new card posted.
- **PAC's words are data.** MCP output is wrapped in `<pac_data>`; Slack
  escapes `<`, `>`, `&` in everything PAC or other people wrote.
- **Interfaces never grant.** `watch` runs with `--no-auto-grant`; granting is
  the daemon's and the user's job.
- **Logs carry codes and counts, never content.**

## Setup (macOS, PAC installed and granted)

```bash
npm install
export PAC_HOME=/Users/Shared/neuralweb-pac
node bin/main.ts doctor        # must show your user and "grant": "granted"
```

### Claude Code

```bash
node bin/main.ts install claude-code   # prints: skill copy, hook JSON, `claude mcp add` line
```

### Hermes

```bash
node bin/main.ts install hermes        # prints: skill copy, mcp_servers block
```

Add the MCP server with `hermes mcp add` or the dashboard. `PAC_HOME` must be
in the server's `env`.

### Slack

See [`slack/README.md`](slack/README.md).

## Develop

```bash
npm run check                         # tsc + vitest (a fake `pac` binary records every argv)
PAC_HOME=<home> node dev/smoke.ts     # read-only smoke against a real home
```

Node 24+, TS by type stripping (`.ts` import specifiers, erasable syntax only),
single-line commits.
