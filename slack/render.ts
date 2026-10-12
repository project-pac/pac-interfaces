import { createHash } from "node:crypto";
import type { AccessBody, ApprovalBody, Ask, AskBody, DataBody, GroupSpec, Person, QuestionBody, Session } from "../pac/types.ts";

/**
 * Slack Block Kit for PAC: pure functions, so every invariant is testable
 * without Slack. Slack caps a section at 3000 chars and a message at 50 blocks.
 */

export type Block = Record<string, unknown>;

const SECTION_MAX = 2900;
const BLOCKS_MAX = 50;
const WITHHELD = "[withheld]";

export const ACTION = {
  // An approval.
  approve: "pac_approve",
  edit: "pac_edit",
  decline: "pac_decline",
  // A question.
  answer: "pac_answer",
  choose: "pac_choose",
  skip: "pac_skip",
  pass: "pac_pass",
  // An access ask.
  allow: "pac_allow",
  deny: "pac_deny",
  // A group run's data ask.
  submit: "pac_submit",
  submitChoice: "pac_submit_choice",
} as const;
export const VIEW = { answer: "pac_answer_view", edit: "pac_edit_view", deny: "pac_deny_view", submit: "pac_submit_view" } as const;

/** Slack mrkdwn: escape the three control characters, so `<!channel>` and links in other people's words stay text. */
export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const quote = (text: string) =>
  esc(text)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

export function chunk(text: string, max = SECTION_MAX): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) {
      cut = max;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) {
    out.push(rest);
  }
  return out;
}

const sections = (text: string): Block[] => chunk(text).map((piece) => ({ type: "section", text: { type: "mrkdwn", text: piece } }));
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const header = (text: string): Block => ({ type: "header", text: { type: "plain_text", text: text.slice(0, 150) } });
const button = (action_id: string, text: string, value: string, style?: "primary" | "danger", confirm?: Block): Block => ({
  type: "button",
  action_id,
  text: { type: "plain_text", text: text.slice(0, 75) },
  value,
  ...(style ? { style } : {}),
  ...(confirm ? { confirm } : {}),
});
const names = (people: Person[]) => people.map((p) => esc(p.name)).join(", ");

/** Exactly which ask a button acts on: a click on a card whose ask changed is refused. */
export function reviewHash(body: AskBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
}

export interface ButtonValue {
  ask: string;
  h?: string;
  /** A choice the button gives. */
  c?: string;
}

