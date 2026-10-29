// OmniTown: the team and the town of one project. One town per project; every worker has an identity and a workplace; workplaces grow with the
// number of workers; meetings are recorded with who took part and what they led to. Pure data and rules (no Node, no Electron).
//
// Two rules keep this honest and keep Studio and Village on the same facts:
//  * A town holds PEOPLE and PLACES, never the state of the work. Whether a worker is busy, waiting or finished is read from the plan and the real
//    activity, never stored here, so a picture of a worker working always means something is really running.
//  * Changing the team has cost and permission implications, so only the owner applies team changes. The coordinator can only suggest them.
import { z } from 'zod';
import type { PlannerProject } from './planner';
import { CHUNK_FORMAT, planSummary } from './plannerContext';

export const TOWN_VERSION = 1;
export const TOWN_LIMITS = { agents: 100, businesses: 50, workplaces: 100, meetings: 200, notesPerMeeting: 200, suggestions: 100, participants: 12, name: 60, text: 2000 } as const;

export type AgentRole = 'coordinator' | 'worker';
/** Which AI a worker uses. 'default' follows the project's choice; a role is never tied to one provider. */
export type AgentEngine = { kind: 'default' } | { kind: 'claude' | 'openai' | 'gemini' | 'local'; model?: string };
export type WorkplaceKind = 'town-hall' | 'workplace';

