// The "Build" chat: a Claude Code session inside OmniCandy's own source, shown in a slide-out panel.

export const BUILD_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
] as const;
export const BUILD_EFFORTS = ['low', 'medium', 'high'] as const;
export type BuildEffort = (typeof BUILD_EFFORTS)[number];
export const DEFAULT_BUILD_MODEL = 'claude-sonnet-5-5';

/** A picture pasted into the chat. */
export interface BuildImage { mediaType: string; data: string }

export interface BuildItem {
  id: number;
  kind: 'user' | 'claude' | 'tool' | 'error';
  text: string;
}

export interface BuildApproval {
  id: string;
  tool: string;
  /** One plain line saying what Claude wants to do. */
  summary: string;
}

export interface BuildUsage {
  /** Tokens sent to and received from Claude over this chat. */
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** What the chat so far would cost at API prices. A Claude subscription is not billed per request. */
  costUsd: number;
  turns: number;
  /** Size of the conversation Claude is holding right now, and the most it can hold. */
  contextTokens: number;
  contextWindow: number | null;
  /** Claude plan limit, when signed in with a Claude subscription: 0 to 1 used, and when it resets (ms since 1970). */
  limits: Array<{ kind: string; used: number | null; resetsAt: number | null; status: 'allowed' | 'allowed_warning' | 'rejected' }>;
}

export interface BuildState {
  status: 'idle' | 'working';
  items: BuildItem[];
  approval: BuildApproval | null;
  usage: BuildUsage;
  workspace: WorkspaceState;
  model: string;
  effort: BuildEffort;
  /** Why the chat cannot start (Claude Code missing, source not found), or null. */
  unavailable: string | null;
}

/** The editable copy of OmniCandy's source that the Build chat works in. */
export interface WorkspaceState {
  /** 'source': OmniCandy is running from its source folder. 'installed': an installed copy, which keeps its editable source in the user's Documents. */
  mode: 'source' | 'installed';
  /** needs-setup: nothing unpacked yet. busy: setting up, building or restoring. ready: Claude can work. no-bundle: this installer carries no source. */
  state: 'needs-setup' | 'busy' | 'ready' | 'no-bundle';
  folder: string | null;
  /** What is happening now, plus the last lines of its output. */
  step: string | null;
  log: string[];
  /** Node.js (needed to rebuild) was found on this PC. */
  nodeFound: boolean;
  /** This session is running the person's edited copy. */
  runningEdited: boolean;
  /** The edited copy was started once and never came up, so the original was started instead. */
  editedFailed: boolean;
  /** The last rebuild failed; this is what it printed. */
  buildError: string | null;
}

export const EMPTY_WORKSPACE: WorkspaceState = {
  mode: 'source', state: 'no-bundle', folder: null, step: null, log: [], nodeFound: false, runningEdited: false, editedFailed: false, buildError: null,
};

export const EMPTY_BUILD_USAGE: BuildUsage = {
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, turns: 0, contextTokens: 0, contextWindow: null, limits: [],
};

export interface PlanUsageBar { percent: number; resetsAt: number | null }

/** The plan limits Claude Code's /usage shows, read live from Anthropic. */
export interface PlanUsage {
  plan: string | null;
  fetchedAt: number;
  /** Why the numbers could not be read, or null. */
  error: string | null;
  session: PlanUsageBar | null;
  weekly: PlanUsageBar | null;
  weeklyOpus: PlanUsageBar | null;
  weeklySonnet: PlanUsageBar | null;
  credits: { usedUsd: number; limitUsd: number } | null;
}
