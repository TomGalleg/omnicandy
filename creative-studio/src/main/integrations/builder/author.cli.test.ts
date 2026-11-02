import { describe, expect, it } from 'vitest';
import { buildQueryOptions } from './author';

const options = (cli?: string | null) => buildQueryOptions('m', 'C:/x', 's', { tools: [], maxTurns: 1 }, new AbortController(), undefined, cli);

describe('the Claude program the builder starts', () => {
  it('is passed to the SDK when known, so a packaged build never launches a copy inside app.asar', () => {
    expect(options('C:/p/app.asar.unpacked/claude.exe').pathToClaudeCodeExecutable).toBe('C:/p/app.asar.unpacked/claude.exe');
  });
  it('is left to the SDK when none was found', () => {
    expect('pathToClaudeCodeExecutable' in options()).toBe(false);
  });
});
