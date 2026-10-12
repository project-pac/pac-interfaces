import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Ask, Env, FileContent, FileEntry, Member, Ready, Sent, Session, Status, WatchEvent } from "./types.ts";

/**
 * PAC through its CLI, `pac <cmd> … --json`: the interface PAC documents for
 * anything built on it (docs.projectpac.net/cli). Never the daemon's API,
 * never `keys.json`.
 */

/** The PAC home as PAC finds it: `PAC_HOME`, else `~/.pac`. */
export function pacHome(env: Env = process.env): string {
  const set = env.PAC_HOME?.trim();
  return resolve(set ? set : join(env.HOME?.trim() || homedir(), ".pac"));
}

/** `PAC_BIN` (tests, custom installs), else the home's own `bin/pac`, else `pac` on PATH. */
export function pacArgv(env: Env = process.env): string[] {
  const set = env.PAC_BIN?.trim();
  if (set) {
    return set.split(/\s+/);
  }
  const own = join(pacHome(env), "bin", "pac");
  return existsSync(own) ? [own] : ["pac"];
}

/** A pac command that exited non-zero: `code` is PAC's (`usage`, `no_daemon`, …) or `failed`. */
export class PacError extends Error {
  readonly code: string;
  readonly exit: number;
  constructor(code: string, exit: number, message = code) {
    super(message);
    this.code = code;
    this.exit = exit;
  }
}

export const codeOf = (error: unknown): string => (error instanceof PacError ? error.code : error instanceof Error ? error.message : "failed");

export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function stripFrontMatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
}

/** A positional argument: one that starts with "-" would read as a flag. */
const positional = (text: string): string => (text.startsWith("-") ? ` ${text}` : text);

export interface PacOptions {
  /** Kill a command that runs longer than this. Default 120 s (`goal --wait` included). */
  timeoutMs?: number;
}

export class Pac {
  readonly #argv: string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMs: number;

