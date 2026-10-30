// Who might raise a hand in a Town Hall meeting, decided by rules, for free. No AI is asked who wants to speak: a "!" over someone's head only means
// "they could add something here". What they actually say is generated only if the owner clicks the "!" to invite them.
//
// A director scores for:
//   named by the owner               the owner's own words name them (or their job title)             strong, and may skip the cool-down
//   named in the answer              the person the owner is talking with says "ask the Creative Director"
//   their topics                     words in the conversation that belong to their job (art and style for the Creative Director...)
//   their tasks                      words that match the title of one of their open tasks (two shared words are a match, one is a hint)
// and loses for:
//   spoke recently                   they already had their say a moment ago
//   covered by the speaker           their topics are all topics of the person being talked with, so they would say the same
// Only the best one is shown, only above a threshold, and never twice in a row, so it stays natural and not every message raises a hand.
import { DIRECTORS, type DirectorKey } from './town';

/** The words that belong to each director's job. Words are matched whole, in lower case. */
export const DIRECTOR_TOPICS: Record<DirectorKey, readonly string[]> = {
  'general-manager': ['plan', 'project', 'team', 'priority', 'scope', 'decide', 'goal', 'coordinate'],
  'creative-director': ['art', 'style', 'look', 'colour', 'color', 'colours', 'colors', 'palette', 'character', 'characters', 'design', 'illustration', 'illustrate', 'draw', 'sketch', 'visual', 'mood', 'logo', 'concept', 'watercolor', 'watercolour', 'paint', 'picture', 'image', 'poster', 'cartoon', 'pixel'],
  'ai-director': ['model', 'models', 'prompt', 'prompts', 'agent', 'agents', 'provider', 'openai', 'gemini', 'claude', 'local', 'cost', 'tokens', 'generate', 'generation', 'ai', 'llm'],
  'software-director': ['blender', 'unreal', 'resolve', 'davinci', 'freecad', 'revit', 'application', 'applications', 'app', 'apps', 'plugin', 'plugins', 'integration', 'software', 'connect', 'pipeline'],
  'production-director': ['schedule', 'deadline', 'milestone', 'milestones', 'deliver', 'delivery', 'timeline', 'order', 'phase', 'phases', 'steps', 'risk', 'blocked', 'progress', 'estimate', 'budget', 'time'],
  'technical-director': ['code', 'engine', 'build', 'performance', 'framework', 'platform', 'browser', 'phone', 'mobile', 'game', 'script', 'develop', 'program', 'api', 'render', 'unity', 'godot', 'format'],
  'quality-director': ['test', 'tests', 'testing', 'verify', 'check', 'quality', 'bug', 'bugs', 'review', 'accept', 'acceptance', 'correct', 'standard', 'proof', 'validate'],
  'research-director': ['research', 'reference', 'references', 'source', 'sources', 'document', 'documentation', 'learn', 'examples', 'study', 'inspiration', 'audience', 'market', 'history', 'facts'],
  'media-manager': ['file', 'files', 'asset', 'assets', 'library', 'version', 'versions', 'folder', 'name', 'naming', 'import', 'export', 'organize', 'organise', 'storage', 'resolution', 'size', 'format'],
};

export interface HandCandidate { id: string; key: DirectorKey | null; name: string; /** Titles of their open tasks. */ taskTitles: readonly string[] }
export interface HandInput {
  candidates: readonly HandCandidate[];
  /** The person the owner is talking with: they cannot raise a hand, and what they cover is not repeated. */
  talkingWithId: string;
  ownerText: string;
  /** What the person talked with said, once they have answered. */
  replyText?: string;
  /** Who spoke in the last few turns, oldest first. */
  recentSpeakerIds: readonly string[];
  /** Owner messages since a hand was last shown (a big number when none ever was). */
  messagesSinceHand: number;
}
export interface HandPick { id: string; name: string; score: number; /** Why, in plain words, for the tooltip. */ reason: string }

export const HAND_THRESHOLD = 6;
const NAMED_BY_OWNER = 10;
const NAMED_IN_ANSWER = 8;
const PER_TOPIC = 2;
const MAX_TOPICS = 3;
const PER_TASK_WORD = 3;
const MAX_TASK_SCORE = 6;
const RECENT_PENALTY = 4;
const COVERED_PENALTY = 5;
const RECENT_TURNS = 2;

