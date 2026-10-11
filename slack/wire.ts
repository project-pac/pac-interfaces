import type { Message, OwnerEvent, SlackReply, ViewAck } from "./events.ts";
import type { Block } from "./render.ts";

/**
 * Between the shared relay and a person's connector: one JSON object per
 * WebSocket text frame. The relay holds the Slack tokens and no PAC keys; the
 * connector holds the PAC home and no Slack tokens. A connector refers to a
 * Slack event by its id, so trigger ids and response URLs never leave the relay.
 */

export type Call =
  /** Into the linked person's DM with the bot; the result's value is the message ts. */
  | { method: "post"; message: Message; thread?: string }
  /** A message of the bot's in that DM. */
  | { method: "update"; channel: string; ts: string; message: Message }
  /** Back where an event of the linked person's came from (its response URL). */
  | { method: "respond"; event: string; reply: SlackReply }
  /** A form, on an event of the linked person's that carried a trigger. */
  | { method: "open_view"; event: string; view: Block };

export type ToRelay =
  | { t: "link"; code: string; name?: string }
  | { t: "hello"; token: string; name?: string }
  | { t: "ack"; id: string; response?: ViewAck }
  | ({ t: "call"; id: string } & Call);

export type Refusal = "bad_code" | "bad_token" | "replaced" | "unlinked" | "bad_frame";

export type ToConnector =
  /** Signed in: whose Slack this is, and their DM. `token` comes once, right after a link. */
  | { t: "welcome"; user: string; dm: string; token?: string }
  | { t: "refused"; code: Refusal }
  | { t: "event"; id: string; event: OwnerEvent }
  | { t: "result"; id: string; ok: true; value?: string }
  | { t: "result"; id: string; ok: false; code: string };

export const PATH = "/connect";

/** Frames are small; anything bigger is refused. */
export const MAX_FRAME = 1024 * 1024;

export function parseFrame<T extends { t: string }>(text: unknown): T | undefined {
  if (typeof text !== "string" || text.length > MAX_FRAME) {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as T;
    return value && typeof value === "object" && typeof value.t === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
