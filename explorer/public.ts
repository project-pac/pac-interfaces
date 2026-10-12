import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256Hex, verifySig } from "./verify.ts";

/**
 * What anyone can see of PAC, without keys: the signed deployment descriptor,
 * the bulletin (an append-only log of TEE announcements and program loads),
 * the vault's height, and the vault's public objects (profiles, TEE
 * handovers, program manifests). Every signature is checked here, again.
 * Txs are not here: they're encrypted to their participants.
 */

export const DESCRIPTOR_URL = "https://cdn.projectpac.net/deployment.json";

export interface Release {
  measurement: string;
  codeIdentity: string;
  version?: string;
  commit?: string;
  status: string;
  at: string;
  backend?: string;
  platform?: string;
  teeMode?: string;
  imageSha256?: string;
  composeHash?: string;
  egress?: unknown;
  programs?: unknown;
  events: number;
}

export interface Deployment {
  name: string;
  vault: string;
  bulletin: string;
  publisher: string;
  signer: string;
  at: string;
  sigValid: boolean;
  releases: Release[];
  /** Releases of the PAC program itself, by bundle digest. */
  pac: { sha256: string; status: string; at: string }[];
}

export interface Post {
  index: number;
  postedAt: string;
  type: string;
  tee?: string;
  at?: string;
  sigValid: boolean;
  codeIdentity?: string;
  program?: string;
  quote?: Quote;
}

/** A TEE's attestation, as posted: the quote itself only by fingerprint. */
export interface Quote {
  backend?: string;
  platform?: string;
  sha256: string;
  bytes: number;
  events: number;
  collateral: boolean;
}

export interface Handover {
  from: string | null;
  asOf: number;
  at: string;
  sigValid: boolean;
}

export interface Tee {
  id: string;
  codeIdentity?: string;
  /** The release whose code identity it announced, by measurement. */
  release?: string;
  releaseStatus?: string;
  version?: string;
  platform?: string;
  announcedAt?: string;
  postIndex?: number;
  quote?: Quote;
  sigValid: boolean;
  handover?: Handover;
  /** The newest handover is home: where records are written now. */
  current: boolean;
  loads: { program: string; at: string; postIndex: number; sigValid: boolean }[];
}

export interface Profile {
  id: string;
  name: string;
  enc: string;
  at: string;
  version: number;
  sigValid: boolean;
}

export interface Program {
  publisher: string;
  name: string;
  sha256: string;
  content?: string;
  egress?: unknown;
  build?: unknown;
  writtenAt: string;
  sigValid: boolean;
  /** From the descriptor, for the PAC program: current or retired. */
  status?: string;
}

export interface Network {
  at: string;
  /** Accepted writes in the vault so far: PAC's block height, as near as it has one. */
  height: number;
  deployment: Deployment;
  posts: Post[];
  tees: Tee[];
  profiles: Profile[];
  programs: Program[];
  /** What failed to load or verify, by code. */
  problems: string[];
}

export type Fetch = (url: string) => Promise<Response>;

type Obj = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

async function json(fetch: Fetch, url: string): Promise<Obj> {
  const r = await fetch(url);
  if (!r.ok) {
    throw new Error(`http_${r.status}`);
  }
  return (await r.json()) as Obj;
}

/** A vault object on the wire: `u32 BE metaLen | meta JSON | body`. */
export function decodeObject(bytes: Uint8Array): { meta: { header: Obj; sig: string }; body?: Uint8Array } {
  if (bytes.byteLength < 4) {
    throw new Error("not_an_object");
  }
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + len > bytes.byteLength) {
    throw new Error("not_an_object");
  }
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len))) as { header: Obj; sig: string; body?: boolean };
  return { meta: { header: meta.header, sig: meta.sig }, ...(meta.body ? { body: bytes.subarray(4 + len) } : {}) };
}

/** A public object, checked: signed by its writer, its body the one the header names, written by its namespace's owner. */
function checked(header: Obj, sig: string, body: Uint8Array | undefined, ns: string): boolean {
  return verifySig(String(header.writer), "header", header, sig) && header.writer === ns && body !== undefined && header.bodySha256 === sha256Hex(body) && header.bodySize === body.byteLength;
}