const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z][a-z0-9]*/g) ?? []);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a director might be named: the full title, and the first word of it when that is distinctive ("the Creative Director", "creative"). */
function nameForms(name: string): string[] {
  const full = name.toLowerCase();
  const first = full.split(/\s+/)[0] ?? '';
  const forms = [full];
  if (first.length >= 5 && first !== 'general') forms.push(first);
  return forms;
}
const mentions = (text: string, name: string): boolean => { const t = text.toLowerCase(); return nameForms(name).some((f) => new RegExp(`\\b${esc(f)}\\b`).test(t)); };

export function pickHandRaiser(i: HandInput): HandPick | null {
  const text = words(`${i.ownerText} ${i.replyText ?? ''}`);
  const speaker = i.candidates.find((c) => c.id === i.talkingWithId);
  const speakerTopics = new Set(speaker?.key ? DIRECTOR_TOPICS[speaker.key] : []);
  const recent = new Set(i.recentSpeakerIds.slice(-RECENT_TURNS));
  let best: (HandPick & { named: boolean }) | null = null;
  for (const c of i.candidates) {
    if (c.id === i.talkingWithId) continue;
    let score = 0; const why: string[] = [];
    const namedByOwner = mentions(i.ownerText, c.name);
    const namedInAnswer = !!i.replyText && mentions(i.replyText, c.name);
    if (namedByOwner) { score += NAMED_BY_OWNER; why.push('you mentioned them'); }
    else if (namedInAnswer) { score += NAMED_IN_ANSWER; why.push('named in the answer'); }
    const hits = (c.key ? DIRECTOR_TOPICS[c.key] : []).filter((w) => text.has(w));
    const distinctHits = [...new Set(hits)];
    if (distinctHits.length) { score += Math.min(MAX_TOPICS, distinctHits.length) * PER_TOPIC; if (!namedByOwner && !namedInAnswer) why.push(`about ${distinctHits.slice(0, 2).join(' and ')}`); }
    // A task of theirs counts more the more real words (four letters or more) it shares with the conversation: one shared word is a hint, two is a match.
    const shared = c.taskTitles.map((t) => ({ t, n: [...words(t)].filter((w) => w.length >= 4 && text.has(w)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n);
    if (shared.length) { score += Math.min(MAX_TASK_SCORE, shared[0]!.n * PER_TASK_WORD); why.push(`has a task: "${shared[0]!.t.slice(0, 40)}"`); }
    // They would only repeat the person already being talked with: every topic of theirs that came up is also a topic of that person's job.
    if (!namedByOwner && !namedInAnswer && distinctHits.length && distinctHits.every((w) => speakerTopics.has(w))) score -= COVERED_PENALTY;
    if (recent.has(c.id)) score -= RECENT_PENALTY;
    if (score < HAND_THRESHOLD) continue;
    if (!best || score > best.score) best = { id: c.id, name: c.name, score, reason: why.join(', '), named: namedByOwner };
  }
  if (!best) return null;
  // Not on every message: after a hand was shown, wait a message, unless the owner named this person themselves.
  if (i.messagesSinceHand < 1 && !best.named) return null;
  return { id: best.id, name: best.name, score: best.score, reason: best.reason };
}

/** A candidate for each person at the table: their job key (when they are one of the nine) and the titles of their open tasks. */
export function handCandidates(people: ReadonlyArray<{ id: string; name: string; director?: DirectorKey | undefined }>, tasks: ReadonlyArray<{ title: string; status: string; assignee?: string | null }>): HandCandidate[] {
  return people.map((a) => ({
    id: a.id, key: a.director ?? null, name: a.name,
    taskTitles: a.director ? tasks.filter((t) => t.assignee === a.director && t.status !== 'accepted' && t.status !== 'cancelled').map((t) => t.title) : [],
  }));
}

/** The jobs, for anything that wants to show why. */
export const directorJob = (key: DirectorKey): string => DIRECTORS.find((d) => d.key === key)?.remit ?? '';
