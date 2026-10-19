// Every OmniCandi project has its own Planner, kept inside the project folder. These tests use real project folders and the real planner service.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeProject } from './projectContext';
import { ProjectPlanner, type OpenProject } from './projectPlanner';
import { PROJECT_PLANNER_FOLDER, RoutedPlannerStore } from './routedStore';
import { PlannerService, userCtx } from './service';
import { ProjectStore } from '../projectStore';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'sample-project');
let tmp: string;
beforeAll(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-pplan-')); });
afterAll(async () => {
  const walk = async (d: string): Promise<void> => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f); else await fs.chmod(f, 0o666).catch(() => undefined); } };
  await walk(tmp);
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const user = userCtx();
let n = 0;

async function makeProject(name: string, withFiles = false): Promise<ProjectStore> {
  const store = new ProjectStore(path.join(tmp, `proj${++n}`));
  await store.create(name);
  if (withFiles) {
    const a = (await store.importFile(path.join(FIXTURES, 'photocraft-smoke.png'))).asset;
    await store.addDerivedFile(await copyToWork(store, 'photocraft-smoke.png', 'v1.png', 'one'), { name: 'photocraft-smoke-v1.png', parentId: a.id, provenance: { origin: 'generated', source: 'test edit' } });
    await store.importFile(path.join(FIXTURES, 'tone-a440.wav'));
  }
  return store;
}
async function copyToWork(store: ProjectStore, from: string, to: string, salt: string): Promise<string> {
  const dest = path.join(await store.workDir(), to);
  await fs.writeFile(dest, Buffer.concat([await fs.readFile(path.join(FIXTURES, from)), Buffer.from(salt)]));
  return dest;
}

/** One app-wide service over a shared folder, with a switchable "open project" (as in the app). */
function rig() {
  const shared = path.join(tmp, `shared${++n}`);
  const store = new RoutedPlannerStore(shared);
  const svc = new PlannerService(store);
  let open: OpenProject | null = null;
  const pp = new ProjectPlanner(svc, store, async () => open);
  const openProject = async (s: ProjectStore) => { const m = await s.loadManifest(); open = { id: m.id, name: m.name, root: s.root, store: s }; };
  return { shared, store, svc, pp, openProject, close: () => { open = null; } };
}

describe('a plan belongs to its project and lives in its folder', () => {
  it('has no plan until one is started; the plan is saved inside that project\'s folder with the project identity', async () => {
    const r = rig();
    const a = await makeProject('Dragon poster');
    await r.openProject(a);
    expect(await r.pp.forProject()).toMatchObject({ project: { name: 'Dragon poster' }, plan: null, older: [] });
    const plan = await r.pp.startPlan();
    expect(plan.title).toBe('Dragon poster');
    expect(plan.ownerProjectId).toBe((await a.loadManifest()).id);
    const file = path.join(a.root, PROJECT_PLANNER_FOLDER, 'projects', plan.id, 'project.json');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).ownerProjectId).toBe(plan.ownerProjectId);
    await expect(fs.readdir(path.join(r.shared, 'projects'))).rejects.toThrow(); // nothing went to the shared folder
    await expect(r.pp.startPlan()).rejects.toThrow(/already has a plan/);
  });

  it('keeps each project\'s plan apart and restores it when the project is opened again', async () => {
    const r = rig();
    const a = await makeProject('A');
    const b = await makeProject('B');
    await r.openProject(a); const pa = await r.pp.startPlan({ goal: 'goal A' });
    await r.svc.addItem(user, pa.id, { type: 'requirement', title: 'Rule for A' });
    await r.openProject(b); expect((await r.pp.forProject()).plan).toBeNull();
    const pb = await r.pp.startPlan({ goal: 'goal B' });
    await expect(r.svc.getProject(user, pa.id)).rejects.toMatchObject({ code: 'not_found' }); // A's plan is not reachable from B
    await r.openProject(a);
    const back = (await r.pp.forProject()).plan!;
    expect(back.id).toBe(pa.id);
    expect(back.goal).toBe('goal A');
    expect(back.items.map((i) => i.title)).toEqual(['Rule for A']);
    expect((await r.svc.listProjects(user)).map((s) => s.id)).toEqual([pa.id]);
    await r.openProject(b);
    expect((await r.pp.forProject()).plan!.id).toBe(pb.id);
  });

  it('a duplicated project takes its copy of the plan with it, and the copy owns it', async () => {
    const r = rig();
    const a = await makeProject('Original');
    await r.openProject(a);
    const plan = await r.pp.startPlan({ goal: 'g' });
    await r.svc.addTask(user, plan.id, { title: 'Chunk 1' });
    const copyRoot = path.join(tmp, `dup${++n}`);
    await fs.cp(a.root, copyRoot, { recursive: true });
    const dup = new ProjectStore(copyRoot);
    await dup.regenerateIdentity('Copy');
    await r.openProject(dup);
    const state = await r.pp.forProject();
    expect(state.plan!.tasks.map((t) => t.title)).toEqual(['Chunk 1']);
    expect(state.plan!.ownerProjectId).toBe((await dup.loadManifest()).id);
    expect(state.plan!.ownerProjectId).not.toBe((await a.loadManifest()).id);
  });
});

