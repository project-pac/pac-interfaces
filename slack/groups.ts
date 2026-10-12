import { randomBytes } from "node:crypto";
import { codeOf, PacError, type Pac } from "../pac/cli.ts";
import type { Group, GroupDraft, GroupSpec, Listing, Sent } from "../pac/types.ts";
import { esc, type Block } from "./render.ts";

/**
 * Groups in Slack: a group fixes in advance what a prompt leaves to PAC (a
 * data ask every member answers, and a group prompt run over what they
 * submit), so a team's weekly sync is one. Listing, showing, joining and
 * leaving are the person's own acts; running and closing, its creator's;
 * making one is shown first as members will see it, and made only on a
 * second click. Submissions are data asks, answered on their own cards.
 */

export const GACT = {
  show: "pac_group_show",
  join: "pac_group_join",
  leave: "pac_group_leave",
  runNow: "pac_group_run_now",
  runNext: "pac_group_run_next",
  close: "pac_group_close",
  create: "pac_group_create",
  cancel: "pac_group_cancel",
} as const;
export const GMODAL = { create: "pac_group_new_view" } as const;

/** A group's id, or the start of one that pastes back. */
export const GROUP = /^g_[0-9a-f]{4,32}$/;

export interface GReply {
  text: string;
  blocks?: Block[];
  modal?: Block;
}

const say = (text: string): GReply => ({ text });
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const quote = (text: string) =>
  esc(text)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
const button = (action_id: string, text: string, value: string, style?: "primary" | "danger", confirm?: Block): Block => ({ type: "button", action_id, text: { type: "plain_text", text }, value, ...(style ? { style } : {}), ...(confirm ? { confirm } : {}) });
const confirm = (title: string, text: string, yes: string): Block => ({ title: { type: "plain_text", text: title }, text: { type: "plain_text", text }, confirm: { type: "plain_text", text: yes }, deny: { type: "plain_text", text: "Back" } });

const isGroup = (g: Group | Listing): g is Group => "id" in g && "runs" in g;

const READS: Record<GroupSpec["reads"], string> = { submissions: "only what members submit", members: "members' files too", anyone: "anyone's files it finds" };
function recipients(to: GroupSpec["to"]): string {
  if (Array.isArray(to)) {
    return to.map((p) => esc(p.name)).join(", ");
  }
  const words: Record<string, string> = { members: "every member", submitters: "those who submit", each: "each submitter, their own", creator: "its creator", agent: "whoever PAC picks, approved by those it affects" };
  return words[to] ?? esc(to);
}

/** Whether a group's latest run is still taking submissions. */
function gathering(g: Group, now = Date.now()): boolean {
  const run = g.runs.at(-1);
  return Boolean(run && !run.now && new Date(run.deadline).getTime() > now);
}

function specText(s: GroupSpec): string {
  return [
    `*${esc(s.creator.name)}* made it. Its prompt, run over what members submit:\n${quote(s.run.prompt)}`,
    `It asks each member${s.ask.answer === "text" ? "" : ` (${s.ask.answer === "yes_no" ? "yes or no" : s.ask.answer === "choice" ? `one of: ${(s.ask.choices ?? []).map(esc).join(", ")}` : "files"})`}:\n${quote(s.ask.text)}`,
    `*Members:* ${s.members === "open" ? "open to anyone on PAC" : s.members.map((p) => esc(p.name)).join(", ")}`,
    `*PAC reads:* ${READS[s.reads]}${s.files ? `, and ${s.files} of the creator's files` : ""} · *Output to:* ${recipients(s.to)}`,
  ].join("\n\n");
}

