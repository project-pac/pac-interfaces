import type { Pac } from "../pac/cli.ts";
import type { Ask, AskBody } from "../pac/types.ts";
import { reviewHash, type ButtonValue } from "./render.ts";

export type Outcome = { ok: true; text: string } | { ok: false; reason: "changed" | "closed" | "wrong_kind" | "text_required" | "bad_choice" | "too_long"; text: string };

/**
 * A click, checked against its ask as it is now: still open, the kind the
 * card was for, and the same ask the card showed. Only then is it sent.
 */
async function current(pac: Pac, value: ButtonValue, kind: AskBody["kind"]): Promise<Ask | Outcome> {
  const ask = await pac.ask(value.ask);
  if (ask.body.kind !== kind) {
    return { ok: false, reason: "wrong_kind", text: "That card isn't for this kind of ask." };
  }
  if (ask.status !== "open") {
    return { ok: false, reason: "closed", text: "This is already answered, decided or closed." };
  }
  if (!value.h || value.h !== reviewHash(ask.body)) {
    return { ok: false, reason: "changed", text: "This changed since it was shown. The new version is posted below." };
  }
  return ask;
}
const isOutcome = (v: Ask | Outcome): v is Outcome => "ok" in v;

/** An approval: yes, edit (with what to change) or no. */
export async function decide(pac: Pac, value: ButtonValue, choice: "yes" | "edit" | "no", text?: string): Promise<Outcome> {
  const ask = await current(pac, value, "approval");
  if (isOutcome(ask)) {
    return ask;
  }
  if (choice === "edit" && !text?.trim()) {
    return { ok: false, reason: "text_required", text: "Say what to change." };
  }
  await pac.decide(ask.id, choice, choice === "yes" ? undefined : text?.trim() || undefined);
  const said = {
    yes: ":white_check_mark: Approved. PAC releases once everyone involved agrees.",
    edit: ":pencil2: Change requested. PAC revises, and everyone approves again.",
    no: ":no_entry: Declined. The turn ends and nothing is released.",
  };
  return { ok: true, text: said[choice] };
}

/** An access ask: yes lets PAC read the file for the rest of the session; no keeps it closed, with why if given. */
export async function access(pac: Pac, value: ButtonValue, choice: "yes" | "no", why?: string): Promise<Outcome> {
  const ask = await current(pac, value, "access");
  if (isOutcome(ask)) {
    return ask;
  }
  await pac.decide(ask.id, choice, choice === "no" ? why?.trim() || undefined : undefined);
  return { ok: true, text: choice === "yes" ? ":open_file_folder: PAC may read it for the rest of this session. You still approve before anything of yours is shared." : ":lock: Kept closed." };
}

export type Answer = { text: string } | { choice: string } | "skip" | "decline";

/** A question: text, a choice, a skip, or a decline (asked nothing more in its session). */
export async function answerQuestion(pac: Pac, value: ButtonValue, answer: Answer): Promise<Outcome> {
  const ask = await current(pac, value, "question");
  if (isOutcome(ask) || ask.body.kind !== "question") {
    return isOutcome(ask) ? ask : { ok: false, reason: "wrong_kind", text: "" };
  }
  if (answer === "skip" || answer === "decline") {
    await pac.pass(ask.id, answer);
    return { ok: true, text: answer === "skip" ? ":fast_forward: Skipped." : ":no_bell: Declined. PAC asks you nothing more in this session." };
  }
  if ("text" in answer) {
    if (!answer.text.trim()) {
      return { ok: false, reason: "text_required", text: "Write an answer." };
    }
    await pac.answer(ask.id, answer.text.trim());
  } else {
    const allowed = ask.body.answer === "yes_no" ? ["yes", "no"] : (ask.body.choices ?? []);
    if (!allowed.includes(answer.choice)) {
      return { ok: false, reason: "bad_choice", text: "That isn't one of its choices." };
    }
    await pac.choose(ask.id, answer.choice);
  }
  return { ok: true, text: ":speech_balloon: Answered. You approve before anything of yours is shared." };
}

/** A group run's data ask: a submission consents to the whole group as its card showed it. */
export async function submitData(pac: Pac, value: ButtonValue, answer: { text: string } | { choice: string } | "skip"): Promise<Outcome> {
  const ask = await current(pac, value, "data");
  if (isOutcome(ask) || ask.body.kind !== "data") {
    return isOutcome(ask) ? ask : { ok: false, reason: "wrong_kind", text: "" };
  }
  if (answer === "skip") {
    await pac.pass(ask.id, "skip");
    return { ok: true, text: ":fast_forward: Skipped this run." };
  }
  const format = ask.body.spec.ask;
  if ("text" in answer) {
    const text = answer.text.trim();
    if (!text) {
      return { ok: false, reason: "text_required", text: "Write your submission." };
    }
    if (text.length > format.maxChars) {
      return { ok: false, reason: "too_long", text: `At most ${format.maxChars} characters.` };
    }
    await pac.submit(ask.id, { text });
  } else {
    const allowed = format.answer === "yes_no" ? ["yes", "no"] : (format.choices ?? []);
    if (!allowed.includes(answer.choice)) {
      return { ok: false, reason: "bad_choice", text: "That isn't one of its choices." };
    }
    await pac.submit(ask.id, { choice: answer.choice });
  }
  return { ok: true, text: ":inbox_tray: Submitted to the group's run." };
}
