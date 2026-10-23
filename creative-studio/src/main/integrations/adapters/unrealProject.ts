// Creating and starting Unreal projects, so OmniCandy can set a project up from nothing (project.create, editor.launch, project.list).
//
// project.create does what Unreal's own "New Project" does for a template, using the template's own rules (Config/TemplateDefs.ini):
//   * copy the template folder, skipping the folders and files it says to ignore,
//   * replace the template's name by the project's name in its config and source files,
//   * copy the shared content packs it names (characters, input, level prototyping...) from Templates/TemplateResources,
//   * write <Name>.uproject for this engine version.
// On top of that it turns on the two MCP plugins and Auto Start Server, which are what let OmniCandy talk to the editor.
// Nothing is claimed until the result has been read back: the .uproject, the plugin entries, the start-up map and every copied file.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AdapterError } from '../sdk';

export const TEMPLATES: Record<string, { folder: string; label: string }> = {
  third_person: { folder: 'TP_ThirdPersonBP', label: 'Third Person (Blueprint)' },
  first_person: { folder: 'TP_FirstPersonBP', label: 'First Person (Blueprint)' },
  top_down: { folder: 'TP_TopDownBP', label: 'Top Down (Blueprint)' },
  vehicle: { folder: 'TP_VehicleAdvBP', label: 'Vehicle (Blueprint)' },
  blank: { folder: 'TP_BlankBP', label: 'Blank (Blueprint)' },
};

export const MCP_PLUGINS = ['ModelContextProtocol', 'AllToolsets'] as const;
const RESERVED_NAMES = new Set(['engine', 'game', 'content', 'config', 'source', 'binaries', 'intermediate', 'saved', 'plugins', 'templates', 'developer', 'editor', 'runtime']);
const REWRITE_EXTS = new Set(['.ini', '.cpp', '.h', '.cs']);

/** <root>/Engine/Binaries/Win64/UnrealEditor.exe -> <root> */
export const engineRootOf = (exePath: string): string => path.resolve(path.dirname(exePath), '..', '..', '..');

/** The installed engine's own version ("5.8.4"), from Engine/Build/Build.version: the one source that is always there. */
export async function engineVersionOf(engineRoot: string): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(engineRoot, 'Engine', 'Build', 'Build.version'), 'utf8')) as { MajorVersion?: number; MinorVersion?: number; PatchVersion?: number };
    return typeof j.MajorVersion === 'number' ? `${j.MajorVersion}.${j.MinorVersion ?? 0}.${j.PatchVersion ?? 0}` : null;
  } catch { return null; }
}

export function validateProjectName(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name)) return 'The project name must start with a letter and use only letters, digits and underscores (up to 40 characters).';
  if (RESERVED_NAMES.has(name.toLowerCase()) || /^TP_/i.test(name)) return `"${name}" is a name Unreal reserves; choose another.`;
  return undefined;
}

/** Where new projects go by default: next to the user's other Unreal projects (their Documents folder, OneDrive's when it holds it). */
export async function defaultProjectsDir(): Promise<string> {
  const home = os.homedir();
  for (const base of [path.join(home, 'OneDrive', 'Documents'), path.join(home, 'Documents')]) {
    if (await fs.stat(base).then((s) => s.isDirectory(), () => false)) return path.join(base, 'Unreal Projects');
  }
  return path.join(home, 'Unreal Projects');
}

