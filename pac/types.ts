/** What `pac <cmd> --json` prints (PAC 0.5), only the fields interfaces read. */

export type Env = Record<string, string | undefined>;

export interface Person {
  user: string;
  name: string;
}

export interface Disclosure {
  to: string;
  items: { source: string; quote: string; how: string; by: string[] }[];
  overlaps?: { source: string; text: string }[];
  edits?: { source: string; how: string }[];
}

export interface ApprovalBody {
  kind: "approval";
  round: number;
  resultsSha256: string;
  recipients: Person[];
  yourFiles: { file: string; name: string; sha256?: string }[];
  disclosures: Disclosure[];
  summary?: string;
  whyIncluded?: string;
  unverifiedQuotes?: number;
  revisedFor?: unknown[];
}

export interface RequestBody {
  kind: "request";
  question: string;
  about?: string;
}

export type AskStatus = "open" | "answered" | "expired" | "closed";

export interface Ask<B = ApprovalBody | RequestBody> {
  id: string;
  tx: string;
  step: string;
  status: AskStatus;
  body: B;
  /** PAC's own rendering, as a person should read it. */
  text?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface Tx {
  id: string;
  initiator: string;
  participants: Person[];
  intent?: { prompt?: string };
  state: string;
  createdAt: string;
  updatedAt?: string;
}

export interface TxEntry {
  pointer: { tx: string; role: string; resultFile?: string; at: string };
  tx: Tx;
}

export interface FileEntry {
  file: string;
  name: string;
  version: number;
  writtenAt: string;
  kind?: string;
  meta?: { pac?: { result?: { tx?: string } } };
}

export interface FileContent {
  name: string;
  contentType?: string;
  content: string;
}

export interface Status {
  version: string;
  identity?: { user: string; name: string };
  asks?: { open?: number; requests?: number; approvals?: number };
  tee?: { current?: { granted?: boolean } };
  grant?: { state?: string };
  problems?: (string | { code: string })[];
}

export interface Sent {
  msg?: string;
  receipt?: { status: "accepted" | "rejected"; error?: string };
  tx?: string;
}

export interface WatchEvent {
  event: string;
  [key: string]: unknown;
}

export const isRequest = (a: Ask): a is Ask<RequestBody> => a.body.kind === "request";
export const isApproval = (a: Ask): a is Ask<ApprovalBody> => a.body.kind === "approval";
