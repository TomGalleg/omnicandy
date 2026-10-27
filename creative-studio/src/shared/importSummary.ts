// Plain-words report for an import (an upload button or a drop), shared by every screen that accepts files.

import type { ImportResult } from './ipc';

const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;

export function importSummary(r: ImportResult): { text: string; error: boolean } {
  const parts: string[] = [];
  if (r.imported.length) parts.push(`Added ${files(r.imported.length)} to your library`);
  if (r.duplicates.length) parts.push(`${files(r.duplicates.length)} ${r.duplicates.length === 1 ? 'was' : 'were'} already in the library (not copied again)`);
  if (r.errors.length) parts.push(`Could not add: ${r.errors.slice(0, 3).map((e) => e.replace(/\.+$/, '')).join('; ')}${r.errors.length > 3 ? `; and ${r.errors.length - 3} more` : ''}`);
  if (!parts.length) return { text: 'Nothing was added. Drop pictures, videos or sounds from your computer.', error: false };
  return { text: `${parts.join('. ')}.`, error: !r.imported.length && !r.duplicates.length && r.errors.length > 0 };
}