/** The nine main workers every town has. Each has an office on the OmniTown map. `spot` is where the office sits on that picture, in percent. */
export const DIRECTORS = [
  { key: 'general-manager', title: 'General Manager', remit: 'Overall project coordination', spot: { x: 14.7, y: 46 },
    job: 'Coordinate the whole project: help the owner work out what they want to make, keep every part moving together, decide which director should handle what, suggest next steps and bring decisions back to the owner.' },
  { key: 'creative-director', title: 'Creative Director', remit: 'Art and visual direction', spot: { x: 18.5, y: 21 },
    job: 'Guide the art and the look of the project: style, colour, composition, characters, mood and visual consistency. Explain your choices in plain words and offer options.' },
  { key: 'ai-director', title: 'AI Director', remit: 'AI models and agents', spot: { x: 36.8, y: 13 },
    job: 'Know the AI models and agents available and which one fits each task. Advise on prompts, model choice, cost and quality, and on how AI helpers should be set up for this project.' },
  { key: 'software-director', title: 'Software Director', remit: 'Connected applications and specialists', spot: { x: 65.8, y: 14.5 },
    job: 'Know the applications connected to OmniCandy (for example Blender, Unreal and DaVinci Resolve) and what each can do. Say which application and specialist suits each chunk of work and what it would need.' },
  { key: 'production-director', title: 'Production Director', remit: 'Plans, tasks and delivery', spot: { x: 85, y: 23 },
    job: 'Own the plan: break work into clear chunks, order them, spot what blocks what, track progress honestly and say what is needed to deliver on time.' },
  { key: 'technical-director', title: 'Technical Director', remit: 'Development and engineering', spot: { x: 86.4, y: 48 },
    job: 'Handle the technical side: code, tools, pipelines, file formats and performance. Explain technical choices simply and flag technical risks early.' },
  { key: 'quality-director', title: 'Quality Director', remit: 'Testing and verification', spot: { x: 19.7, y: 74.5 },
    job: 'Check that work is correct and good: define what done means for each chunk, say how to test it, and point out what could be wrong. Never call something verified unless it really was.' },
  { key: 'research-director', title: 'Research Director', remit: 'Research and documentation', spot: { x: 50, y: 80 },
    job: 'Find out what the project needs to know and write it down: references, how-tos, decisions and notes. Say clearly what you know, what you are unsure of and where it came from.' },
  { key: 'media-manager', title: 'Media Manager', remit: 'Media library, assets, versions and file organization', spot: { x: 80.4, y: 74.5 },
    job: 'Look after the files: the media library, assets, versions and folder organisation. Suggest where things should live and how to name them, and keep track of which version is current.' },
] as const;
export type DirectorKey = (typeof DIRECTORS)[number]['key'];
const DIRECTOR_KEYS = DIRECTORS.map((d) => d.key) as [DirectorKey, ...DirectorKey[]];
export const isDirectorKey = (k: unknown): k is DirectorKey => typeof k === 'string' && DIRECTORS.some((d) => d.key === k);
/** A director from what an AI or a person wrote: the key, the title ("Creative Director"), or the start of the title ("Creative"). Null when nothing matches; never guessed. */
export function directorFromName(name: string): DirectorKey | null {
  const n = name.trim().toLowerCase().replace(/[.:]+$/, '').replace(/'s office$/, '');
  if (n.length < 3) return null;
  const hit = DIRECTORS.find((d) => d.key === n || d.title.toLowerCase() === n) ?? DIRECTORS.filter((d) => d.title.toLowerCase().startsWith(n) || d.title.toLowerCase().replace(/ (director|manager)$/, '') === n);
  if (Array.isArray(hit)) return hit.length === 1 ? hit[0]!.key : null;
  return hit.key;
}
export const directorTitle = (k: string | null | undefined): string | null => DIRECTORS.find((d) => d.key === k)?.title ?? null;
export const directorOffice = (title: string) => `${title}'s Office`;
export type MeetingKind = 'kickoff' | 'planning' | 'brainstorm' | 'technical' | 'progress' | 'emergency' | 'other';
export const MEETING_KINDS: readonly MeetingKind[] = ['kickoff', 'planning', 'brainstorm', 'technical', 'progress', 'emergency', 'other'];

export interface TownAgent {
  id: string; name: string; role: AgentRole; specialty: string;
  /** What this worker is for, in the owner's words. The worker is told this and works within it. */
  job?: string;
  /** Set for the nine main workers. They cannot be retired or moved; their job can still be edited. */
  director?: DirectorKey;
  businessId: string; workplaceId: string; engine: AgentEngine;
  /** How the character looks. A seed and an accent colour are enough for any renderer to draw the same person. */
  look: { seed: number; accent: string };
  createdAt: string; retired?: boolean;
}
export interface TownBusiness { id: string; name: string; trade: string; managerId: string | null; createdAt: string }
/** A place in the town. Position is presentation only; the size of the building is worked out from how many people work there. */
export interface TownWorkplace { id: string; businessId: string; name: string; kind: WorkplaceKind; x: number; y: number }
export interface MeetingNote { by: string; text: string; at: string }
export interface TownMeeting {
  id: string; topic: string; kind: MeetingKind; participantIds: string[]; startedAt: string; endedAt?: string;
  notes: MeetingNote[];
  /** Planner proposals this meeting produced. Nothing in them is part of the plan until the owner adds it. */
  proposalIds: string[];
}

export type TeamChange =
  | { op: 'add_business'; name: string; trade: string }
  | { op: 'add_agent'; name: string; specialty: string; job?: string; businessId: string; engine?: AgentEngine }
  | { op: 'update_agent'; agentId: string; name?: string; specialty?: string; job?: string; engine?: AgentEngine }
  | { op: 'move_agent'; agentId: string; businessId: string }
  | { op: 'retire_agent'; agentId: string }
  | { op: 'rename_business'; businessId: string; name: string };
export interface TeamSuggestion { id: string; by: string; at: string; note: string; changes: TeamChange[]; status: 'pending' | 'accepted' | 'rejected' }

export interface TownState {
  version: 1; rev: number; updatedAt: string;
  businesses: TownBusiness[]; workplaces: TownWorkplace[]; agents: TownAgent[]; meetings: TownMeeting[]; suggestions: TeamSuggestion[];
}

export class TownError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'limit', message: string) { super(message); this.name = 'TownError'; }
}

const str = (n: number) => z.string().trim().max(n);
export const JOB_MAX = 1200;
const name = str(TOWN_LIMITS.name).min(1);
const engineSchema = z.union([z.object({ kind: z.literal('default') }).strict(), z.object({ kind: z.enum(['claude', 'openai', 'gemini', 'local']), model: z.string().min(1).max(80).optional() }).strict()]);
export const teamChangeSchema: z.ZodType<TeamChange> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_business'), name, trade: str(TOWN_LIMITS.name).default('') }).strict(),
  z.object({ op: z.literal('add_agent'), name, specialty: str(200).default(''), job: str(JOB_MAX).optional(), businessId: z.string().max(80).min(1), engine: engineSchema.optional() }).strict(),
  z.object({ op: z.literal('update_agent'), agentId: z.string().max(80).min(1), name: name.optional(), specialty: str(200).optional(), job: str(JOB_MAX).optional(), engine: engineSchema.optional() }).strict(),
  z.object({ op: z.literal('move_agent'), agentId: z.string().max(80).min(1), businessId: z.string().max(80).min(1) }).strict(),
  z.object({ op: z.literal('retire_agent'), agentId: z.string().max(80).min(1) }).strict(),
  z.object({ op: z.literal('rename_business'), businessId: z.string().max(80).min(1), name }).strict(),
]) as z.ZodType<TeamChange>;
export const teamChangesSchema = z.array(teamChangeSchema).min(1).max(30);

