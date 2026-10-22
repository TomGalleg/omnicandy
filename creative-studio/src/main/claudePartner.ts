// Claude Creative Partner, powered by the Claude Agent SDK (Claude Code as a library) using the
// Claude Code sign-in on this PC — no API key is stored by OmniCandy.
//
// Claude gets NO built-in Claude Code tools (no shell, no file access, no web): `tools: []`,
// `settingSources: []` (ignores the user's Claude Code settings/plugins), and only OmniCandy's own
// in-process tools are allowed. Every tool that changes the document goes through
// LiveTaskController's Claude gate: the shared edit lock (Pause / Take Control stop it), the
// PhotoCraft allowlist, the quick-edit tables, and versioning (saving never overwrites a file).

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import { changeSchema } from '@shared/planner';
import { CLAUDE_MODELS, type ClaudeChatItem, type ClaudeModelId, type ClaudeState } from '@shared/claude';
import { estimateCost, formatUsd, IMAGE_MODELS, modelById, providerById, type ImageJob } from '@shared/generation';
import type { GenerateResultDto, ProviderStatusDto } from '@shared/ipc';
import { estimateVideoCost, VIDEO_MODELS, videoModelById, type VideoJob, type VideoJobRecord } from '@shared/video';
import { EDITOR_APPS, type EditorAppId } from '@shared/appEditors';
import { buildWorkflowPlan, workflowCatalog, type PlanContext, type StepChange, type WorkflowPlan } from '@shared/workflowPlan';
import type { RunSnapshot } from '@shared/workflowControl';
import type { DeliverQueue } from './deliver';
import { exportFileText, listExportFormatsText } from './exportOps';
import { buildResumeContext } from '@shared/claudeHistory';
import { builtinTemplates, templateCatalogForClaude } from '@shared/templates';
import { signInEnv, type ClaudeAuth } from './claudeAuth';
import { claudeLoginLaunch, defaultClaudeCliPath, findOnPath } from './platform/exec';
import { parseProjectPlan, PROJECT_KINDS, type ProjectPlan } from '@shared/projectPlan';
import type { LiveTaskController } from './liveTask';
import type { ProjectStore } from './projectStore';
import type { ToolDef } from './agentHarness/types';
import type { Requester } from './generation';

const SYSTEM_PROMPT = `You are Claude, the Creative Partner inside OmniCandy, a desktop app where the user edits media in ArtCraft apps: PhotoCraft (photos), VectorCraft (vector art), SoundCraft (audio), FilmCraft (video, on a timeline), DesignCraft (page layouts) WordCraft (word-processing documents, .docx), GridCraft (spreadsheets, .xlsx), DeckCraft (presentations, .deckcraft and .pptx), FigCraft (UI and UX design, .figcraft), CADCraft (2D CAD drawings, .dxf and .dwg) and PdfCraft (PDFs: text, pages, watermark) in the Edit tab, LightCraft (photo light and colour) in the Color tab, and EffectCraft (effects and titles on pictures and video) in the Effects tab. The file the user is working on is open in one of these apps, shown inside OmniCandy. get_status tells you which app, and the edits that app offers.

You can only act through the createcraft tools. Start by calling get_status. For visual work, call look_at_document before and after you change something, so you see what you are doing.

One file is open at a time, in one app. To use a different app, open a file in it with open_file and its app (get_status lists every app and the file types it takes). The same photo can go to PhotoCraft (edit), LightCraft (light and colour) or EffectCraft (effects and titles); a video to FilmCraft (timeline: trim, speed, sound, fades) or EffectCraft. To carry your changes from one app to the next, save_version first, then open the saved version (its name is in the save result) in the next app. Opening another file replaces what is open, so save first if the user wants to keep the changes. get_status also shows details of the open file when the app provides them (FilmCraft: the timeline with clip ids; DesignCraft: the text on the page, which replaceText can change; WordCraft: the paragraphs of the document, which replaceText can change and addParagraph can extend; PdfCraft: the page count and the text of the first pages, which replaceText can change). To build a video from several files, open the first video, then add more with timeline_add (as clip, or as music), arrange them with timeline_move_clip / timeline_remove_clip, and use apply_edit for trims, crossfades between clips, fades, music volume and looks, which act on the whole video.

Follow the user's direction. You may suggest improvements, but ask before big creative reinterpretations. Work in small steps and say briefly what you changed. If a tool says the user paused you or took control, stop at once and tell them you are waiting. Never claim a change you did not make.

Saving creates a new version in the library; the user's original file is never changed. Save only when the user asks or agrees.

To deliver finished files (JPEG for the web, PDF, MP4, WAV, GIF and so on), use list_export_formats and export_file. Exports go to the project's exports folder (the Deliver tab) and are made from saved library files, never from unsaved changes in the open app. To hand a file to another app (a Word document to PdfCraft as a PDF, or a PDF to WordCraft as a .docx), export it with export_file and add_to_library set to true, then open the new library file with open_file. The conversion is approximate for layout: tell the user what was kept.
Keep replies short and plain.

For third-party software that is not one of the ArtCraft apps (Blender, Autodesk, Adobe, FreeCAD, Godot and so on), call external_apps to see what is installed and which commands really exist, then external_run (integrations the user installed appear there too; commands marked long_running return a job id, follow it with external_job). The user approves each run in a dialog. A result is only successful when ok is true; say what the result's evidence lists as verified (files that exist, objects found when the file was re-opened) and nothing more. If the program is missing, unsupported or the command is not listed, say so plainly instead of improvising. Never use external_run for the native Craft apps. When the user wants a program that has no integration (or a missing capability), you may offer to build a private custom integration with integration_builder_start; the user confirms, Claude researches and writes it in the background, OmniCandy tests it, and only the user can review and install it (Settings > Integrations). Check progress with integration_builder_status. When the user asks you to work from the Project Planner, use planner_packages, planner_get_package, planner_claim and planner_report (and planner_propose to suggest plan changes, which the user reviews and may reject: you can never edit the plan or treat your own suggestion as accepted): work only on what they asked for, never treat ideas or proposals as requirements, never report a check as passed unless you ran it, and remember that only the user can accept your work or change the plan. Preparing or reading a package never starts work by itself. Never describe a custom integration as working or tested until its status says commands were tested on the real program.

You can also create new pictures with generate_image (OpenAI or Google Gemini, using the user's own account). It costs the user money: only generate when they ask for it, keep the count low, and say which model you will use. OmniCandy shows the user the price and asks them to approve every call; if they cancel, accept it and do not ask again unless they bring it up. New images are added to the library as new files; open one with open_file to edit it. For free video on this PC use local_video_status, make_local_video (AI, on the user GPU) or make_motion_video (camera move on a picture, not AI); never switch to a paid provider because local is unavailable, ask first. For paid video use list_video_models and generate_video (Google Veo or Runway): it costs more, takes minutes, the user approves the price, and the clip lands in the library later, so tell the user rather than waiting.

When the user wants a repeatable multi-step process (for example edit many photos and export them), build a workflow with plan_workflow instead of editing files yourself: read list_files, list_image_models and workflow_catalog, then propose it. The user decides whether to use it. Explain the plan in plain words, say what it costs and what they will be asked to approve, and be honest about warnings.

Once the user has applied a workflow, you can run and look after it with the workflow tools. workflow_status shows the steps, who has control, progress, problems and what is waiting for the user (use wait_seconds to watch a running workflow). run_workflow and rerun_workflow only start after the user approves in a dialog. rerun_workflow runs again only the steps a change affects. change_workflow_step changes one step (the rest keeps its results). pause_workflow stops between steps. You never approve or reject results: that is the user's decision in the Workflow tab; tell them what is waiting. If the user takes manual control, do not try to change or start anything until they give it back. Approved results are protected: a rerun never asks about them again and never replaces them. Previous workflow versions are listed with list_workflow_versions and restored with restore_workflow_version. After a successful run you can save the workflow as a reusable template with save_workflow_template if the user wants that. A paid AI Generate step in a workflow asks the user to approve the price in a dialog when it is reached, and respects the project's spending limit; if they decline the step stops and nothing is charged.`;

