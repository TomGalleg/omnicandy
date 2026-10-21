import { z } from 'zod';
import type { ToolDef, ToolResult } from './types';

/** Snapshot a tool collection for a model turn; execution always rechecks current access in the backend. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  constructor(tools: ToolDef[] = []) { for (const t of tools) this.add(t); }
  add(tool: ToolDef) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new Error(`Invalid or duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  snapshot(): ToolDef[] { return [...this.tools.values()]; }
  async call(snapshot: readonly ToolDef[], name: string, args: unknown): Promise<ToolResult> {
    const advertised = snapshot.find((t) => t.name === name);
    const current = this.tools.get(name);
    if (!advertised || !current || current !== advertised) return { text: `Error: Tool ${name} is unknown or no longer available.`, isError: true };
    try {
      // Every native tool also performs zod validation; execution backend enforces real permissions.
      const result = await current.execute(args);
      if (typeof result?.text !== 'string' || (result.imageDataUrl !== undefined && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.imageDataUrl) || result.imageDataUrl.length > 4_000_000)) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
        return { text: 'Error: Tool returned an invalid result.', isError: true };
      }
      return { ...result, text: result.text.slice(0, 8000) };
    } catch (e) { return { text: `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 8000), isError: true }; }
  }
}
export function validated<T extends z.ZodTypeAny>(schema: T, fn: (args: z.infer<T>) => Promise<string>): ToolDef['execute'] {
  return async (args) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { text: `Error: Invalid tool arguments: ${z.prettifyError(parsed.error)}`.slice(0, 2000), isError: true };
    return { text: await fn(parsed.data), verified: false };
  };
}
export function tool<T extends z.ZodTypeAny>(name: string, description: string, schema: T, fn: (args: z.infer<T>) => Promise<string>): ToolDef {
  return { name, description, parameters: z.toJSONSchema(schema) as Record<string, unknown>, execute: validated(schema, fn) };
}
