import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The connector as a launchd agent: it starts at login, and comes back if it
 * crashes. It stays down when the relay refused it for good (it exits 0).
 */

export const LABEL = "net.projectpac.interfaces.slack";

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = () => `gui/${process.getuid?.() ?? 501}`;

/** `launchctl <args>`, no shell: its stdout, or a rejection on a non-zero exit. */
function launchctl(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("launchctl", args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("error", fail);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`launchctl_${code}`))));
  });
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function plist(o: { node: string; main: string; root: string; home: string; log: string }): string {
  const args = [o.node, o.main, "slack", "connector"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(o.root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PAC_HOME</key>
    <string>${xml(o.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(o.log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(o.log)}</string>
</dict>
</plist>
`;
}

/** macOS won't let a launchd agent read these folders, so a checkout there can't run as one. */
export function guarded(root: string): boolean {
  return ["Desktop", "Documents", "Downloads"].some((d) => root === join(homedir(), d) || root.startsWith(join(homedir(), d) + "/"));
}

export async function install(o: { root: string; home: string }): Promise<string> {
  if (process.platform !== "darwin") {
    throw new Error("launchd_only");
  }
  if (guarded(o.root)) {
    throw new Error("guarded_folder");
  }
  const log = join(o.home, "interfaces", "slack", "connector.log");
  await mkdir(join(o.home, "interfaces", "slack"), { recursive: true, mode: 0o700 });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await launchctl(["bootout", `${domain()}/${LABEL}`]).catch(() => undefined);
  await writeFile(plistPath(), plist({ node: process.execPath, main: join(o.root, "bin", "main.ts"), root: o.root, home: o.home, log }));
  await launchctl(["bootstrap", domain(), plistPath()]);
  return log;
}

export async function uninstall(): Promise<void> {
  await launchctl(["bootout", `${domain()}/${LABEL}`]).catch(() => undefined);
  await rm(plistPath(), { force: true });
}

export async function status(): Promise<{ installed: boolean; running: boolean; pid?: number }> {
  try {
    const out = await launchctl(["print", `${domain()}/${LABEL}`]);
    const pid = /\bpid = (\d+)/.exec(out)?.[1];
    return { installed: true, running: pid !== undefined, ...(pid ? { pid: Number(pid) } : {}) };
  } catch {
    return { installed: false, running: false };
  }
}
