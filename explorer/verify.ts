import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * PAC's signatures, checked independently of PAC's own code:
 * SIG(key, domain, x) = Ed25519(key, "pac/v1/" + domain + "\n" + JCS(x)),
 * where a key's id is its raw public key in hex.
 */

/** RFC 8785 canonical JSON, for the values PAC signs: objects, arrays, strings, integers, booleans, null. */
export function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new Error("no JSON form");
    }
    return text;
  }
  if (Array.isArray(value)) {
    return `[${value.map(jcs).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${jcs(v)}`).join(",")}}`;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** False, never a throw, for a malformed key, value or signature. */
export function verifySig(id: string, domain: string, value: unknown, sig: string): boolean {
  try {
    if (!HEX64.test(id)) {
      return false;
    }
    const signature = Buffer.from(sig, "base64url");
    if (signature.length !== 64) {
      return false;
    }
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(id, "hex").toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.from(`pac/v1/${domain}\n${jcs(value)}`, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
