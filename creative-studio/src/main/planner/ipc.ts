// Main-side handlers for the Planner workspace. Every call runs as the user (the only caller that may edit the plan or review
// results). One channel with named methods keeps the preload small; the service validates and enforces the rules.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import type { PlanAsset } from '@shared/planner';
import type { PackageView, PlannerConnectionInfo } from '@shared/plannerApi';
import { defaultPlannerDir } from './dir';
import { chatSystemPrompt, CHAT_PROVIDER_IDS, MAX_CHAT_MESSAGE_CHARS, MAX_CHAT_MESSAGES } from '@shared/plannerChat';
import { type ChatDeps, PlannerChat } from './chat';
import { ProjectPlanner, type OpenProject } from './projectPlanner';
import { RoutedPlannerStore } from './routedStore';
import { PlannerService, userCtx } from './service';

export const PLANNER_CALL = 'planner:call';

/** `dir` is the older, shared planner folder; each project keeps its own plan in its own folder (see routedStore.ts). */
export function createPlanner(userDataDir: string): { service: PlannerService; store: RoutedPlannerStore; dir: string } {
  const dir = process.env.CREATECRAFT_PLANNER_DIR ? defaultPlannerDir() : path.join(userDataDir, 'planner');
  const store = new RoutedPlannerStore(dir);
  return { service: new PlannerService(store), store, dir };
}

function bundleInfo() {
  const packaged = app.isPackaged;
  const bundlePath = packaged ? path.join(process.resourcesPath, 'planner-mcp.cjs') : path.join(app.getAppPath(), 'out', 'planner-mcp.cjs');
  return { packaged, bundlePath, found: fsSync.existsSync(bundlePath) };
}

export function connectionInfo(dir: string): PlannerConnectionInfo {
  const b = bundleInfo();
  const command = b.packaged ? process.execPath : 'node';
  const env = b.packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const mk = (id: 'brainstorm' | 'executor', label: string, scopes: string[], actor: string, kind: string) => {
    const args = [b.bundlePath, '--dir', dir, '--scopes', scopes.join(','), '--actor', actor, '--kind', kind];
    const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    const name = `createcraft-planner-${id}`;
    const envFlags = Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(' ');
    return {
      id, label, scopes, actor,
      claudeCode: `claude mcp add --transport stdio --scope user ${envFlags ? `${envFlags} ` : ''}${name} -- ${[command, ...args].map(q).join(' ')}`,
      json: JSON.stringify({ mcpServers: { [name]: { command, args, ...(Object.keys(env).length ? { env } : {}) } } }, null, 2),
      geminiCli: JSON.stringify({ mcpServers: { [name]: { command, args, ...(Object.keys(env).length ? { env } : {}) } } }, null, 2),
    };
  };
  return {
    folder: dir, bundleFound: b.found, bundlePath: b.bundlePath,
    profiles: [
      mk('brainstorm', 'Brainstorming connection: can read the plan and suggest changes. Cannot start or finish work.', ['read', 'propose'], 'Brainstorm AI', 'other'),
      mk('executor', 'Executor connection: can read packages, claim tasks and report. Cannot change the plan.', ['read', 'execute'], 'Claude Code', 'claude-code'),
    ],
    http: `Remote clients (ChatGPT, the Gemini app) cannot reach a program on this computer. A local HTTP mode exists: run "${[command, b.bundlePath].map((s) => (/\s/.test(s) ? `"${s}"` : s)).join(' ')}" --http --port 8765 --token-file <file with a random token of 24+ characters> --scopes read,propose. It listens on 127.0.0.1 only and requires "Authorization: Bearer <token>". Making it reachable from the internet (a tunnel or your own HTTPS host) is your explicit choice and is not set up by OmniCandy.`,
  };
}

interface Deps { service: PlannerService; store: RoutedPlannerStore; dir: string; project: () => Promise<OpenProject | null>; isTrustedSender: (e: IpcMainInvokeEvent) => boolean; window: () => BrowserWindow | null; chat?: ChatDeps }