  constructor(env: Env = process.env, options: PacOptions = {}) {
    this.#argv = pacArgv(env);
    this.#env = { ...process.env, ...env, PAC_HOME: pacHome(env) } as NodeJS.ProcessEnv;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** Runs `pac <args> --json` and returns its one JSON value. */
  async run<T>(args: string[]): Promise<T> {
    const argv = [...this.#argv, ...args, "--json"];
    const { code, out } = await new Promise<{ code: number; out: string }>((done, fail) => {
      const child = spawn(argv[0]!, argv.slice(1), { env: this.#env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), this.#timeoutMs);
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", () => {});
      child.on("error", (e) => {
        clearTimeout(timer);
        fail(new PacError((e as NodeJS.ErrnoException).code === "ENOENT" ? "no_pac" : "spawn_failed", 1));
      });
      child.on("close", (c, signal) => {
        clearTimeout(timer);
        done({ code: signal ? 124 : (c ?? 1), out: stdout });
      });
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.trim().split("\n").pop() ?? "null");
    } catch {
      parsed = undefined;
    }
    if (code === 124) {
      throw new PacError("timeout", code);
    }
    if (code !== 0) {
      const err = parsed as { code?: string; error?: string; receipt?: { error?: string } } | undefined;
      throw new PacError(err?.code ?? err?.receipt?.error ?? "failed", code, err?.error ?? `pac ${args[0]} failed`);
    }
    return parsed as T;
  }

  /** `pac system status`: who this home is, its version and grant, and what's wrong. */
  status(): Promise<Status> {
    return this.run(["system", "status"]);
  }

  /** `pac status`: whether PAC is ready, what waits, what's under way. */
  ready(): Promise<Ready> {
    return this.run(["status"]);
  }

  asks(all = false): Promise<Ask[]> {
    return this.run(["asks", ...(all ? ["--all"] : [])]);
  }

  /** One ask as it is now, whatever its status, by id or a prefix of one. */
  async ask(id: string): Promise<Ask> {
    const all = await this.asks(true);
    const found = all.find((a) => a.id === id) ?? (() => {
      const matches = all.filter((a) => a.id.startsWith(id));
      return matches.length === 1 ? matches[0] : undefined;
    })();
    if (!found) {
      throw new PacError("unknown_ask", 2);
    }
    return found;
  }

  sessions(): Promise<Session[]> {
    return this.run(["sessions"]);
  }

  session(ref: string): Promise<Session> {
    return this.run(["session", ref]);
  }

  files(): Promise<FileEntry[]> {
    return this.run(["files", "ls"]);
  }

  cat(file: string): Promise<FileContent> {
    return this.run(["files", "cat", file]);
  }

  /** Everyone on PAC, by name and handle. */
  people(): Promise<Member[]> {
    return this.run(["people"]);
  }

  /** Ask PAC: a new session, or with `session` that session's next turn. */
  prompt(text: string, options: { with?: string[]; only?: boolean; session?: string } = {}): Promise<Sent> {
    return this.run([
      "prompt",
      positional(text),
      ...(options.with?.length ? [`--with=${options.with.join(",")}`] : []),
      ...(options.only ? ["--only"] : []),
      ...(options.session ? [`--session=${options.session}`] : []),
      "--wait",
    ]);
  }

  abort(session: string): Promise<Sent> {
    return this.run(["abort", session, "--wait"]);
  }

  verify(): Promise<{ checked?: number; problems?: unknown[] }> {
    return this.run(["system", "verify"]);
  }

  trust(): Promise<{ status?: string; deployment?: { name?: string; pac?: string; current?: string[]; retired?: string[] } }> {
    return this.run(["system", "trust"]);
  }

  /** A question's answer in words. */
  answer(ask: string, text: string): Promise<Sent> {
    return this.run(["reply", ask, `--text=${text}`, "--wait"]);
  }

  /** A yes-or-no or multiple-choice question's answer. */
  choose(ask: string, choice: string): Promise<Sent> {
    return this.run(["reply", ask, `--choice=${choice}`, "--wait"]);
  }

  /** Skip a question or a data ask; decline a question, which also asks PAC to ask nothing more in that session. */
  pass(ask: string, how: "skip" | "decline"): Promise<Sent> {
    return this.run(["reply", ask, `--${how}`, "--wait"]);
  }

  /**
   * An approval's decision, or an access ask's. Only a human's click may
   * reach this: never wire it to anything a model can call (MCP tools,
   * agent skills). A yes is consent, so it's sent with --yes: the click is
   * the person's yes to what their card showed.
   */
  decide(ask: string, choice: "yes" | "edit" | "no", text?: string): Promise<Sent> {
    return this.run(["reply", ask, choice, ...(choice === "yes" ? ["--yes"] : text ? [`--text=${text}`] : []), "--wait"]);
  }

  /**
   * A group run's submission: consent to the whole group's computation, so,
   * like a decision, only a human's click may reach this.
   */
  submit(ask: string, answer: { text: string } | { choice: string }): Promise<Sent> {
    return this.run(["reply", ask, "text" in answer ? `--text=${answer.text}` : `--choice=${answer.choice}`, "--yes", "--wait"]);
  }

  /** Saves a note as one of the user's files; the same name makes a new version. */
  async put(name: string, content: string): Promise<FileEntry | Record<string, unknown>> {
    if (!NAME.test(name)) {
      throw new PacError("bad_name", 2);
    }
    const dir = await mkdtemp(join(tmpdir(), "pac-put-"));
    try {
      const path = join(dir, name);
      await writeFile(path, content, { mode: 0o600 });
      return await this.run(["files", "put", path, "--name", name]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * `pac watch --json --no-auto-grant`: asks and sessions, one event per line, until stopped.
   * Interfaces never grant a TEE on the user's behalf; the daemon does that.
   */
  watch(onEvent: (event: WatchEvent) => void, onExit: (code: number) => void): { stop: () => void } {
    const argv = [...this.#argv, "watch", "--no-auto-grant", "--json"];
    const child: ChildProcess = spawn(argv[0]!, argv.slice(1), { env: this.#env, stdio: ["ignore", "pipe", "ignore"] });
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const value = JSON.parse(line) as WatchEvent;
        if (value && typeof value.event === "string") {
          onEvent(value);
        }
      } catch {
        // Not an event line.
      }
    });
    child.on("error", () => onExit(1));
    child.on("close", (c) => onExit(c ?? 1));
    return { stop: () => child.kill("SIGTERM") };
  }
}
