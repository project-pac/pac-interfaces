# Relay: the shared PAC Slack app

One "PAC" bot for the whole Slack workspace. Anyone can connect **their own**
PAC to it: the relay carries Slack events to a small connector on that
person's machine, and the connector runs their `pac`. The relay holds the
Slack tokens and the list of who is linked; it never holds a PAC key and runs
no `pac` command.

```
Slack ──Socket Mode──▶ relay ◀──WebSocket (/connect)── connector on each person's machine ──▶ ~/.pac/bin/pac … --json
```

What the relay lets a connector do, and nothing else:

- post and update messages in **its own person's DM** with the bot;
- respond to, and open forms on, **its own person's** Slack events (it names
  them by id; trigger ids and response URLs never leave the relay);
- PAC's words go `in_channel` only in that DM; anywhere else they're ephemeral.

What the relay can see: whatever it carries, which is what Slack shows that
person anyway (cards, answers). Whoever runs it is trusted with that, as Slack is.

## Run it

1. Create the Slack app from [`../slack/manifest.yaml`](../slack/manifest.yaml)
   (api.slack.com/apps → **Create New App → From a manifest**), install it to
   the workspace, and make an app-level token with `connections:write`.
2. Deploy (Railway: a service from this repo, `RAILWAY_DOCKERFILE_PATH=relay/Dockerfile`,
   a volume at `/data`, a public domain). Variables:

   | Variable | What |
   |---|---|
   | `SLACK_BOT_TOKEN` | `xoxb-…` |
   | `SLACK_APP_TOKEN` | `xapp-…` |
   | `PAC_RELAY_URL` | `wss://<public domain>/connect`, shown to people when they link |
   | `PAC_RELAY_DATA` | where links are kept (`/data` in the image) |
   | `PAC_RELAY_GET` | optional: how people get the connector (default: clone this repo + `npm install`) |

   Locally: `SLACK_BOT_TOKEN=… SLACK_APP_TOKEN=… node bin/main.ts relay` (port 8080, `GET /health`).

Only one Socket Mode client should run per Slack app: stop any owner-mode
`slack` bot that uses the same app first.

## Connect (each person)

1. In Slack: `/pac link` (or DM the bot anything). It answers with a one-time
   code (10 minutes) and the exact command.
2. On your machine, with PAC installed and granted, in a pac-interfaces checkout:
   `node bin/main.ts slack connect <code> --relay wss://…/connect`
3. Keep it running at login: `node bin/main.ts slack service install`
   (`status`, `uninstall`). Logs: `$PAC_HOME/interfaces/slack/connector.log`.

`/pac unlink` disconnects. Linking again (another code) replaces the old connector.