export const PLAN_PROMPT = `You are Claude, the Creative Partner inside OmniCandy. The user describes a creative project in their own words. Answer with ONE JSON object and nothing else (no code fence, no commentary) with these keys:
"name": a short project name (max 60 characters);
"kind": one of ${PROJECT_KINDS.map((k) => `"${k.id}" (${k.label})`).join(', ')};
"finishedOutput": one sentence naming the finished result the user wants;
"summary": two or three plain sentences describing your creative plan;
"apps": which ArtCraft apps to use, from PhotoCraft (photos), VectorCraft (vector art), SoundCraft (audio), FilmCraft (video timeline), LightCraft (light and colour), EffectCraft (effects and titles), DesignCraft (page layouts), WordCraft (text documents), GridCraft (spreadsheets), DeckCraft (presentations), FigCraft (UI and UX design), CADCraft (2D CAD drawings), PdfCraft (PDFs);
"aiTools": AI image generation tools worth using, only from the list of available models you are given (an empty list when none is needed or none are set up); say what each is for;
"steps": 3 to 6 short steps in plain language;
"questions": at most 2 essential questions you still need answered (usually none);
"template": the id of ONE template from the list you are given if it clearly fits the project, otherwise null. Never invent an id.
Do not start any work and do not mention software internals, node graphs or file formats unless the user did. Write in the user's language.`;

/** Shown when the Claude Code command cannot be found. */
export const CLAUDE_CODE_MISSING = 'Claude Code is not installed on this PC (or OmniCandy cannot find it). Install it, then press Check again.';

/** Plain settings are limited to 512 characters by the integration manager; a structured (JSON) setting of a built-in adapter, such as the Blender scene spec, may be an object or longer JSON text. */
export const externalRunSettings = z.record(z.string(), z.union([z.string().max(64000), z.number(), z.boolean(), z.record(z.string(), z.unknown()), z.array(z.unknown())]));
const TOOL_NAMES = ['get_status', 'look_at_document', 'apply_edit', 'photocraft_command', 'app_commands', 'app_command', 'undo', 'save_version', 'list_files', 'open_file', 'new_document', 'list_image_models', 'generate_image', 'list_video_models', 'generate_video', 'local_video_status', 'make_local_video', 'make_motion_video', 'request_model_download', 'list_export_formats', 'export_file', 'timeline_add', 'timeline_move_clip', 'timeline_remove_clip', 'workflow_catalog', 'plan_workflow', 'workflow_status', 'run_workflow', 'rerun_workflow', 'pause_workflow', 'resume_workflow', 'cancel_workflow', 'change_workflow_step', 'list_workflow_versions', 'restore_workflow_version', 'save_workflow_template', 'external_apps', 'external_run', 'external_job', 'integration_builder_start', 'integration_builder_status', 'planner_packages', 'planner_get_package', 'planner_claim', 'planner_report', 'planner_propose'];

export interface WorkflowControlApi {
  /** Snapshot of the run (waits up to `waitSeconds` for it to finish, pause or need the user). */
  status(waitSeconds: number): Promise<{ run: RunSnapshot; steps: Array<{ id: string; label: string }>; changedSinceRun: string[] | null; templateReady: boolean }>;
  /** Asks the user (native dialog) and then starts the run in the background; rejects if they say no or control is theirs. */
  start(mode: 'run' | 'rerun', from?: string): Promise<string>;
  pause(): Promise<string>;
  resume(): Promise<string>;
  cancel(): Promise<string>;
  changeStep(nodeId: string, change: StepChange): Promise<string>;
  versions(): Promise<Array<{ id: string; savedAt: string; reason: string; steps: number }>>;
  restore(id: string): Promise<string>;
  saveTemplate(name: string, description: string): Promise<string>;
}

export interface ClaudePartnerDeps {
  live: () => Promise<LiveTaskController>;
  store: () => Promise<ProjectStore>;
  /** Opens a library file in its app inside the Edit tab (same path as the UI). */
  openAsset: (assetId: string, app?: EditorAppId) => Promise<void>;
  /** Adds the app's blank starter file to the library (these apps only edit library files). */
  newBlankFile: (app: EditorAppId, name?: string) => Promise<{ id: string; name: string }>;
  emit: (s: ClaudeState) => void;
  /** Claude Code CLI on this PC, used only for `auth status` / `auth login`. */
  cliPath: string;
  /** Which credentials every Claude session uses (the Claude sign-in, or the Anthropic API key chosen in Settings). */
  auth: ClaudeAuth;
  workDir: () => Promise<string>;
  /** Same path as the Generate tab: approval dialog in main, then the provider call. */
  generate: (job: ImageJob, requester?: Requester) => Promise<GenerateResultDto>;
  /** Same approval dialog and spending limit as the Generate tab; resolves when the job is submitted, not when the video is ready. */
  generateVideo: (job: VideoJob, requester?: Requester) => Promise<VideoJobRecord>;
  /** Free local AI and Motion Effects (no provider, no cost). Every method returns plain text for Claude. */
  localAi: {
    status: () => Promise<string>;
    /** Starts a clip in the background and returns at once. */
    startVideo: (prompt: string, preset: 'experimental' | 'low' | 'balanced' | 'higher') => Promise<string>;
    /** Camera move on a library picture (a few seconds). */
    motion: (job: { fileName: string; preset: string; intensity: string; seconds: number; aspect: string }) => Promise<string>;
    /** Shows the user the license/size dialog; downloads only if they accept. */
    requestDownload: (modelId: string) => Promise<string>;
  };
  /** External third-party applications (not the native Craft apps): scan result as JSON text, and one verified command run. */
  external: {
    list: () => Promise<string>;
    run: (app: string, command: string, params: Record<string, unknown>, background?: boolean) => Promise<string>;
    /** Status (and optionally cancel) of a background job started by run. */
    job: (id: string, cancel: boolean) => Promise<string>;
  };
  /** AI Adapter Builder: starts a private custom integration (the user confirms in a dialog and approves the result later) and lists projects. */
  builder: {
    start: (appName: string, goal?: string) => Promise<string>;
    status: () => Promise<string>;
  };
  /** Project Planner executor access: the same rules and permissions as the planner MCP server (read + execute only; Claude cannot edit the plan or accept work). Returns the tool's JSON text. */
  planner: { call: (tool: string, args: Record<string, unknown>) => Promise<string> };
  /** Providers with a saved key (status only, never the key). */
  imageModels: () => Promise<ProviderStatusDto[]>;
  /** The Deliver tab's export queue (same queue, presets and manifest as the UI). */
  deliver: () => Promise<DeliverQueue>;
  /** Workflow planning: the library and provider status to validate against, and where a validated plan goes (shown to the user; never saved or run by Claude). */
  workflowPlan: { context: () => Promise<PlanContext>; propose: (plan: WorkflowPlan) => void };
  /** Runs, monitoring and changes to the saved workflow: the same engine and rules as the Workflow tab. */
  workflowControl: WorkflowControlApi;
  /** The open project's saved chat (inside the project folder, never in app settings). */
  history: { load: () => Promise<ClaudeChatItem[]>; save: (items: ClaudeChatItem[]) => Promise<void> };
}