/** The buttons a group's card offers, by the person's part in it. */
function groupButtons(g: Group | Listing): Block | undefined {
  if (!isGroup(g)) {
    return { type: "actions", elements: [button(GACT.join, "Join", g.group, "primary")] };
  }
  if (g.status === "closed") {
    return undefined;
  }
  if (g.you === "left") {
    return { type: "actions", elements: [button(GACT.join, "Join again", g.id, "primary")] };
  }
  if (g.you === "member") {
    return { type: "actions", elements: [button(GACT.leave, "Leave", g.id, undefined, confirm("Leave this group?", "You stop getting its asks; a submission to a run still gathering is withdrawn.", "Leave"))] };
  }
  return {
    type: "actions",
    elements: [
      gathering(g) ? button(GACT.runNow, "Run now on what's in", g.id, "primary") : button(GACT.runNext, "Start the next run", g.id, "primary"),
      button(GACT.close, "Close the group", g.id, "danger", confirm("Close this group?", "No more runs; a run still gathering is aborted.", "Close")),
    ],
  };
}

function groupCard(g: Group | Listing): Block[] {
  const blocks: Block[] = [{ type: "header", text: { type: "plain_text", text: `Group: ${g.spec.name}`.slice(0, 150) } }, section(specText(g.spec))];
  if (isGroup(g)) {
    const run = g.runs.at(-1);
    const part = { creator: "you made it", member: "you're a member", left: "you left" }[g.you];
    blocks.push(context(`\`${esc(g.ref ?? g.id)}\` · ${part}${g.status === "closed" ? " · closed" : ""}${run ? ` · run ${run.n} ${gathering(g) ? `gathers until ${new Date(run.deadline).toUTCString()}` : "has run"}` : " · no runs yet"}${g.needsYou ? " · :raising_hand: waits on you" : ""}`));
  } else {
    blocks.push(context(`\`${esc(g.ref ?? g.group)}\` · open group${g.gathering ? ` · run ${g.gathering.run} gathers until ${new Date(g.gathering.deadline).toUTCString()}` : ""}`));
  }
  const buttons = groupButtons(g);
  return buttons ? [...blocks, buttons] : blocks;
}

export async function groupsList(pac: Pac, open: boolean): Promise<GReply> {
  const all = await pac.groups(open);
  if (!all.length) {
    return say(open ? "No open groups right now. Make one with `/pac group new`." : "You're in no groups. See `/pac groups open`, or make one with `/pac group new`.");
  }
  const blocks: Block[] = [section(open ? "*Open groups anyone on PAC may join*" : "*Your groups*")];
  for (const g of all.slice(0, 20)) {
    const id = isGroup(g) ? g.id : g.group;
    const line = isGroup(g)
      ? `*${esc(g.spec.name)}* · ${{ creator: "yours", member: "member", left: "left" }[g.you]}${g.status === "closed" ? " · closed" : ""} · run ${g.runs.at(-1)?.n ?? 0}${gathering(g) ? " gathering" : ""}${g.needsYou ? " · :raising_hand: waits on you" : ""}`
      : `*${esc(g.spec.name)}* · by ${esc(g.spec.creator.name)}${g.gathering ? ` · run ${g.gathering.run} gathering` : ""}`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${line}\n\`${esc(g.ref ?? id)}\`` }, accessory: button(GACT.show, "Show", id) });
  }
  return { text: open ? "Open PAC groups" : "Your PAC groups", blocks };
}

export async function groupShow(pac: Pac, ref: string): Promise<GReply> {
  if (!GROUP.test(ref)) {
    return say("Which group? `/pac group g_…` (see `/pac groups`).");
  }
  try {
    const g = await pac.group(ref);
    return { text: `PAC group ${g.spec.name}`, blocks: groupCard(g) };
  } catch (error) {
    return say(`No group \`${esc(ref)}\` for you (\`${esc(codeOf(error))}\`).`);
  }
}

/** What a sent group message did, in words. */
export function groupSent(s: Sent, what: string): string {
  if (s.status === "rejected" || s.receipt?.status === "rejected") {
    return `PAC refused it: \`${esc(s.receipt?.error ?? "rejected")}\``;
  }
  return `:busts_in_silhouette: ${what}.`;
}

