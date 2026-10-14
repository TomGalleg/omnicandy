// Claude Creative Partner, powered by the Claude Agent SDK (Claude Code as a library) using the
// Claude Code sign-in on this PC — no API key is stored by CreateCraft.
//
// Claude gets NO built-in Claude Code tools (no shell, no file access, no web): `tools: []`,
// `settingSources: []` (ignores the user's Claude Code settings/plugins), and only CreateCraft's own
// in-process tools are allowed. Every tool that changes the document goes through
// LiveTaskController's Claude gate: the shared edit lock (Pause / Take Control stop it), the
// PhotoCraft allowlist, the quick-edit tables, and versioning (saving never overwrites a file).

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CLAUDE_MODELS, type ClaudeChatItem, type ClaudeModelId, type ClaudeState } from '@shared/claude';
import { estimateCost, formatUsd, IMAGE_MODELS, modelById, providerById, type ImageJob } from '@shared/generation';
import type { GenerateResultDto, ProviderStatusDto } from '@shared/ipc';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { presetsFor } from '@shared/deliver';
import type { DeliverQueue } from './deliver';
import type { LiveTaskController } from './liveTask';
import type { ProjectStore } from './projectStore';

const SYSTEM_PROMPT = `You are Claude, the Creative Partner inside CreateCraft, a desktop app where the user edits media in ArtCraft apps: PhotoCraft (photos), VectorCraft (vector art), SoundCraft (audio), FilmCraft (video, on a timeline) and DesignCraft (page layouts) in the Edit tab, LightCraft (photo light and colour) in the Color tab, and EffectCraft (effects and titles on pictures and video) in the Effects tab. The file the user is working on is open in one of these apps, shown inside CreateCraft. get_status tells you which app, and the edits that app offers.

You can only act through the createcraft tools. Start by calling get_status. For visual work, call look_at_document before and after you change something, so you see what you are doing.

One file is open at a time, in one app. To use a different app, open a file in it with open_file and its app (get_status lists every app and the file types it takes). The same photo can go to PhotoCraft (edit), LightCraft (light and colour) or EffectCraft (effects and titles); a video to FilmCraft (timeline: trim, speed, sound, fades) or EffectCraft. To carry your changes from one app to the next, save_version first, then open the saved version (its name is in the save result) in the next app. Opening another file replaces what is open, so save first if the user wants to keep the changes. get_status also shows details of the open file when the app provides them (FilmCraft: the timeline; DesignCraft: the text on the page, which replaceText can change).

Follow the user's direction. You may suggest improvements, but ask before big creative reinterpretations. Work in small steps and say briefly what you changed. If a tool says the user paused you or took control, stop at once and tell them you are waiting. Never claim a change you did not make.

Saving creates a new version in the library; the user's original file is never changed. Save only when the user asks or agrees.

To deliver finished files (JPEG for the web, PDF, MP4, WAV, GIF and so on), use list_export_formats and export_file. Exports go to the project's exports folder (the Deliver tab) and are made from saved library files, never from unsaved changes in the open app. Keep replies short and plain.

You can also create new pictures with generate_image (OpenAI or Google Gemini, using the user's own account). It costs the user money: only generate when they ask for it, keep the count low, and say which model you will use. CreateCraft shows the user the price and asks them to approve every call; if they cancel, accept it and do not ask again unless they bring it up. New images are added to the library as new files; open one with open_file to edit it.`;

const TOOL_NAMES = ['get_status', 'look_at_document', 'apply_edit', 'photocraft_command', 'undo', 'save_version', 'list_files', 'open_file', 'list_image_models', 'generate_image', 'list_export_formats', 'export_file'];

