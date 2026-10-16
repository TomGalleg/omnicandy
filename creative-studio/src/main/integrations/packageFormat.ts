// Adapter package format (.ccadapter = a ZIP, or an unpacked folder while developing).
//
//   adapter.json   the manifest (below); lists the SHA-256 of every other file
//   adapter.sig    optional: { algorithm: "ed25519", publicKey: <base64 SPKI DER>, signature: <base64> }
//                  over the exact bytes of adapter.json
//   <files>        the entry script and anything it needs
//
// Reading a package never executes anything. Integrity (hashes), identity (signature and its fingerprint)
// and structure (names, sizes, schema) are all checked here, before anything is written to disk.

import { createHash, createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ADAPTER_SDK_VERSION, PERMISSION_LABEL, SUPPORTED_MANIFEST_VERSIONS,
  type AdapterManifest, type IntegrationType, type AdapterRequirement, type CommandSpec, type Permission, type SignatureState,
} from '@shared/integrations';
import { PACKAGE_LIMITS, readZip, safeEntryName, ZipError, type ZipLimits } from './zip';

export const MANIFEST_FILE = 'adapter.json';
export const SIGNATURE_FILE = 'adapter.sig';

const PERMS = Object.keys(PERMISSION_LABEL) as [Permission, ...Permission[]];
const text = (max: number) => z.string().min(1).max(max);
const versionStr = z.string().regex(/^\d+(\.\d+){0,2}$/, 'must look like 1.2 or 1.2.3');

const paramSpec = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  description: text(300),
  required: z.boolean().optional(),
  default: z.union([z.string().max(512), z.number(), z.boolean()]).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
}).strict();

const commandSpec = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/, 'command id: lower-case letters, digits, "_", "." or "-"'),
  label: text(80),
  description: text(400),
  params: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/), paramSpec).refine((o) => Object.keys(o).length <= 20, 'at most 20 settings per command'),
  permissions: z.array(z.enum(PERMS)).max(PERMS.length),
  destructive: z.boolean().optional(),
  idempotent: z.boolean().optional(),
  timeoutMs: z.number().int().min(1000).max(6 * 60 * 60 * 1000).optional(),
  longRunning: z.boolean().optional(),
}).strict();

const requirement = z.object({
  kind: z.enum(['application', 'edition', 'running', 'runtime', 'preference', 'licence', 'other']),
  text: text(300),
}).strict();

const dependency = z.object({
  kind: z.enum(['python', 'dotnet', 'java', 'application', 'other']),
  name: text(80),
  min: versionStr.optional(),
  note: z.string().max(300).optional(),
}).strict();

const range = z.object({ min: versionStr.optional(), max: versionStr.optional() }).strict();

const idRe = /^[a-z0-9][a-z0-9.-]{1,60}$/;
const workflow = z.object({ title: text(120), steps: z.array(text(300)).min(1).max(10), officialUrl: z.string().url().max(200).optional() }).strict();

// Manifest version 2: how the integration reaches the program. The manifest only NAMES a host profile and a destination;
// the folders, file types and limits live in the installer's own table (install/hostProfiles.ts), so a package cannot
// grant itself a write location. There is deliberately no field for scripts, commands or absolute paths.
export const integrationSchema = z.object({
  type: z.enum(['external', 'internal', 'hybrid']),
  host: z.object({
    profile: z.string().regex(idRe),
    simulated: z.boolean().optional(),
    editions: z.array(text(60)).max(8).optional(),
    versions: z.array(range).max(8).optional(),
  }).strict().optional(),
  plugin: z.object({
    id: z.string().regex(idRe),
    name: text(80).optional(),
    version: versionStr,
    technology: z.enum(['dotnet-addin', 'python-addin', 'cep', 'uxp', 'extendscript', 'maxscript', 'bundle', 'node-module']),
    mechanism: z.enum(['file-copy', 'vendor-workflow']),
    destination: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
    files: z.array(z.object({ from: text(200), to: text(200) }).strict()).max(40),
    restart: z.enum(['required', 'not-required', 'unknown']),
    closeHost: z.enum(['required', 'not-required']),
    admin: z.enum(['never', 'required']),
    dependencies: z.array(dependency).max(12).optional(),
    vendorWorkflow: workflow.optional(),
  }).strict().optional(),
  communication: z.object({
    transport: z.literal('named-pipe'),
    protocol: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
    /** Everything the plugin may ever register, with what each needs. */
    capabilities: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_.-]{0,60}$/), permissions: z.array(z.enum(PERMS)).max(PERMS.length) }).strict()).max(50),
  }).strict().optional(),
  uninstall: z.object({ vendorWorkflow: workflow.optional() }).strict().optional(),
}).strict();

