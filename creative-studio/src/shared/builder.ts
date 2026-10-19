// AI Adapter Builder: the contract shared by main and renderer, plus the plain-language wording.
// Nothing here touches the machine. The builder produces PRIVATE, LOCAL integration packages (.ccadapter) for the existing
// Universal Connect framework; it has no sharing, publishing or marketplace concept on purpose.

import type { ControlMethod, IntegrationType, Permission } from './integrations';

/** Generated packages are always labelled with this publisher name; the AI cannot choose its own identity. */
export const BUILDER_PUBLISHER = 'Created on this computer (AI-generated)';

/** Which reusable template turns a blueprint into a package. */
export type TemplateId = 'python-script' | 'cli' | 'file-exchange' | 'dotnet-addin' | 'uxp-plugin';

export const TEMPLATE_LABEL: Record<TemplateId, string> = {
  'python-script': 'Python scripting inside the program',
  cli: 'Command-line program',
  'file-exchange': 'File exchange',
  'dotnet-addin': 'C# / .NET add-in',
  'uxp-plugin': 'Adobe UXP plug-in',
};

/** Where a project is in its life. Only `live-verified` means real commands were run and checked against the real program. */
export type BuilderStatus =
  | 'researching' | 'building' | 'testing'
  | 'needs-documentation'      // not enough trustworthy information: nothing was generated
  | 'not-feasible'             // researched, and it cannot be integrated safely or reliably (reason given)
  | 'failed'
  | 'ready-for-approval'       // built and tested with the program available; waiting for the user
  | 'awaiting-live-verification' // built and tested only with mocks (program not installed or not yet tested)
  | 'installed'                // installed, not yet live-tested
  | 'live-verified'            // at least one command verified against the real program
  | 'needs-repair';

export const STATUS_LABEL: Record<BuilderStatus, string> = {
  researching: 'Checking application compatibility', building: 'Building integration', testing: 'Testing safely',
  'needs-documentation': 'Needs documentation', 'not-feasible': 'Cannot be integrated safely', failed: 'Could not be built',
  'ready-for-approval': 'Ready for your approval', 'awaiting-live-verification': 'Awaiting live verification',
  installed: 'Installed, not tested on the real program yet', 'live-verified': 'Tested on the real program', 'needs-repair': 'Needs repair',
};

/** The understandable steps a beginner sees. */
export type BuilderStage = 'checking' | 'researching' | 'preparing' | 'building' | 'testing' | 'ready' | 'connecting' | 'connected';
export const STAGE_LABEL: Record<BuilderStage, string> = {
  checking: 'Checking application compatibility', researching: 'Researching how the program can be connected', preparing: 'Preparing connector',
  building: 'Building integration', testing: 'Testing safely', ready: 'Ready for your approval', connecting: 'Connecting', connected: 'Connected and tested',
};
export const STAGE_ORDER: BuilderStage[] = ['checking', 'researching', 'preparing', 'building', 'testing', 'ready', 'connecting', 'connected'];

/** What a stage of the test pipeline concluded. `skipped` always says why. */
export type CheckState = 'passed' | 'failed' | 'warning' | 'skipped';
export interface CheckResult { id: string; title: string; state: CheckState; detail: string }

export type PipelineStageId = 'static' | 'security' | 'simulated' | 'live';
export interface PipelineReport {
  stage: PipelineStageId;
  title: string;
  /** failed if any check failed; warning if only warnings; passed if all passed; skipped when the stage could not run. */
  state: CheckState;
  checks: CheckResult[];
  at: string;
  /** Simulated results never prove the program works; this is set on every simulated report. */
  mock?: boolean;
}

export interface ResearchSource { title: string; url: string; kind: 'official' | 'vendor-community' | 'user-supplied' | 'other'; note?: string }
export interface ResearchMethodNote { method: ControlMethod; officialSupport: 'official' | 'partial' | 'none'; note: string }

/** What the research phase found. Every claim must be backed by a source or listed as unknown. */
export interface ResearchReport {
  application: { name: string; publisher: string | null; platforms: string[]; version: string | null };
  summary: string;
  sources: ResearchSource[];
  methods: ResearchMethodNote[];
  scripting: string[];
  commandLine: string[];
  fileFormats: string[];
  pluginTechnologies: string[];
  licensing: string;
  requiredTools: string[];
  limitations: string[];
  /** Set when the information is not enough to generate anything safely: says what is missing. */
  insufficient: string | null;
  /** True when live documentation was read (web or user files). False means the claims are not backed by sources. */
  sourcesConsulted: boolean;
}