const input = (block_id: string, label: string, element: Block, optional = false, hint?: string): Block => ({ type: "input", block_id, optional, label: { type: "plain_text", text: label }, element, ...(hint ? { hint: { type: "plain_text", text: hint } } : {}) });
const text = (multiline = false, max = 3000, placeholder?: string): Block => ({ type: "plain_text_input", action_id: "value", multiline, max_length: max, ...(placeholder ? { placeholder: { type: "plain_text", text: placeholder } } : {}) });
const option = (value: string, label: string) => ({ text: { type: "plain_text", text: label }, value });

/** `/pac group new`: everything a member will see, in one form. */
export function groupModal(): Block {
  const answers = [option("text", "In words"), option("yes_no", "Yes or no"), option("choice", "One of some choices"), option("files", "With files")];
  const tos = [option("members", "Every member"), option("submitters", "Those who submit"), option("each", "Each submitter, their own"), option("me", "Only me"), option("pac", "Let PAC pick (those affected approve)")];
  return {
    type: "modal",
    callback_id: GMODAL.create,
    title: { type: "plain_text", text: "Make a PAC group" },
    submit: { type: "plain_text", text: "Preview" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      context("A group asks every member the same thing, then runs one prompt over what they submit. You'll see it as members will, before it's made."),
      input("name", "Name", text(false, 120, "Weekly sync")),
      input("ask", "What each member is asked", text(true, 3000, "What did you ship this week, and what blocks you?")),
      input("answer", "They answer", { type: "static_select", action_id: "value", initial_option: answers[0], options: answers }),
      input("choices", "Choices, if they pick one", text(false, 1600, "on track, at risk, blocked"), true, "Comma-separated, 2 to 8."),
      input("prompt", "Group prompt: what PAC does with the submissions", text(true, 3000, "Summarize what everyone shipped and what blocks them, by person.")),
      input("invite", "Invite", text(false, 1000, "Dhrumil, Kate, @dhvani"), true, "Names or handles from /pac people, comma-separated."),
      input("open", "Open group", { type: "checkboxes", action_id: "value", options: [option("open", "Anyone on PAC may join")] }, true),
      input("to", "The output goes to", { type: "static_select", action_id: "value", initial_option: tos[0], options: tos }),
      input("by", "Submissions close", text(false, 40, "2d, Friday 17:00"), true, "Seven days unless you say."),
      input("read", "What else PAC may read", { type: "checkboxes", action_id: "value", options: [option("members", "Members' own files, not only what they submit")] }, true),
    ],
  };
}

const ANSWERS = ["text", "yes_no", "choice", "files"] as const;
const TOS = ["members", "submitters", "each", "me", "pac"] as const;