const idRe = /^[a-z]{2,10}_[a-z0-9]{4,24}$/;
const idStr = z.string().regex(idRe);
const agentSchema = z.object({
  id: idStr, name, role: z.enum(['coordinator', 'worker']), specialty: str(200), job: str(JOB_MAX).optional(), director: z.enum(DIRECTOR_KEYS).optional(), businessId: idStr, workplaceId: idStr, engine: engineSchema,
  look: z.object({ seed: z.number().int().min(0).max(2 ** 31), accent: z.string().max(32) }).strict(), createdAt: z.string().max(40), retired: z.boolean().optional(),
}).strict();
export const townStateSchema = z.object({
  version: z.literal(1), rev: z.number().int().min(0), updatedAt: z.string().max(40),
  businesses: z.array(z.object({ id: idStr, name, trade: str(TOWN_LIMITS.name), managerId: idStr.nullable(), createdAt: z.string().max(40) }).strict()).max(TOWN_LIMITS.businesses),
  workplaces: z.array(z.object({ id: idStr, businessId: idStr, name, kind: z.enum(['town-hall', 'workplace']), x: z.number().finite().min(-1e6).max(1e6), y: z.number().finite().min(-1e6).max(1e6) }).strict()).max(TOWN_LIMITS.workplaces),
  agents: z.array(agentSchema).max(TOWN_LIMITS.agents),
  meetings: z.array(z.object({
    id: idStr, topic: str(200).min(1), kind: z.enum(['kickoff', 'planning', 'brainstorm', 'technical', 'progress', 'emergency', 'other']),
    participantIds: z.array(idStr).max(TOWN_LIMITS.participants), startedAt: z.string().max(40), endedAt: z.string().max(40).optional(),
    notes: z.array(z.object({ by: str(TOWN_LIMITS.name), text: str(TOWN_LIMITS.text), at: z.string().max(40) }).strict()).max(TOWN_LIMITS.notesPerMeeting),
    proposalIds: z.array(z.string().max(40)).max(50),
  }).strict()).max(TOWN_LIMITS.meetings),
  suggestions: z.array(z.object({
    id: idStr, by: str(TOWN_LIMITS.name), at: z.string().max(40), note: str(1000), changes: teamChangesSchema, status: z.enum(['pending', 'accepted', 'rejected']),
  }).strict()).max(TOWN_LIMITS.suggestions),
}).strict();

/** How a building looks for the people in it. The numbers are examples of a scale, not limits: any count works. */
export type Tier = 'studio' | 'workshop' | 'factory';
export const tierFor = (workers: number): Tier => (workers >= 6 ? 'factory' : workers >= 2 ? 'workshop' : 'studio');

export const activeAgents = (t: TownState, businessId?: string) => t.agents.filter((a) => !a.retired && (!businessId || a.businessId === businessId));
export const coordinatorOf = (t: TownState): TownAgent | undefined => t.agents.find((a) => a.role === 'coordinator' && !a.retired);

const ACCENTS = ['#4f7cff', '#e5534b', '#3fb950', '#d29922', '#a371f7', '#39c5cf', '#f778ba', '#ff9f43'];
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
export const lookFor = (seedText: string): TownAgent['look'] => { const seed = hash(seedText) % 2 ** 31; return { seed, accent: ACCENTS[seed % ACCENTS.length]! }; };

let counter = 0;
/** Short ids like the rest of the planner (`prefix_` + hex). `rnd` is injectable so tests are deterministic. */
export function makeId(prefix: string, rnd: () => number = Math.random): string {
  counter = (counter + 1) % 0xffff;
  const body = Array.from({ length: 8 }, () => Math.floor(rnd() * 16).toString(16)).join('') + counter.toString(16).padStart(4, '0');
  return `${prefix}_${body}`;
}

