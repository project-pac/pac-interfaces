import { codeOf, NAME, stripFrontMatter, type Pac } from "../pac/cli.ts";
import { ended, latest, type Sent, type Session } from "../pac/types.ts";
import { chunk, esc, type Block } from "./render.ts";

/**
 * What the owner types (`/pac …` or a DM), as a reply. Pure over a Pac, so
 * every command is testable without Slack. Only read-only commands and the
 * owner's own acts (ask, reply, remember, abort behind a confirm) are here;
 * key and grant commands stay at the terminal.
 */

export const ACT = { show: "pac_show", reply: "pac_reply", abort: "pac_abort" } as const;
export const MODAL = { reply: "pac_reply_view", remember: "pac_remember_view" } as const;

export const HELP = [
  "*PAC in Slack*",
  "`/pac <question>` (or DM me): ask PAC; it finds whose files bear on it, and asks them",
  "`/pac with Dhrumil,Kate <question>`: involve these people too · `/pac only Dhrumil <question>`: no one else (`me` is you)",
  "`/pac sessions` · `/pac show <session>` · `/pac reply <session> <text>` (or reply in an answer's Slack thread)",
  "`/pac abort <session>`: end a session's current turn; nothing is released",
  "`/pac files` · `/pac file <name or id>` · `/pac remember <name.md>` (then the text, or a form opens)",
  "`/pac people` · `/pac status` · `/pac verify` · `/pac trust` · `/pac asks`",
  "`/pac link` · `/pac unlink` (shared PAC app): connect this Slack account to the PAC on your Mac, or stop",
  "Grants, keys, upgrades and deleting stay at your terminal (`pac …`).",
].join("\n");

export interface Reply {
  text: string;
  blocks?: Block[];
  /** Open this modal (slash commands only: they carry a trigger). */
  modal?: Block;
}

const MAX_SECTIONS = 40;
/** A session's id, or the start of one that pastes back (`pac sessions` shows them). */
export const SESSION = /^s_[0-9a-f]{4,32}$/;
const WITH = /^(\S+)\s+([\s\S]+)$/;

const say = (text: string): Reply => ({ text });
const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
const context = (text: string): Block => ({ type: "context", elements: [{ type: "mrkdwn", text }] });
const quote = (text: string) =>
  esc(text)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

function sections(text: string): Block[] {
  const parts = chunk(text);
  return parts.length > MAX_SECTIONS ? [...parts.slice(0, MAX_SECTIONS).map(section), context("Cut for Slack: the full text is in your PAC files.")] : parts.map(section);
}

function sent(s: Sent, what: string): Reply {
  if (s.status === "rejected" || s.receipt?.status === "rejected") {
    return say(`PAC refused it: \`${esc(s.receipt?.error ?? "rejected")}\``);
  }
  return say(`:mag: ${what}${s.session ? ` (\`${esc(s.pointer?.ref ?? s.session)}\`)` : ""}. The answer comes here once everyone involved approves what of theirs it carries.`);
}

const nameIn = (s: Session, user: string) => s.people.find((p) => p.user === user)?.name ?? user.slice(0, 8);

const STATE: Record<string, string> = { queued: "queued", gathering: "gathering submissions", running: "running", waiting: "waiting on answers", reviewing: "waiting on approvals", answered: "answered", failed: "failed", expired: "expired" };
const stateOf = (s: Session) => {
  const t = latest(s);
  return t ? `${STATE[t.status] ?? t.status}${t.failure ? ` (${t.failure})` : ""}` : "no turns";
};

export function remember(name: string, content?: string): Block {
  return {
    type: "modal",
    callback_id: MODAL.remember,
    title: { type: "plain_text", text: "Keep a note in PAC" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "name", label: { type: "plain_text", text: "File name" }, element: { type: "plain_text_input", action_id: "value", initial_value: name, max_length: 128 } },
      {
        type: "input",
        block_id: "text",
        label: { type: "plain_text", text: "What PAC may use (one subject per file)" },
        element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000, ...(content ? { initial_value: content } : {}) },
      },
    ],
  };
}

export function replyModal(session: string): Block {
  return {
    type: "modal",
    callback_id: MODAL.reply,
    private_metadata: session,
    title: { type: "plain_text", text: "Reply in the session" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      context("Goes to everyone in this PAC session. Nothing of anyone's is shared without their approval."),
      { type: "input", block_id: "text", label: { type: "plain_text", text: "Your next prompt" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000 } },
    ],
  };
}

export function sessionButtons(session: string, done: boolean): Block {
  return {
    type: "actions",
    elements: [
      { type: "button", action_id: ACT.reply, text: { type: "plain_text", text: "Reply" }, value: session },
      ...(done
        ? []
        : [
            {
              type: "button",
              action_id: ACT.abort,
              text: { type: "plain_text", text: "Abort" },
              style: "danger",
              value: session,
              confirm: {
                title: { type: "plain_text", text: "Abort this turn?" },
                text: { type: "plain_text", text: "Its current turn ends for everyone in it, and nothing is released." },
                confirm: { type: "plain_text", text: "Abort" },
                deny: { type: "plain_text", text: "Keep it" },
              },
            },
          ]),
    ],
  };
}

/** `/pac show <session>`: its turns, who's in it, and your latest result once released. */
export async function show(pac: Pac, ref: string): Promise<Reply> {
  if (!SESSION.test(ref)) {
    return say("Which session? `/pac show s_…` (see `/pac sessions`).");
  }
  let s: Session;
  try {
    s = await pac.session(ref);
  } catch (error) {
    return say(`No session \`${esc(ref)}\` for you (\`${esc(codeOf(error))}\`).`);
  }
  const blocks: Block[] = [];
  if (s.group) {
    blocks.push(context(`Group *${esc(s.group.name)}* · run ${s.group.run}`));
  }
  for (const t of s.turns) {
    blocks.push(section(`*${esc(nameIn(s, t.by))}*${s.turns.length > 1 ? ` (turn ${t.n})` : ""} asked:\n${quote(t.prompt)}`));
  }
  blocks.push(context(`\`${esc(s.ref ?? s.id)}\` · ${esc(stateOf(s))} · with ${s.people.map((p) => esc(p.name)).join(", ")}${s.needsYou ? " · :raising_hand: waits on you" : ""}`));
  const last = s.results.at(-1);
  if (last) {
    const file = await pac.cat(last.file);
    blocks.push({ type: "divider" }, ...sections(esc(stripFrontMatter(file.content))));
  }
  blocks.push(sessionButtons(s.id, ended(latest(s)?.status ?? "answered")));
  return { text: `PAC session ${s.ref ?? s.id}: ${stateOf(s)}`, blocks };
}