export const packageManifestSchema = z.object({
  manifestVersion: z.number().int().refine((v) => SUPPORTED_MANIFEST_VERSIONS.includes(v), 'unsupported manifestVersion (this CreateCraft reads 1 and 2)'),
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,60}$/, 'id: lower-case letters, digits, "." or "-" (2 to 61 characters)'),
  name: text(80),
  version: versionStr,
  description: z.string().max(500).optional(),
  license: z.string().max(80).optional(),
  homepage: z.string().url().max(200).optional(),
  publisher: z.object({ name: text(80) }).strict(),
  sdk: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict(),
  application: z.object({
    kind: z.enum(['program', 'self-contained']),
    name: text(80),
    exeNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,60}\.exe$/i, 'a plain .exe file name')).max(10).optional(),
    /** Literal text; a program matches when its display name STARTS with it (case-insensitive). Not a regular expression. */
    displayNames: z.array(text(80)).max(10).optional(),
    versions: z.array(range).max(8).optional(),
  }).strict(),
  requirements: z.array(requirement).max(12).optional(),
  /** Required for external and hybrid integrations; internal-only packages carry no adapter code. */
  runtime: z.object({
    entry: text(200),
    dependencies: z.array(dependency).max(12).optional(),
  }).strict().optional(),
  integration: integrationSchema.optional(),
  methods: z.array(z.enum(['api', 'scripting', 'mcp', 'cli', 'file-exchange', 'ui-automation', 'visual'])).min(1).max(7),
  capabilities: z.array(z.enum(['detect', 'inspectCapabilities', 'connect', 'disconnect', 'healthCheck', 'launch', 'openProject', 'executeCommand', 'getExecutionStatus', 'cancelOperation', 'saveProject', 'exportFile', 'importFile', 'getApplicationState', 'dispose'])).max(15),
  commands: z.array(commandSpec).max(50),
  files: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 as 64 hex characters')),
}).strict();

export type PackageManifest = z.infer<typeof packageManifestSchema>;
export type IntegrationSpec = z.infer<typeof integrationSchema>;

export const integrationTypeOf = (m: Pick<PackageManifest, 'integration'>): IntegrationType => m.integration?.type ?? 'external';
/** Entry script of the adapter part; null for internal-only packages. */
export const entryOf = (m: Pick<PackageManifest, 'runtime'>): string | null => m.runtime?.entry ?? null;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** The set of permissions any command may use. */
export function requestedPermissions(m: Pick<PackageManifest, 'commands' | 'integration'>): Permission[] {
  const fromPlugin = (m.integration?.communication?.capabilities ?? []).flatMap((c) => c.permissions);
  return [...new Set([...m.commands.flatMap((c) => c.permissions), ...fromPlugin])].sort();
}

export interface SignatureInfo { state: SignatureState; fingerprint: string | null; publicKey: string | null; detail: string }

/** "ab12 cd34 ..." (32 hex characters of the key's SHA-256, grouped), the identity shown to the user. */
export function fingerprintOf(spkiDer: Buffer): string {
  return sha256(spkiDer).slice(0, 32).toUpperCase().replace(/(.{4})(?=.)/g, '$1 ');
}

