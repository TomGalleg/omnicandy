export function inspectPackage(file: string): { id: string | null; version: string | null; fingerprint: string | null; problems: string[] };
export function releaseCheck(resourcesDir: string, o?: { allowDev?: boolean }): { ok: boolean; errors: string[]; warnings: string[]; info: string[]; releasable: boolean };
export function readZip(buf: Buffer): Map<string, Buffer>;
