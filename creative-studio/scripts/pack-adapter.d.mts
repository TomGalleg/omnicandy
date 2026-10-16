export function zipFiles(files: Map<string, Buffer>): Buffer;
export function generateKeyFile(file: string): void;
export function packAdapter(o: { dir: string; privateKeyPem?: string }): { bytes: Buffer; manifest: Record<string, unknown>; fingerprint: string | null };