export function checkSignature(manifestBytes: Buffer, sigBytes: Buffer | undefined): SignatureInfo {
  if (!sigBytes) return { state: 'unsigned', fingerprint: null, publicKey: null, detail: 'The package is not signed.' };
  try {
    const j = JSON.parse(sigBytes.toString('utf8')) as { algorithm?: string; publicKey?: string; signature?: string };
    if (j.algorithm !== 'ed25519' || typeof j.publicKey !== 'string' || typeof j.signature !== 'string') throw new Error('unsupported signature format');
    const der = Buffer.from(j.publicKey, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    const ok = verify(null, manifestBytes, key, Buffer.from(j.signature, 'base64'));
    if (!ok) return { state: 'invalid', fingerprint: fingerprintOf(der), publicKey: j.publicKey, detail: 'The signature does not match the manifest. The package was changed after signing, or the signature is forged.' };
    return { state: 'valid', fingerprint: fingerprintOf(der), publicKey: j.publicKey, detail: 'The signature matches the manifest.' };
  } catch (e) {
    return { state: 'invalid', fingerprint: null, publicKey: null, detail: `The signature file could not be verified: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export interface LoadedSource { files: Map<string, Buffer>; bytes: number }

/** Reads a package from a .ccadapter file or an unpacked folder with the same size and name rules. */
export async function readPackageSource(source: string, limits: ZipLimits = PACKAGE_LIMITS): Promise<LoadedSource> {
  const st = await fs.lstat(source);
  if (st.isSymbolicLink()) throw new ZipError('the package path is a symbolic link');
  let files: Map<string, Buffer>;
  if (st.isDirectory()) {
    files = new Map();
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isSymbolicLink()) throw new ZipError(`symbolic link "${rel}"`);
        if (e.isDirectory()) { await walk(path.join(dir, e.name), rel); continue; }
        if (!e.isFile()) throw new ZipError(`"${rel}" is not a regular file`);
        safeEntryName(rel);
        if (files.size >= limits.maxFiles) throw new ZipError(`package has more than ${limits.maxFiles} files`);
        const s = await fs.stat(path.join(dir, e.name));
        if (s.size > limits.maxFileBytes) throw new ZipError(`"${rel}" is larger than ${limits.maxFileBytes} bytes`);
        total += s.size;
        if (total > limits.maxTotalBytes) throw new ZipError(`package is larger than ${limits.maxTotalBytes} bytes`);
        files.set(rel, await fs.readFile(path.join(dir, e.name)));
      }
    };
    await walk(source, '');
  } else if (st.isFile()) {
    if (st.size > limits.maxTotalBytes + 1024 * 1024) throw new ZipError('the package file is too large');
    files = readZip(await fs.readFile(source), limits);
  } else throw new ZipError('not a file or folder');
  let bytes = 0;
  for (const b of files.values()) bytes += b.length;
  return { files, bytes };
}

export interface ParsedPackage {
  manifest: PackageManifest;
  manifestBytes: Buffer;
  signature: SignatureInfo;
  problems: string[];
}

/** Structure, schema and integrity checks. `problems` empty means the files are exactly what the manifest says. */
export function parsePackage(files: Map<string, Buffer>): ParsedPackage | { problems: string[]; manifest: null; signature: SignatureInfo } {
  const none: SignatureInfo = { state: 'unsigned', fingerprint: null, publicKey: null, detail: '' };
  const mb = files.get(MANIFEST_FILE);
  if (!mb) return { manifest: null, problems: [`${MANIFEST_FILE} is missing`], signature: none };
  let raw: unknown;
  try { raw = JSON.parse(mb.toString('utf8')); } catch (e) { return { manifest: null, problems: [`${MANIFEST_FILE} is not valid JSON: ${(e as Error).message}`], signature: none }; }
  const r = packageManifestSchema.safeParse(raw);
  const signature = checkSignature(mb, files.get(SIGNATURE_FILE));
  if (!r.success) {
    return { manifest: null, signature, problems: r.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || 'manifest'}: ${i.message}`) };
  }
  const m = r.data;
  const problems: string[] = [];
  if (m.sdk.min > m.sdk.max) problems.push('sdk.min is greater than sdk.max');
  if (ADAPTER_SDK_VERSION < m.sdk.min || ADAPTER_SDK_VERSION > m.sdk.max) problems.push(`needs adapter SDK ${m.sdk.min}-${m.sdk.max}; this CreateCraft speaks ${ADAPTER_SDK_VERSION}`);
  if (m.application.kind === 'program' && !m.application.exeNames?.length) problems.push('a program adapter must list application.exeNames');
  if (m.application.kind === 'self-contained' && m.application.exeNames?.length) problems.push('a self-contained adapter must not list application.exeNames');
  if (m.commands.length && !m.capabilities.includes('executeCommand')) problems.push('declares commands without the executeCommand capability');
  const ids = new Set<string>();
  for (const c of m.commands) { if (ids.has(c.id)) problems.push(`duplicate command ${c.id}`); ids.add(c.id); }
  for (const name of Object.keys(m.files)) {
    try { safeEntryName(name); } catch (e) { problems.push((e as Error).message); }
    if (name === MANIFEST_FILE || name === SIGNATURE_FILE) problems.push(`${name} cannot be listed in files`);
  }
  const type = integrationTypeOf(m);
  if (m.manifestVersion === 1 && m.integration) problems.push('"integration" needs manifestVersion 2');
  if (type !== 'internal' && !m.runtime) problems.push(`a ${type} integration needs runtime.entry`);
  if (type === 'internal' && m.runtime) problems.push('an internal-only integration carries no adapter code: remove runtime');
  if (m.runtime) {
    try { safeEntryName(m.runtime.entry); } catch (e) { problems.push(`runtime.entry: ${(e as Error).message}`); }
    if (!/\.c?js$/.test(m.runtime.entry)) problems.push('runtime.entry must be a .js or .cjs file');
    if (!(m.runtime.entry in m.files)) problems.push('runtime.entry is not listed in files');
  }
  problems.push(...integrationProblems(m, type));
  // Integrity: the package holds exactly the listed files, byte for byte.
  for (const [name, hash] of Object.entries(m.files)) {
    const b = files.get(name);
    if (!b) problems.push(`listed file "${name}" is missing`);
    else if (sha256(b) !== hash) problems.push(`"${name}" does not match its recorded SHA-256`);
  }
  for (const name of files.keys()) {
    if (name === MANIFEST_FILE || name === SIGNATURE_FILE) continue;
    if (!(name in m.files)) problems.push(`"${name}" is in the package but not listed in the manifest`);
  }
  return { manifest: m, manifestBytes: mb, signature, problems };
}