async function sessionsList(pac: Pac): Promise<Reply> {
  const all = (await pac.sessions()).slice(0, 15);
  if (!all.length) {
    return say("No PAC sessions yet. Ask with `/pac <question>`.");
  }
  const blocks: Block[] = [section("*Your PAC sessions* (latest first)")];
  for (const s of all) {
    const t = latest(s);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${s.group ? `*${esc(s.group.name)}* · ` : ""}${quote((t?.prompt ?? "").slice(0, 300))}\n\`${esc(s.ref ?? s.id)}\` · ${esc(stateOf(s))}${s.results.length ? " · :white_check_mark: answer released" : ""}${s.needsYou ? " · :raising_hand: waits on you" : ""}` },
      accessory: { type: "button", action_id: ACT.show, text: { type: "plain_text", text: "Show" }, value: s.id },
    });
  }
  return { text: `${all.length} PAC sessions`, blocks };
}

async function files(pac: Pac): Promise<Reply> {
  const all = (await pac.files()).sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  if (!all.length) {
    return say("No PAC files yet. Keep one with `/pac remember <name.md>`.");
  }
  const lines = all.slice(0, 40).map((f) => `• \`${esc(f.name)}\` v${f.version}${f.kind === "result" || f.meta?.pac?.result ? " · result" : ""} · \`${esc(f.file)}\``);
  return { text: `${all.length} PAC files`, blocks: [section(`*Your PAC files* (${all.length})`), ...sections(lines.join("\n")), ...(all.length > 40 ? [context(`and ${all.length - 40} more: \`pac files ls\``)] : [])] };
}

async function file(pac: Pac, ref: string): Promise<Reply> {
  if (!ref) {
    return say("Which file? `/pac file <name or id>` (see `/pac files`).");
  }
  const match = (await pac.files()).filter((f) => f.file === ref || f.name === ref).sort((a, b) => b.version - a.version)[0];
  if (!match) {
    return say(`No file \`${esc(ref)}\`. See \`/pac files\`.`);
  }
  const f = await pac.cat(match.file);
  return { text: `PAC file ${match.name}`, blocks: [section(`*\`${esc(match.name)}\`* v${match.version}`), { type: "divider" }, ...sections(esc(stripFrontMatter(f.content)))] };
}

/** Splits `A,B <question>` into the names and the question. */
export function parseWith(rest: string): { names: string[]; question: string } | undefined {
  const m = rest.trim().match(WITH);
  if (!m) {
    return undefined;
  }
  const names = m[1]!.split(",").map((n) => n.trim()).filter(Boolean);
  return names.length ? { names, question: m[2]!.trim() } : undefined;
}

