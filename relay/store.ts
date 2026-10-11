import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Who is linked: a Slack user and the hash of their connector's token. The
 * token itself is shown once, to the connector, and never kept here.
 */
export interface Linked {
  user: string;
  tokenHash: string;
  /** The PAC name the connector reported when it linked (its own words). */
  name?: string;
  linkedAt: string;
}

export class Store {
  readonly #path: string | undefined;
  readonly #users = new Map<string, Linked>();

  private constructor(path: string | undefined, linked: Linked[]) {
    this.#path = path;
    for (const l of linked) {
      this.#users.set(l.user, l);
    }
  }

  /** From a JSON file, or in memory only without a path (tests). */
  static async open(path?: string): Promise<Store> {
    if (!path) {
      return new Store(undefined, []);
    }
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as { linked?: Linked[] };
      return new Store(path, (raw.linked ?? []).filter((l) => typeof l.user === "string" && typeof l.tokenHash === "string"));
    } catch {
      return new Store(path, []);
    }
  }

  get count(): number {
    return this.#users.size;
  }

  get(user: string): Linked | undefined {
    return this.#users.get(user);
  }

  byTokenHash(hash: string): Linked | undefined {
    for (const l of this.#users.values()) {
      if (l.tokenHash === hash) {
        return l;
      }
    }
    return undefined;
  }

  async put(linked: Linked): Promise<void> {
    this.#users.set(linked.user, linked);
    await this.#save();
  }

  async remove(user: string): Promise<boolean> {
    const had = this.#users.delete(user);
    if (had) {
      await this.#save();
    }
    return had;
  }

  async #save(): Promise<void> {
    if (!this.#path) {
      return;
    }
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify({ linked: [...this.#users.values()] }), { mode: 0o600 });
    await rename(tmp, this.#path);
  }
}