/** Per command AND per application version: only a real run against the real program, independently checked, sets `verified`. */
export interface CommandVerification {
  commandId: string;
  appVersion: string;
  state: 'verified' | 'failed' | 'untested';
  at: string;
  evidence: string[];
  detail: string;
}

export interface BuilderFileView { path: string; bytes: number; role: 'manifest' | 'connector' | 'program-script' | 'plugin' | 'docs' | 'tests' | 'other'; text: string | null }

export interface BuilderVersionInfo { version: string; createdAt: string; reason: string; sha256: string; current: boolean; installed: boolean; verifiedCommands: number }

export interface BuilderProjectSummary {
  id: string;
  appName: string;
  publisher: string | null;
  createdAt: string;
  updatedAt: string;
  status: BuilderStatus;
  statusLabel: string;
  /** One plain sentence for the card. */
  headline: string;
  stage: BuilderStage | null;
  adapterId: string | null;
  version: string | null;
  integrationType: IntegrationType | null;
  template: TemplateId | null;
  commandCount: number;
  permissions: Permission[];
  /** The program was found on this PC when the integration was built. */
  appInstalled: boolean;
  appVersion: string | null;
  /** Installed in OmniCandi (reviewed and approved by the user). */
  installed: boolean;
  verification: { verified: number; failed: number; untested: number };
  /** Paths to a package that can be reviewed and installed (null while nothing is built). */
  packagePath: string | null;
  error: string | null;
}

export interface BuilderCommandView {
  id: string; label: string; description: string; permissions: Permission[]; destructive: boolean; readOnly: boolean;
  verifications: CommandVerification[];
}

export interface BuilderProjectDetail extends BuilderProjectSummary {
  /** The project file extension (".uproject") when the program works with project files: live tests then need the full path of one. */
  needsProject: string | null;
  request: { appName: string; fromInstalled: boolean; exePath: string | null; documentation: string[] };
  research: ResearchReport | null;
  decision: { type: IntegrationType; template: TemplateId; methods: ControlMethod[]; rationale: string; feasible: boolean; notFeasibleReason: string | null } | null;
  commands: BuilderCommandView[];
  reports: PipelineReport[];
  files: BuilderFileView[];
  versions: BuilderVersionInfo[];
  log: Array<{ at: string; stage: BuilderStage | null; text: string }>;
  /** What to tell the user to do next when manual action is needed. */
  nextSteps: string[];
  userGuide: string | null;
  /** Compatibility facts for the Advanced section. */
  compatibility: { declared: string; tested: string[]; note: string };
  /** Tokens/cost Claude reported for this project (the user's Claude sign-in; no key is stored). */
  usage: { calls: number; costUsd: number };
  /** A repair waiting for approval, if any. */
  proposal: RepairProposal | null;
  /** Documentation collected for this program: where each document came from and whether it is outdated. */
  documentation: Array<{ origin: string; originLabel: string; title: string; url: string; versionNote: string; fetchedAt: string; bytes: number; outdated: boolean }>;
}

export interface BuilderRequest {
  appName: string;
  /** Option A: the installed program the user picked (its executable path). */
  exePath?: string | null;
  /** Documentation or SDK files/folders the user chose themselves (read locally, sent only to the selected AI provider). */
  documentation?: string[];
  /** Web pages (https links) the user pasted as documentation. Read once as plain text; only public pages. */
  documentationUrls?: string[];
  /** Extra intent in the user's words, e.g. "export to PDF". */
  goal?: string;
}

export interface BuilderProgress {
  projectId: string;
  stage: BuilderStage;
  label: string;
  detail?: string;
  status: BuilderStatus;
}

/** A program on this PC that has no compatible integration yet (Option A). Local information only. */
export interface InstalledProgram {
  key: string;
  name: string;
  publisher: string | null;
  version: string | null;
  /** Best guess at the program file (may be null: then only the name is used). */
  exePath: string | null;
  installLocation: string | null;
}