/** The office and the person for one director, added to `t`. The General Manager is the coordinator. */
function addDirector(t: TownState, d: (typeof DIRECTORS)[number], iso: string, rnd?: () => number): TownAgent {
  const biz: TownBusiness = { id: makeId('biz', rnd), name: directorOffice(d.title), trade: d.remit, managerId: null, createdAt: iso };
  const place: TownWorkplace = { id: makeId('place', rnd), businessId: biz.id, name: biz.name, kind: 'workplace', x: d.spot.x, y: d.spot.y };
  const a: TownAgent = {
    id: makeId('agent', rnd), name: d.title, role: d.key === 'general-manager' ? 'coordinator' : 'worker', specialty: d.remit, job: d.job, director: d.key,
    businessId: biz.id, workplaceId: place.id, engine: { kind: 'default' }, look: lookFor(d.key), createdAt: iso,
  };
  biz.managerId = a.id;
  t.businesses.push(biz); t.workplaces.push(place); t.agents.push(a);
  return a;
}

/** A new town: the Town Hall and the nine directors, each in their own office. Nobody else is added; helpers are hired by the owner. */
export function defaultTown(now: Date, rnd?: () => number): TownState {
  const iso = now.toISOString();
  const business: TownBusiness = { id: makeId('biz', rnd), name: 'Town Hall', trade: 'Meetings and planning together', managerId: null, createdAt: iso };
  const hall: TownWorkplace = { id: makeId('place', rnd), businessId: business.id, name: 'Town Hall', kind: 'town-hall', x: 50, y: 31 };
  const t: TownState = { version: 1, rev: 1, updatedAt: iso, businesses: [business], workplaces: [hall], agents: [], meetings: [], suggestions: [] };
  for (const d of DIRECTORS) addDirector(t, d, iso, rnd);
  return t;
}

/**
 * Brings a town made before the directors existed up to date: the old coordinator becomes the General Manager and the other eight arrive.
 * Returns the same object when nothing was missing, so callers can tell whether to save.
 */
export function withDirectors(state: TownState, now: Date, rnd?: () => number): TownState {
  const has = (k: DirectorKey) => state.agents.some((a) => a.director === k);
  if (DIRECTORS.every((d) => has(d.key))) return state;
  const t: TownState = structuredClone(state);
  const iso = now.toISOString();
  const old = t.agents.find((a) => a.role === 'coordinator' && !a.director && !a.retired);
  for (const d of DIRECTORS) {
    if (t.agents.some((a) => a.director === d.key)) continue;
    const fresh = addDirector(t, d, iso, rnd);
    if (d.key !== 'general-manager' || !old) continue;
    // The same person (same id, same conversations), now in their own office with a proper title.
    t.agents = t.agents.filter((a) => a.id !== fresh.id);
    const from = t.businesses.find((b) => b.id === old.businessId);
    if (from && from.managerId === old.id) from.managerId = null;
    old.director = d.key; old.businessId = fresh.businessId; old.workplaceId = fresh.workplaceId;
    if (old.name === 'Coordinator') old.name = d.title;
    if (!old.job) old.job = d.job;
    t.businesses.find((b) => b.id === fresh.businessId)!.managerId = old.id;
  }
  t.rev = state.rev + 1; t.updatedAt = iso;
  return t;
}

const need = <T extends { id: string }>(list: T[], id: string, what: string): T => {
  const x = list.find((i) => i.id === id);
  if (!x) throw new TownError('not_found', `There is no ${what} with that id.`);
  return x;
};

function ring(n: number): { x: number; y: number } {
  const a = (n * 137.5 * Math.PI) / 180;
  const r = 180 + 40 * Math.sqrt(n);
  return { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) };
}

