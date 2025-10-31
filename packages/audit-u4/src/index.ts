import { randomBytes, createHash as createSha512 } from "crypto";
import { createHash } from "blake3";
import { EventEmitter } from "events";
import * as ed from "@noble/ed25519";

// Configure @noble/ed25519 with Node.js crypto sha512
ed.etc.sha512Sync = (...m) => createSha512("sha512").update(Buffer.concat(m)).digest();

export interface AuditEvent<TPayload = unknown> {
  id: string;
  type: string;
  timestamp: string;
  payload: TPayload;
  prevHash: string | null;
  hash: string;
  signature: string;
}

export interface AuditTrailOptions {
  seed?: Uint8Array;
}

function digestBlake3(value: string): Uint8Array {
  const hasher = createHash();
  hasher.update(Buffer.from(value));
  return hasher.digest({ length: 32 });
}

export class AuditTrail extends EventEmitter {
  private readonly privateKey: Uint8Array;
  private readonly publicKey: Uint8Array;
  private lastHash: string | null = null;

  constructor(options: AuditTrailOptions = {}) {
    super();
    const seed = options.seed ?? randomBytes(32);
    this.privateKey = seed;
    this.publicKey = ed.getPublicKey(seed);
  }

  getPublicKey(): string {
    return Buffer.from(this.publicKey).toString("base64");
  }

  async recordEvent<TPayload>(type: string, payload: TPayload): Promise<AuditEvent<TPayload>> {
    const timestamp = new Date().toISOString();
    const serialized = JSON.stringify({ type, timestamp, payload, prevHash: this.lastHash });
    const hashBytes = digestBlake3(serialized);
    const hash = Buffer.from(hashBytes).toString("base64");
    const signatureBytes = await ed.signAsync(hashBytes, this.privateKey);
    const signature = Buffer.from(signatureBytes).toString("base64");
    const idBytes = digestBlake3(`${serialized}:${Math.random()}`);
    const event: AuditEvent<TPayload> = {
      id: Buffer.from(idBytes).toString("base64"),
      type,
      timestamp,
      payload,
      prevHash: this.lastHash,
      hash,
      signature
    };
    this.lastHash = hash;
    this.emit("event", event);
    return event;
  }
}