/** The form's fields as a draft, or the fields that need fixing. */
export function draftOf(values: Record<string, string>): { draft: GroupDraft } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = (values.name ?? "").trim();
  const ask = (values.ask ?? "").trim();
  const prompt = (values.prompt ?? "").trim();
  const answer = (ANSWERS as readonly string[]).includes(values.answer ?? "") ? (values.answer as GroupDraft["answer"]) : "text";
  const to = (TOS as readonly string[]).includes(values.to ?? "") ? (values.to as GroupDraft["to"]) : "members";
  const choices = (values.choices ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const invite = (values.invite ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  const open = (values.open ?? "").split(",").includes("open");
  if (!name) errors.name = "Give it a name.";
  if (!ask) errors.ask = "Say what each member is asked.";
  if (!prompt) errors.prompt = "Say what PAC does with the submissions.";
  if (answer === "choice" && (choices.length < 2 || choices.length > 8)) errors.choices = "2 to 8 choices, comma-separated.";
  if (open && invite.length) errors.invite = "An open group invites no one: leave this empty, or untick Open.";
  if (open && (to === "members" || to === "pac")) errors.to = "An open group's output goes to those who submit, each their own, or you.";
  if (Object.keys(errors).length) {
    return { errors };
  }
  return {
    draft: {
      name,
      ask,
      prompt,
      answer,
      to,
      ...(answer === "choice" ? { choices } : {}),
      ...(invite.length ? { invite } : {}),
      ...(open ? { open: true } : {}),
      ...((values.by ?? "").trim() ? { by: values.by!.trim() } : {}),
      ...((values.read ?? "").split(",").includes("members") ? { pacMayRead: true } : {}),
    },
  };
}

/** Drafts waiting on their Create click, kept in memory for an hour. */
export class Drafts {
  readonly #drafts = new Map<string, { draft: GroupDraft; at: number }>();

  put(draft: GroupDraft): string {
    const now = Date.now();
    for (const [id, d] of this.#drafts) {
      if (now - d.at > 3_600_000) {
        this.#drafts.delete(id);
      }
    }
    const id = randomBytes(9).toString("base64url");
    this.#drafts.set(id, { draft, at: now });
    return id;
  }

  take(id: string): GroupDraft | undefined {
    const d = this.#drafts.get(id);
    this.#drafts.delete(id);
    return d && Date.now() - d.at <= 3_600_000 ? d.draft : undefined;
  }
}

/** PAC's own preview of a group, as every member will see it, with Create and Cancel. */
export function previewBlocks(id: string, preview: string): Block[] {
  return [
    { type: "header", text: { type: "plain_text", text: "Make this group?" } },
    section(`\`\`\`${esc(preview).replace(/```/g, "'''")}\`\`\``),
    context("This is how every member sees it before they submit. Nothing is made until you click Create."),
    { type: "actions", elements: [button(GACT.create, "Create", id, "primary"), button(GACT.cancel, "Cancel", id)] },
  ];
}

/** Why the CLI refused, in its own words where it gave some. */
export const refusal = (error: unknown): string => (error instanceof PacError && error.message && error.message !== error.code ? `${error.message} (\`${error.code}\`)` : `\`${codeOf(error)}\``);

/** `/pac groups …` and `/pac group …`. */
export async function groupCommand(pac: Pac, word: "groups" | "group", rest: string): Promise<GReply> {
  const [sub = "", ref = "", extra = ""] = rest.split(/\s+/).filter(Boolean);
  if (word === "groups") {
    return groupsList(pac, sub.toLowerCase() === "open");
  }
  switch (sub.toLowerCase()) {
    case "":
      return groupsList(pac, false);
    case "new":
      return { text: "Make a PAC group", modal: groupModal() };
    case "show":
      return groupShow(pac, ref);
    case "join":
      return GROUP.test(ref) ? say(groupSent(await pac.groupAct("join", ref), "Joined. A run still gathering asks you too")) : say("`/pac group join g_…` (see `/pac groups open`).");
    case "run":
      return GROUP.test(ref) ? say(groupSent(await pac.runGroup(ref, extra.toLowerCase() === "now"), extra.toLowerCase() === "now" ? "Running on what's in" : "The next run is gathering")) : say("`/pac group run g_… [now]`: as its creator.");
    case "leave":
    case "close": {
      if (!GROUP.test(ref)) {
        return say(`\`/pac group ${sub} g_…\` (see \`/pac groups\`).`);
      }
      // Leaving and closing end things for people: a confirm button, never straight from a typed line.
      const g = await pac.group(ref);
      const buttons = groupButtons(g);
      return { text: `${sub} ${g.spec.name}?`, blocks: [section(`*${esc(g.spec.name)}*: ${sub === "close" ? "close it for everyone? No more runs; a run still gathering is aborted." : "leave it?"}`), ...(buttons ? [buttons] : [])] };
    }
    default:
      return GROUP.test(sub) ? groupShow(pac, sub) : say("`/pac groups` · `/pac groups open` · `/pac group g_…` · `/pac group new` · `/pac group join|leave g_…` · `/pac group run g_… [now]` · `/pac group close g_…`");
  }
}