export function parseValue(raw: string | undefined): ButtonValue | undefined {
  try {
    const v = JSON.parse(raw ?? "") as Partial<ButtonValue>;
    return typeof v.ask === "string" ? { ask: v.ask, ...(typeof v.h === "string" ? { h: v.h } : {}), ...(typeof v.c === "string" ? { c: v.c } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

const valueOf = (ask: Ask, c?: string) => JSON.stringify({ ask: ask.id, h: reviewHash(ask.body), ...(c !== undefined ? { c } : {}) } satisfies ButtonValue);

/** Who asked PAC what, as every ask carries it. */
const asked = (ask: Ask) => `*${esc(ask.prompt.by.name)}* asked PAC:\n${quote(ask.prompt.text)}`;

const DECLINE_CONFIRM: Block = {
  title: { type: "plain_text", text: "Decline?" },
  text: { type: "plain_text", text: "PAC skips this, and asks you nothing more in this session." },
  confirm: { type: "plain_text", text: "Decline" },
  deny: { type: "plain_text", text: "Back" },
};

/** Buttons for what a question or data ask takes, in the form it takes it. */
function answerButtons(ask: Ask, format: { answer: QuestionBody["answer"]; choices?: string[] }, kinds: { text: string; choose: string; label: string }, decline: boolean): Block[] {
  const v = valueOf(ask);
  const choices = format.answer === "yes_no" ? ["yes", "no"] : format.answer === "choice" ? (format.choices ?? []) : [];
  const elements: Block[] = [];
  if (format.answer === "text") {
    elements.push(button(kinds.text, kinds.label, v, "primary"));
  }
  for (const c of choices.slice(0, 8)) {
    elements.push(button(kinds.choose, format.answer === "yes_no" ? (c === "yes" ? "Yes" : "No") : c, valueOf(ask, c)));
  }
  elements.push(button(ACTION.skip, "Skip", v));
  if (decline) {
    elements.push(button(ACTION.pass, "Decline", v, undefined, DECLINE_CONFIRM));
  }
  const out: Block[] = [{ type: "actions", elements }];
  if (format.answer === "files") {
    out.unshift(context(`This takes files of yours: answer in PAC's app, or \`pac reply ${ask.id} --files <file>\`.`));
  }
  return out;
}

export function questionBlocks(ask: Ask<QuestionBody>): Block[] {
  return [
    header("PAC has a question for you"),
    ...sections(`${asked(ask)}\n\nPAC asks you${ask.body.everyone ? " (and everyone on PAC)" : ""}:\n${quote(ask.body.text)}`),
    context("Your answer goes only to PAC. Nothing of yours reaches anyone until you approve it."),
    ...answerButtons(ask, ask.body, { text: ACTION.answer, choose: ACTION.choose, label: "Answer" }, true),
  ];
}

export function accessBlocks(ask: Ask<AccessBody>): Block[] {
  const v = valueOf(ask);
  return [
    header("PAC asks to read a file of yours"),
    ...sections(`${asked(ask)}\n\nPAC wants to read *${esc(ask.body.name)}*, which you keep as "ask first".${ask.body.text ? `\nWhy, in its words:\n${quote(ask.body.text)}` : ""}`),
    context("Yes lets PAC read it for the rest of this session. Nothing of yours reaches anyone until you approve it."),
    { type: "actions", elements: [button(ACTION.allow, "Yes, let PAC read it", v, "primary"), button(ACTION.deny, "No", v)] },
  ];
}

/**
 * An approval, with every passage of the user's that would go to anyone.
 * If it can't all be shown in one message, no decision buttons are offered.
 */
export function approvalBlocks(ask: Ask<ApprovalBody>): { blocks: Block[]; decidable: boolean } {
  const b = ask.body;
  const nameOf = (user: string) => b.recipients.find((r) => r.user === user)?.name ?? user.slice(0, 8);
  const head: Block[] = [
    header("Approve what PAC shares of yours"),
    ...sections(`For ${asked(ask)}` + (b.summary ? `\n\n*What goes to whom:* ${esc(b.summary)}` : "") + (b.whyIncluded ? `\n*Why your data is in it:* ${esc(b.whyIncluded)}` : "")),
  ];
  const facts = [`Recipients: ${names(b.recipients)}`];
  if (b.yourMaterial.length) {
    facts.push(`Of yours: ${b.yourMaterial.map((m) => `\`${esc(m.name)}\`${m.index ? " (its index entry)" : ""}`).join(", ")}`);
  }
  if (b.revisedFor?.length) {
    facts.push(`Revised for ${names(b.revisedFor)}'s edits`);
  }
  head.push(context(facts.join(" · ")));
  const body: Block[] = [];
  for (const d of b.disclosures) {
    const lines = [`*To ${esc(nameOf(d.to))}:*`];
    if (!d.items.length && !d.overlaps?.length) {
      lines.push("_Nothing of yours._");
    }
    for (const item of d.items) {
      const notes = [item.by.includes("agent") ? "" : "not cited", item.index ? "from the file's index entry" : ""].filter(Boolean);
      lines.push(`${quote(item.quote)}\n   _${esc(item.how)}_${notes.length ? ` _(${notes.join(", ")})_` : ""}`);
    }
    for (const o of d.overlaps ?? []) {
      lines.push(`Verbatim overlap${o.index ? " (index entry)" : ""}:\n${quote(o.text)}`);
    }
    for (const e of d.edits ?? []) {
      lines.push(`Following your edit: _${esc(e.how)}_`);
    }
    body.push({ type: "divider" }, ...sections(lines.join("\n")));
  }
  const warnings: string[] = [];
  if ((b.unverifiedQuotes ?? 0) > 0) {
    warnings.push(`${b.unverifiedQuotes} quote(s) could not be verified against your material.`);
  }
  if (`${b.summary ?? ""} ${b.whyIncluded ?? ""}`.includes(WITHHELD)) {
    warnings.push("[withheld] marks words that repeat someone else's material, which you can't be shown. Every passage of yours is listed above.");
  }
  const all = [...head, ...body, ...(warnings.length ? [context(`:warning: ${warnings.join(" ")}`)] : [])];
  if (all.length + 1 > BLOCKS_MAX) {
    return { blocks: [...all.slice(0, BLOCKS_MAX - 1), context(`Too much to show in Slack in full: decide this one with \`pac asks\` / \`pac reply ${ask.id}\` or PAC's app.`)], decidable: false };
  }
  const v = valueOf(ask);
  return {
    blocks: [...all, { type: "actions", elements: [button(ACTION.approve, "Yes, share", v, "primary"), button(ACTION.edit, "Ask for a change", v), button(ACTION.decline, "No", v, "danger")] }],
    decidable: true,
  };
}

const READS: Record<GroupSpec["reads"], string> = { submissions: "only what members submit", members: "members' files too", anyone: "anyone's files it finds" };

function recipientsOf(to: GroupSpec["to"]): string {
  if (Array.isArray(to)) {
    return names(to);
  }
  const words: Record<string, string> = { members: "every member", submitters: "those who submit", each: "each submitter, their own", creator: "its creator", agent: "whoever PAC picks, approved by those it affects" };
  return words[to] ?? esc(to);
}

/** A group run's data ask: the whole group as members see it, since a submission consents to exactly that. */
export function dataBlocks(ask: Ask<DataBody>): Block[] {
  const s = ask.body.spec;
  return [
    header(`Group "${s.name}": run ${ask.body.run}`),
    ...sections(
      [
        `*${esc(s.creator.name)}* runs this group. Its prompt, run over what members submit:\n${quote(s.run.prompt)}`,
        `It asks each member:\n${quote(s.ask.text)}`,
        `*Members:* ${s.members === "open" ? "open to anyone on PAC" : names(s.members)}`,
        `*PAC reads:* ${READS[s.reads]}${s.files ? `, and ${s.files} of the creator's files` : ""}`,
        `*The output goes to:* ${recipientsOf(s.to)}`,
      ].join("\n\n"),
    ),
    context(`Your submission is consent to exactly this computation (at most ${s.ask.maxChars} characters). Members see how many submitted, never who.`),
    ...answerButtons(ask, s.ask, { text: ACTION.submit, choose: ACTION.submitChoice, label: "Submit" }, false),
  ];
}

/** The card for any open ask, by its kind. */
export function askBlocks(ask: Ask): Block[] {
  switch (ask.body.kind) {
    case "question":
      return questionBlocks(ask as Ask<QuestionBody>);
    case "access":
      return accessBlocks(ask as Ask<AccessBody>);
    case "approval":
      return approvalBlocks(ask as Ask<ApprovalBody>).blocks;
    case "data":
      return dataBlocks(ask as Ask<DataBody>);
  }
}

export function askSummary(ask: Ask): string {
  switch (ask.body.kind) {
    case "question":
      return `PAC asks: ${ask.body.text}`;
    case "access":
      return `PAC asks to read ${ask.body.name}`;
    case "approval":
      return `PAC wants your approval for: ${ask.prompt.text}`;
    case "data":
      return `Group ${ask.body.spec.name}: your submission`;
  }
}

export function answerBlocks(session: Session, turn: number, answer: string): Block[] {
  const t = session.turns.find((x) => x.n === turn) ?? session.turns.at(-1);
  const by = session.people.find((p) => p.user === t?.by)?.name ?? "Someone";
  const text = sections(esc(answer));
  const room = BLOCKS_MAX - 4;
  return [
    header(session.group ? `PAC answered: ${session.group.name}` : "PAC answered"),
    ...sections(`*${esc(by)}* asked:\n${quote(t?.prompt ?? "")}`),
    { type: "divider" },
    ...(text.length > room ? [...text.slice(0, room - 1), context("Answer cut for Slack: the full text is in your PAC files.")] : text),
    context(`With ${names(session.people)} · \`${esc(session.ref ?? session.id)}\`${session.turns.length > 1 ? ` · turn ${turn}` : ""}`),
  ];
}

export function textModal(callback: string, meta: string, title: string, label: string, optional = false): Block {
  return {
    type: "modal",
    callback_id: callback,
    private_metadata: meta,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "text", optional, label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000 } }],
  };
}

export const resolved = (text: string): Block[] => [{ type: "section", text: { type: "mrkdwn", text } }];