export interface ClaudePartnerDeps {
  live: () => Promise<LiveTaskController>;
  store: () => Promise<ProjectStore>;
  /** Opens a library file in its app inside the Edit tab (same path as the UI). */
  openAsset: (assetId: string, app?: EditorAppId) => Promise<void>;
  emit: (s: ClaudeState) => void;
  /** Claude Code CLI on this PC, used only for `auth status` / `auth login`. */
  cliPath: string;
  workDir: () => Promise<string>;
  /** Same path as the Generate tab: approval dialog in main, then the provider call. */
  generate: (job: ImageJob) => Promise<GenerateResultDto>;
  /** Providers with a saved key (status only, never the key). */
  imageModels: () => Promise<ProviderStatusDto[]>;
  /** The Deliver tab's export queue (same queue, presets and manifest as the UI). */
  deliver: () => Promise<DeliverQueue>;
}

export class ClaudePartner {
  private model: ClaudeModelId = 'claude-opus-5-5';
  private items: ClaudeChatItem[] = [];
  private status: ClaudeState['status'] = 'idle';
  private signedIn: boolean | null = null;
  private costUsd = 0;
  private sessionId: string | null = null;
  private abort: AbortController | null = null;
  private login: ClaudeState['login'] = { stage: 'idle', url: null, message: null };
  private loginPoll: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: ClaudePartnerDeps) {}

  state(): ClaudeState {
    return { status: this.status, model: this.model, items: this.items, signedIn: this.signedIn, costUsd: this.costUsd, login: this.login };
  }

  private publish() { this.d.emit(this.state()); }
  private add(role: ClaudeChatItem['role'], text: string) {
    const last = this.items.at(-1);
    if (role === 'error' && last?.role === 'error' && last.text === text) return; // same error reported twice
    this.items = [...this.items.slice(-199), { id: randomUUID(), role, text, at: new Date().toISOString() }];
    this.publish();
  }

  setModel(m: string) {
    const found = CLAUDE_MODELS.find((x) => x.id === m);
    if (!found) throw new Error('Unknown model.');
    this.model = found.id;
    this.publish();
  }

  reset() {
    if (this.status === 'working') throw new Error('Stop Claude first.');
    this.items = [];
    this.sessionId = null;
    this.publish();
  }

  /** Reads `claude auth status` (never prints or stores credentials). */
  async checkAuth(): Promise<boolean | null> {
    if (!fs.existsSync(this.d.cliPath)) { this.signedIn = null; this.publish(); return null; }
    const out = await new Promise<string>((resolve) => {
      execFile(this.d.cliPath, ['auth', 'status'], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => resolve(String(stdout ?? '')));
    });
    try { this.signedIn = !!(JSON.parse(out) as { loggedIn?: boolean }).loggedIn; } catch { this.signedIn = null; }
    if (this.signedIn && this.status === 'signed-out') this.status = 'idle';
    if (this.signedIn === false) this.status = 'signed-out';
    this.publish();
    return this.signedIn;
  }

  /**
   * Opens Claude Code's own sign-in (`claude auth login`) in a console window. It opens the browser;
   * if the page shows a code, the user pastes it into that window (Claude Code reads it from its own
   * console, so CreateCraft never sees it). CreateCraft polls `claude auth status` until signed in.
   */
  signIn() {
    if (!fs.existsSync(this.d.cliPath)) throw new Error('Claude Code is not installed on this PC.');
    if (/["&|<>^%]/.test(this.d.cliPath)) throw new Error('Unexpected characters in the Claude Code path.');
    spawn('cmd.exe', ['/c', 'start', '"Sign in to Claude"', `"${this.d.cliPath}"`, 'auth', 'login'], {
      detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true,
    }).unref();
    this.login = { stage: 'waiting-code', url: null, message: null };
    this.publish();
    if (this.loginPoll) clearInterval(this.loginPoll);
    const deadline = Date.now() + 15 * 60_000;
    this.loginPoll = setInterval(() => {
      void this.checkAuth().then((ok) => {
        if (ok) {
          clearInterval(this.loginPoll!); this.loginPoll = null;
          this.login = { stage: 'idle', url: null, message: null };
          this.add('activity', 'Signed in to Claude. You can start chatting.');
        } else if (Date.now() > deadline) {
          clearInterval(this.loginPoll!); this.loginPoll = null;
          this.login = { stage: 'failed', url: null, message: 'Sign-in did not finish. Try again.' };
          this.publish();
        }
      });
    }, 3000);
  }

  cancelSignIn() {
    if (this.loginPoll) clearInterval(this.loginPoll);
    this.loginPoll = null;
    this.login = { stage: 'idle', url: null, message: null };
    this.publish();
  }

  stop() {
    this.abort?.abort();
  }

  private async tools() {
    const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    const activity = (t: string) => this.add('activity', t);
    const ctl = await this.d.live();

    return createSdkMcpServer({
      name: 'createcraft',
      version: '0.1.0',
      tools: [
        tool('get_status', 'What is open (file and app), its edit history, whether you may edit (lock), and the edits available for this app with their settings.', {}, async () => {
          try { return text(JSON.stringify(await ctl.statusForClaude(), null, 2)); } catch (e) { return fail(e); }
        }),
        tool('look_at_document', 'Returns a picture of the open document (photos, vector art, layouts, the current video frame or composition) or of the app window (audio), so you can see it.', {}, async () => {
          try {
            const png = await ctl.preview(1024);
            if (!png) return text('No picture is available for this document.');
            activity('Looked at the document');
            return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
          } catch (e) { return fail(e); }
        }),
        tool('apply_edit', 'Applies one of the available edits (see get_status) in the open app. settings uses the keys listed for that edit; omit a key to use its default.', {
          edit_id: z.string().max(64),
          settings: z.record(z.string().max(64), z.union([z.number(), z.string().max(200)])).optional(),
        }, async ({ edit_id, settings }) => {
          try { const r = await ctl.claudeQuickEdit(edit_id, settings ?? {}); activity(r); return text(r); } catch (e) { activity(`Edit refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('photocraft_command', 'PhotoCraft only: runs one engine command for finer control, e.g. image.adjustments.levels {"inBlack":10,"gamma":1.1,"inWhite":240}, image.adjustments.curves, image.adjustments.selectiveColor, filter.blur.gaussianBlur {"radius":2}. Only adjustments, filters, rotations and fill are allowed; nothing that opens, saves or references files.', {
          command: z.string().max(128),
          params: z.record(z.string().max(64), z.unknown()).optional(),
        }, async ({ command, params }) => {
          try { const r = await ctl.claudePhotoCraftCommand(command, params ?? {}); activity(r); return text(r); } catch (e) { activity(`Command refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('undo', 'Undoes the last change in the open app.', {}, async () => {
          try { const r = await ctl.claudeUndo(); activity('Undid the last change'); return text(r); } catch (e) { return fail(e); }
        }),
        tool('save_version', 'Saves the open document as a NEW version in the library (the original is never changed). Only when the user asks or agrees.', {}, async () => {
          try {
            if (ctl.snapshot().collab.lockOwner === 'user') throw new Error('The user has control; let them save.');
            const s = await ctl.saveVersion();
            activity(s.message ?? 'Saved a new version');
            return text(s.message ?? 'Saved.');
          } catch (e) { return fail(e); }
        }),
        tool('list_export_formats', 'Export formats (Deliver presets) available for a library file (exact name from list_files).', {
          name: z.string().max(512),
        }, async ({ name }) => {
          try {
            const a = (await (await this.d.store()).loadManifest()).assets.find((x) => x.name === name);
            if (!a) throw new Error(`No file named "${name}". Use list_files.`);
            const ps = presetsFor(a.sourceFormat);
            if (!ps.length) return text(`${a.sourceFormat.toUpperCase()} files can't be exported yet.`);
            return text(JSON.stringify(ps.map((p) => ({ preset_id: p.id, label: p.label, note: p.note, file_type: p.ext, made_by: EDITOR_APPS[p.app].name })), null, 2));
          } catch (e) { return fail(e); }
        }),
        tool('export_file', 'Exports a library file (exact name from list_files) with one or more Deliver presets (see list_export_formats) into the project\'s exports folder, and waits until done. Exports use the SAVED library file: if the user wants changes in the open app included, save_version first and export the new version. Never changes the library.', {
          name: z.string().max(512),
          preset_ids: z.array(z.string().max(64)).min(1).max(10),
        }, async ({ name, preset_ids }) => {
          try {
            const a = (await (await this.d.store()).loadManifest()).assets.find((x) => x.name === name);
            if (!a) throw new Error(`No file named "${name}". Use list_files.`);
            const q = await this.d.deliver();
            const jobs = await q.enqueue(a.id, preset_ids, 'claude');
            activity(`Exporting ${a.name}: ${jobs.map((j) => j.presetLabel).join(', ')}`);
            const done = await q.wait(jobs.map((j) => j.id));
            const lines = done.map((j) => (j.status === 'done' ? `${j.presetLabel}: exports/${j.output}` : `${j.presetLabel}: ${j.status}${j.error ? ` (${j.error})` : ''}`));
            activity(`Export finished: ${lines.join('; ')}`);
            const s = ctl.snapshot();
            const unsaved = s.asset?.id === a.id && s.history.length > 1 && !s.savedVersionIds.length;
            return text(lines.join('\n') + (unsaved ? '\nNote: the open document has edits that are not saved, so they are not in these exports.' : ''));
          } catch (e) { return fail(e); }
        }),
        tool('list_files', 'Lists the files in the project library (name, kind, size).', {}, async () => {
          try {
            const m = await (await this.d.store()).loadManifest();
            return text(JSON.stringify(m.assets.map((a) => ({ name: a.name, kind: a.kind, format: a.sourceFormat, size: a.width ? `${a.width}x${a.height}` : a.durationSec ? `${a.durationSec}s` : undefined, version: !!a.parentId })), null, 2));
          } catch (e) { return fail(e); }
        }),
        tool('list_image_models', 'Image generation models the user has set up (their own OpenAI / Google Gemini account), with settings and the estimated price per image at default settings.', {}, async () => {
          try {
            const ready = await this.d.imageModels();
            const models = IMAGE_MODELS.filter((m) => ready.some((p) => p.id === m.provider && p.billable)).filter((m) => {
              const listed = ready.find((p) => p.id === m.provider)?.lastTest?.models;
              return !listed?.length || listed.includes(m.id);
            });
            if (!models.length) return text('No image provider is set up. Ask the user to add an API key in Generate → Providers.');
            return text(JSON.stringify(models.map((m) => ({
              model_id: m.id, name: m.label, note: m.note, can_use_reference_images: m.capabilities.includes('image-edit'), max_count: m.maxCount,
              settings: Object.fromEntries(m.settings.map((s) => [s.key, { default: s.default, options: s.options.map((o) => o.value) }])),
              price_per_image_at_defaults: formatUsd(estimateCost({ modelId: m.id, prompt: 'x', referenceAssetIds: [], settings: {}, count: 1 }).perImage),
            })), null, 2));
          } catch (e) { return fail(e); }
        }),
        tool('generate_image', 'Generates new pictures with one of list_image_models. The user sees the price and must approve before anything is sent; results are added to the library as new files (returned by name).', {
          prompt: z.string().min(1).max(4000),
          model_id: z.string().max(64),
          settings: z.record(z.string().max(64), z.string().max(64)).optional(),
          count: z.number().int().min(1).max(4).optional(),
          reference_file_names: z.array(z.string().max(512)).max(4).optional().describe('Library pictures (exact names from list_files) to use as references/input.'),
        }, async ({ prompt, model_id, settings, count, reference_file_names }) => {
          try {
            const m = await (await this.d.store()).loadManifest();
            const refs = (reference_file_names ?? []).map((n) => {
              const a = m.assets.find((x) => x.name === n);
              if (!a) throw new Error(`No file named "${n}". Use list_files.`);
              return a.id;
            });
            const paid = providerById(modelById(model_id)?.provider ?? '')?.billable ?? true;
            activity(`Asked to generate ${count ?? 1} image${(count ?? 1) === 1 ? '' : 's'} with ${model_id}${paid ? ' (waiting for your approval)' : ''}`);
            const r = await this.d.generate({ modelId: model_id, prompt, referenceAssetIds: refs, settings: settings ?? {}, count: count ?? 1 });
            const names = (await (await this.d.store()).loadManifest()).assets.filter((a) => r.assetIds.includes(a.id)).map((a) => a.name);
            activity(r.message);
            return text(`${r.message}
New files: ${names.join(', ') || '(none)'}`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            activity(/cancelled/i.test(msg) ? 'You cancelled the generation' : `Generation failed: ${msg}`);
            return fail(/cancelled/i.test(msg) ? new Error('The user cancelled this generation. Nothing was charged. Do not retry unless they ask.') : e);
          }
        }),
        tool('open_file', 'Opens a library file (exact name from list_files) in an ArtCraft app and shows it in that app\'s CreateCraft tab. Without app it uses the file type\'s Edit-tab app (photos: PhotoCraft, vector: VectorCraft, audio: SoundCraft, video: FilmCraft, .designcraft: DesignCraft). Pass app to use another one, e.g. lightcraft for colour work on a photo or effectcraft for effects and titles. Ask the user first if the current document has unsaved changes.', {
          name: z.string().max(512),
          app: z.enum(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft']).optional(),
        }, async ({ name, app }) => {
          try {
            const a = (await (await this.d.store()).loadManifest()).assets.find((x) => x.name === name);
            if (!a) throw new Error(`No file named "${name}". Use list_files.`);
            await this.d.openAsset(a.id, app);
            const s = ctl.snapshot();
            const appName = EDITOR_APPS[s.appId].name;
            activity(`Opened ${a.name} in ${appName}`);
            return text(`${a.name} is open in ${appName}. Call get_status to see its edits.`);
          } catch (e) { return fail(e); }
        }),
      ],
    });
  }

  /** Sends one message; Claude works until it answers. Streams activity and replies to the panel. */
  async send(message: string): Promise<void> {
    if (this.status === 'working') throw new Error('Claude is still working. Stop it or wait.');
    this.add('user', message);
    this.status = 'working';
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const server = await this.tools();
      const q = query({
        prompt: message,
        options: {
          model: this.model,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          mcpServers: { createcraft: server },
          allowedTools: TOOL_NAMES.map((n) => `mcp__createcraft__${n}`),
          permissionMode: 'dontAsk',
          settingSources: [],
          maxTurns: 40,
          cwd: await this.d.workDir(),
          abortController: abort,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'CreateCraft/0.1' } as Record<string, string>,
        },
      });
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') this.sessionId = m.session_id;
        else if (m.type === 'assistant') {
          const said = m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
          if (said) this.add('claude', said);
        } else if (m.type === 'result') {
          this.costUsd += m.total_cost_usd ?? 0;
          const resultText = 'result' in m ? String(m.result ?? '') : '';
          if (/not logged in|\/login/i.test(resultText)) {
            this.status = 'signed-out';
            this.signedIn = false;
            this.items = this.items.filter((i) => i.text !== resultText);
            this.add('error', 'Claude Code on this PC is not signed in. Click "Sign in to Claude", finish in your browser, then send your message again.');
          } else if (m.is_error) {
            this.add('error', `Claude stopped: ${'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : m.subtype}`);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (abort.signal.aborted) this.add('activity', 'Stopped.');
      else if (/not logged in|\/login/i.test(msg)) {
        this.status = 'signed-out';
        this.signedIn = false;
        this.add('error', 'Claude Code on this PC is not signed in. Click "Sign in to Claude", finish in your browser, then send your message again.');
      } else this.add('error', msg);
    } finally {
      this.abort = null;
      try { (await this.d.live()).claudeDone(); } catch { /* no live doc */ }
      if (this.status === 'working') this.status = 'idle';
      this.publish();
    }
  }
}

export const defaultClaudeCli = () => path.join(process.env.USERPROFILE ?? '', '.local', 'bin', 'claude.exe');