/** Applies team changes in order. All or nothing: any problem throws and the original state is returned untouched by the caller. */
export function applyTeamChanges(state: TownState, changesIn: TeamChange[], now: Date, rnd?: () => number): TownState {
  const changes = teamChangesSchema.parse(changesIn);
  const t: TownState = structuredClone(state);
  const iso = now.toISOString();
  /** `@last` in a later change means "the business added by the change before it", so a suggestion can add a business and its first worker together. */
  let lastBusiness: string | null = null;
  const bizId = (ref: string): string => { const id = ref === '@last' ? lastBusiness : ref; if (!id) throw new TownError('invalid', 'That change refers to a business that was not added before it.'); return id; };
  for (const c of changes) {
    switch (c.op) {
      case 'add_business': {
        if (t.businesses.length >= TOWN_LIMITS.businesses) throw new TownError('limit', 'The town cannot hold more businesses.');
        if (t.businesses.some((b) => b.name.toLowerCase() === c.name.toLowerCase())) throw new TownError('invalid', `There is already a business called "${c.name}".`);
        const b: TownBusiness = { id: makeId('biz', rnd), name: c.name, trade: c.trade, managerId: null, createdAt: iso };
        t.businesses.push(b);
        lastBusiness = b.id;
        if (t.workplaces.length >= TOWN_LIMITS.workplaces) throw new TownError('limit', 'The town cannot hold more places.');
        t.workplaces.push({ id: makeId('place', rnd), businessId: b.id, name: c.name, kind: 'workplace', ...ring(t.workplaces.length) });
        break;
      }
      case 'add_agent': {
        const biz = need(t.businesses, bizId(c.businessId), 'business');
        if (t.agents.length >= TOWN_LIMITS.agents) throw new TownError('limit', 'The town cannot hold more workers.');
        const place = t.workplaces.find((w) => w.businessId === biz.id);
        if (!place) throw new TownError('invalid', 'That business has no workplace.');
        const a: TownAgent = { id: makeId('agent', rnd), name: c.name, role: 'worker', specialty: c.specialty, ...(c.job ? { job: c.job } : {}), businessId: biz.id, workplaceId: place.id, engine: c.engine ?? { kind: 'default' }, look: lookFor(`${c.name}:${t.agents.length}`), createdAt: iso };
        t.agents.push(a);
        if (!biz.managerId) biz.managerId = a.id;
        break;
      }
      case 'update_agent': {
        const a = need(t.agents, c.agentId, 'worker');
        if (c.name !== undefined) a.name = c.name;
        if (c.specialty !== undefined) a.specialty = c.specialty;
        if (c.job !== undefined) { if (c.job) a.job = c.job; else delete a.job; }
        if (c.engine !== undefined) a.engine = c.engine;
        break;
      }
      case 'move_agent': {
        const a = need(t.agents, c.agentId, 'worker');
        if (a.role === 'coordinator' || a.director) throw new TownError('invalid', `${a.name} stays in their own office.`);
        const biz = need(t.businesses, bizId(c.businessId), 'business');
        const place = t.workplaces.find((w) => w.businessId === biz.id);
        if (!place) throw new TownError('invalid', 'That business has no workplace.');
        const from = t.businesses.find((b) => b.id === a.businessId);
        if (from?.managerId === a.id) from.managerId = t.agents.find((x) => x.businessId === from.id && x.id !== a.id && !x.retired)?.id ?? null;
        a.businessId = biz.id; a.workplaceId = place.id;
        if (!biz.managerId) biz.managerId = a.id;
        break;
      }
      case 'retire_agent': {
        const a = need(t.agents, c.agentId, 'worker');
        if (a.role === 'coordinator') throw new TownError('invalid', 'The coordinator cannot be retired.');
        if (a.director) throw new TownError('invalid', `${a.name} is one of the nine main workers and cannot be retired.`);
        a.retired = true;
        const biz = t.businesses.find((b) => b.id === a.businessId);
        if (biz?.managerId === a.id) biz.managerId = t.agents.find((x) => x.businessId === biz.id && x.id !== a.id && !x.retired)?.id ?? null;
        break;
      }
      case 'rename_business': {
        const b = need(t.businesses, c.businessId, 'business');
        if (t.workplaces.some((w) => w.kind === 'town-hall' && w.businessId === b.id)) throw new TownError('invalid', 'The Town Hall keeps its name.');
        if (t.agents.some((a) => a.director && a.businessId === b.id)) throw new TownError('invalid', 'The nine offices keep their names.');
        b.name = c.name;
        for (const w of t.workplaces) if (w.businessId === b.id) w.name = c.name;
        break;
      }
    }
  }
  t.rev = state.rev + 1;
  t.updatedAt = iso;
  return t;
}

