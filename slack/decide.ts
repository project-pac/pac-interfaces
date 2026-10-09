import type { Pac } from "../pac/cli.ts";
import { isApproval, isRequest } from "../pac/types.ts";
import { reviewHash, type ButtonValue } from "./render.ts";

export type Outcome = { ok: true; text: string } | { ok: false; reason: "changed" | "closed" | "not_approval" | "not_request" | "text_required"; text: string };

/**
 * A click on an approval card, checked against the ask as it is now: still
 * open, and the same review the card showed. Only then is it sent.
 */
export async function decide(pac: Pac, value: ButtonValue, choice: "yes" | "edit" | "no", text?: string): Promise<Outcome> {
  const ask = await pac.ask(value.ask);
  if (!isApproval(ask)) {
    return { ok: false, reason: "not_approval", text: "That isn't an approval." };
  }
  if (ask.status !== "open") {
    return { ok: false, reason: "closed", text: "This approval is already decided or closed." };
  }
  if (!value.h || value.h !== reviewHash(ask.body)) {
    return { ok: false, reason: "changed", text: "This approval changed since it was shown. The new version is posted below." };
  }
  if (choice === "edit" && !text?.trim()) {
    return { ok: false, reason: "text_required", text: "Say what to change." };
  }
  await pac.decide(ask.id, choice, choice === "edit" ? text!.trim() : undefined);
  const said = {
    yes: ":white_check_mark: Approved. PAC releases once everyone involved agrees.",
    edit: ":pencil2: Change requested. PAC runs a new round and asks you again.",
    no: ":no_entry: Declined. Nothing is released.",
  };
  return { ok: true, text: said[choice] };
}

export async function answerRequest(pac: Pac, value: ButtonValue, action: "answer" | "skip", text?: string): Promise<Outcome> {
  const ask = await pac.ask(value.ask);
  if (!isRequest(ask)) {
    return { ok: false, reason: "not_request", text: "That isn't a question." };
  }
  if (ask.status !== "open") {
    return { ok: false, reason: "closed", text: "This question is already answered or closed." };
  }
  if (action === "answer" && !text?.trim()) {
    return { ok: false, reason: "text_required", text: "Write an answer." };
  }
  if (action === "answer") {
    await pac.answer(ask.id, text!.trim());
  } else {
    await pac.skip(ask.id);
  }
  return { ok: true, text: action === "answer" ? ":speech_balloon: Answered. You approve before anything of yours is shared." : ":fast_forward: Skipped." };
}
