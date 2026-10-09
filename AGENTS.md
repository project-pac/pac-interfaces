# pac-interfaces: agent notes

- Interfaces talk to PAC only through `pac <cmd> … --json` (`pac/cli.ts`).
  Never the daemon's HTTP API, never `keys.json`, never `pac-agent`/`pac-system` code.
- Nothing a model can call may reach `Pac.decide`. Only `slack/decide.ts`
  (an owner's click, hash-checked) calls it. The MCP test asserts this for every tool.
- Node 24+, TS by type stripping: `.ts` import specifiers, erasable syntax only.
- `npm run check` before committing. Single-line commit messages. Push only when asked.
- Tests use `tests/fake-pac.ts` (a fake `pac` via `PAC_BIN`), one invariant per test.