describe('older plans (made before projects held their own)', () => {
  it('are listed apart, keep working, and can be copied into a project without changing the original', async () => {
    const r = rig();
    // an older plan lives in the shared folder, with no owner
    const legacy = await r.svc.createProject(user, { title: 'Old plan', goal: 'old' });
    await r.svc.addTask(user, legacy.id, { title: 'Old chunk' });
    const originalBytes = await fs.readFile(path.join(r.shared, 'projects', legacy.id, 'project.json'));
    const p = await makeProject('Project');
    await r.openProject(p);
    const state = await r.pp.forProject();
    expect(state.plan).toBeNull();
    expect(state.older.map((s) => [s.id, s.inThisProject])).toEqual([[legacy.id, false]]);
    expect((await r.svc.getProject(user, legacy.id)).title).toBe('Old plan'); // still usable as before
    const attached = await r.pp.attachOlder(legacy.id);
    expect(attached.importedFrom).toBe(legacy.id);
    expect(attached.ownerProjectId).toBe((await p.loadManifest()).id);
    expect(attached.tasks.map((t) => t.title)).toEqual(['Old chunk']);
    expect(Buffer.compare(await fs.readFile(path.join(r.shared, 'projects', legacy.id, 'project.json')), originalBytes)).toBe(0); // the original is untouched
    expect((await r.pp.forProject()).older).toEqual([]); // no longer offered
    await expect(r.pp.attachOlder(legacy.id)).resolves.toBeTruthy();
    const other = await makeProject('Other');
    await r.openProject(other);
    expect((await r.pp.forProject()).older.map((s) => s.id)).toEqual([legacy.id]); // other projects still see the older plan
  });

  it('a project that already has a plan does not take a second one', async () => {
    const r = rig();
    const legacy = await r.svc.createProject(user, { title: 'Old' });
    const p = await makeProject('P');
    await r.openProject(p);
    await r.pp.startPlan();
    await expect(r.pp.attachOlder(legacy.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the plan approved on Home goes into the open project\'s plan as suggestions instead of starting another plan', async () => {
    const r = rig();
    const p = await makeProject('Home project');
    await r.openProject(p);
    const plan = await r.pp.startPlan({ goal: 'g' });
    const res = await r.svc.createFromHomePlan(user, { title: 'ignored', goal: 'g2', steps: ['Do A', 'Do B'], questions: [] });
    expect(res.project.id).toBe(plan.id);
    expect(res.proposal.status).toBe('pending');
    expect((await r.svc.listProjects(user)).length).toBe(1);
  });
});

describe('where you left off, and the conversation', () => {
  it('remembers the chunk worked on last, without changing the accepted plan', async () => {
    const r = rig();
    await r.openProject(await makeProject('P'));
    const plan = await r.pp.startPlan();
    const t1 = await r.svc.addTask(user, plan.id, { title: 'First chunk' });
    const t2 = await r.svc.addTask(user, plan.id, { title: 'Second chunk' });
    const before = await r.svc.getProject(user, plan.id);
    expect(before.lastActive).toBeUndefined();
    await r.svc.touchTask(user, plan.id, t2.id, 'opened');
    const after = await r.svc.getProject(user, plan.id);
    expect(after.lastActive).toMatchObject({ taskId: t2.id, title: 'Second chunk', what: 'opened' });
    expect(after.planRevision).toBe(before.planRevision);
    await r.svc.touchTask(user, plan.id, t2.id, 'opened'); // the same thing again within ten minutes writes nothing new
    expect((await r.svc.getProject(user, plan.id)).revision).toBe(after.revision);
    await r.svc.prepareSend(user, plan.id, { taskIds: [t1.id] }); // sending a chunk to an AI counts too
    expect((await r.svc.getProject(user, plan.id)).lastActive).toMatchObject({ taskId: t1.id, what: 'sent to an AI' });
    expect((await r.pp.forProject()).plan!.lastActive!.taskId).toBe(t1.id); // and it is there when the project is opened again
  });

  it('keeps the planning conversation with the plan, and a damaged file is just an empty conversation', async () => {
    const r = rig();
    const p = await makeProject('P');
    await r.openProject(p);
    const plan = await r.pp.startPlan();
    expect(await r.store.readChat(plan.id)).toEqual({ messages: [] });
    await r.store.writeChat(plan.id, { messages: [{ role: 'user', text: 'Help me plan' }, { role: 'assistant', text: 'Sure. What is it for?' }], provider: 'claude', model: 'm' });
    const back = await r.store.readChat(plan.id);
    expect(back.messages.map((m) => m.text)).toEqual(['Help me plan', 'Sure. What is it for?']);
    expect(back).toMatchObject({ provider: 'claude', model: 'm' });
    expect(await fs.readFile(path.join(p.root, PROJECT_PLANNER_FOLDER, 'projects', plan.id, 'chat.json'), 'utf8')).toContain('Help me plan');
    await fs.writeFile(path.join(p.root, PROJECT_PLANNER_FOLDER, 'projects', plan.id, 'chat.json'), '{not json');
    expect(await r.store.readChat(plan.id)).toEqual({ messages: [] });
  });
});

describe('looking at what a project already holds', () => {
  it('summarises the files, versions and saved brief, offers the saved goal and description, and marks nothing as done', async () => {
    const p = await makeProject('Island art', true);
    await p.setMeta({ brief: 'A tropical island illustration for a travel poster', objective: 'Finish the island poster' });
    await fs.writeFile(path.join(await p.exportsDir(), 'poster.pdf'), 'x');
    const f = await analyzeProject(p);
    expect(f.stats).toMatchObject({ files: 3, originals: 2, versions: 1, exports: 1 });
    expect(f.lines.join(' ')).toMatch(/3 files/);
    expect(f.lines.join(' ')).toMatch(/1 saved version/);
    expect(f.lines.join(' ')).toMatch(/saved brief/);
    expect(f.lines.join(' ')).toMatch(/none of this is marked as done/);
    expect(f.changes.some((c) => c.op === 'set_brief' && c.patch.goal === 'Finish the island poster')).toBe(true);
    expect(f.changes.some((c) => c.op === 'set_brief' && c.patch.description?.startsWith('A tropical island'))).toBe(true);
    expect(f.changes.filter((c) => c.op === 'add_task')).toEqual([]); // a file existing never means a chunk is done
    expect(f.aiContext.join('\n')).toContain('Island art');
    expect(f.aiContext.join('\n')).not.toContain(p.root); // names and counts, never locations
  });

  it('says plainly when there is nothing yet, and does not assume a brief or history that is not there', async () => {
    const f = await analyzeProject(await makeProject('Blank'));
    expect(f.lines[0]).toMatch(/Nothing has been made/);
    expect(f.changes.filter((c) => c.op === 'set_brief')).toEqual([]);
    expect(f.stats.files).toBe(0);
  });

  it('adds only the ticked findings, as accepted by the owner, and never touches the project files', async () => {
    const r = rig();
    const p = await makeProject('Island art', true);
    await p.setMeta({ objective: 'Finish the island poster' });
    await r.openProject(p);
    const plan = await r.pp.startPlan();
    const findings = await r.pp.analyze();
    const snapshot = async () => (await fs.readdir(p.root, { recursive: true })).filter((f) => !f.startsWith(PROJECT_PLANNER_FOLDER)).sort();
    const sha = async () => (await fs.readFile(path.join(p.root, 'project.json'))).toString();
    const filesBefore = await snapshot(); const manifestBefore = await sha();
    const goal = findings.changes.findIndex((c) => c.op === 'set_brief');
    await r.pp.applyFindings(plan.id, [goal]);
    const after = await r.svc.getProject(user, plan.id);
    expect(after.goal).toBe('Finish the island poster');
    expect(after.description).toBe(''); // the description was not ticked, so it was not added
    expect(after.tasks).toEqual([]);
    expect(await snapshot()).toEqual(filesBefore);
    expect(await sha()).toBe(manifestBefore); // the project's own data is exactly as it was
    await expect(r.pp.applyFindings(plan.id, [])).rejects.toThrow(/Tick at least one/);
  });

  it('refuses to add findings to a plan that belongs to another project', async () => {
    const r = rig();
    const a = await makeProject('A'); const b = await makeProject('B');
    await r.openProject(a); const planA = await r.pp.startPlan();
    await r.openProject(b);
    await expect(r.pp.applyFindings(planA.id, [0])).rejects.toBeTruthy(); // not even reachable from B
  });

  it('tells the planning AI what the project holds only for the open project\'s own plan', async () => {
    const r = rig();
    const p = await makeProject('Island art', true);
    await r.openProject(p);
    const plan = await r.pp.startPlan();
    expect((await r.pp.chatContext(plan))!.join('\n')).toMatch(/Island art/);
    const legacy = await r.svc.createProject(user, { title: 'Old' }).catch(() => null);
    if (legacy) expect(await r.pp.chatContext({ ...legacy, ownerProjectId: 'someone-else' })).toBeUndefined();
  });
});