export async function command(pac: Pac, input: string, resync: () => Promise<void>): Promise<Reply> {
  const text = input.trim();
  const [head = "", ...restWords] = text.split(/\s+/);
  const word = head.toLowerCase();
  const rest = text.slice(head.length).trim();
  switch (word) {
    case "":
    case "help":
      return say(HELP);
    case "status": {
      const [s, r] = await Promise.all([pac.status(), pac.ready().catch(() => undefined)]);
      const problems = (s.problems ?? []).map((p) => (typeof p === "string" ? p : p.code));
      return say(`You are *${esc(s.identity?.name ?? "?")}* in PAC ${esc(s.version)} · ${r?.ready === false ? "not ready" : "ready"} · grant: \`${esc(s.grant?.state ?? "none")}\` · open asks: ${r?.asks?.length ?? 0}${problems.length ? ` · problems: ${problems.map((p) => `\`${esc(p)}\``).join(", ")}` : ""}`);
    }
    case "asks":
      if (!rest) {
        await resync();
        return say("Open questions, access asks, approvals and group asks are posted again in our DM.");
      }
      break;
    case "sessions":
    case "threads":
      if (!rest) {
        return sessionsList(pac);
      }
      break;
    case "show":
      return show(pac, restWords[0] ?? "");
    case "reply": {
      const [session = "", ...words] = restWords;
      const body = words.join(" ").trim();
      if (!SESSION.test(session) || !body) {
        return say("`/pac reply s_… <your next prompt>`, or reply in an answer card's Slack thread.");
      }
      return sent(await pac.prompt(body, { session }), "Sent to the session");
    }
    case "with":
    case "only": {
      const parsed = parseWith(rest);
      if (!parsed) {
        return say(`\`/pac ${word} Dhrumil,Kate <question>\`: names or handles from \`/pac people\`, \`me\` for yourself.`);
      }
      return sent(await pac.prompt(parsed.question, { with: parsed.names, only: word === "only" }), `Sent to PAC ${word === "only" ? "with only" : "with"} ${parsed.names.map(esc).join(", ")}`);
    }
    case "abort": {
      const session = restWords[0] ?? "";
      if (!SESSION.test(session)) {
        return say("`/pac abort s_…` (see `/pac sessions`).");
      }
      return { text: `Abort ${session}?`, blocks: [section(`Abort \`${esc(session)}\`'s current turn? It ends for everyone in it, and nothing is released.`), sessionButtons(session, false)] };
    }
    case "people":
    case "contacts": {
      if (rest) {
        break;
      }
      const people = await pac.people();
      return say(people.length ? `*Everyone on PAC (${people.length}):* ${people.map((p) => `${esc(p.name)} \`@${esc(p.handle)}\``).join(", ")}` : "No one on PAC yet.");
    }
    case "files":
      if (!rest) {
        return files(pac);
      }
      break;
    case "file":
      return file(pac, rest);
    case "remember": {
      const [name = "", ...lines] = rest.split("\n");
      const n = name.trim();
      const content = lines.join("\n").trim();
      if (!NAME.test(n)) {
        return say("`/pac remember travel-preferences.md` opens a form; in a DM put the text on the next lines.");
      }
      if (!content) {
        return { text: `Keep ${n} in PAC`, modal: remember(n) };
      }
      await pac.put(n, content);
      return say(`:floppy_disk: Saved \`${esc(n)}\` in PAC. The same name again makes a new version.`);
    }
    case "link":
    case "unlink":
      // The shared app's relay answers these before they reach a connector.
      return say("Linking is for the shared PAC Slack app. This bot already runs on its owner's machine.");
    case "verify":
      if (!rest) {
        const v = await pac.verify();
        const problems = v.problems ?? [];
        return say(problems.length ? `:warning: Checked ${v.checked ?? 0}; ${problems.length} problem(s). Run \`pac system verify\` at your terminal for details.` : `:white_check_mark: Checked the provenance of ${v.checked ?? 0} things you can read: no problems.`);
      }
      break;
    case "trust":
      if (!rest) {
        const t = await pac.trust();
        const d = t.deployment ?? {};
        return say(`Deployment *${esc(d.name ?? "?")}* · \`${esc(t.status ?? "?")}\` · current release ${(d.current ?? []).map((m) => `\`${esc(m.slice(0, 12))}…\``).join(", ") || "none"}${t.status && t.status !== "up_to_date" ? "\nAdopt it at your terminal: `pac system trust update`." : ""}`);
      }
      break;
  }
  // "pac status" typed into a DM means the command, not a question for PAC.
  if (word === "pac" || word === "/pac") {
    return command(pac, rest, resync);
  }
  const question = text.replace(/^ask\s+/i, "");
  return sent(await pac.prompt(question), "Sent to PAC");
}

export { codeOf };