const SIGNED_AS: Record<string, string> = { tee_announcement: "announcement", program_loaded: "loaded" };

function release(r: Obj): Release {
  const m = (r.measured ?? {}) as Obj;
  return {
    measurement: String(r.measurement),
    codeIdentity: String(r.codeIdentity),
    status: String(r.status ?? "unknown"),
    at: String(r.at ?? ""),
    events: Array.isArray(r.events) ? r.events.length : 0,
    ...(str(m.version) ? { version: str(m.version) } : {}),
    ...(str(r.commit) ? { commit: str(r.commit) } : {}),
    ...(str(r.backend) ? { backend: str(r.backend) } : {}),
    ...(str(r.platform) ? { platform: str(r.platform) } : {}),
    ...(str(m.teeMode) ? { teeMode: str(m.teeMode) } : {}),
    ...(str(m.imageSha256) ? { imageSha256: str(m.imageSha256) } : {}),
    ...(str(r.composeHash) ? { composeHash: str(r.composeHash) } : {}),
    ...(m.egress !== undefined ? { egress: m.egress } : {}),
    ...(m.programs !== undefined ? { programs: m.programs } : {}),
  };
}

/** An announcement's quote: `{backend, platform, quote (hex), events, collateral, …}`, or a bare string. */
function quoteOf(q: unknown): Quote | undefined {
  const raw = typeof q === "string" ? q : str((q as Obj | undefined)?.quote);
  if (!raw) {
    return undefined;
  }
  const o = (typeof q === "object" && q ? q : {}) as Obj;
  return {
    sha256: sha256Hex(raw),
    bytes: /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 ? raw.length / 2 : /^[A-Za-z0-9_-]+$/.test(raw) ? Buffer.from(raw, "base64url").byteLength : raw.length,
    events: Array.isArray(o.events) ? o.events.length : 0,
    collateral: o.collateral !== undefined,
    ...(str(o.backend) ? { backend: str(o.backend) } : {}),
    ...(str(o.platform) ? { platform: str(o.platform) } : {}),
  };
}

/** The program a load names, as text, whichever shape it was posted in. */
function programRef(p: unknown): string {
  if (typeof p === "string") {
    return p;
  }
  const o = (p ?? {}) as Obj;
  const name = [str(o.publisher)?.slice(0, 12), str(o.name)].filter(Boolean).join("/");
  return `${name || "program"}${str(o.sha256) ? `@${str(o.sha256)!.slice(0, 12)}` : ""}`;
}