export function registerPlannerIpc(d: Deps): void {
  const u = userCtx();
  const s = d.service;
  const sha = async (p: string) => createHash('sha256').update(await fs.readFile(p)).digest('hex');
  const win = () => d.window() ?? undefined;
  const chat = d.chat ? new PlannerChat(d.chat) : null;
  const needChat = () => { if (!chat) throw new Error('The planning chat is not available.'); return chat; };
  const provider = z.enum(CHAT_PROVIDER_IDS);
  const chatReq = z.object({
    projectId: z.string().max(60), provider, model: z.string().min(1).max(80),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().min(1).max(MAX_CHAT_MESSAGE_CHARS) })).min(1).max(MAX_CHAT_MESSAGES),
    mode: z.enum(['talk', 'chunks']).optional(),
  });
  // Which project is open decides where plans are read from and written to (see projectPlanner.ts).
  const pp = new ProjectPlanner(s, d.store, d.project);
  const sync = () => pp.sync();
  const methods: Record<string, (...a: any[]) => unknown> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    forProject: () => pp.forProject(),
    startPlan: (input?: { title?: string; goal?: string }) => pp.startPlan(input),
    analyze: () => pp.analyze(),
    applyFindings: (id: string, only: number[]) => pp.applyFindings(id, only),
    touchTask: async (id: string, taskId: string, what: string) => { await sync(); await s.touchTask(u, id, taskId, String(what).slice(0, 80)); },
    attachOlder: (id: string) => pp.attachOlder(id),
    chatLoad: async (id: string) => { await sync(); return d.store.readChat(id); },
    chatSave: async (id: string, chat: { messages: Array<{ role: 'user' | 'assistant'; text: string }>; provider?: string; model?: string }) => { await sync(); await d.store.writeChat(id, chat); },
    list: () => s.listProjects(u),
    get: (id: string) => s.getProject(u, id),
    activity: (id: string) => s.activity(u, id),
    assetHealth: (id: string) => s.assetHealth(u, id),
    create: (input: never) => s.createProject(u, input),
    update: (id: string, patch: never, rev?: number) => s.updateProject(u, id, patch, rev),
    addItem: (id: string, i: never) => s.addItem(u, id, i),
    updateItem: (id: string, itemId: string, patch: never, rev?: number) => s.updateItem(u, id, itemId, patch, rev),
    setItemStatus: (id: string, itemId: string, st: never, opts?: never) => s.setItemStatus(u, id, itemId, st, opts),
    removeItem: (id: string, itemId: string) => s.removeItem(u, id, itemId),
    addTask: (id: string, t: never) => s.addTask(u, id, t),
    updateTask: (id: string, taskId: string, patch: never, rev?: number) => s.updateTask(u, id, taskId, patch, rev),
    setTaskStatus: (id: string, taskId: string, st: never, note?: string, rev?: number) => s.setTaskStatus(u, id, taskId, st, note, rev),
    removeTask: (id: string, taskId: string) => s.removeTask(u, id, taskId),
    releaseClaim: (id: string, taskId: string) => s.releaseClaim(u, id, taskId),
    addAsset: (id: string, a: never) => s.addAsset(u, id, a),
    pickAssets: async (id: string, role: PlanAsset['role']) => {
      const r = await dialog.showOpenDialog(win() as BrowserWindow, { title: 'Link files to the plan (they are not copied)', properties: ['openFile', 'multiSelections'] });
      const out: PlanAsset[] = [];
      for (const p of r.canceled ? [] : r.filePaths) out.push(await s.addAsset(u, id, { role, title: path.basename(p), source: 'file', path: p, sha256: await sha(p).catch(() => '') }));
      return out;
    },
    removeAsset: (id: string, aid: string) => s.removeAsset(u, id, aid),
    addMilestone: async (id: string, m: never) => { await s.addMilestone(u, id, m); },
    removeMilestone: (id: string, mid: string) => s.removeMilestone(u, id, mid),
    decideProposal: async (id: string, pid: string, accept: boolean, only?: number[]) => { await s.decideProposal(u, id, pid, accept, only); },
    createPackage: (id: string, req: never) => s.createPackage(u, id, req),
    prepareSend: (id: string, req: never) => s.prepareSend(u, id, req),
    importSuggestions: (id: string, req: never) => s.importSuggestions(u, id, req),
    createFromHomePlan: (input: never) => s.createFromHomePlan(u, input),
    cancelPackage: (id: string, pkgId: string) => s.cancelPackage(u, id, pkgId),
    packageView: async (id: string, pkgId: string): Promise<PackageView> => { const v = await s.getPackage(u, id, pkgId); return { ...v, json: JSON.stringify(v.package, null, 2) }; },
    savePackage: async (id: string, pkgId: string) => {
      const v = await s.getPackage(u, id, pkgId);
      const r = await dialog.showSaveDialog(win() as BrowserWindow, { title: 'Save execution package', defaultPath: `execution-package-${v.package.number}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, v.markdown, 'utf8');
      await fs.writeFile(r.filePath.replace(/\.md$/i, '') + '.json', JSON.stringify(v.package, null, 2), 'utf8');
      return r.filePath;
    },
    importReport: (id: string, req: never) => s.importReport(u, id, req),
    reviewReport: (id: string, rid: string, decision: never, note?: string, ack?: boolean) => s.reviewReport(u, id, rid, decision, note, { acknowledgeOutdated: !!ack }),
    rawReport: (id: string, rid: string) => s.rawReport(u, id, rid),
    exportProject: async (id: string, mode: 'reference' | 'bundle') => {
      const p = await s.getProject(u, id);
      const r = await dialog.showSaveDialog(win() as BrowserWindow, { title: 'Export project plan', defaultPath: `${p.title.replace(/[^\w\- ]/g, '_')}.plannerexport.zip`, filters: [{ name: 'Planner export', extensions: ['zip'] }] });
      if (r.canceled || !r.filePath) return null;
      await fs.writeFile(r.filePath, await s.exportProject(u, id, mode));
      return r.filePath;
    },
    importProject: async () => {
      const r = await dialog.showOpenDialog(win() as BrowserWindow, { title: 'Import a planner export', properties: ['openFile'], filters: [{ name: 'Planner export', extensions: ['zip'] }] });
      const f = r.filePaths[0];
      if (r.canceled || !f) return null;
      return s.importProject(u, await fs.readFile(f));
    },
    // The planning chat: only when the owner presses a button. It reads the plan (a short summary goes to the chosen AI) and writes nothing.
    chatProviders: () => needChat().providers(),
    chatModels: (p: unknown) => needChat().models(provider.parse(p)),
    chat: async (req: unknown) => {
      const r = chatReq.parse(req);
      const plan = await s.getProject(u, r.projectId);
      // What the project already contains (names and counts only) is part of what the AI is told, when this is the open project's plan.
      const context = await pp.chatContext(plan);
      return needChat().reply({ system: chatSystemPrompt(plan, context, r.mode ?? 'talk'), provider: r.provider, model: r.model, messages: r.messages });
    },
    connectionInfo: async () => { await sync(); return connectionInfo(d.store.projectRoot ?? d.dir); },
    openFolder: async () => { await sync(); const dir = d.store.projectRoot ?? d.dir; await fs.mkdir(dir, { recursive: true }); await shell.openPath(dir); },
  };
  ipcMain.handle(PLANNER_CALL, async (e, ...raw) => {
    if (!d.isTrustedSender(e)) throw new Error('Untrusted sender.');
    const [method, args] = z.tuple([z.string(), z.array(z.unknown())]).parse(raw);
    const fn = Object.prototype.hasOwnProperty.call(methods, method) ? methods[method] : undefined;
    if (!fn) throw new Error(`Unknown planner call ${method}.`);
    await sync();
    return fn(...args);
  });
}
