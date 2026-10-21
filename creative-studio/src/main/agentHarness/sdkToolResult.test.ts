import { describe, expect, it } from 'vitest';
import { toSdkToolReply } from './sdkToolResult';

describe('Claude SDK transport for shared tool results', () => {
  it('preserves success and uncertainty without falsely claiming verification', () => {
    expect(toSdkToolReply({ text: 'applied' })).toEqual({ content: [{ type: 'text', text: 'applied' }] });
    expect(toSdkToolReply({ text: 'applied', verified: false }).content[1]).toEqual({ type: 'text', text: 'CreateCraft verification: verified=false (not independently verified).' });
    expect(toSdkToolReply({ text: 'saved', verified: true }).content[1]).toEqual({ type: 'text', text: 'CreateCraft verification: verified=true.' });
  });
  it('retains errors as errors', () => {
    expect(toSdkToolReply({ text: 'Denied', isError: true })).toEqual({ content: [{ type: 'text', text: 'Denied' }], isError: true });
  });
  it('converts PNG previews to SDK image content', () => {
    expect(toSdkToolReply({ text: 'preview', imageDataUrl: 'data:image/png;base64,aGVsbG8=' }).content[1]).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
  });
  it('rejects malformed image data', () => {
    expect(toSdkToolReply({ text: 'preview', imageDataUrl: 'data:image/jpeg;base64,AA==' }).isError).toBe(true);
  });
});
