import type { Asset } from '@shared/types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDims(a: Asset): string {
  if (a.width && a.height) return `${a.width}×${a.height}`;
  if (a.durationSec != null) return `${a.durationSec.toFixed(2)} s`;
  return '';
}
