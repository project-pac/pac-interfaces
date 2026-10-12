#!/usr/bin/env node
import { readFileSync } from "node:fs";

/**
 * Claude Code PreToolUse hook: refuses any Bash command that gives a PAC
 * consent: `pac reply <ask> yes|no|edit`, anything with `--yes` (an
 * approval's yes, a file's access, a group submission), or 0.5's
 * `pac decide`. Approvals are the user's own act; with the skill path
 * (Claude calling the CLI itself) this hook is what makes that structural
 * instead of a request. Answering a plain question (text, `--choice`,
 * `--skip`) stays open to Claude. Exit 2 blocks the call and tells Claude
 * why (stderr).
 */

const PAC = String.raw`(^|[\s;&|("'/` + "`" + String.raw`$])(pac|\$\{?PAC\}?)["']?\s+(?:--?\S+\s+)*`;
const DECIDE = new RegExp(`${PAC}decide\\b`);
const REPLY = new RegExp(`${PAC}reply\\b([^;&|]*)`);

export function decides(command: string): boolean {
  if (DECIDE.test(command)) {
    return true;
  }
  const m = command.match(REPLY);
  if (!m) {
    return false;
  }
  const args = (m[3] ?? "").split(/\s+/).map((a) => a.replace(/^["']|["']$/g, ""));
  // A value given to --choice or --text answers a question; it isn't a decision.
  const words = args.filter((_, i) => !["--choice", "--text"].includes(args[i - 1] ?? ""));
  return words.some((a) => a === "yes" || a === "no" || a === "edit" || a === "--yes" || a.startsWith("--yes="));
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
    process.stderr.write(
      "Blocked: approving, editing or declining a PAC share, letting PAC read a file, and submitting to a group are the user's own decisions. Tell them to decide in Slack, PAC's app, or by running `pac reply` themselves. (To answer a yes-or-no question, use `pac reply <ask> --choice yes`.)\n",
    );
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