export interface BuilderOverview {
  /** Installed programs without an integration, newest scan. */
  programs: InstalledProgram[];
  /** Everything built so far, newest first. */
  projects: BuilderProjectSummary[];
  /** Is Claude signed in (the builder needs it for research and generation)? */
  claude: { ready: boolean; reason: string };
}

/** Which group an installed integration belongs to in My Integrations. */
export type IntegrationOrigin = 'official' | 'custom';

export interface MyIntegration {
  adapterId: string;
  name: string;
  version: string;
  origin: IntegrationOrigin;
  publisher: string;
  signed: boolean;
  enabled: boolean;
  state: string;
  stateDetail: string;
  integrationType: IntegrationType;
  commandCount: number;
  /** Custom ones: the builder project it came from. */
  projectId: string | null;
  verification: { verified: number; failed: number; untested: number; summary: string } | null;
  status: BuilderStatus | null;
}

export interface BuilderChangeSummary {
  /** Plain list of what changes between the current and the proposed package. */
  added: string[];
  removed: string[];
  changed: string[];
  newPermissions: Permission[];
  removedPermissions: Permission[];
  /** What the AI said it changed, in its own words (shown as a claim, not as proof). */
  notes: string[];
}

export interface RepairProposal {
  projectId: string;
  fromVersion: string;
  toVersion: string;
  /** What failed, in plain words. */
  problem: string;
  diagnosis: string[];
  changes: BuilderChangeSummary;
  reports: PipelineReport[];
  packagePath: string | null;
  /** True when every automatic check passed. Approval is still required. */
  passed: boolean;
}

/** Plain wording for the first screen. */
export const BUILDER_CONSENT =
  'To build this, OmniCandi asks Claude (your Claude sign-in) to research the program and write the connector. The program\'s name and any documentation you choose are sent to Claude. Nothing else leaves your computer, and nothing is installed or run until you review and approve it.';

/** A permission set is "read only" when no command can change anything. */
export const MUTATING_PERMISSIONS: Permission[] = ['modify-project', 'write-files', 'ui-automation', 'execute-scripts', 'network', 'launch'];

/** Addresses found in text the user pasted (one per line, or separated by spaces or commas). Duplicates removed, bullets and trailing punctuation dropped. */
export function parseLinks(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const t = raw.trim().replace(/^[-*•(<"']+/, '').replace(/[)\].,;>"']+$/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Documentation pages known to describe how a program can be controlled. Offered as one click in Create Custom Integration; the user can still edit the list. */
const UE = 'https://dev.epicgames.com/documentation/en-us/unreal-engine/';
const SUGGESTED_DOC_LINKS: Array<{ match: RegExp; label: string; links: string[]; /** Addresses of this program's documentation take ?application_version=<major.minor>. */ versioned?: RegExp }> = [
  {
    match: /unreal/i, label: 'Unreal Engine', versioned: /^https:\/\/dev\.epicgames\.com\//,
    links: [
      `${UE}scripting-the-unreal-editor-using-python`,
      `${UE}unreal-engine-command-line-arguments-reference`,
      `${UE}python-api/class/EditorAssetLibrary`,
      `${UE}python-api/class/EditorActorSubsystem`,
      `${UE}python-api/class/LevelEditorSubsystem`,
      `${UE}python-api/class/EditorLevelLibrary`,
      `${UE}python-api/class/AssetRegistry`,
      `${UE}python-api/class/AssetExportTask`,
      `${UE}python-api/class/AutomationLibrary`,
      `${UE}python-api/class/EditorLoadingAndSavingUtils`,
    ],
  },
];

/** Suggested documentation links for a program name, or null when none are known. With the program's version, links are for that version. */
export function suggestedLinksFor(programName: string, version?: string | null): { label: string; links: string[] } | null {
  const hit = SUGGESTED_DOC_LINKS.find((x) => x.match.test(programName));
  if (!hit) return null;
  const v = /^(\d+)\.(\d+)/.exec(version ?? '');
  const pin = (u: string) => (v && hit.versioned?.test(u) ? `${u}${u.includes('?') ? '&' : '?'}application_version=${v[1]}.${v[2]}` : u);
  return { label: hit.label, links: hit.links.map(pin) };
}
