import { codeOf, NAME, stripFrontMatter, type Pac } from "../pac/cli.ts";
import { txIdOf, type Sent, type Tx } from "../pac/types.ts";
import { chunk, esc, type Block } from "./render.ts";

/**
 * What the owner types (`/pac …` or a DM), as a reply. Pure over a Pac, so
 * every command is testable without Slack. Only read-only commands and the
 * owner's own acts (ask, reply, answer, remember, abort behind a confirm)
 * are here; key and grant commands stay at the terminal.
 */

export const ACT = { show: "pac_show", reply: "pac_reply", abort: "pac_abort" } as const;
export const MODAL = { reply: "pac_reply_view", remember: "pac_remember_view" } as const;

export const HELP = [
  "*PAC in Slack*",
  "`/pac <question>` (or DM me): ask PAC; it picks who takes part",
  "`/pac with Dhrumil,Kate <question>`: ask the people you name (`me` is you)",
  "`/pac threads` · `/pac show <tx>` · `/pac reply <tx> <text>` (or reply in an answer's Slack thread)",
  "`/pac abort <tx>`: end a thread you're in; nothing is released",
  "`/pac files` · `/pac file <name or id>` · `/pac remember <name.md>` (then the text, or a form opens)",
  "`/pac contacts` · `/pac status` · `/pac verify` · `/pac trust` · `/pac asks`",
  "Grants, keys, upgrades and deleting stay at your terminal (`pac …`).",
].join("\n");

export interface Reply {
  text: string;
  blocks?: Block[];
  /** Open this modal (slash commands only: they carry a trigger). */
  modal?: Block;
}

const ENDED = new Set(["succeeded", "failed", "aborted", "expired", "declined", "rejected", "closed"]);
const MAX_SECTIONS = 40;
const TX = /^tx_[A-Za-z0-9]+$/;

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
  if (s.receipt?.status === "rejected") {
    return say(`PAC refused it: \`${esc(s.receipt.error ?? "rejected")}\``);
  }
  const tx = txIdOf(s);
  return say(`:mag: ${what}${tx ? ` (\`${esc(tx)}\`)` : ""}. The answer comes here once everyone involved approves what of theirs it carries.`);
}

const nameIn = (tx: Tx, user: string) => tx.participants.find((p) => p.user === user)?.name ?? user.slice(0, 8);

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

export function replyModal(tx: string): Block {
  return {
    type: "modal",
    callback_id: MODAL.reply,
    private_metadata: tx,
    title: { type: "plain_text", text: "Reply in the thread" },
    submit: { type: "plain_text", text: "Send" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      context("Goes to everyone in this PAC thread. Nothing of anyone's is shared without their approval."),
      { type: "input", block_id: "text", label: { type: "plain_text", text: "Your next question" }, element: { type: "plain_text_input", action_id: "value", multiline: true, max_length: 3000 } },
    ],
  };
}

export function threadButtons(tx: string, state: string): Block {
  return {
    type: "actions",
    elements: [
      { type: "button", action_id: ACT.reply, text: { type: "plain_text", text: "Reply" }, value: tx },
      ...(ENDED.has(state)
        ? []
        : [
            {
              type: "button",
              action_id: ACT.abort,
              text: { type: "plain_text", text: "Abort" },
              style: "danger",
              value: tx,
              confirm: {
                title: { type: "plain_text", text: "Abort this thread?" },
                text: { type: "plain_text", text: "It ends for everyone in it, and nothing is released." },
                confirm: { type: "plain_text", text: "Abort" },
                deny: { type: "plain_text", text: "Keep it" },
              },
            },
          ]),
    ],
  };
}

/** `/pac show <tx>`: the question, its state, who's in it, and your answer once released. */
export async function show(pac: Pac, id: string): Promise<Reply> {
  if (!TX.test(id)) {
    return say("Which thread? `/pac show tx_…` (see `/pac threads`).");
  }
  const [shown, entry] = await Promise.all([pac.tx(id) as Promise<{ tx?: Tx & { open?: unknown[] } }>, pac.txs().then((all) => all.find((t) => t.tx.id === id))]);
  const tx: (Tx & { open?: unknown[] }) | undefined = shown.tx ?? entry?.tx;
  if (!tx) {
    return say(`No thread \`${esc(id)}\` for you.`);
  }
  const blocks: Block[] = [
    section(`*${esc(nameIn(tx, tx.initiator))}* asked:\n${quote(tx.intent?.prompt ?? "")}`),
    context(`\`${esc(tx.id)}\` · ${esc(tx.state)} · with ${tx.participants.map((p) => esc(p.name)).join(", ")}${tx.open?.length ? ` · waiting on ${tx.open.length}` : ""}`),
  ];
  if (entry?.pointer.resultFile) {
    const file = await pac.cat(entry.pointer.resultFile);
    blocks.push({ type: "divider" }, ...sections(esc(stripFrontMatter(file.content))));
  }
  blocks.push(threadButtons(tx.id, tx.state));
  return { text: `PAC thread ${tx.id}: ${tx.state}`, blocks };
}

