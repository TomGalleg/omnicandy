// Plugin bridge protocol, version 1. CreateCraft <-> a plugin running INSIDE another program.
//
// Transport: a Windows named pipe (a Unix socket elsewhere) created by CreateCraft with a random name per run; newline-
// delimited JSON frames, at most 1 MB each. The pipe is local only. Windows rejects remote clients on pipes created this way.
//
// Who is who: CreateCraft is the server and the only side that issues work. The plugin dials in, proves it knows the secret
// that was created when it was installed (mutual HMAC challenge, the secret is never sent), tells CreateCraft which
// capabilities it can offer in this program right now, and then answers typed commands. A plugin cannot ask CreateCraft for
// anything: the only frames it may send are hello, register, progress, result and pong.
//
// Execution context: the plugin must run every command inside the host program's supported API context (for example a
// Revit ExternalEvent or the host's main-thread dispatcher) and answer from there. CreateCraft only describes WHAT to run.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const BRIDGE_PROTOCOL = { min: 1, max: 1 } as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_RESULT_DATA_BYTES = 64 * 1024;

const proto = z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict();
const idStr = z.string().min(1).max(80);

// ---- plugin -> CreateCraft ----
export const clientHello = z.object({
  t: z.literal('hello'),
  protocol: proto,
  pluginId: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,60}$/),
  pluginVersion: z.string().max(40),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
  app: z.object({ name: z.string().min(1).max(80), version: z.string().max(40).nullable(), edition: z.string().max(60).optional(), pid: z.number().int().min(0).optional() }).strict(),
}).strict();

export const clientRegister = z.object({ t: z.literal('register'), capabilities: z.array(z.string().max(80)).max(100) }).strict();
export const clientProgress = z.object({ t: z.literal('progress'), id: idStr, stage: z.string().max(200), fraction: z.number().min(0).max(1).optional() }).strict();
export const clientResult = z.object({
  t: z.literal('result'), id: idStr, ok: z.boolean(),
  message: z.string().max(1000).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  evidence: z.array(z.string().max(300)).max(20).optional(),
  verified: z.boolean().optional(),
  error: z.object({ kind: z.enum(['app-error', 'unsupported', 'invalid-params', 'cancelled', 'verification-failed']), message: z.string().max(1000) }).strict().optional(),
}).strict();
export const clientPong = z.object({ t: z.literal('pong'), n: z.number().int() }).strict();
export const clientFrame = z.discriminatedUnion('t', [clientHello, clientRegister, clientProgress, clientResult, clientPong]);
export type ClientFrame = z.infer<typeof clientFrame>;
export type ClientResult = z.infer<typeof clientResult>;

// ---- CreateCraft -> plugin ----
export type ServerFrame =
  | { t: 'hello'; product: 'createcraft'; protocol: { min: number; max: number }; nonce: string }
  | { t: 'welcome'; protocol: number; proof: string; sessionId: string; heartbeatMs: number }
  | { t: 'reject'; code: RejectCode; message: string }
  | { t: 'health'; id: string }
  | { t: 'command'; id: string; name: string; params: Record<string, string | number | boolean>; timeoutMs: number }
  | { t: 'cancel'; id: string }
  | { t: 'ping'; n: number }
  | { t: 'bye'; reason: string };

export type RejectCode = 'auth-failed' | 'protocol-mismatch' | 'malformed' | 'too-slow' | 'replaced';

/** Why a bridge call failed. `connection-lost` means the outcome is UNKNOWN (the command may have run). */
export class BridgeError extends Error {
  constructor(readonly kind: 'not-connected' | 'unsupported' | 'timeout' | 'cancelled' | 'connection-lost' | 'plugin-error' | 'invalid-result', message: string, readonly pluginKind?: string) { super(message); }
}

const sign = (secret: string, role: 'c' | 's', snonce: string, cnonce: string, pluginId: string, binding: string) =>
  createHmac('sha256', Buffer.from(secret, 'hex')).update(`cc-bridge|${role}|${snonce}|${cnonce}|${pluginId}|${binding}`).digest('hex');

/** What the plugin sends as proof: bound to both nonces, its id and the ranges it offered. */
export const clientProof = (secret: string, snonce: string, cnonce: string, pluginId: string, offered: { min: number; max: number }) =>
  sign(secret, 'c', snonce, cnonce, pluginId, `${offered.min}-${offered.max}`);
/** What CreateCraft sends back: proves it also knows the secret (so a fake server cannot collect commands or results). */
export const serverProof = (secret: string, snonce: string, cnonce: string, pluginId: string, negotiated: number) =>
  sign(secret, 's', snonce, cnonce, pluginId, String(negotiated));

export function proofEquals(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Highest protocol version both sides support, or null. */
export function negotiate(a: { min: number; max: number }, b: { min: number; max: number }): number | null {
  const hi = Math.min(a.max, b.max);
  return hi >= Math.max(a.min, b.min) ? hi : null;
}
