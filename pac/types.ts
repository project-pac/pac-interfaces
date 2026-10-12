/** What `pac <cmd> --json` prints (PAC 0.6), only the fields interfaces read. */

export type Env = Record<string, string | undefined>;

export interface Person {
  user: string;
  name: string;
}

/** Everyone on PAC, as `pac people` lists them. */
export interface Member extends Person {
  handle: string;
}

/** A question: something no file says. */
export interface QuestionBody {
  kind: "question";
  text: string;
  answer: "text" | "yes_no" | "choice" | "files";
  choices?: string[];
  everyone?: true;
}

/** Leave to read a file its owner keeps as "ask first". */
export interface AccessBody {
  kind: "access";
  file: string;
  name: string;
  text?: string;
}

export interface Disclosure {
  to: string;
  items: { source: string; quote: string; how: string; by: ("agent" | "view")[]; index?: true }[];
  overlaps?: { source: string; text: string; index?: true }[];
  edits?: { source: string; how: string }[];
}

/** What of the person's own material each other recipient's draft carries. */
export interface ApprovalBody {
  kind: "approval";
  batch: string;
  batchSha256: string;
  recipients: Person[];
  yourMaterial: { source: string; name: string; sha256: string; index?: true }[];
  disclosures: Disclosure[];
  summary?: string;
  whyIncluded?: string;
  unverifiedQuotes?: number;
  revisedFor?: Person[];
}

/** A group, as a member sees it: what their submission consents to. */
export interface GroupSpec {
  name: string;
  creator: Person;
  run: { prompt: string };
  ask: { text: string; answer: QuestionBody["answer"]; choices?: string[]; maxChars: number };
  members: "open" | Person[];
  reads: "submissions" | "members" | "anyone";
  files: number;
  to: string | Person[];
}

/** A group run's data ask: the same for every member. */
export interface DataBody {
  kind: "data";
  group: string;
  run: number;
  spec: GroupSpec;
}

export type AskBody = QuestionBody | AccessBody | ApprovalBody | DataBody;

/** A group the person is in (or made, or left), as `pac groups` and `pac group show` print it. */
export interface Group {
  id: string;
  spec: GroupSpec;
  status: "open" | "closed";
  you: "creator" | "member" | "left";
  runs: { n: number; session: string; deadline: string; now?: true; createdAt: string }[];
  ref?: string;
  needsYou?: boolean;
  /** PAC's own rendering. */
  text?: string;
}

/** An open group anyone on PAC may join, as `pac groups --open` lists it. */
export interface Listing {
  group: string;
  spec: GroupSpec;
  gathering?: { run: number; deadline: string };
  ref?: string;
  text?: string;
}

/** What `pac group new` takes: everything a member sees before they submit. */
export interface GroupDraft {
  name: string;
  prompt: string;
  ask: string;
  answer: QuestionBody["answer"];
  choices?: string[];
  invite?: string[];
  open?: boolean;
  to?: "members" | "submitters" | "each" | "me" | "pac";
  by?: string;
  pacMayRead?: boolean;
}

export type AskStatus = "open" | "answered" | "expired" | "closed";

export interface Ask<B extends AskBody = AskBody> {
  id: string;
  session: string;
  turn: number;
  /** The turn it's for, which every participant sees. */
  prompt: { by: Person; text: string };
  status: AskStatus;
  body: B;
  /** PAC's own rendering, as a person should read it. */
  text?: string;
  createdAt?: string;
  expiresAt?: string;
}

export type TurnStatus = "queued" | "gathering" | "running" | "waiting" | "reviewing" | "answered" | "failed" | "expired";

export interface Turn {
  n: number;
  by: string;
  prompt: string;
  with: string[];
  status: TurnStatus;
  failure?: string;
  deadline?: string;
  gathered?: { in: number; of: number };
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

/** A session the person is in, as `pac sessions` and `pac session` print it. */
export interface Session {
  id: string;
  you: string[];
  people: Person[];
  group?: { id: string; name: string; run: number };
  turns: Turn[];
  asks: { ask: string; turn: number; kind: AskBody["kind"]; status: AskStatus }[];
  results: { turn: number; file: string; batch: string }[];
  read?: { file: string; version: number; turn: number }[];
  agent?: { codeIdentity: string; measurement: string };
  /** The shortest id that pastes back. */
  ref?: string;
  needsYou?: boolean;
  /** PAC's own rendering. */
  text?: string;
}

export interface FileEntry {
  file: string;
  name: string;
  version: number;
  writtenAt: string;
  kind?: string;
  meta?: { pac?: { result?: unknown } };
}

export interface FileContent {
  name: string;
  contentType?: string;
  content: string;
}

/** `pac status`: whether PAC is ready, and what waits. */
export interface Ready {
  ready: boolean;
  problems?: (string | { code: string })[];
  asks?: unknown[];
  sessions?: unknown[];
}

/** `pac system status`: everything about this home. */
export interface Status {
  version: string;
  identity?: { user: string; name: string };
  asks?: { open?: number };
  tee?: { current?: { granted?: boolean } };
  grant?: { state?: string };
  problems?: (string | { code: string })[];
}

/** What `prompt`, `reply` and `abort` print: sent, or with `--wait` PAC's receipt; a consent's preview without `--yes`. */
export interface Sent {
  status: "sent" | "accepted" | "rejected" | "preview";
  msg?: string;
  session?: string;
  receipt?: { status: "accepted" | "rejected"; error?: string };
  pointer?: Session;
  text?: string;
}

export interface WatchEvent {
  event: string;
  [key: string]: unknown;
}

export const isQuestion = (a: Ask): a is Ask<QuestionBody> => a.body.kind === "question";
export const isAccess = (a: Ask): a is Ask<AccessBody> => a.body.kind === "access";
export const isApproval = (a: Ask): a is Ask<ApprovalBody> => a.body.kind === "approval";
export const isData = (a: Ask): a is Ask<DataBody> => a.body.kind === "data";

const ENDED: readonly TurnStatus[] = ["answered", "failed", "expired"];
export const ended = (status: string): boolean => (ENDED as readonly string[]).includes(status);

/** A session's latest turn, which says where it stands. */
export const latest = (s: Session): Turn | undefined => s.turns.at(-1);
