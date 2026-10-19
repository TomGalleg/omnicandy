// Claude Creative Partner state, pushed from main to the renderer.

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number]['id'];

export interface ClaudeChatItem {
  id: string;
  role: 'user' | 'claude' | 'activity' | 'error';
  text: string;
  at: string;
}

export type ClaudeAuthMode = 'sign-in' | 'api-key';
export interface ClaudeBilling { mode: ClaudeAuthMode; keyReady: boolean; keyUnreadable: boolean; keyIgnored: boolean }

export interface ClaudeState {
  /** working = Claude is thinking or editing; signed-out = Claude Code on this PC needs sign-in. */
  status: 'idle' | 'working' | 'signed-out' | 'unavailable';
  model: ClaudeModelId;
  items: ClaudeChatItem[];
  /** From `claude auth status`; null when unknown. */
  signedIn: boolean | null;
  /** Reported by Claude Code for this session (may be 0 on subscription plans). */
  costUsd: number;
  /** Sign-in in progress: the browser opened; paste the code it shows. */
  login: { stage: 'idle' | 'waiting-code' | 'checking' | 'failed'; url: string | null; message: string | null };
  /** Whether the Claude Code command was found on this PC; null until the first check. */
  installed: boolean | null;
  /**
   * How Claude is paid for: the Claude sign-in (plan, the default) or an Anthropic API key the user added in Settings (billed per use by Anthropic).
   * keyReady = a usable key is saved; keyUnreadable = one is saved but cannot be decrypted here; keyIgnored = a key in the PC's environment was found and is not used.
   */
  billing: ClaudeBilling;
}