/** Everything public, read once, every signature checked. */
export async function loadNetwork(fetch: Fetch, descriptorUrl = DESCRIPTOR_URL): Promise<Network> {
  const problems: string[] = [];
  const d = await json(fetch, descriptorUrl);
  const { sig: dsig, ...unsigned } = d;
  const deployment: Deployment = {
    name: String(d.name ?? "PAC"),
    vault: String(d.vault),
    bulletin: String(d.bulletin),
    publisher: String(d.publisher),
    signer: String(d.signer),
    at: String(d.at ?? ""),
    sigValid: verifySig(String(d.signer), "pac:deployment", unsigned, String(dsig)),
    releases: (Array.isArray(d.releases) ? (d.releases as Obj[]) : []).map(release),
    pac: (Array.isArray(d.pac) ? (d.pac as Obj[]) : []).map((p) => ({ sha256: String(p.sha256), status: String(p.status ?? "unknown"), at: String(p.at ?? "") })),
  };
  if (!deployment.sigValid) {
    problems.push("descriptor_signature");
  }

  // The bulletin, page by page.
  const posts: Post[] = [];
  const bodies: Obj[] = [];
  for (let since = 0; ; ) {
    const page = await json(fetch, `${deployment.bulletin}/v1/posts?since=${since}`);
    const items = Array.isArray(page.items) ? (page.items as Obj[]) : [];
    for (const it of items) {
      let body: Obj;
      try {
        body = JSON.parse(Buffer.from(String(it.bytes), "base64url").toString("utf8")) as Obj;
      } catch {
        problems.push("bulletin_post_unreadable");
        continue;
      }
      const { sig, ...rest } = body;
      const type = String(body.type ?? "unknown");
      const domain = SIGNED_AS[type];
      const quote = quoteOf(body.quote);
      posts.push({
        index: Number(it.index),
        postedAt: String(it.postedAt),
        type,
        sigValid: domain !== undefined && verifySig(String(body.tee), domain, rest, String(sig)),
        ...(str(body.tee) ? { tee: str(body.tee) } : {}),
        ...(str(body.at) ? { at: str(body.at) } : {}),
        ...(str(body.codeIdentity) ? { codeIdentity: str(body.codeIdentity) } : {}),
        ...(body.program !== undefined ? { program: programRef(body.program) } : {}),
        ...(quote ? { quote } : {}),
      });
      bodies.push(body);
    }
    since += items.length;
    if (!page.more || items.length === 0) {
      break;
    }
  }

  // The vault: its height, then every public write in its change log.
  const height = num((await json(fetch, `${deployment.vault}/v1/health`)).seq) ?? 0;
  const latest = new Map<string, { ns: string; path: string; version: number; deleted: boolean }>();
  for (let since = 0; since < height; ) {
    const page = await json(fetch, `${deployment.vault}/v1/changes?since=${since}&limit=5000`);
    for (const c of Array.isArray(page.items) ? (page.items as Obj[]) : []) {
      const key = `${c.ns}/${c.path}`;
      const version = Number(c.version);
      if ((latest.get(key)?.version ?? 0) < version) {
        latest.set(key, { ns: String(c.ns), path: String(c.path), version, deleted: c.deleted === true });
      }
    }
    const next = num(page.seq) ?? since;
    if (next <= since) {
      break;
    }
    since = next;
  }

  const profiles: Profile[] = [];
  const programs: Program[] = [];
  const handovers = new Map<string, Handover>();
  await Promise.all(
    [...latest.values()]
      .filter((o) => !o.deleted)
      .map(async (o) => {
        try {
          const r = await fetch(`${deployment.vault}/v1/objects/${o.ns}/${o.path}`);
          if (!r.ok) {
            throw new Error(`http_${r.status}`);
          }
          const { meta, body } = decodeObject(new Uint8Array(await r.arrayBuffer()));
          const sigValid = checked(meta.header, meta.sig, body, o.ns);
          const b = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array())) as Obj;
          if (o.path === "profile" && b.type === "profile") {
            profiles.push({ id: o.ns, name: String(b.name ?? ""), enc: String(b.enc ?? ""), at: String(b.at ?? meta.header.writtenAt ?? ""), version: o.version, sigValid: sigValid && b.user === o.ns });
          } else if (o.path === "handover" && b.type === "handover") {
            handovers.set(o.ns, { from: str(b.from) ?? null, asOf: num(b.asOf) ?? 0, at: String(b.at ?? ""), sigValid: sigValid && b.tee === o.ns });
          } else if (/^programs\/[^/]+\/[0-9a-f]{64}\/manifest$/.test(o.path) && b.type === "program_manifest") {
            const m = (b.manifest ?? {}) as Obj;
            const sha = o.path.split("/")[2]!;
            programs.push({
              publisher: o.ns,
              name: String(b.name ?? o.path.split("/")[1]),
              sha256: sha,
              writtenAt: String(meta.header.writtenAt ?? ""),
              sigValid: sigValid && b.sha256 === sha,
              ...(str(b.content) ? { content: str(b.content) } : {}),
              ...(m.egress !== undefined ? { egress: m.egress } : {}),
              ...(m.build !== undefined ? { build: m.build } : {}),
              ...(o.ns === deployment.publisher ? { status: deployment.pac.find((p) => p.sha256 === sha)?.status ?? "unlisted" } : {}),
            });
          }
        } catch {
          problems.push("vault_object_unreadable");
        }
      }),
  );

  // TEEs: each one's announcement, its loads, and its handover.
  const tees = new Map<string, Tee>();
  const teeOf = (id: string): Tee => {
    let t = tees.get(id);
    if (!t) {
      t = { id, sigValid: false, current: false, loads: [] };
      tees.set(id, t);
    }
    return t;
  };
  posts.forEach((p, i) => {
    if (!p.tee) {
      return;
    }
    const t = teeOf(p.tee);
    if (p.type === "tee_announcement") {
      const measured = (bodies[i]?.measured ?? {}) as Obj;
      const rel = deployment.releases.find((r) => r.codeIdentity === p.codeIdentity);
      Object.assign(t, {
        sigValid: p.sigValid,
        postIndex: p.index,
        ...(p.codeIdentity ? { codeIdentity: p.codeIdentity } : {}),
        ...(p.at ? { announcedAt: p.at } : {}),
        ...(p.quote ? { quote: p.quote } : {}),
        ...(str(measured.version) ?? rel?.version ? { version: str(measured.version) ?? rel?.version } : {}),
        ...(rel ? { release: rel.measurement, releaseStatus: rel.status, ...(rel.platform ? { platform: rel.platform } : {}) } : {}),
      });
    } else if (p.type === "program_loaded") {
      t.loads.push({ program: p.program ?? "program", at: p.at ?? p.postedAt, postIndex: p.index, sigValid: p.sigValid });
    }
  });
  for (const [id, h] of handovers) {
    teeOf(id).handover = h;
  }
  const home = [...tees.values()].filter((t) => t.handover).sort((a, b) => b.handover!.at.localeCompare(a.handover!.at))[0];
  if (home) {
    home.current = true;
  }
  for (const p of posts) {
    if (!p.sigValid) {
      problems.push(`bulletin_signature_${p.index}`);
    }
  }

  return {
    at: new Date().toISOString(),
    height,
    deployment,
    posts,
    tees: [...tees.values()].sort((a, b) => (b.announcedAt ?? "").localeCompare(a.announcedAt ?? "")),
    profiles: profiles.sort((a, b) => a.name.localeCompare(b.name)),
    programs: programs.sort((a, b) => b.writtenAt.localeCompare(a.writtenAt)),
    problems: [...new Set(problems)],
  };
}