/** One worker per distinct kind of work named in the plan (an application id on a task), without naming any application here. */
export function suggestTeamFromPlan(town: TownState, resourceHints: ReadonlyArray<{ id: string; note: string }>): TeamChange[] {
  const taken = new Set(town.businesses.map((b) => b.name.toLowerCase()));
  const seen = new Set<string>();
  const out: TeamChange[] = [];
  for (const h of resourceHints) {
    const key = h.id.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = key.split(/[.:/\\ _-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(' ') || key;
    const biz = `${label} Studio`.slice(0, TOWN_LIMITS.name);
    if (taken.has(biz.toLowerCase())) continue;
    out.push({ op: 'add_business', name: biz, trade: `Work that uses ${label}` });
    out.push({ op: 'add_agent', name: `${label} Specialist`.slice(0, TOWN_LIMITS.name), specialty: `Does the chunks that use ${label}`, businessId: '@last' });
  }
  return out;
}

// ---- meetings ---------------------------------------------------------------------------------------------------------------
const touch = (t: TownState, now: Date): TownState => ({ ...t, rev: t.rev + 1, updatedAt: now.toISOString() });

/** Calls a meeting. Only people who work in the town can come. Nothing starts running because they sit down: a meeting is a record. */
export function startMeeting(state: TownState, req: { topic: string; kind?: MeetingKind; participantIds: string[] }, now: Date, rnd?: () => number): { town: TownState; meeting: TownMeeting } {
  const topic = req.topic.trim().slice(0, 200);
  if (!topic) throw new TownError('invalid', 'Give the meeting a topic.');
  const ids = [...new Set(req.participantIds)];
  if (ids.length > TOWN_LIMITS.participants) throw new TownError('limit', `A meeting can have at most ${TOWN_LIMITS.participants} people.`);
  for (const id of ids) { const a = need(state.agents, id, 'worker'); if (a.retired) throw new TownError('invalid', `${a.name} has retired.`); }
  const coordinator = coordinatorOf(state);
  const participantIds = coordinator && !ids.includes(coordinator.id) ? [coordinator.id, ...ids] : ids;
  const meeting: TownMeeting = { id: makeId('meet', rnd), topic, kind: req.kind && MEETING_KINDS.includes(req.kind) ? req.kind : 'other', participantIds, startedAt: now.toISOString(), notes: [], proposalIds: [] };
  const meetings = [...state.meetings, meeting].slice(-TOWN_LIMITS.meetings);
  return { town: touch({ ...state, meetings }, now), meeting };
}

const meetingOf = (t: TownState, id: string): TownMeeting => need(t.meetings, id, 'meeting');

export function addMeetingNote(state: TownState, meetingId: string, note: { by: string; text: string }, now: Date): TownState {
  const t = structuredClone(state);
  const m = meetingOf(t, meetingId);
  if (m.endedAt) throw new TownError('invalid', 'That meeting is over.');
  const text = note.text.trim().slice(0, TOWN_LIMITS.text);
  if (!text) throw new TownError('invalid', 'Write something to add.');
  if (m.notes.length >= TOWN_LIMITS.notesPerMeeting) throw new TownError('limit', 'This meeting has no room for more notes.');
  m.notes.push({ by: note.by.trim().slice(0, TOWN_LIMITS.name) || 'You', text, at: now.toISOString() });
  return touch(t, now);
}

/** Remembers a planner proposal that came out of the meeting (the proposal itself lives in the plan and waits for the owner). */
export function linkMeetingProposal(state: TownState, meetingId: string, proposalId: string, now: Date): TownState {
  const t = structuredClone(state);
  const m = meetingOf(t, meetingId);
  if (!m.proposalIds.includes(proposalId)) m.proposalIds.push(proposalId);
  return touch(t, now);
}

export function endMeeting(state: TownState, meetingId: string, now: Date): TownState {
  const t = structuredClone(state);
  const m = meetingOf(t, meetingId);
  if (!m.endedAt) m.endedAt = now.toISOString();
  return touch(t, now);
}

// ---- suggestions from the coordinator -------------------------------------------------------------------------------------
export function addTeamSuggestion(state: TownState, by: string, note: string, changes: TeamChange[], now: Date, rnd?: () => number): { town: TownState; suggestion: TeamSuggestion } {
  const checked = teamChangesSchema.parse(changes);
  applyTeamChanges(state, checked, now, rnd); // refuse a suggestion that could never be applied
  const suggestion: TeamSuggestion = { id: makeId('sugg', rnd), by: by.slice(0, TOWN_LIMITS.name), at: now.toISOString(), note: note.slice(0, 1000), changes: checked, status: 'pending' };
  return { town: touch({ ...state, suggestions: [...state.suggestions, suggestion].slice(-TOWN_LIMITS.suggestions) }, now), suggestion };
}

/** The owner's answer. Accepting applies the changes (all or nothing); rejecting just closes the suggestion. */
export function decideTeamSuggestion(state: TownState, suggestionId: string, accept: boolean, now: Date, rnd?: () => number): TownState {
  const s = need(state.suggestions, suggestionId, 'suggestion');
  if (s.status !== 'pending') throw new TownError('invalid', 'That suggestion was already decided.');
  const base = accept ? applyTeamChanges(state, s.changes, now, rnd) : touch(structuredClone(state), now);
  return { ...base, suggestions: base.suggestions.map((x) => (x.id === suggestionId ? { ...x, status: accept ? 'accepted' : 'rejected' } : x)) };
}

/**
 * What the General Manager is told when the owner talks to them in the Studio. It is the same person as the one in the town, so they know who they work
 * with. (The planning rules that follow it are the Studio's own; see shared/plannerChat.ts.)
 */
export function generalManagerIntro(town: TownState): string[] {
  const gm = town.agents.find((a) => a.director === 'general-manager' && !a.retired) ?? coordinatorOf(town);
  const mates = activeAgents(town).filter((a) => a.id !== gm?.id).slice(0, 30);
  return [
    `You are ${gm?.name ?? 'the General Manager'}, the General Manager and project coordinator. You are the owner's first point of contact, and the same person whether they talk to you in the Studio or in your office in the town.`,
    ...(mates.length ? ['', 'The rest of the team:', ...mates.map((m) => `- ${m.name}: ${(m.job ?? m.specialty ?? '').trim().slice(0, 160) || 'general help'}`)] : []),
    '',
  ];
}

// ---- what a worker is told ----------------------------------------------------------------------------------------------------
const DEFAULT_COORDINATOR_JOB = 'Keep the project organised: help the owner work out what they want to make, break it into chunks, suggest next steps, and bring decisions back to them.';

/**
 * Everything a worker needs to understand its job: who it is, what it is for, where it works, who else is on the team, and what the project is.
 * The owner stays in charge: a worker advises and proposes; it never claims anything is done and never changes the plan itself.
 */
export function agentSystemPrompt(town: TownState, agent: TownAgent, plan: PlannerProject): string {
  const biz = town.businesses.find((b) => b.id === agent.businessId);
  const mates = activeAgents(town).filter((a) => a.id !== agent.id);
  const job = (agent.job ?? '').trim() || (agent.role === 'coordinator' ? DEFAULT_COORDINATOR_JOB : agent.specialty.trim()) || 'Help with whatever this project needs, within your business.';
  return [
    `You are ${agent.name}, ${agent.role === 'coordinator' ? 'the project coordinator' : agent.director ? 'one of the nine main workers' : 'a member of the team'} at ${biz?.name ?? 'the project'}, in the OmniTown team for the project "${plan.title}". You are talking with the project owner.`,
    '',
    `Your job: ${job}`,
    ...(agent.specialty.trim() && agent.job ? [`Your specialty: ${agent.specialty.trim()}`] : []),
    ...(biz?.trade ? [`Your business: ${biz.name}, ${biz.trade}.`] : []),
    ...(mates.length ? ['', 'The rest of the team:', ...mates.map((m) => `- ${m.name}${m.role === 'coordinator' ? ' (coordinator)' : ''}: ${(m.job ?? m.specialty ?? '').trim().slice(0, 160) || 'general help'}`)] : []),
    '',
    'How to behave:',
    '- Plain, short sentences. Sound like a friendly, capable colleague. Ask at most two short questions at a time, and only when you really need the answer.',
    '- Stay inside your job. If something belongs to someone else on the team, say who, and what to ask them.',
    '- If you need something from another team member, end your reply with a line on its own: "Ask: <their title> — <what you need>". For information only: "Note: <their title> — <what they should know>". Use their exact title, at most two such lines, and only when it really matters. The owner decides whether it is sent; you cannot give anyone work.',
    '- You can discuss, advise, plan and suggest. You do not do the work yourself yet, and you cannot change the plan: the owner decides what joins it and what is finished.',
    '- Never say that something is done unless the owner has said so. Say what you would do and what you would need.',
    '- If the owner asks you to add or change steps, answer in the plan format below, listing only the chunks for your part of the work.',
    '',
    'Plan format (only when asked for steps):',
    CHUNK_FORMAT,
    '',
    'The project so far:',
    ...planSummary(plan),
  ].join(String.fromCharCode(10));
}