/** A reference picture or file the user attached while planning (read only; nothing is copied). */
/** Runs the planning prompt on another AI and returns its text answer. */
export type PlanRunner = (input: { system: string; intro: string; images: Array<{ name: string; dataUrl: string }>; signal: AbortSignal }) => Promise<string>;

export interface PlanReference { name: string; kind: string; bytes: number; image?: { mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string } }

export class ClaudePartner {
  /** The first chat loaded after OmniCandy starts is cleared: every new instance begins with an empty Creative Partner. */
  private static startedFresh = false;
  private model: ClaudeModelId = 'claude-sonnet-5-5';
  private items: ClaudeChatItem[] = [];
  private status: ClaudeState['status'] = 'idle';
  private signedIn: boolean | null = null;
  /** Whether the Claude Code command was found (null = not looked yet). */
  private installed: boolean | null = null;
  private costUsd = 0;
  private sessionId: string | null = null;
  private abort: AbortController | null = null;
  private login: ClaudeState['login'] = { stage: 'idle', url: null, message: null };
  private loginPoll: ReturnType<typeof setInterval> | null = null;

  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly d: ClaudePartnerDeps) {}

  state(): ClaudeState {
    return { status: this.status, model: this.model, items: this.items, signedIn: this.signedIn, costUsd: this.costUsd, login: this.login, installed: this.installed, billing: this.billingInfo };
  }

  /** Loads this project's saved chat once (before the first state or message). */
  ready(): Promise<void> {
    return (this.loaded ??= this.d.history.load().then((saved) => {
      if (!ClaudePartner.startedFresh) {
        ClaudePartner.startedFresh = true;
        if (saved.length) this.persist(true); // this.items is empty: the saved chat is dropped
        return;
      }
      if (!this.items.length) this.items = saved;
    }).catch(() => { /* an unreadable history is simply empty */ }));
  }

  private persist(now = false) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const run = () => { this.saveTimer = null; void this.d.history.save(this.items).catch(() => { /* chat still works */ }); };
    if (now) run(); else this.saveTimer = setTimeout(run, 400);
  }

  /** Records the planning exchange as the start of a new project's chat (only when the chat is empty). */
  async seed(user: string, claude: string): Promise<void> {
    await this.ready();
    if (this.items.length) return;
    const at = new Date().toISOString();
    this.items = [{ id: randomUUID(), role: 'user', text: user, at }, { id: randomUUID(), role: 'claude', text: claude, at }];
    this.publish();
    this.persist(true);
  }

  private publish() { this.d.emit(this.state()); }
  private add(role: ClaudeChatItem['role'], text: string) {
    const last = this.items.at(-1);
    if (role === 'error' && last?.role === 'error' && last.text === text) return; // same error reported twice
    this.items = [...this.items.slice(-199), { id: randomUUID(), role, text, at: new Date().toISOString() }];
    this.publish();
    this.persist();
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
    this.persist(true);
  }

  /** The Claude Code command: the official install location first, then anywhere on PATH. Looked up each time, so installing it later is noticed. */
  async findCli(): Promise<string | null> {
    const found = fs.existsSync(this.d.cliPath) ? this.d.cliPath : await findOnPath('claude').catch(() => null);
    this.installed = !!found;
    return found;
  }

  private billingInfo: ClaudeState['billing'] = { mode: 'sign-in', keyReady: false, keyUnreadable: false, keyIgnored: false };

  /** Re-reads which credentials are in use (after the Settings card changes them) and tells the panel. */
  async refreshAuth(): Promise<ClaudeState['billing']> {
    this.billingInfo = await this.d.auth.billing();
    if (this.billingInfo.mode === 'api-key' && this.status === 'signed-out') this.status = 'idle';
    this.publish();
    return this.billingInfo;
  }

  /** The credentials changed: the next message starts a fresh Claude session with them. */
  async authChanged(): Promise<ClaudeState['billing']> {
    this.sessionId = null;
    this.signedIn = null;
    return this.refreshAuth();
  }

  /** What to tell the user when Claude Code reports it cannot authenticate, depending on the credentials in use. */
  private async authFailure(): Promise<Error> {
    if ((await this.d.auth.mode()) === 'api-key') return new Error('Anthropic did not accept the API key. Check or replace it in Settings, or switch back to the Claude sign-in.');
    this.status = 'signed-out';
    this.signedIn = false;
    return new Error('Claude Code on this PC is not signed in. Open the Claude panel, click "Sign in to Claude", then try again.');
  }

  /** Reads `claude auth status` (never prints or stores credentials). Not used in API-key mode, which needs no sign-in. */
  async checkAuth(): Promise<boolean | null> {
    const cli = await this.findCli();
    const b = await this.refreshAuth();
    if (b.mode === 'api-key') { this.signedIn = null; this.publish(); return b.keyReady; }
    if (!cli) { this.signedIn = null; this.publish(); return null; }
    const out = await new Promise<string>((resolve) => {
      execFile(cli, ['auth', 'status'], { windowsHide: true, timeout: 20_000, env: signInEnv(process.env) }, (_e, stdout) => resolve(String(stdout ?? '')));
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
   * console, so OmniCandy never sees it). OmniCandy polls `claude auth status` until signed in.
   */
  async signIn() {
    const cli = await this.findCli();
    if (!cli) throw new Error(CLAUDE_CODE_MISSING);
    void claudeLoginLaunch(cli).then((plan) => {
      if (!plan) { this.login = { stage: 'failed', url: null, message: 'No terminal program was found. Open a terminal yourself and run: claude auth login' }; this.publish(); return; }
      spawn(plan.cmd, plan.args, { detached: true, stdio: 'ignore', windowsHide: false, env: signInEnv(process.env), ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}) }).unref();
    }).catch((e: unknown) => { this.login = { stage: 'failed', url: null, message: e instanceof Error ? e.message : String(e) }; this.publish(); });
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

  /** Every tool Claude has. Handlers are shared as they are: the Independent AI agent reuses the very same implementations (see agentToolDefs). */
  private async toolDefinitions(activity: (t: string) => void, requester: Requester = 'claude') {
    const { tool } = await import('@anthropic-ai/claude-agent-sdk');
    const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
    const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });
    const ctl = await this.d.live();

    return [
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
        tool('photocraft_command', 'PhotoCraft only: runs one engine command for finer control, e.g. image.adjustments.levels {"inBlack":10,"gamma":1.1,"inWhite":240}, image.adjustments.curves, image.adjustments.selectiveColor, filter.blur.gaussianBlur {"radius":2}. Everything that edits the open picture works: adjustments, filters, text (type.create {"text":"…","x":px,"y":px,"size":pt,"color":"#rrggbb","font":"…"}, type.setStyle, type.edit), layers (layer.translate, layer.arrange.*, layer.layerStyle.*), selections, painting, paths, transforms. Commands that open, save or import files or run actions, scripts or plugins ask the user to approve first; if declined, accept that and say so.', {
          command: z.string().max(128),
          params: z.record(z.string().max(64), z.unknown()).optional(),
        }, async ({ command, params }) => {
          try { const r = await ctl.claudePhotoCraftCommand(command, params ?? {}); activity(r); return text(r); } catch (e) { activity(`Command refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('app_commands', 'Lists the engine commands (ids and parameters) of the open ArtCraft app so you can find the exact one to run with app_command, e.g. EffectCraft: filter "layer", "effect", "keyframe", "text", "comp". Always look here before saying an app cannot do something; the apps have hundreds of commands beyond the quick edits.', {
          filter: z.string().max(64).optional().describe('A word to narrow the list, e.g. layer.'),
        }, async ({ filter }) => {
          try { return text(await ctl.appCommandList(filter)); } catch (e) { return fail(e); }
        }),
        tool('app_command', 'Runs one engine command in whichever ArtCraft app is open (VectorCraft, EffectCraft, DesignCraft, WordCraft, GridCraft, DeckCraft, FigCraft, CADCraft, PdfCraft, SoundCraft, FilmCraft, LightCraft; PhotoCraft too). Use the command ids of that app (find them with app_commands first; never guess); PdfCraft and EffectCraft tools are written tool:<name>, and PdfCraft fills in the document for you; params is the command JSON object. Anything that edits the open document runs at once. Commands that open, save, import, export or place files, or run scripts, actions, plugins or batches ask the user to approve first; if declined, accept that and say so.', {
          command: z.string().max(128),
          params: z.record(z.string().max(64), z.unknown()).optional(),
        }, async ({ command, params }) => {
          try { const r = await ctl.claudeAppCommand(command, params ?? {}); activity(r); return text(r); } catch (e) { activity(`Command refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
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
        tool('timeline_add', 'FilmCraft only (a video open in the Edit tab): adds a library file (exact name from list_files) to the open video. as "clip" puts a video or picture at the end of the picture track (pictures last 3 s); as "music" puts a sound file on a music track from the start, trimmed to the video\'s length. get_status shows the timeline with clip ids.', {
          name: z.string().max(512),
          as: z.enum(['clip', 'music']),
        }, async ({ name, as }) => {
          try {
            const a = (await (await this.d.store()).loadManifest()).assets.find((x) => x.name === name);
            if (!a) throw new Error(`No file named "${name}". Use list_files.`);
            const r = await ctl.claudeTimelineEdit({ kind: 'add', assetId: a.id, as });
            activity(r); return text(r);
          } catch (e) { activity(`Timeline change refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('timeline_move_clip', 'FilmCraft only: moves a picture clip (id from get_status, track V1) to a new position in the clip order (0 = first). Its sound moves with it; music stays put.', {
          clip_id: z.number().int().min(0),
          to_position: z.number().int().min(0).max(1000),
        }, async ({ clip_id, to_position }) => {
          try { const r = await ctl.claudeTimelineEdit({ kind: 'move', clip: clip_id, to: to_position }); activity(r); return text(r); } catch (e) { activity(`Timeline change refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('timeline_remove_clip', 'FilmCraft only: removes a clip (id from get_status) and closes the gap. Removing a picture clip removes its sound too.', {
          clip_id: z.number().int().min(0),
        }, async ({ clip_id }) => {
          try { const r = await ctl.claudeTimelineEdit({ kind: 'remove', clip: clip_id }); activity(r); return text(r); } catch (e) { activity(`Timeline change refused: ${e instanceof Error ? e.message : e}`); return fail(e); }
        }),
        tool('list_export_formats', 'Export formats (Deliver presets) available for a library file (exact name from list_files).', {
          name: z.string().max(512),
        }, async ({ name }) => {
          try {
            return text(await listExportFormatsText(await this.d.store(), name));
          } catch (e) { return fail(e); }
        }),
        tool('export_file', 'Exports a library file (exact name from list_files) with one or more Deliver presets (see list_export_formats) into the project\'s exports folder, and waits until done. Exports use the SAVED library file: if the user wants changes in the open app included, save_version first and export the new version. Never changes the library.', {
          name: z.string().max(512),
          preset_ids: z.array(z.string().max(64)).min(1).max(10),
          add_to_library: z.boolean().optional().describe('Also copy each finished file into the library as a new file, so it can be opened with open_file in another app (for example a .docx exported as PDF, then opened in PdfCraft).'),
        }, async ({ name, preset_ids, add_to_library }) => {
          try {
            return text(await exportFileText(await this.d.store(), await this.d.deliver(), ctl, { name, presetIds: preset_ids, addToLibrary: add_to_library }, activity));
          } catch (e) { return fail(e); }
        }),
        tool('list_files', 'Lists the files in the project library (name, kind, size).', {}, async () => {
          try {
            const m = await (await this.d.store()).loadManifest();
            return text(JSON.stringify(m.assets.map((a) => ({ name: a.name, kind: a.kind, format: a.sourceFormat, size: a.width ? `${a.width}x${a.height}` : a.durationSec ? `${a.durationSec}s` : undefined, version: !!a.parentId, ...(a.provenance.role === 'reference' ? { reference_from_user: true } : {}) })), null, 2));
          } catch (e) { return fail(e); }
        }),
        tool('workflow_catalog', 'What a workflow can contain: step types, every ArtCraft app with its edits and settings, and the connection rules. Call it before plan_workflow.', {}, async () => text(JSON.stringify(workflowCatalog(), null, 2))),
        tool('plan_workflow', 'Proposes a workflow (a node graph) for the user\'s request, built on the same engine as the Workflow tab. It validates every connection and setting and returns problems to fix, or the plan with cost estimate and approval points, which the user then sees in the Workflow tab and decides to use. It does NOT save, run or generate anything. Use list_files, list_image_models and workflow_catalog first; use exact names and ids. A typical shape: import -> artcraftEdit -> approval -> export. Put an approval step before export and before anything paid.', {
          title: z.string().min(1).max(120),
          explanation: z.string().min(1).max(2000).describe('Plain-language description of what the workflow does and why, for the user.'),
          steps: z.array(z.object({
            key: z.string().min(1).max(40).describe('Your own short name for the step, used in connections.'),
            type: z.enum(['import', 'aiGenerate', 'artcraftEdit', 'approval', 'export']),
            files: z.array(z.string().max(512)).max(100).optional().describe('import: exact library file names.'),
            model_id: z.string().max(64).optional().describe('aiGenerate: from list_image_models.'),
            prompt: z.string().max(4000).optional(),
            count: z.number().int().min(1).max(4).optional(),
            settings: z.record(z.string().max(64), z.string().max(64)).optional().describe('aiGenerate model settings.'),
            app: z.string().max(32).optional().describe('artcraftEdit: app id, e.g. photocraft.'),
            edit: z.string().max(64).optional().describe('artcraftEdit: edit id from workflow_catalog.'),
            edit_settings: z.record(z.string().max(64), z.union([z.string().max(200), z.number()])).optional(),
            note: z.string().max(300).optional().describe('approval: what to check.'),
            presets: z.array(z.string().max(64)).max(10).optional().describe('export: Deliver preset ids (list_export_formats).'),
          })).min(1).max(30),
          connections: z.array(z.object({ from: z.string().max(40), to: z.string().max(40), from_port: z.string().max(32).optional(), to_port: z.string().max(32).optional() })).max(60),
        }, async (input) => {
          try {
            const r = buildWorkflowPlan(input, await this.d.workflowPlan.context());
            if (!r.ok) return text(['The plan has problems; fix them and call plan_workflow again:', ...r.issues.map((x) => `- ${x}`)].join('\n'));
            this.d.workflowPlan.propose(r.plan);
            activity(`Proposed a workflow: ${r.plan.title}`);
            return text(`Plan shown to the user in the Workflow tab (nothing saved or run yet; they choose "Use this workflow").
Steps: ${r.plan.steps.map((x, i) => `${i + 1}. ${x.title}`).join(' | ')}
Cost: ${r.plan.costNote}
Waits for the user: ${r.plan.approvals.join(' ') || 'nothing'}
Warnings: ${r.plan.warnings.join(' ') || 'none'}
Now explain the plan to the user in plain language, including cost and what they must approve.`);
          } catch (e) { return fail(e); }
        }),
        tool('workflow_status', 'The saved workflow and its run: steps (ids and labels), state (idle, running, paused, waiting-for-you, finished), who has control, per-step status and message, problems per file, what is waiting for the user, and which steps changed since the last run. wait_seconds (0-60) waits for the run to finish, pause or need the user.', {
          wait_seconds: z.number().int().min(0).max(60).optional(),
        }, async ({ wait_seconds }) => {
          try { return text(JSON.stringify(await this.d.workflowControl.status(wait_seconds ?? 0), null, 2)); } catch (e) { return fail(e); }
        }),
        tool('run_workflow', 'Runs the saved workflow from the start, in the background. The user is asked to approve in a dialog first; if they decline, accept it. Does not wait: use workflow_status to follow progress. Paid generation never runs.', {}, async () => {
          try { const m = await this.d.workflowControl.start('run'); activity('Started the workflow'); return text(m); } catch (e) { return fail(e); }
        }),
        tool('rerun_workflow', 'Runs again only the steps affected by changes since the last run (and what comes after them); every other step keeps its results. Optionally from one step id. The user approves in a dialog first.', {
          from_step: z.string().max(128).optional().describe('Step id from workflow_status to rerun from.'),
        }, async ({ from_step }) => {
          try { const m = await this.d.workflowControl.start('rerun', from_step); activity('Started a rerun of the changed steps'); return text(m); } catch (e) { return fail(e); }
        }),
        tool('pause_workflow', 'Pauses the running workflow before its next step (a step that is running finishes first).', {}, async () => {
          try { return text(await this.d.workflowControl.pause()); } catch (e) { return fail(e); }
        }),
        tool('resume_workflow', 'Continues a paused workflow.', {}, async () => {
          try { return text(await this.d.workflowControl.resume()); } catch (e) { return fail(e); }
        }),
        tool('cancel_workflow', 'Stops the running workflow. Finished steps keep their results.', {}, async () => {
          try { return text(await this.d.workflowControl.cancel()); } catch (e) { return fail(e); }
        }),
        tool('change_workflow_step', 'Changes one step of the saved workflow (not while it runs unless paused). Fields allowed depend on the step type: import: files; artcraftEdit: app, edit, edit_settings; approval: note; export: presets; aiGenerate: prompt. The previous version is kept; use rerun_workflow afterwards to redo only what is affected.', {
          step_id: z.string().min(1).max(128),
          files: z.array(z.string().max(512)).max(100).optional(),
          app: z.string().max(32).optional(),
          edit: z.string().max(64).optional(),
          edit_settings: z.record(z.string().max(64), z.union([z.string().max(200), z.number()])).optional(),
          note: z.string().max(300).optional(),
          presets: z.array(z.string().max(64)).max(10).optional(),
          prompt: z.string().max(4000).optional(),
        }, async ({ step_id, ...change }) => {
          try { const m = await this.d.workflowControl.changeStep(step_id, change); activity(`Changed a workflow step: ${m}`); return text(m); } catch (e) { return fail(e); }
        }),
        tool('list_workflow_versions', 'Earlier versions of this workflow (kept automatically before each run, change, restore and plan).', {}, async () => {
          try { return text(JSON.stringify(await this.d.workflowControl.versions(), null, 2)); } catch (e) { return fail(e); }
        }),
        tool('restore_workflow_version', 'Restores an earlier workflow version by id (the current one is kept first). Not while it runs.', {
          version_id: z.string().min(1).max(128),
        }, async ({ version_id }) => {
          try { const m = await this.d.workflowControl.restore(version_id); activity('Restored an earlier workflow version'); return text(m); } catch (e) { return fail(e); }
        }),
        tool('save_workflow_template', 'Saves the workflow as a reusable template (steps and settings; file choices are left out). Only works after a successful run of the workflow as it is now.', {
          name: z.string().min(1).max(80),
          description: z.string().max(400).optional(),
        }, async ({ name, description }) => {
          try { const m = await this.d.workflowControl.saveTemplate(name, description ?? ''); activity(`Saved workflow template: ${name}`); return text(m); } catch (e) { return fail(e); }
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
        tool('list_video_models', 'Video generation models the user has set up (Google Veo with their Gemini key, Runway with their Runway key), with allowed settings and the estimated price at the default settings.', {}, async () => {
          try {
            const ready = await this.d.imageModels();
            const models = VIDEO_MODELS.filter((m) => ready.some((p) => p.id === m.provider && p.billable));
            if (!models.length) return text('No video provider is set up. Ask the user to add a Gemini (Google Veo) or Runway API key in AI Generate → Providers.');
            return text(JSON.stringify(models.map((m) => ({
              model_id: m.id, name: m.label, note: m.note, needs_starting_picture: !m.capabilities.includes('text-to-video'),
              aspect_ratios: m.aspectRatios, durations_seconds: m.durations, resolutions: m.resolutions,
              note_on_resolution: m.eightSecondOnly.length ? `${m.eightSecondOnly.join(' and ')} only for 8 second clips` : undefined,
              price_at_720p_4s: formatUsd(estimateVideoCost({ modelId: m.id, prompt: 'x', referenceAssetId: null, aspectRatio: '16:9', durationSeconds: m.durations.includes(4) ? 4 : m.durations[0]!, resolution: '720p' }).amount),
            })), null, 2));
          } catch (e) { return fail(e); }
        }),
        tool('external_apps', 'External third-party software found on this PC (Blender, Autodesk, Adobe and others) with status, how it can be controlled and the exact commands that exist. These are NOT the native Craft apps. Only commands listed here can be run; unsupported programs are only detected.', {}, async () => {
          try { activity('Looking for external applications'); return text(await this.d.external.list()); } catch (e) { return fail(e); }
        }),
        tool('external_run', 'Runs one command from external_apps in an external application. The user is asked to allow it first; if they decline, accept it. The result states what was verified (for example the saved file exists and was re-opened); report only that, never claim more. Outputs land in the project external folder.', {
          app: z.string().max(200).describe('app_key, adapter id or name from external_apps.'),
          command: z.string().max(100),
          settings: externalRunSettings.optional(),
          background: z.boolean().optional().describe('Commands marked long_running start a job and return a job id at once; follow it with external_job. Set false to wait for the result instead.'),
        }, async ({ app, command, settings, background }) => {
          try { activity(`Running ${command} in ${app}`); return text(await this.d.external.run(app, command, settings ?? {}, background)); } catch (e) { return fail(e); }
        }),
        tool('integration_builder_start', 'Starts building a PRIVATE custom integration for a program that OmniCandy cannot control yet. The user is asked first. Claude researches the vendor documentation and writes a connector in the background; OmniCandy tests it; the user reviews and installs it in Settings. You cannot install it. Use only when the user asked to connect a program that external_apps shows as unsupported.', {
          app: z.string().min(1).max(80).describe('Name of the program, for example "Adobe Photoshop".'),
          goal: z.string().max(400).optional().describe('What the user wants to do with it, in their words.'),
        }, async ({ app, goal }) => {
          try { activity(`Starting a custom integration for ${app}`); return text(await this.d.builder.start(app, goal)); } catch (e) { return fail(e); }
        }),
        tool('integration_builder_status', 'Progress of custom integrations being built or waiting for the user: status, whether the commands were tested on the real program, and what is needed next.', {}, async () => {
          try { return text(await this.d.builder.status()); } catch (e) { return fail(e); }
        }),
        tool('planner_packages', 'Lists the open Project Planner execution packages the user prepared (id, objective, tasks), or the planner projects when projectId is omitted. Only use when the user asks you to work from the planner. Reading a package does not start anything.', {
          projectId: z.string().max(60).optional(),
        }, async ({ projectId }) => {
          try { activity('Looking at the Project Planner'); return text(await this.d.planner.call(projectId ? 'list_packages' : 'list_projects', projectId ? { projectId } : {})); } catch (e) { return fail(e); }
        }),
        tool('planner_get_package', 'Retrieves one execution package: objective, accepted requirements and decisions, constraints, assets, tasks with completion checks, and whether the plan changed since. Ideas, questions and proposals are not requirements.', {
          projectId: z.string().max(60), packageId: z.string().max(60),
        }, async (a) => {
          try { activity('Reading a planner package'); return text(await this.d.planner.call('get_package', a)); } catch (e) { return fail(e); }
        }),
        tool('planner_claim', 'Claims ONE task of a package before you work on it (so nobody does it twice). Returns the claimToken you need to report. Claim only a task the user asked you to do.', {
          projectId: z.string().max(60), packageId: z.string().max(60), taskId: z.string().max(60),
        }, async (a) => {
          try { activity('Claiming a planner task'); return text(await this.d.planner.call('claim_task', a)); } catch (e) { return fail(e); }
        }),
        tool('planner_report', 'Submits the structured report for a claimed task. Say only what you did and the checks you ACTUALLY ran (result pass, fail or not_run for each completion check id). The report only claims completion: the user decides whether to accept it.', {
          projectId: z.string().max(60), packageId: z.string().max(60), taskId: z.string().max(60), claimToken: z.string().max(80),
          report: z.object({
            outcome: z.enum(['complete', 'partial', 'blocked', 'failed']), workPerformed: z.string().min(1).max(8000),
            outputs: z.array(z.object({ description: z.string().max(500), path: z.string().max(1000).optional() })).max(50).optional(),
            changedFiles: z.array(z.string().max(1000)).max(200).optional(),
            verification: z.array(z.object({ check: z.string().max(500), checkId: z.string().max(80).optional(), result: z.enum(['pass', 'fail', 'not_run']), details: z.string().max(2000).optional() })).max(50).optional(),
            blockers: z.array(z.string().max(1000)).max(30).optional(), limitations: z.array(z.string().max(1000)).max(30).optional(), unresolvedQuestions: z.array(z.string().max(1000)).max(30).optional(),
          }),
        }, async (a) => {
          try { activity('Submitting a planner report'); return text(await this.d.planner.call('submit_report', a)); } catch (e) { return fail(e); }
        }),
        tool('planner_propose', 'Suggests changes to a Project Planner plan: new rules, decisions, questions, ideas or tasks, or edits to existing ones (edits need baseRev, the rev you read). Nothing is applied: the user reviews every suggestion and may reject it. Only use when the user asks you to help plan.', {
          projectId: z.string().max(60), note: z.string().max(1000), changes: z.array(changeSchema).min(1).max(30),
        }, async (a) => {
          try { activity('Suggesting planner changes'); return text(await this.d.planner.call('propose_changes', a)); } catch (e) { return fail(e); }
        }),
        tool('external_job', 'Status, progress and result of a background job started by external_run, or cancels it. A job is finished only when status is succeeded, failed or cancelled; report its result exactly, including the verified evidence.', {
          job_id: z.string().max(100),
          cancel: z.boolean().optional(),
        }, async ({ job_id, cancel }) => {
          try { return text(await this.d.external.job(job_id, !!cancel)); } catch (e) { return fail(e); }
        }),
        tool('local_video_status', 'Free local AI video on this PC: hardware tier, which engine and models are downloaded, which presets exist, and what has really been verified. Check this before offering local video. Never switch to a paid provider because local is unavailable; ask the user first.', {}, async () => {
          try { return text(await this.d.localAi.status()); } catch (e) { return fail(e); }
        }),
        tool('make_local_video', 'Makes a short text-to-video clip on the user own PC with the downloaded local model (free, no account, no approval needed, but it uses the GPU for minutes). Only when the user asks. Starts in the background and returns at once; the clip is added to the library when done. Use local_video_status first. Presets: experimental (320x192, about 1 s), low, balanced, higher.', {
          prompt: z.string().min(1).max(1000),
          preset: z.enum(['experimental', 'low', 'balanced', 'higher']).optional(),
        }, async ({ prompt, preset }) => {
          try { activity('Starting a local video'); return text(await this.d.localAi.startVideo(prompt, preset ?? 'experimental')); } catch (e) { return fail(e); }
        }),
        tool('make_motion_video', 'Free, non-AI camera move (zoom or pan) on one library picture, saved as a short video. Say it is Motion Effects, not generated AI video.', {
          file_name: z.string().max(512).describe('Exact picture name from list_files (PNG, JPEG or WebP).'),
          movement: z.enum(['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down']).optional(),
          strength: z.enum(['subtle', 'medium', 'strong']).optional(),
          seconds: z.number().min(2).max(20).optional(),
          aspect_ratio: z.enum(['16:9', '9:16', '1:1']).optional(),
        }, async ({ file_name, movement, strength, seconds, aspect_ratio }) => {
          try {
            activity('Making a motion video');
            return text(await this.d.localAi.motion({ fileName: file_name, preset: movement ?? 'zoom-in', intensity: strength ?? 'medium', seconds: seconds ?? 6, aspect: aspect_ratio ?? '16:9' }));
          } catch (e) { return fail(e); }
        }),
        tool('request_model_download', 'Asks the user to download a local AI model or the engine. A native dialog shows license, size and folder and the user decides; nothing downloads unless they accept. Model ids come from local_video_status. Never assume the answer.', {
          model_id: z.string().max(80),
        }, async ({ model_id }) => {
          try { return text(await this.d.localAi.requestDownload(model_id)); } catch (e) { return fail(e); }
        }),
        tool('generate_video', 'Starts a video with one of list_video_models. Costs the user money: only when they ask, keep clips short, say which model. The user sees the price and must approve before anything is sent. Returns as soon as the job is submitted; the video takes minutes and is added to the library when ready (the user sees it under Video jobs). Optionally start from a library picture.', {
          prompt: z.string().min(1).max(2000),
          model_id: z.string().max(64),
          aspect_ratio: z.string().max(16).optional(),
          duration_seconds: z.number().int().min(1).max(60).optional(),
          resolution: z.string().max(16).optional(),
          start_picture_file_name: z.string().max(512).optional().describe('Library picture (exact name from list_files) to start from.'),
        }, async ({ prompt, model_id, aspect_ratio, duration_seconds, resolution, start_picture_file_name }) => {
          try {
            const vm = videoModelById(model_id);
            if (!vm) throw new Error(`Unknown video model "${model_id}". Use list_video_models.`);
            let ref: string | null = null;
            if (start_picture_file_name) {
              const a = (await (await this.d.store()).loadManifest()).assets.find((x) => x.name === start_picture_file_name);
              if (!a) throw new Error(`No file named "${start_picture_file_name}". Use list_files.`);
              ref = a.id;
            }
            activity(`Asked to make a video with ${vm.label} (waiting for your approval)`);
            const r = await this.d.generateVideo({
              modelId: model_id, prompt, referenceAssetId: ref,
              aspectRatio: aspect_ratio ?? '16:9', durationSeconds: duration_seconds ?? (vm.durations.includes(4) ? 4 : vm.durations[0]!), resolution: resolution ?? vm.resolutions[0]!,
            }, requester);
            activity('Video job started');
            return text(`Video job started (${vm.label}, about $${r.estimateUsd.toFixed(2)}). It takes a few minutes; it will appear in the library and under Video jobs in AI Generate when it is ready. Do not wait for it; tell the user.`);
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
            const r = await this.d.generate({ modelId: model_id, prompt, referenceAssetIds: refs, settings: settings ?? {}, count: count ?? 1 }, requester);
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
        tool('new_document', 'Starts a NEW document from nothing: adds a blank file made by the app itself to the library and opens it, ready for app_commands / app_command. For apps that edit one library file: designcraft (layout), wordcraft (.docx), pdfcraft (one blank page), gridcraft (.xlsx), deckcraft (presentation), figcraft (UI design), cadcraft (.dxf drawing), vectorcraft (.svg), photocraft (white 1920x1080 picture), soundcraft (10 s of silence to build on: add tracks, clips and generated sound with its commands), lightcraft and effectcraft (white 1920x1080 still; EffectCraft makes a 5 s composition from it). Not for filmcraft: it needs a real video clip from the library. Use this when the user wants something new and the library has no suitable file. Never stop to ask the user for a starting file.', {
          app: z.enum(['photocraft', 'vectorcraft', 'designcraft', 'wordcraft', 'pdfcraft', 'gridcraft', 'deckcraft', 'figcraft', 'cadcraft', 'soundcraft', 'lightcraft', 'effectcraft']),
          name: z.string().max(60).optional().describe('File name without extension, e.g. "Dragon Field Guide".'),
        }, async ({ app, name }) => {
          try {
            const a = await this.d.newBlankFile(app, name);
            await this.d.openAsset(a.id, app);
            activity(`Started a new ${EDITOR_APPS[app].name} document, ${a.name}`);
            return text(`${a.name} is open in ${EDITOR_APPS[app].name} and is empty (a PDF has one blank page; a picture is white). Look up the commands with app_commands, then build it; resize or add pages with the app's own commands.`);
          } catch (e) { return fail(e); }
        }),
        tool('open_file', 'Opens a library file (exact name from list_files) in an ArtCraft app and shows it in that app\'s OmniCandy tab. Without app it uses the file type\'s Edit-tab app (photos: PhotoCraft, vector: VectorCraft, audio: SoundCraft, video: FilmCraft, .designcraft: DesignCraft, .docx: WordCraft, .xlsx: GridCraft, .deckcraft/.pptx: DeckCraft, .figcraft: FigCraft, .dxf/.dwg: CADCraft, .pdf: PdfCraft). Pass app to use another one, e.g. lightcraft for colour work on a photo or effectcraft for effects and titles. Ask the user first if the current document has unsaved changes.', {
          name: z.string().max(512),
          app: z.enum(['photocraft', 'vectorcraft', 'soundcraft', 'filmcraft', 'lightcraft', 'effectcraft', 'designcraft', 'wordcraft', 'pdfcraft', 'gridcraft', 'deckcraft', 'figcraft', 'cadcraft']).optional(),
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
    ];
  }

  private async tools() {
    const { createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');
    return createSdkMcpServer({ name: 'createcraft', version: '0.1.0', tools: await this.toolDefinitions((t) => this.add('activity', t)) });
  }

  /**
   * The named Claude tools as Independent AI tools: same handlers and same input schemas, so approvals (paid
   * generation, model downloads, workflow runs), output-path rules and manual-takeover checks are exactly the
   * ones Claude has. Nothing is re-implemented, and nothing is written to Claude's chat.
   */
  async agentToolDefs(names: readonly string[]): Promise<ToolDef[]> {
    const wanted = new Set(names);
    const defs = (await this.toolDefinitions(() => undefined, 'independent')).filter((t) => wanted.has(t.name));
    return defs.map((def): ToolDef => {
      const schema = z.object(def.inputSchema as z.ZodRawShape).strict();
      return {
        name: def.name,
        description: def.description,
        parameters: z.toJSONSchema(schema) as Record<string, unknown>,
        execute: async (args) => {
          const parsed = schema.safeParse(args);
          if (!parsed.success) return { text: `Error: Invalid tool arguments: ${z.prettifyError(parsed.error)}`.slice(0, 2000), isError: true };
          const reply = await (def.handler as (a: unknown, extra: unknown) => Promise<{ content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }>)(parsed.data, {});
          const parts = reply.content ?? [];
          const image = parts.find((p) => p.type === 'image' && p.data && p.mimeType === 'image/png');
          return {
            text: parts.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') || (image ? 'Picture follows.' : ''),
            ...(reply.isError ? { isError: true } : {}),
            ...(image ? { imageDataUrl: `data:image/png;base64,${image.data}` } : {}),
          };
        },
      };
    });
  }

  /**
   * One real Claude call that turns a described project into a creative plan. No tools, no project
   * files, no generation: it only returns text. Needs the Claude Code sign-in like the chat does.
   */
  async planProject(request: string, refs: PlanReference[] = [], via?: PlanRunner): Promise<ProjectPlan> {
    if (this.status === 'working') throw new Error('Claude is busy with another request. Wait for it to finish or stop it.');
    this.status = 'working';
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const ready = await this.d.imageModels().catch(() => []);
      const models = IMAGE_MODELS.filter((m) => ready.some((p) => p.id === m.provider && p.billable))
        .map((m) => `${m.label} (${m.id}, ${m.note})`);
      const intro = `Templates you may recommend:
${templateCatalogForClaude()}

Available AI image models: ${models.length ? models.join('; ') : 'none set up'}.\n\nThe user wants to create:\n${request}`
        + (refs.length ? `\n\nThe user attached ${refs.length} reference file${refs.length === 1 ? '' : 's'} (kept on their PC; they are imported only after they approve your plan): ${refs.map((r) => `${r.name} (${r.kind}, ${Math.round(r.bytes / 1024)} KB${r.image ? ', shown below' : ''})`).join('; ')}. Take them into account in your plan.` : '');
      let said = '';
      if (via) {
        // Another AI (OpenAI, Gemini, local) plans with the very same prompt, intro and parsing. It only returns text.
        said = await via({ system: PLAN_PROMPT.replace('You are Claude,', 'You are the AI Creative Partner,'), intro,
          images: refs.filter((r) => r.image).map((r) => ({ name: r.name, dataUrl: `data:${r.image!.mediaType};base64,${r.image!.data}` })), signal: abort.signal });
      } else {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const images = refs.filter((r) => r.image);
      const prompt = images.length
        ? (async function* () {
          yield {
            type: 'user' as const, parent_tool_use_id: null, session_id: '',
            message: { role: 'user' as const, content: [
              { type: 'text' as const, text: intro },
              ...images.map((r) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: r.image!.mediaType, data: r.image!.data } })),
            ] },
          };
        })()
        : intro;
      const q = query({
        prompt,
        options: {
          model: this.model, systemPrompt: PLAN_PROMPT, tools: [], allowedTools: [], permissionMode: 'dontAsk',
          settingSources: [], maxTurns: 1, cwd: await this.d.workDir(), abortController: abort,
          env: await this.d.auth.env(),
        },
      });
      for await (const m of q) {
        if (m.type === 'assistant') said += m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
        else if (m.type === 'result') {
          this.costUsd += m.total_cost_usd ?? 0;
          const resultText = 'result' in m ? String(m.result ?? '') : '';
          if (/not logged in|\/login|invalid api key/i.test(resultText)) throw await this.authFailure();
          if (m.is_error) throw new Error('Claude could not make a plan right now. Try again in a moment.');
        }
      }
      }
      const parsed = parseProjectPlan(said);
      if (parsed.template && !builtinTemplates().some((t) => t.id === parsed.template)) parsed.template = null;
      return parsed;
    } catch (e) {
      if (abort.signal.aborted) throw new Error('Planning was cancelled.');
      if (e instanceof Error && /not logged in|\/login|invalid api key/i.test(e.message)) throw await this.authFailure();
      if (e instanceof Error) throw new Error(await this.d.auth.scrub(e.message));
      throw e;
    } finally {
      this.abort = null;
      if (this.status === 'working') this.status = 'idle';
      this.publish();
    }
  }

  /** One no-tools Claude request for the Planner's chat: returns text only, touches no files and no plan. Needs the Claude Code sign-in. */
  async planChat(system: string, prompt: string, model?: string): Promise<string> {
    if (this.status === 'working') throw new Error('Claude is busy with another request. Wait for it to finish or stop it.');
    this.status = 'working';
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const q = query({
        prompt,
        options: {
          model: (model as ClaudeModelId | undefined) ?? this.model, systemPrompt: system, tools: [], allowedTools: [], permissionMode: 'dontAsk',
          settingSources: [], maxTurns: 1, cwd: await this.d.workDir(), abortController: abort,
          env: await this.d.auth.env(),
        },
      });
      let said = '';
      for await (const m of q) {
        if (m.type === 'assistant') said += m.message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n');
        else if (m.type === 'result') {
          this.costUsd += m.total_cost_usd ?? 0;
          const resultText = 'result' in m ? String(m.result ?? '') : '';
          if (/not logged in|\/login|invalid api key/i.test(resultText)) throw await this.authFailure();
          if (m.is_error) throw new Error('Claude could not answer right now. Try again in a moment.');
        }
      }
      if (!said.trim()) throw new Error('Claude sent no text back. Try again.');
      return said;
    } catch (e) {
      if (abort.signal.aborted) throw new Error('The request was cancelled.');
      if (e instanceof Error && /not logged in|\/login|invalid api key/i.test(e.message)) throw await this.authFailure();
      if (e instanceof Error) throw new Error(await this.d.auth.scrub(e.message));
      throw e;
    } finally {
      this.abort = null;
      if (this.status === 'working') this.status = 'idle';
      this.publish();
    }
  }

  /** Sends one message; Claude works until it answers. Streams activity and replies to the panel. */
  async send(message: string): Promise<void> {
    if (this.status === 'working') throw new Error('Claude is still working. Stop it or wait.');
    await this.ready();
    // A new session (project just reopened): give Claude a short summary and the last few messages, not the whole chat.
    const resume = this.sessionId ? '' : buildResumeContext(this.items);
    this.add('user', message);
    this.status = 'working';
    this.publish();
    const abort = new AbortController();
    this.abort = abort;
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk');
      const server = await this.tools();
      const q = query({
        prompt: resume ? `${resume}\n\nNew message from the user:\n${message}` : message,
        options: {
          model: this.model,
          systemPrompt: SYSTEM_PROMPT,
          tools: [],
          mcpServers: { createcraft: server },
          allowedTools: TOOL_NAMES.map((n) => `mcp__createcraft__${n}`),
          permissionMode: 'dontAsk',
          settingSources: [],
          maxTurns: 300,
          cwd: await this.d.workDir(),
          abortController: abort,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          env: await this.d.auth.env(),
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
          if (/not logged in|\/login|invalid api key/i.test(resultText)) {
            const problem = await this.authFailure();
            this.items = this.items.filter((i) => i.text !== resultText);
            this.add('error', problem.message);
          } else if (m.is_error) {
            this.add('error', await this.d.auth.scrub(`Claude stopped: ${'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : m.subtype}`));
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (abort.signal.aborted) this.add('activity', 'Stopped.');
      else if (/not logged in|\/login|invalid api key/i.test(msg)) this.add('error', (await this.authFailure()).message);
      else this.add('error', await this.d.auth.scrub(msg));
    } finally {
      this.abort = null;
      try { (await this.d.live()).claudeDone(); } catch { /* no live doc */ }
      if (this.status === 'working') this.status = 'idle';
      this.publish();
      this.persist(true);
    }
  }
}

export const defaultClaudeCli = () => defaultClaudeCliPath();
