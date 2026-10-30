import { z } from 'zod';
import type { AccessGuard } from '../teamAccess/guard';
import type { ToolDef, ToolResult } from './types';

/** Snapshot a tool collection for a model turn; execution always rechecks current access in the backend. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();
  constructor(tools: ToolDef[] = []) { for (const t of tools) this.add(t); }
  /** When an AI worker (a director, an expert) is acting, every call is checked against their current access first. Without one, nothing changes. */
  private guard: AccessGuard | null = null;
  setGuard(g: AccessGuard | null) { this.guard = g; }
  add(tool: ToolDef) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new Error(`Invalid or duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }
  private readonly hints = new Map<string, string>();
  /** Extra guidance for a call to a tool that is not (yet) advertised, for example the family to enable first. */
  hint(name: string, text: string) { this.hints.set(name, text); }
  /** Lets a tool bound to per-run state (task_plan) be registered again when a registry is reused for a resumed run. */
  remove(name: string) { this.tools.delete(name); }
  snapshot(): ToolDef[] { return [...this.tools.values()]; }
  /** True only when the advertised tool classifies this exact call as read-only; any failure means "not read-only". */
  async isReadOnly(snapshot: readonly ToolDef[], name: string, args: unknown): Promise<boolean> {
    const advertised = snapshot.find((t) => t.name === name);
    if (!advertised?.readOnly || this.tools.get(name) !== advertised) return false;
    try { return (await advertised.readOnly(args)) === true; } catch { return false; }
  }
  async call(snapshot: readonly ToolDef[], name: string, args: unknown): Promise<ToolResult> {
    const advertised = snapshot.find((t) => t.name === name);
    const current = this.tools.get(name);
    if (!advertised || !current || current !== advertised) return { text: `Error: Tool ${name} is unknown or no longer available.${this.hints.get(name) ? ` ${this.hints.get(name)}` : ''}`, isError: true };
    const gate = this.guard ? await this.guard.before(name, args) : null;
    if (gate && !gate.ok) return { text: gate.text, isError: true };
    try {
      // Every native tool also performs zod validation; execution backend enforces real permissions.
      const result = await current.execute(args);
      gate?.done(result?.isError === true, result?.isError === true ? result.text : undefined);
      if (typeof result?.text !== 'string' || (result.imageDataUrl !== undefined && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.imageDataUrl) || result.imageDataUrl.length > 4_000_000)) || (result.isError !== undefined && typeof result.isError !== 'boolean')) {
        return { text: 'Error: Tool returned an invalid result.', isError: true };
      }
      return { ...result, text: result.text.slice(0, 8000), ...(result.trustedReadback === true && !result.isError ? { trustedReadback: true, readback: result.readback } : { trustedReadback: undefined, readback: undefined }) };
    } catch (e) { gate?.done(true, e instanceof Error ? e.message : String(e)); return { text: `Error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 8000), isError: true }; }
  }
}
export function validated<T extends z.ZodTypeAny>(schema: T, fn: (args: z.infer<T>) => Promise<string | ToolResult>): ToolDef['execute'] {
  return async (args) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { text: `Error: Invalid tool arguments: ${z.prettifyError(parsed.error)}`.slice(0, 2000), isError: true };
    const value = await fn(parsed.data);
    return typeof value === 'string' ? { text: value, verified: false } : value;
  };
}
export function tool<T extends z.ZodTypeAny>(name: string, description: string, schema: T, fn: (args: z.infer<T>) => Promise<string | ToolResult>): ToolDef {
  return { name, description, parameters: z.toJSONSchema(schema) as Record<string, unknown>, execute: validated(schema, fn) };
}