/** The network, read at most once a `ttlMs`; a failed read serves the last good one. */
export class PublicSource {
  readonly #fetch: Fetch;
  readonly #url: string;
  readonly #ttlMs: number;
  #last: Network | undefined;
  #at = 0;
  #pending: Promise<Network> | undefined;

  constructor(o: { fetch?: Fetch; descriptorUrl?: string; ttlMs?: number } = {}) {
    this.#fetch = o.fetch ?? ((url) => fetch(url));
    this.#url = o.descriptorUrl ?? DESCRIPTOR_URL;
    this.#ttlMs = o.ttlMs ?? 60_000;
  }

  async get(): Promise<Network> {
    if (this.#last && Date.now() - this.#at < this.#ttlMs) {
      return this.#last;
    }
    this.#pending ??= loadNetwork(this.#fetch, this.#url)
      .then((n) => {
        this.#last = n;
        this.#at = Date.now();
        return n;
      })
      .catch((error) => {
        if (this.#last) {
          return { ...this.#last, problems: [...new Set([...this.#last.problems, "stale"])] };
        }
        throw error;
      })
      .finally(() => (this.#pending = undefined));
    return this.#pending;
  }

  /** The vault's height alone: cheap, for the activity log. */
  async height(): Promise<number> {
    const vault = this.#last?.deployment.vault ?? String((await json(this.#fetch, this.#url)).vault);
    return num((await json(this.#fetch, `${vault}/v1/health`)).seq) ?? 0;
  }
}

/** The vault's height over time, sampled by the server: writes per hour, as public as the height itself. */
export class Activity {
  readonly #path: string | undefined;
  samples: { at: string; height: number }[] = [];
  static readonly KEPT = 7 * 24 * 12;

  constructor(path?: string) {
    this.#path = path;
  }

  async load(): Promise<void> {
    if (!this.#path) {
      return;
    }
    try {
      const raw = JSON.parse(await readFile(this.#path, "utf8")) as { samples?: { at: string; height: number }[] };
      this.samples = (raw.samples ?? []).filter((s) => typeof s.at === "string" && typeof s.height === "number").slice(-Activity.KEPT);
    } catch {
      // A first run.
    }
  }

  async record(height: number, at = new Date()): Promise<void> {
    this.samples.push({ at: at.toISOString(), height });
    this.samples = this.samples.slice(-Activity.KEPT);
    if (this.#path) {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(`${this.#path}.tmp`, JSON.stringify({ samples: this.samples }));
      await rename(`${this.#path}.tmp`, this.#path);
    }
  }
}
