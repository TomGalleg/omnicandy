// A big scene's read-back is ONE long line that starts with the result marker; keeping only the tail of the output used to cut the marker
// off and turn a successful run into "Blender stopped with exit code 0". These tests pin the buffer size and the error-line choice.
import { describe, expect, it } from 'vitest';
import { parseResultLine, runProcess } from './process';

const printLong = (chars: number) => ['-e', `process.stdout.write('CREATECRAFT_RESULT {"big":"' + 'x'.repeat(${chars}) + '"}\\n')`];

describe('process output buffer', () => {
  it('cuts the start of a very long line with the default buffer (why Blender runs ask for more)', async () => {
    const r = await runProcess(process.execPath, printLong(300_000), { timeoutMs: 20_000, label: 'node' });
    expect(parseResultLine(r.out)).toBeNull();
  });
  it('keeps a long result line whole when maxOut is raised', async () => {
    const r = await runProcess(process.execPath, printLong(300_000), { timeoutMs: 20_000, label: 'node', maxOut: 1_000_000 });
    expect((parseResultLine(r.out) as { big: string }).big).toHaveLength(300_000);
  });
});
