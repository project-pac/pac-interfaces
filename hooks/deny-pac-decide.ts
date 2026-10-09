#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Claude Code PreToolUse hook: refuses any Bash command that runs `pac decide`.
 * Approvals are the user's own act; with the skill path (Claude calling the
 * CLI itself) this hook is what makes that structural instead of a request.
 * Exit 2 blocks the call and tells Claude why (stderr).
 */

export function decides(command: string): boolean {
  // `pac decide`, `~/.pac/bin/pac decide`, `"$PAC" decide`, with flags or quoting in between.
  return /(^|[\s;&|("'/`$])(pac|\$\{?PAC\}?)["']?\s+(?:--?\S+\s+)*decide\b/.test(command);
}

function main(): void {
  let input: { tool_name?: string; tool_input?: { command?: string } };
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const command = input.tool_input?.command ?? "";
  if (input.tool_name === "Bash" && decides(command)) {
    process.stderr.write("Blocked: approving, editing or declining a PAC share is the user's own decision. Tell them to decide in Slack, PAC's app, or by running `pac decide` themselves.\n");
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