function integrationProblems(m: PackageManifest, type: IntegrationType): string[] {
  const out: string[] = [];
  const i = m.integration;
  if (!i) return out;
  if (i.type === 'external') {
    if (i.plugin || i.communication) out.push('an external integration cannot declare a plugin or communication');
    return out;
  }
  if (!i.plugin) out.push(`a ${type} integration needs integration.plugin`);
  if (!i.communication) out.push(`a ${type} integration needs integration.communication`);
  if (!i.host) out.push(`a ${type} integration needs integration.host.profile`);
  const pl = i.plugin;
  if (pl) {
    for (const f of pl.files) {
      try { safeEntryName(f.to); } catch (e) { out.push(`plugin file target "${f.to}": ${(e as Error).message}`); }
      if (!(f.from in m.files)) out.push(`plugin file "${f.from}" is not listed in files`);
    }
    if (pl.mechanism === 'file-copy' && !pl.files.length) out.push('a file-copy plugin lists no files');
    if (pl.mechanism === 'vendor-workflow' && !pl.vendorWorkflow) out.push('a vendor-workflow plugin needs vendorWorkflow steps');
    if (pl.mechanism === 'vendor-workflow' && pl.files.length) out.push('a vendor-workflow plugin must not list files for CreateCraft to copy');
    if (pl.vendorWorkflow?.officialUrl && !/^https:\/\//.test(pl.vendorWorkflow.officialUrl)) out.push('vendorWorkflow.officialUrl must be https');
  }
  const c = i.communication;
  if (c) {
    if (c.protocol.min > c.protocol.max) out.push('communication.protocol.min is greater than max');
    const caps = new Set(c.capabilities.map((x) => x.id));
    if (caps.size !== c.capabilities.length) out.push('duplicate communication capability');
    if (type === 'internal') for (const cmd of m.commands) if (!caps.has(cmd.id)) out.push(`command "${cmd.id}" has no matching communication capability`);
  }
  return out;
}

/** Converts a package manifest into the registry's AdapterManifest. Packages are always "experimental": verified is CreateCraft's word. */
export function toAdapterManifest(m: PackageManifest, trust: 'trusted-publisher' | 'unsigned'): AdapterManifest {
  const ranges = m.application.versions;
  const mins = (ranges ?? []).map((r) => r.min).filter((x): x is string => !!x);
  const maxs = (ranges ?? []).map((r) => r.max).filter((x): x is string => !!x);
  const cmp = (a: string, b: string) => a.split('.').map(Number).reduce((d, x, i) => d || x - (Number(b.split('.')[i]) || 0), 0);
  const selfContained = m.application.kind === 'self-contained';
  const reqs: AdapterRequirement[] = [...(m.requirements ?? [])];
  for (const d of m.runtime?.dependencies ?? []) reqs.push({ kind: 'runtime', text: `${d.name}${d.min ? ` ${d.min} or newer` : ''}${d.note ? `: ${d.note}` : ''}` });
  return {
    id: m.id,
    name: m.name,
    vendor: m.publisher.name,
    sdkVersion: ADAPTER_SDK_VERSION,
    maturity: 'experimental',
    exeNames: selfContained ? [] : (m.application.exeNames ?? []),
    displayNames: (m.application.displayNames ?? []).map((n) => `^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    versions: { min: mins.length === (ranges?.length ?? 0) && mins.length ? [...mins].sort(cmp)[0] : undefined, max: maxs.length === (ranges?.length ?? 0) && maxs.length ? [...maxs].sort(cmp).at(-1) : undefined },
    versionRanges: ranges?.length ? ranges : undefined,
    methods: m.methods,
    capabilities: m.capabilities,
    commands: m.commands as CommandSpec[],
    notes: m.description,
    version: m.version,
    description: m.description,
    license: m.license,
    requirements: reqs,
    source: 'package',
    trust,
    selfContained,
    integrationType: integrationTypeOf(m),
  };
}
