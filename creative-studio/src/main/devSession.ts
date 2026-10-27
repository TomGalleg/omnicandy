// The "Build" chat (slide panel): a Claude Code session inside OmniCandy's own source, primed to know the app.
// This is how apps get added and the interface gets changed, by chatting.
import type { EditWorkspace } from './editWorkspace';
import { BUILD_EFFORTS, BUILD_MODELS, DEFAULT_BUILD_MODEL, EMPTY_BUILD_USAGE, type BuildApproval, type BuildEffort, type BuildImage, type BuildItem, type BuildState, type BuildUsage } from '@shared/buildSession';

export const DEV_SESSION_PROMPT = [
  'You are working inside OmniCandy\'s own source code (the folder you were started in). The person talking to you uses OmniCandy and is chatting with you from its Build panel, which shows your messages and asks them to approve edits and commands.',
  'Read CLAUDE.md first: it maps the interface (src/renderer), the app internals (src/main) and how apps are connected (src/main/integrations).',
  'Adding an app = writing or extending an adapter (see docs/external-integration-sdk.md and the Blender/Unreal adapters). Changing the interface = editing the React components under src/renderer/src/components.',
  'Explain changes in plain language. Run `npm run check` before saying a change is done. To see a change, the app must be rebuilt: tell the person to close OmniCandy and double-click "Run CreateCraft.cmd" (one folder up).',
].join('\n');

const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch']);

/** One plain line for the approval card. */
export function describeToolUse(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  if (tool === 'Bash') return `Run: ${s('command').slice(0, 300)}`;
  if (tool === 'Edit' || tool === 'MultiEdit') return `Change ${s('file_path')}`;
  if (tool === 'Write') return `Write ${s('file_path')}`;
  const detail = s('file_path') || s('path') || s('command') || s('url');
  return detail ? `${tool}: ${detail.slice(0, 300)}` : tool;
}

export const needsApproval = (tool: string) => !READ_ONLY.has(tool);

export interface BuildDeps {
  workspace: EditWorkspace;
  env: () => Promise<Record<string, string>>;
  scrub: (text: string) => Promise<string>;
  cliPath?: string;
  emit: (s: BuildState) => void;
}

/** The Build chat. One conversation lives here until Reset, so closing the panel does not lose it. */
export class BuildSession {
  private items: BuildItem[] = [];
  private nextId = 1;
  private usage: BuildUsage = { ...EMPTY_BUILD_USAGE };
  private status: 'idle' | 'working' = 'idle';
  private approval: (BuildApproval & { resolve: (allow: boolean) => void }) | null = null;
  private abort: AbortController | null = null;
  private sessionId: string | null = null;
  private unavailable: string | null = null;
  private model: string = DEFAULT_BUILD_MODEL;
  private effort: BuildEffort = 'medium';

  constructor(private d: BuildDeps) {}

  state(): BuildState {
    const a = this.approval ? { id: this.approval.id, tool: this.approval.tool, summary: this.approval.summary } : null;
    return { status: this.status, items: this.items, approval: a, usage: this.usage, workspace: this.d.workspace.state(), model: this.model, effort: this.effort, unavailable: this.unavailable };
  }

  /** Re-reads the workspace from disk and sends the state out. */
  async refresh(): Promise<void> { await this.d.workspace.refresh(); this.publish(); }
  publish() { this.d.emit(this.state()); }
  private add(kind: BuildItem['kind'], text: string) { this.items = [...this.items, { id: this.nextId++, kind, text }]; this.publish(); }

  answer(id: string, allow: boolean) { if (this.approval?.id === id) { const r = this.approval.resolve; this.approval = null; r(allow); this.publish(); } }

  stop() { this.abort?.abort(); this.answerPending(false); }
  private answerPending(allow: boolean) { if (this.approval) { const r = this.approval.resolve; this.approval = null; r(allow); } }

  reset() {
    this.stop();
    this.items = []; this.sessionId = null; this.usage = { ...EMPTY_BUILD_USAGE }; this.status = 'idle';
    this.publish();
  }

  setModel(id: string) { if (BUILD_MODELS.some((m) => m.id === id)) { this.model = id; this.publish(); } }
  setEffort(e: string) { if ((BUILD_EFFORTS as readonly string[]).includes(e)) { this.effort = e as BuildEffort; this.publish(); } }

