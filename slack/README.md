# Slack interface

One Slack bot for **one PAC home** and **one Slack user** (its owner). It runs
on the owner's machine in Socket Mode: no public URL, keys never leave the home.

- `/pac <question>` or a DM: asks PAC (`pac goal … --wait`).
- `/pac status`, `/pac asks` (re-post open cards), `/pac help`.
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

Logs are one JSON line per event (`slack_started`, `synced` with counts,
`sync_failed` / `watch_exited` with a code).

## Test on the network

1. `/pac status`: your name, `grant: granted`.
2. `/pac What …?`: you get `Sent to PAC (tx_…)`.
3. Someone else on the network asks something your files answer, so you get
   an approval card. Click **Yes, share**. The card changes to "Approved".
4. The answer card arrives in the DM when PAC releases it.
