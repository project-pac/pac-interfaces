# Claude companion

Moving here from `project-pac/pac-agent@claude-companion` (owner: Dhrumil).

It stores session intents in the user's PAC vault and surfaces relevant PAC
results next to Claude's answers.

**Before it runs here:** that branch reads PAC through the daemon's data
routes (`/api/me`, `/api/feed`, `/api/asks`, `/api/goal`, `/api/files`, …).
PAC 0.5 serves only control routes on the daemon, and the decision is that
interfaces talk to the `pac` CLI directly. So its `pac/daemon.ts` layer
should be swapped for `../pac/cli.ts`. There is no `pac feed`: build feed
items from `pac tx ls` (released ⇔ `pointer.resultFile`) plus `pac files cat`.
