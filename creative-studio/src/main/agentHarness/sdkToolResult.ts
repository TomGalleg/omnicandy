import type { ToolResult } from './types';

/** Provider-neutral result conversion for the legacy Claude SDK MCP transport.
 * This does not grant permissions or execute tools. ToolRegistry and the existing
 * controllers remain the execution boundary.
 */
export type SdkToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/png' };
export interface SdkToolReply {
  content: SdkToolContent[];
  isError?: boolean;
}

export function toSdkToolReply(result: ToolResult): SdkToolReply {
  const content: SdkToolContent[] = [{ type: 'text', text: result.text }];
  if (result.imageDataUrl) {
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.imageDataUrl);
    if (!match || result.imageDataUrl.length > 4_000_000) {
      return { content: [{ type: 'text', text: 'Error: Invalid image result.' }], isError: true };
    }
    content.push({ type: 'image', data: match[1]!, mimeType: 'image/png' });
  }
  // Verification is never inferred. If present, communicate it explicitly;
  // the Claude SDK MCP content format has no separate verified field.
  if (result.verified === true) {
    content.push({ type: 'text', text: 'CreateCraft verification: verified=true.' });
  } else if (result.verified === false) {
    content.push({ type: 'text', text: 'CreateCraft verification: verified=false (not independently verified).' });
  }
  return { content, ...(result.isError ? { isError: true } : {}) };
}
