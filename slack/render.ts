import { createHash } from "node:crypto";
import type { ApprovalBody, Ask, Person, RequestBody, Tx } from "../pac/types.ts";

/**
 * Slack Block Kit for PAC: pure functions, so every invariant is testable
 * without Slack. Slack caps a section at 3000 chars and a message at 50 blocks.
 */

export type Block = Record<string, unknown>;

const SECTION_MAX = 2900;
const BLOCKS_MAX = 50;
const WITHHELD = "[withheld]";

export const ACTION = { approve: "pac_approve", edit: "pac_edit", decline: "pac_decline", answer: "pac_answer", skip: "pac_skip" } as const;
export const VIEW = { answer: "pac_answer_view", edit: "pac_edit_view" } as const;

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

/** Exactly which review a button decides: a click on a card whose ask changed is refused. */
export function reviewHash(body: ApprovalBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
}

export interface ButtonValue {
  ask: string;
  h?: string;
}

export function parseValue(raw: string | undefined): ButtonValue | undefined {
  try {
    const v = JSON.parse(raw ?? "") as Partial<ButtonValue>;
    return typeof v.ask === "string" ? { ask: v.ask, ...(typeof v.h === "string" ? { h: v.h } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** The goal and who asked it, from `tx ls` (asks don't carry them). */
export interface Context {
  goal: string;
  from: string;
  people: Person[];
}

export function contextOf(tx: Tx | undefined): Context {
  if (!tx) {
    return { goal: "", from: "Someone", people: [] };
  }
  return { goal: tx.intent?.prompt ?? "", from: tx.participants.find((p) => p.user === tx.initiator)?.name ?? "Someone", people: tx.participants };
}

export function requestBlocks(ask: Ask<RequestBody>, ctx: Context): Block[] {
  const value = JSON.stringify({ ask: ask.id } satisfies ButtonValue);
  return [
    { type: "header", text: { type: "plain_text", text: "PAC has a question for you" } },
    ...sections(`*${esc(ctx.from)}* asked PAC:\n${quote(ctx.goal)}\n\nPAC asks you:\n${quote(ask.body.question)}`),
    context("Your answer goes only to PAC. Nothing of yours reaches anyone until you approve it."),
    {
      type: "actions",
      elements: [
        { type: "button", action_id: ACTION.answer, text: { type: "plain_text", text: "Answer" }, style: "primary", value },
        { type: "button", action_id: ACTION.skip, text: { type: "plain_text", text: "Skip" }, value },
      ],
    },
  ];
}

/**
 * An approval, with every passage of the user's that would go to anyone.
 * If it can't all be shown in one message, no decision buttons are offered.
 */
export function approvalBlocks(ask: Ask<ApprovalBody>, ctx: Context): { blocks: Block[]; decidable: boolean } {
  const b = ask.body;
  const nameOf = (user: string) => b.recipients.find((r) => r.user === user)?.name ?? ctx.people.find((p) => p.user === user)?.name ?? user.slice(0, 8);
  const head: Block[] = [
    { type: "header", text: { type: "plain_text", text: "Approve what PAC shares of yours" } },
    ...sections(`For *${esc(ctx.from)}*'s question:\n${quote(ctx.goal)}` + (b.summary ? `\n\n*What this round did:* ${esc(b.summary)}` : "") + (b.whyIncluded ? `\n*Why your data is in it:* ${esc(b.whyIncluded)}` : "")),
  ];
  if (b.yourFiles.length) {
    head.push(context(`Your files used: ${b.yourFiles.map((f) => `\`${esc(f.name)}\``).join(", ")}`));
  }
  const body: Block[] = [];
  for (const d of b.disclosures) {
    const lines = [`*To ${esc(nameOf(d.to))}:*`];
    if (!d.items.length && !d.overlaps?.length) {
      lines.push("_Nothing of yours._");
    }
    for (const item of d.items) {
      lines.push(`${quote(item.quote)}\n   _${esc(item.how)}_${item.by.includes("execute") ? "" : " _(not cited)_"}`);
    }
    for (const o of d.overlaps ?? []) {
      lines.push(`Verbatim overlap:\n${quote(o.text)}`);
    }
    for (const e of d.edits ?? []) {
      lines.push(`Following your edit: _${esc(e.how)}_`);
    }
    body.push({ type: "divider" }, ...sections(lines.join("\n")));
  }
  const warnings: string[] = [];
  if ((b.unverifiedQuotes ?? 0) > 0) {
    warnings.push(`${b.unverifiedQuotes} quote(s) could not be verified against your files.`);
  }
  if (`${b.summary ?? ""} ${b.whyIncluded ?? ""}`.includes(WITHHELD)) {
    warnings.push("[withheld] marks words that repeat someone else's material, which you can't be shown. Every passage of yours is listed above.");
  }
  const all = [...head, ...body, ...(warnings.length ? [context(`:warning: ${warnings.join(" ")}`)] : [])];
  if (all.length + 1 > BLOCKS_MAX) {
    return { blocks: [...all.slice(0, BLOCKS_MAX - 1), context("Too much to show in Slack in full: decide this one with `pac asks` / `pac decide` or PAC's app.")], decidable: false };
  }
  const value = JSON.stringify({ ask: ask.id, h: reviewHash(b) } satisfies ButtonValue);
  return {
    blocks: [
      ...all,
      {
        type: "actions",
        elements: [
          { type: "button", action_id: ACTION.approve, text: { type: "plain_text", text: "Yes, share" }, style: "primary", value },
          { type: "button", action_id: ACTION.edit, text: { type: "plain_text", text: "Ask for a change" }, value },
          { type: "button", action_id: ACTION.decline, text: { type: "plain_text", text: "No" }, style: "danger", value },
        ],
      },
    ],
    decidable: true,
  };
}

export function answerBlocks(tx: Tx, answer: string): Block[] {
  const ctx = contextOf(tx);
  const text = sections(esc(answer));
  const room = BLOCKS_MAX - 4;
  return [
    { type: "header", text: { type: "plain_text", text: "PAC answered" } },
    ...sections(`*${esc(ctx.from)}* asked:\n${quote(ctx.goal)}`),
    { type: "divider" },
    ...(text.length > room ? [...text.slice(0, room - 1), context("Answer cut for Slack: the full text is in your PAC files.")] : text),
    context(`With ${ctx.people.map((p) => esc(p.name)).join(", ")} · \`${tx.id}\``),
  ];
}

export function textModal(callback: string, meta: string, title: string, label: string): Block {
  return {
    type: "modal",
    callback_id: callback,
    private_metadata: meta,
    title: { type: "plain_text", text: title },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "input", block_id: "text", label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000 } }],
  };
}

export const resolved = (text: string): Block[] => [{ type: "section", text: { type: "mrkdwn", text } }];
