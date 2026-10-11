# Slack interface

Two ways to run it, with the same commands and cards:

- **Shared PAC app** (anyone in the workspace): one bot, run by the
  [relay](../relay/README.md); each person links the PAC on their own machine
  with `/pac link` and `node bin/main.ts slack connect <code> --relay …`.
- **Your own app** (owner mode, below): one Slack bot for **one PAC home** and
  **one Slack user**. It runs on the owner's machine in Socket Mode: no public
  URL, keys never leave the home.

Either way, every PAC call is the person's own `pac` on their own machine.

- `/pac <question>` or a DM: asks PAC (`pac goal … --wait`).
- `/pac with Dhrumil,me <question>`: ask the people you name (`/pac contacts`).
- `/pac threads`, `/pac show <tx>`, `/pac reply <tx> <text>`; or reply in an answer card's Slack thread to ask a follow-up. Answer cards have Reply and Abort buttons (Abort asks Slack-side confirmation first; `/pac abort` only shows that button).
- `/pac files`, `/pac file <name|id>`, `/pac remember <name.md>` (opens a form, or put the text on the next lines).
- `/pac status`, `/pac verify`, `/pac trust`, `/pac contacts`, `/pac asks` (re-post open cards), `/pac help`.
- Not here, by design: keys, grants, upgrades, deleting files, `pac decide` outside a card click. Use the terminal.
- PAC's questions → card with **Answer** (modal) / **Skip**.
- Approvals → card with every passage of yours, per recipient, then
  **Yes, share** / **Ask for a change** (modal) / **No**. The click is checked
  against the ask as it is now (still open, same review hash).
- Released answers → card in the DM (only ones released after the bot first ran).

It hears about changes from `pac watch --json --no-auto-grant`, with a slow
poll (`PAC_SLACK_POLL_MS`, default 60 s) in case `watch` dies. What it already
posted lives in `$PAC_HOME/interfaces/slack/state.json`.

## Create the Slack app

1. api.slack.com/apps → **Create New App** → **From a manifest** → pick the
   workspace → paste `manifest.yaml`.
2. **Basic Information → App-Level Tokens** → generate one with
   `connections:write` → that's `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → install to the workspace → **Bot User OAuth Token** →
   `SLACK_BOT_TOKEN` (`xoxb-…`).
4. Your Slack member id (profile → ⋯ → **Copy member ID**) → `PAC_SLACK_OWNER`.

## Run

```bash
export PAC_HOME=/Users/Shared/neuralweb-pac
export SLACK_BOT_TOKEN=xoxb-… SLACK_APP_TOKEN=xapp-… PAC_SLACK_OWNER=U…
node bin/main.ts slack
```

Tokens: put `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `PAC_SLACK_OWNER` in `$PAC_HOME/interfaces/slack/.env` (mode 600); `node bin/main.ts slack` reads it and it wins over exported shell variables.

Logs are one JSON line per event (`slack_started`, `synced` with counts,
`sync_failed` / `watch_exited` with a code).

## Test on the network

1. `/pac status`: your name, `grant: granted`.
2. `/pac What …?`: you get `Sent to PAC (tx_…)`.
3. Someone else on the network asks something your files answer, so you get
   an approval card. Click **Yes, share**. The card changes to "Approved".
4. The answer card arrives in the DM when PAC releases it.
