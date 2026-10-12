import type { Block } from "./render.ts";

/**
 * Slack, as the owner core sees it: the few fields of each payload it reads.
 * The relay forwards only these to a connector, never tokens, trigger ids or
 * response URLs.
 */

export interface Message {
  text: string;
  blocks: Block[];
}

export interface SlackReply {
  response_type: "ephemeral" | "in_channel";
  replace_original?: boolean;
  text: string;
  blocks?: Block[];
}

export type ViewAck = { response_action: "errors"; errors: Record<string, string> };

export type OwnerEvent =
  | { kind: "command"; user: string; text: string; channel: string }
  | { kind: "message"; user: string; text: string; thread?: string }
  | { kind: "action"; user: string; action: string; value?: string; channel?: string; ts?: string }
  | { kind: "view"; user: string; callback: string; values: Record<string, string>; meta: string };

type RawCommand = { user_id: string; text: string; channel_id: string };
type RawMessage = { channel_type?: string; user?: string; text?: string; subtype?: string; bot_id?: string; thread_ts?: string };
type RawAction = { user: { id: string }; actions: { action_id: string; value?: string }[]; channel?: { id: string }; message?: { ts: string } };
type RawInput = { value?: string | null; selected_option?: { value: string } | null; selected_options?: { value: string }[] };
type RawView = { callback_id: string; private_metadata: string; state: { values: Record<string, Record<string, RawInput>> } };

export const commandEvent = (c: RawCommand): OwnerEvent => ({ kind: "command", user: c.user_id, text: c.text ?? "", channel: c.channel_id });

/** A person's own message in a DM with the bot, or undefined for anything else (edits, bots, joins). */
export function messageEvent(raw: unknown): OwnerEvent | undefined {
  const m = raw as RawMessage;
  if (m.channel_type !== "im" || m.subtype || m.bot_id || !m.user || !m.text?.trim()) {
    return undefined;
  }
  return { kind: "message", user: m.user, text: m.text, ...(m.thread_ts ? { thread: m.thread_ts } : {}) };
}

export function actionEvent(raw: unknown): OwnerEvent | undefined {
  const b = raw as RawAction;
  const a = b.actions?.[0];
  if (!b.user?.id || !a?.action_id) {
    return undefined;
  }
  return { kind: "action", user: b.user.id, action: a.action_id, ...(a.value !== undefined ? { value: a.value } : {}), ...(b.channel?.id ? { channel: b.channel.id } : {}), ...(b.message?.ts ? { ts: b.message.ts } : {}) };
}

/** A submitted form: each input block's value, by block id: its text, its selected option, or its ticked boxes joined by commas. */
export function viewEvent(user: string, raw: unknown): OwnerEvent {
  const v = raw as RawView;
  const values: Record<string, string> = {};
  for (const [block, inputs] of Object.entries(v.state?.values ?? {})) {
    const i = inputs.value ?? Object.values(inputs)[0];
    values[block] = i?.value ?? i?.selected_option?.value ?? (i?.selected_options ?? []).map((o) => o.value).join(",");
  }
  return { kind: "view", user, callback: v.callback_id, values, meta: v.private_metadata ?? "" };
}
