import type { Asset } from '@shared/types';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDims(a: Asset): string {
  const dur = a.durationSec != null ? `${a.durationSec.toFixed(2)} s` : '';
  if (a.width && a.height) return dur ? `${a.width}×${a.height} · ${dur}` : `${a.width}×${a.height}`;
  if (dur) return dur;
  return '';
}