  async send(message: string, images: BuildImage[] = []): Promise<void> {
    if (this.status === 'working') throw new Error('Claude is still working. Wait for it or press Stop.');
    const cwd = await this.d.workspace.sourceRoot();
    if (!cwd) {
      this.unavailable = this.d.workspace.state().state === 'no-bundle'
        ? 'This copy of OmniCandy does not include its source code, so there is nothing for Claude to change.'
        : 'Press Set up editing first. It unpacks the source so Claude can change it.';
      this.publish();
      return;
    }
    this.unavailable = null;
    this.add('user', images.length ? `${message}
(+${images.length} pasted image${images.length > 1 ? 's' : ''})`.trim() : message);
    this.status = 'working';
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const q = query({
        prompt: images.length
          ? (async function* () {
            yield {
              type: 'user' as const, parent_tool_use_id: null, session_id: '',
              message: { role: 'user' as const, content: [
                ...(message ? [{ type: 'text' as const, text: message }] : []),
                ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mediaType as 'image/png', data: i.data } })),
              ] },
            };
          })()
          : message,
        options: {
          systemPrompt: { type: 'preset', preset: 'claude_code', append: DEV_SESSION_PROMPT },
          tools: { type: 'preset', preset: 'claude_code' },
          // Like regular Claude Code with its prompts turned off: the person's own Claude settings and CLAUDE.md apply, and nothing waits for a click.
          settingSources: ['user', 'project', 'local'],
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          model: this.model,
          effort: this.effort,
          cwd,
          abortController: abort,
          maxTurns: 200,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          ...(this.d.cliPath ? { pathToClaudeCodeExecutable: this.d.cliPath } : {}),
          env: await this.d.env(),
          canUseTool: async (tool, input, o) => {
            if (!needsApproval(tool)) return { behavior: 'allow', updatedInput: input };
            const allow = await new Promise<boolean>((resolve) => {
              const onAbort = () => resolve(false);
              o.signal.addEventListener('abort', onAbort, { once: true });
              this.approval = { id: `a${this.nextId++}`, tool, summary: describeToolUse(tool, input), resolve: (v) => { o.signal.removeEventListener('abort', onAbort); resolve(v); } };
              this.publish();
            });
            if (this.approval) this.approval = null;
            return allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The person said no. Ask what they want instead.' };
          },
        },
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') this.sessionId = m.session_id;
        else if (m.type === 'assistant') {
          const u = m.message.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          if (u) { this.usage = { ...this.usage, contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) }; }
          for (const b of m.message.content) {
            if (b.type === 'text' && b.text.trim()) this.add('claude', b.text.trim());
            else if (b.type === 'tool_use') this.add('tool', describeToolUse(b.name, (b.input ?? {}) as Record<string, unknown>));
          }
          this.publish();
        } else if (m.type === 'rate_limit_event') {
          const r = m.rate_limit_info;
          const kind = r.rateLimitType ?? 'five_hour';
          const entry = { kind, used: r.utilization ?? null, resetsAt: r.resetsAt ? r.resetsAt * 1000 : null, status: r.status };
          this.usage = { ...this.usage, limits: [...this.usage.limits.filter((l) => l.kind !== kind), entry] };
          this.publish();
        } else if (m.type === 'result') {
          const u = m.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined;
          const windows = Object.values(m.modelUsage ?? {}).map((x) => x.contextWindow).filter((n): n is number => typeof n === 'number');
          this.usage = {
            ...this.usage,
            inputTokens: this.usage.inputTokens + (u?.input_tokens ?? 0),
            outputTokens: this.usage.outputTokens + (u?.output_tokens ?? 0),
            cachedTokens: this.usage.cachedTokens + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
            // A resumed chat already carries its earlier cost, so take the latest total instead of adding.
            costUsd: m.total_cost_usd ?? this.usage.costUsd,
            turns: this.usage.turns + (m.num_turns ?? 0),
            contextWindow: windows.length ? Math.max(...windows) : this.usage.contextWindow,
          };
          const resultText = 'result' in m ? String(m.result ?? '') : '';
          if (/not logged in|\/login|invalid api key/i.test(resultText)) this.add('error', 'Claude is not signed in. Sign in under Settings → Integrations → Claude, then try again.');
          else if (m.is_error && !abort.signal.aborted) this.add('error', await this.d.scrub(resultText || 'Claude stopped with an error.'));
          this.publish();
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) this.add('error', await this.d.scrub(e instanceof Error ? e.message : String(e)));
    } finally {
      this.abort = null;
      this.answerPending(false);
      this.status = 'idle';
      if (abort.signal.aborted) this.add('error', 'Stopped.');
      else this.publish();
    }
  }
}