export interface TemplateRules { foldersToIgnore: string[]; filesToIgnore: string[]; packs: string[] }
/** Reads the rules that matter from Config/TemplateDefs.ini (commented-out lines are not rules). */
export function parseTemplateDefs(text: string, templateName: string): TemplateRules {
  const rules: TemplateRules = { foldersToIgnore: [], filesToIgnore: [], packs: [] };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    let m = /^FoldersToIgnore=(.+)$/.exec(line);
    if (m) { rules.foldersToIgnore.push(m[1]!.replace(/"/g, '').trim()); continue; }
    m = /^FilesToIgnore=(.+)$/.exec(line);
    if (m) { rules.filesToIgnore.push(m[1]!.replace(/"/g, '').trim().replace(/%TEMPLATENAME%/g, templateName)); continue; }
    m = /^SharedContentPacks=\(MountName="([A-Za-z0-9_]+)"/.exec(line);
    if (m && !rules.packs.includes(m[1]!)) rules.packs.push(m[1]!);
  }
  return rules;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

async function walk(dir: string, out: string[] = [], base = dir): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, base); else if (e.isFile()) out.push(toPosix(path.relative(base, p)));
  }
  return out;
}

/** Template name -> project name in the three spellings Unreal's own rules cover. */
export function renameInText(text: string, from: string, to: string): string {
  return text.split(from.toUpperCase()).join(to.toUpperCase()).split(from.toLowerCase()).join(to.toLowerCase()).replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to);
}

export interface CreateResult { projectDir: string; uproject: string; template: string; files: number; bytes: number; plugins: string[]; startupMap: string | null; packs: string[] }

export async function createProject(o: {
  engineRoot: string; engineVersion: string | null; template: string; name: string; location: string;
  progress: (stage: string, fraction?: number) => void;
}): Promise<CreateResult> {
  const nameProblem = validateProjectName(o.name);
  if (nameProblem) throw new AdapterError('invalid-params', nameProblem);
  const t = TEMPLATES[o.template];
  if (!t) throw new AdapterError('invalid-params', `template must be one of: ${Object.keys(TEMPLATES).join(', ')}.`);
  if (!path.isAbsolute(o.location)) throw new AdapterError('invalid-params', 'location must be a full folder path, or empty for your Unreal Projects folder.');
  const root = path.resolve(o.engineRoot);
  const location = path.resolve(o.location);
  const rel = path.relative(root, location);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new AdapterError('invalid-params', 'A project cannot be created inside the Unreal Engine installation folder.');
  const templateDir = path.join(root, 'Templates', t.folder);
  const defsText = await fs.readFile(path.join(templateDir, 'Config', 'TemplateDefs.ini'), 'utf8').catch(() => null);
  const tplUproject = await fs.readFile(path.join(templateDir, `${t.folder}.uproject`), 'utf8').catch(() => null);
  if (defsText === null || tplUproject === null) throw new AdapterError('missing-app', `Unreal's ${t.label} template was not found under ${path.join(root, 'Templates')}.`);
  const rules = parseTemplateDefs(defsText, t.folder);

  const projectDir = path.join(location, o.name);
  if (await fs.stat(projectDir).then(() => true, () => false)) throw new AdapterError('invalid-params', `${projectDir} already exists. Choose another name or location; nothing was written.`);
  await fs.mkdir(location, { recursive: true });

  // what to copy, by the template's own rules
  const ignoreFolders = new Set(rules.foldersToIgnore.map((f) => f.toLowerCase()));
  const ignoreFiles = new Set(rules.filesToIgnore.map((f) => toPosix(f).toLowerCase()));
  const plan: Array<{ from: string; rel: string }> = [];
  for (const r of await walk(templateDir)) {
    const top = r.split('/')[0]!.toLowerCase();
    if (r.includes('/') && ignoreFolders.has(top)) continue;
    if (ignoreFiles.has(r.toLowerCase())) continue;
    plan.push({ from: path.join(templateDir, r), rel: r });
  }
  const packRoot = path.join(root, 'Templates', 'TemplateResources', 'High');
  for (const pack of rules.packs) {
    const src = path.join(packRoot, pack);
    if (!(await fs.stat(src).then((s) => s.isDirectory(), () => false))) throw new AdapterError('missing-app', `The template's shared content "${pack}" is missing from ${packRoot}. Repair the Unreal installation.`);
    for (const r of await walk(src)) plan.push({ from: path.join(src, r), rel: `Content/${pack}/${r}` });
  }

  const written: Array<{ rel: string; bytes: number; rewritten: boolean }> = [];
  try {
    await fs.mkdir(projectDir, { recursive: true });
    for (const [i, p] of plan.entries()) {
      if (i % 50 === 0) o.progress(`Copying the template (${i} of ${plan.length})`, 0.1 + 0.7 * (i / plan.length));
      const to = path.join(projectDir, ...p.rel.split('/'));
      await fs.mkdir(path.dirname(to), { recursive: true });
      const ext = path.extname(p.rel).toLowerCase();
      let rewritten = false;
      if (REWRITE_EXTS.has(ext)) {
        const buf = await fs.readFile(p.from);
        if (!buf.includes(0)) { // plain text only (a UTF-16 file is copied as it is)
          const txt = buf.toString('utf8');
          const out = renameInText(txt, t.folder, o.name);
          rewritten = out !== txt;
          await fs.writeFile(to, out);
        } else await fs.writeFile(to, buf);
      } else await fs.copyFile(p.from, to);
      written.push({ rel: p.rel, bytes: (await fs.stat(to)).size, rewritten });
    }
    o.progress('Setting up the project', 0.85);
    // the project file, for this engine, with the two plugins OmniCandy needs
    const up = JSON.parse(tplUproject) as { EngineAssociation?: string; Plugins?: Array<{ Name: string; Enabled: boolean; [k: string]: unknown }>; [k: string]: unknown };
    const version = o.engineVersion ?? await engineVersionOf(root);
    if (!version) throw new AdapterError('missing-app', `Could not read the engine version from ${path.join(root, 'Engine', 'Build', 'Build.version')}.`);
    up.EngineAssociation = version.split('.').slice(0, 2).join('.');
    up.Plugins = (up.Plugins ?? []).filter((p) => !(MCP_PLUGINS as readonly string[]).includes(p.Name));
    for (const name of MCP_PLUGINS) up.Plugins.push({ Name: name, Enabled: true });
    const uproject = path.join(projectDir, `${o.name}.uproject`);
    await fs.writeFile(uproject, JSON.stringify(up, null, '\t') + '\n');
    // Auto Start Server for this project (a default the user can still change in Editor Preferences)
    const cfg = path.join(projectDir, 'Config', 'DefaultEditorPerProjectUserSettings.ini');
    const existing = await fs.readFile(cfg, 'utf8').catch(() => '');
    await fs.mkdir(path.dirname(cfg), { recursive: true });
    await fs.writeFile(cfg, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}\n[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]\nbAutoStartServer=True\n`);
    // this file was changed on purpose after it was copied: its final size is what is checked below
    const cfgRel = 'Config/DefaultEditorPerProjectUserSettings.ini';
    const cfgSize = (await fs.stat(cfg)).size;
    const known = written.find((w) => w.rel === cfgRel);
    if (known) { known.bytes = cfgSize; known.rewritten = true; } else written.push({ rel: cfgRel, bytes: cfgSize, rewritten: true });

    // read it all back
    o.progress('Checking the new project', 0.93);
    const back = JSON.parse(await fs.readFile(uproject, 'utf8')) as { Plugins?: Array<{ Name: string; Enabled: boolean }> };
    for (const name of MCP_PLUGINS) if (!back.Plugins?.some((p) => p.Name === name && p.Enabled)) throw new AdapterError('verification-failed', `${name} is not enabled in the new ${o.name}.uproject.`);
    if (!(await fs.readFile(cfg, 'utf8')).includes('bAutoStartServer=True')) throw new AdapterError('verification-failed', 'Auto Start Server was not written to the project settings.');
    for (const w of written) {
      const st = await fs.stat(path.join(projectDir, ...w.rel.split('/'))).catch(() => null);
      if (!st || st.size !== w.bytes) throw new AdapterError('verification-failed', `${w.rel} is missing or changed after copying.`);
    }
    const ini = await fs.readFile(path.join(projectDir, 'Config', 'DefaultEngine.ini'), 'utf8').catch(() => '');
    if (new RegExp(t.folder, 'i').test(ini)) throw new AdapterError('verification-failed', `DefaultEngine.ini still names the template (${t.folder}).`);
    const map = /^EditorStartupMap=(\/Game\/[^.\s]+)/m.exec(ini)?.[1] ?? null;
    if (map && !(await fs.stat(path.join(projectDir, 'Content', ...map.slice('/Game/'.length).split('/')) + '.umap').then((s) => s.isFile(), () => false))) {
      throw new AdapterError('verification-failed', `The project's start-up map ${map} was not copied.`);
    }
    return { projectDir, uproject, template: o.template, files: written.length + 1, bytes: written.reduce((n, w) => n + w.bytes, 0), plugins: [...MCP_PLUGINS], startupMap: map, packs: rules.packs };
  } catch (e) {
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => undefined); // never leave a half-made project behind
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------------- recorded projects

export interface ProjectRecord { name: string; uproject: string; template: string; createdAt: string }
const projectsFile = (workDir: string) => path.join(workDir, 'projects.json');

export async function readProjects(workDir: string): Promise<ProjectRecord[]> {
  try {
    const j = JSON.parse(await fs.readFile(projectsFile(workDir), 'utf8')) as { projects?: ProjectRecord[] };
    return (j.projects ?? []).filter((p) => p && typeof p.name === 'string' && typeof p.uproject === 'string');
  } catch { return []; }
}
export async function recordProject(workDir: string, rec: ProjectRecord): Promise<void> {
  const all = (await readProjects(workDir)).filter((p) => p.name.toLowerCase() !== rec.name.toLowerCase());
  all.push(rec);
  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(projectsFile(workDir), JSON.stringify({ projects: all }, null, 2));
}

/** A project to open: a name recorded by project.create, or the full path of an existing .uproject. */
export async function resolveProject(workDir: string, ref: string): Promise<string> {
  const s = ref.trim();
  if (path.isAbsolute(s)) {
    if (path.extname(s).toLowerCase() !== '.uproject') throw new AdapterError('invalid-params', 'project must be a .uproject file or the name of a project made with project.create.');
    if (!(await fs.stat(s).then((x) => x.isFile(), () => false))) throw new AdapterError('invalid-params', `There is no project file at ${s}.`);
    return s;
  }
  const hit = (await readProjects(workDir)).find((p) => p.name.toLowerCase() === s.toLowerCase());
  if (!hit) throw new AdapterError('invalid-params', `No project named "${s}" was made by OmniCandy. Use project.list, or give the full path of a .uproject file.`);
  if (!(await fs.stat(hit.uproject).then((x) => x.isFile(), () => false))) throw new AdapterError('invalid-params', `The project "${s}" is no longer at ${hit.uproject}.`);
  return hit.uproject;
}

// ---------------------------------------------------------------------------------------------------------------- starting the editor

/** Replaced in tests so no real editor is started. */
export const launchHooks: { start: (exe: string, args: string[]) => ChildProcess } = {
  start: (exe, args) => spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false }),
};