async function threads(pac: Pac): Promise<Reply> {
  const txs = (await pac.txs()).sort((a, b) => (b.tx.updatedAt ?? b.tx.createdAt).localeCompare(a.tx.updatedAt ?? a.tx.createdAt)).slice(0, 15);
  if (!txs.length) {
    return say("No PAC threads yet. Ask with `/pac <question>`.");
  }
  const blocks: Block[] = [section("*Your PAC threads* (newest first)")];
  for (const { tx, pointer } of txs) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${quote((tx.intent?.prompt ?? "").slice(0, 300))}\n\`${esc(tx.id)}\` · ${esc(tx.state)}${pointer.resultFile ? " · :white_check_mark: answer released" : ""} · from ${esc(nameIn(tx, tx.initiator))}` },
      accessory: { type: "button", action_id: ACT.show, text: { type: "plain_text", text: "Show" }, value: tx.id },
    });
  }
  return { text: `${txs.length} PAC threads`, blocks };
}

async function files(pac: Pac): Promise<Reply> {
  const all = (await pac.files()).sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
  if (!all.length) {
    return say("No PAC files yet. Keep one with `/pac remember <name.md>`.");
  }
  const lines = all.slice(0, 40).map((f) => `• \`${esc(f.name)}\` v${f.version}${f.meta?.pac?.result ? " · result" : ""} · \`${esc(f.file)}\``);
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

/** Splits `with A,B <question>` into the names and the question. */
export function parseWith(rest: string): { names: string[]; question: string } | undefined {
  const m = /^(\S+)\s+([\s\S]+)$/.exec(rest.trim());
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
      const s = await pac.status();
      const problems = (s.problems ?? []).map((p) => (typeof p === "string" ? p : p.code));
      return say(`You are *${esc(s.identity?.name ?? "?")}* in PAC ${esc(s.version)} · grant: \`${esc(s.grant?.state ?? "none")}\` · open asks: ${s.asks?.open ?? 0}${problems.length ? ` · problems: ${problems.map((p) => `\`${esc(p)}\``).join(", ")}` : ""}`);
    }
    case "asks":
      if (!rest) {
        await resync();
        return say("Open questions and approvals are posted again in our DM.");
      }
      break;
    case "threads":
      if (!rest) {
        return threads(pac);
      }
      break;
    case "show":
      return show(pac, restWords[0] ?? "");
    case "reply": {
      const [tx = "", ...words] = restWords;
      const body = words.join(" ").trim();
      if (!TX.test(tx) || !body) {
        return say("`/pac reply tx_… <your next question>`, or reply in an answer card's Slack thread.");
      }
      return sent(await pac.reply(tx, body), "Sent to the thread");
    }
    case "with": {
      const parsed = parseWith(rest);
      if (!parsed) {
        return say("`/pac with Dhrumil,Kate <question>`: names from `/pac contacts`, `me` for yourself.");
      }
      return sent(await pac.goal(parsed.question, { with: parsed.names }), `Sent to PAC with ${parsed.names.map(esc).join(", ")}`);
    }
    case "abort": {
      const tx = restWords[0] ?? "";
      if (!TX.test(tx)) {
        return say("`/pac abort tx_…` (see `/pac threads`).");
      }
      return { text: `Abort ${tx}?`, blocks: [section(`Abort \`${esc(tx)}\`? It ends for everyone in it, and nothing is released.`), threadButtons(tx, "running")] };
    }
    case "contacts": {
      if (rest) {
        break;
      }
      const people = await pac.contacts();
      return say(people.length ? `*People you've been in a PAC thread with:* ${people.map((p) => `\`${esc(p.name)}\``).join(", ")}` : "No contacts yet: they appear once you've been in a thread with someone.");
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
    case "verify":
      if (!rest) {
        const v = await pac.verify();
        const problems = v.problems ?? [];
        return say(problems.length ? `:warning: Checked ${v.checked ?? 0}; ${problems.length} problem(s). Run \`pac verify\` at your terminal for details.` : `:white_check_mark: Checked the provenance of ${v.checked ?? 0} things you can read: no problems.`);
      }
      break;
    case "trust":
      if (!rest) {
        const t = await pac.trust();
        const d = t.deployment ?? {};
        return say(`Deployment *${esc(d.name ?? "?")}* · \`${esc(t.status ?? "?")}\` · current release ${(d.current ?? []).map((m) => `\`${esc(m.slice(0, 12))}…\``).join(", ") || "none"}${t.status && t.status !== "up_to_date" ? "\nAdopt it at your terminal: `pac trust update`." : ""}`);
      }
      break;
  }
  const question = text.replace(/^ask\s+/i, "");
  return sent(await pac.goal(question), "Sent to PAC");
}

export { codeOf };
