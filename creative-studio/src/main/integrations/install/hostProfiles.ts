// Host profiles: what CreateCraft itself knows about WHERE and HOW a program accepts plugins.
//
// This table is owned by CreateCraft, not by packages. A package's manifest can only name a profile id and a
// destination id from it; the folders, scopes, allowed file types and size limits below decide what the installer
// may touch, whatever the manifest says. A package can therefore never grant itself a new write location.
//
// Readiness is deliberately conservative:
//   simulated-test  a built-in test double (SimCAD). Real code paths, no real software.
//   groundwork      the vendor mechanism is documented here; NO working CreateCraft plugin exists for it yet.
//   supported       a real CreateCraft add-in exists AND was run against the real program (see the program's doc for what
//                   was verified). Only Autodesk Revit 2027 is in this state.

import path from 'node:path';
import type { PluginTechnology } from '@shared/integrations';

export type Scope = 'user' | 'machine';

export interface InstallEnv {
  /** Environment variables the destination templates read (APPDATA, PROGRAMDATA, ...). Injected so tests never touch the real PC. */
  vars: Record<string, string | undefined>;
  /** Root folder of the simulated test application (SimCAD). */
  simHostRoot: string;
}

export interface DestinationDef {
  id: string;
  label: string;
  scope: Scope;
  /** Writing here needs administrator rights on a default Windows setup. */
  admin: boolean;
  /** Path template. `%NAME%` reads InstallEnv.vars; `{year}` is the program's release year; `{sim}` is InstallEnv.simHostRoot. */
  template: string;
  /** File extensions (lower case, with dot) the installer will write here. Anything else is refused. */
  extensions: string[];
  maxFileBytes: number;
  maxFiles: number;
  /** Plugin technologies that legitimately live in this destination. */
  technologies: PluginTechnology[];
}

export type Restart = 'required' | 'not-required' | 'unknown';

export interface HostProfile {
  id: string;
  vendor: string;
  name: string;
  readiness: 'simulated-test' | 'groundwork' | 'supported';
  exeNames: string[];
  /** Process names checked to see whether the program is open (never ended by CreateCraft). */
  processNames: string[];
  destinations: DestinationDef[];
  /** Supported desktop versions as the vendor documents them; empty when only a test double. */
  supportedVersions: string;
  /** Plugin technologies the vendor supports on desktop, in rough order of preference for CreateCraft. */
  technologies: Array<{ id: PluginTechnology; label: string; note: string }>;
  restart: Restart;
  restartNote: string;
  adminNote: string;
  /** How CreateCraft and a plugin inside the program could talk. */
  communication: string;
  /** Threading/API-context rule commands must respect. */
  apiContext: string;
  vendorInstall: string;
  restrictions: string[];
  /** Official documentation entry points (not fetched at runtime). */
  docs: string[];
  /** How sure this entry is. Nothing here was run against the real program. */
  confidence: 'vendor-documented' | 'vendor-documented-partly-confirm';
}

const MB = 1024 * 1024;
const NET_EXT = ['.dll', '.addin', '.json', '.xml', '.config', '.pdb'];
const BUNDLE_EXT = ['.xml', '.dll', '.json', '.js', '.py', '.cuix', '.lsp', '.scr', '.png', '.ico', '.txt', '.config'];

export const SIMCAD_PROFILE: HostProfile = {
  id: 'simcad',
  vendor: 'CreateCraft test double',
  name: 'SimCAD (simulated application)',
  readiness: 'simulated-test',
  exeNames: [],
  processNames: [],
  destinations: [{
    id: 'simcad-plugins', label: 'SimCAD plugin folder', scope: 'user', admin: false, template: '{sim}/plugins',
    extensions: ['.js', '.json'], maxFileBytes: 1 * MB, maxFiles: 20, technologies: ['node-module'],
  }, {
    id: 'simcad-machine-plugins', label: 'SimCAD shared plugin folder (needs administrator)', scope: 'machine', admin: true, template: '{sim}/machine-plugins',
    extensions: ['.js', '.json'], maxFileBytes: 1 * MB, maxFiles: 20, technologies: ['node-module'],
  }],
  supportedVersions: 'SimCAD 1.x (test double only)',
  technologies: [{ id: 'node-module', label: 'Node module loaded at start-up', note: 'The simulated application loads every module in its plugin folder when it starts.' }],
  restart: 'required',
  restartNote: 'SimCAD loads plugins only when it starts, like many real programs.',
  adminNote: 'The user plugin folder needs no administrator rights; the shared folder is a stand-in for a protected location.',
  communication: 'CreateCraft plugin bridge over a Windows named pipe.',
  apiContext: 'SimCAD only lets its API be used from its own tick loop; the plugin hands every command over to that loop.',
  vendorInstall: 'None: file copy into the plugin folder.',
  restrictions: ['Simulated behaviour. Results from SimCAD prove the CreateCraft plumbing, not any real program.'],
  docs: [],
  confidence: 'vendor-documented',
};

const AUTODESK_DOCS = 'https://aps.autodesk.com/developer/overview';

export const VENDOR_PROFILES: HostProfile[] = [
  {
    id: 'autodesk.revit', vendor: 'Autodesk', name: 'Revit', readiness: 'supported',
    exeNames: ['Revit.exe'], processNames: ['Revit.exe'],
    destinations: [
      { id: 'revit-addins-user', label: 'Revit add-ins (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/Revit/Addins/{year}', extensions: NET_EXT, maxFileBytes: 64 * MB, maxFiles: 60, technologies: ['dotnet-addin'] },
      { id: 'revit-addins-machine', label: 'Revit add-ins (all users)', scope: 'machine', admin: true, template: '%PROGRAMDATA%/Autodesk/Revit/Addins/{year}', extensions: NET_EXT, maxFileBytes: 64 * MB, maxFiles: 60, technologies: ['dotnet-addin'] },
      { id: 'autodesk-appplugins-user', label: 'Autodesk application plug-ins bundle (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/ApplicationPlugins', extensions: BUNDLE_EXT.concat(['.addin']), maxFileBytes: 64 * MB, maxFiles: 80, technologies: ['bundle', 'dotnet-addin'] },
    ],
    supportedVersions: 'A separate add-in build per Revit release year (.NET Framework 4.8 up to Revit 2024, .NET 8 for 2025 and 2026, .NET 10 for Revit 2027). CreateCraft ships the Revit 2027 build only.',
    technologies: [{ id: 'dotnet-addin', label: '.NET add-in with an .addin manifest', note: 'Revit reads *.addin manifests from the Addins/<year> folders at start-up.' }],
    restart: 'required', restartNote: 'Revit reads add-in manifests when it starts. A running Revit must be restarted.',
    adminNote: 'The per-user folder needs no administrator rights; the all-users ProgramData folder does.',
    communication: 'Plugin dials CreateCraft\'s named pipe. Commands are queued and run through a Revit ExternalEvent handler.',
    apiContext: 'The Revit API may only be used inside a valid API context (a command, an event or an ExternalEvent handler). Never from a background thread.',
    vendorInstall: 'Autodesk App Store bundles (PackageContents.xml in an ApplicationPlugins .bundle) are the vendor-recommended distribution; a plain .addin copy is the documented manual route.',
    restrictions: ['One build per release year.', 'Modifying the model needs a Transaction, and Revit may show its own security prompt for unsigned add-ins.'],
    docs: ['https://help.autodesk.com/view/RVT/2025/ENU/?guid=Revit_API_Revit_API_Developers_Guide_Introduction_Add_In_Integration_Add_in_Registration_html', AUTODESK_DOCS],
    confidence: 'vendor-documented',
  },
  {
    id: 'autodesk.autocad', vendor: 'Autodesk', name: 'AutoCAD', readiness: 'groundwork',
    exeNames: ['acad.exe'], processNames: ['acad.exe'],
    destinations: [
      { id: 'autodesk-appplugins-user', label: 'Autodesk application plug-ins bundle (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/ApplicationPlugins', extensions: BUNDLE_EXT, maxFileBytes: 64 * MB, maxFiles: 80, technologies: ['bundle', 'dotnet-addin'] },
      { id: 'autodesk-appplugins-machine', label: 'Autodesk application plug-ins bundle (all users)', scope: 'machine', admin: true, template: '%PROGRAMDATA%/Autodesk/ApplicationPlugins', extensions: BUNDLE_EXT, maxFileBytes: 64 * MB, maxFiles: 80, technologies: ['bundle', 'dotnet-addin'] },
    ],
    supportedVersions: '.NET Framework 4.8 plug-ins up to AutoCAD 2024; .NET 8 plug-ins from AutoCAD 2025. Build per release series.',
    technologies: [
      { id: 'bundle', label: '.bundle folder with PackageContents.xml (autoloader)', note: 'The product loads bundles it finds in ApplicationPlugins.' },
      { id: 'dotnet-addin', label: '.NET assembly (NETLOAD or autoloader)', note: 'Managed API (AcDbMgd/AcMgd).' },
    ],
    restart: 'required', restartNote: 'Bundles are discovered when AutoCAD starts; a running session must be restarted (or the plug-in loaded by hand).',
    adminNote: 'The per-user ApplicationPlugins folder needs no administrator rights; the all-users one does.',
    communication: 'Plugin dials the named pipe; commands are executed on the main thread via the document/command context.',
    apiContext: 'Database changes must run in the application context with the document locked; do not touch the API from other threads.',
    vendorInstall: 'Autoloader .bundle (PackageContents.xml) is the vendor mechanism.',
    restrictions: ['The SECURELOAD system variable may restrict loading from untrusted folders.', 'Series-specific builds.'],
    docs: [AUTODESK_DOCS], confidence: 'vendor-documented-partly-confirm',
  },
  {
    id: 'autodesk.fusion', vendor: 'Autodesk', name: 'Fusion', readiness: 'groundwork',
    exeNames: ['Fusion360.exe'], processNames: ['Fusion360.exe'],
    destinations: [
      { id: 'fusion-addins-user', label: 'Fusion add-ins (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/Autodesk Fusion 360/API/AddIns', extensions: ['.py', '.json', '.manifest', '.png', '.txt', '.dll'], maxFileBytes: 32 * MB, maxFiles: 80, technologies: ['python-addin'] },
    ],
    supportedVersions: 'Current Fusion desktop release (single rolling version).',
    technologies: [{ id: 'python-addin', label: 'Python (or C++) add-in with a .manifest file', note: 'Started from the Scripts and Add-Ins dialog, optionally at Fusion start-up.' }],
    restart: 'not-required', restartNote: 'An add-in can be started from the Scripts and Add-Ins dialog without restarting Fusion.',
    adminNote: 'Per-user folder; no administrator rights.',
    communication: 'Add-in connects to the named pipe (or a loopback socket) from a worker thread and passes work to the main thread with a custom event.',
    apiContext: 'The Fusion API is not thread-safe; use a custom event to run commands on the main thread.',
    vendorInstall: 'Autodesk App Store or manual copy plus the Scripts and Add-Ins dialog.',
    restrictions: ['The user has to enable the add-in once inside Fusion.'],
    docs: [AUTODESK_DOCS], confidence: 'vendor-documented-partly-confirm',
  },
  {
    id: 'autodesk.inventor', vendor: 'Autodesk', name: 'Inventor', readiness: 'groundwork',
    exeNames: ['Inventor.exe'], processNames: ['Inventor.exe'],
    destinations: [
      { id: 'inventor-addins-user', label: 'Inventor add-ins (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/Inventor {year}/Addins', extensions: NET_EXT, maxFileBytes: 64 * MB, maxFiles: 60, technologies: ['dotnet-addin'] },
      { id: 'inventor-addins-machine', label: 'Inventor add-ins (all users)', scope: 'machine', admin: true, template: '%PROGRAMDATA%/Autodesk/Inventor Addins', extensions: NET_EXT, maxFileBytes: 64 * MB, maxFiles: 60, technologies: ['dotnet-addin'] },
    ],
    supportedVersions: 'Build per Inventor release year.',
    technologies: [{ id: 'dotnet-addin', label: '.NET add-in with an .addin manifest', note: 'Add-ins are listed in the Add-In Manager.' }],
    restart: 'required', restartNote: 'Add-ins are registered when Inventor starts; a running session needs a restart.',
    adminNote: 'The per-user folder needs no administrator rights; the shared folder does.',
    communication: 'Add-in dials the named pipe; execution happens in the Inventor application context.',
    apiContext: 'Inventor\'s API is apartment-threaded COM: marshal calls to the main thread.',
    vendorInstall: 'Autodesk App Store bundles or manual .addin copy.',
    restrictions: ['COM apartment rules apply.'],
    docs: [AUTODESK_DOCS], confidence: 'vendor-documented-partly-confirm',
  },
  {
    id: 'autodesk.3dsmax', vendor: 'Autodesk', name: '3ds Max', readiness: 'groundwork',
    exeNames: ['3dsmax.exe'], processNames: ['3dsmax.exe'],
    destinations: [
      { id: 'autodesk-appplugins-user', label: 'Autodesk application plug-ins bundle (this user)', scope: 'user', admin: false, template: '%APPDATA%/Autodesk/ApplicationPlugins', extensions: BUNDLE_EXT, maxFileBytes: 64 * MB, maxFiles: 80, technologies: ['bundle', 'python-addin', 'maxscript'] },
    ],
    supportedVersions: 'Per 3ds Max release year (Python 3 via pymxs from recent releases).',
    technologies: [
      { id: 'bundle', label: '.bundle with PackageContents.xml', note: 'Autodesk\'s shared plug-in loader.' },
      { id: 'python-addin', label: 'Python (pymxs) start-up script', note: 'Runs inside 3ds Max.' },
      { id: 'maxscript', label: 'MAXScript', note: 'Start-up script.' },
    ],
    restart: 'required', restartNote: 'Plug-ins and start-up scripts load when 3ds Max starts.',
    adminNote: 'The per-user bundle folder needs no administrator rights.',
    communication: 'Script plug-in connects to the named pipe; work is applied on the main thread.',
    apiContext: 'The scene must only be modified from the main thread.',
    vendorInstall: 'Autodesk App Store bundle or manual copy.',
    restrictions: ['Python/.NET runtime differs by release.'],
    docs: [AUTODESK_DOCS], confidence: 'vendor-documented-partly-confirm',
  },
  adobeProfile('adobe.photoshop', 'Photoshop', ['Photoshop.exe'], 'UXP plug-in (current) or CEP panel (older) and ExtendScript / COM scripting.', [
    { id: 'uxp', label: 'UXP plug-in (.ccx)', note: 'Distributed through Adobe\'s Unified Plugin Installer / Creative Cloud; developer loading uses the UXP Developer Tool.' },
    { id: 'cep', label: 'CEP panel (legacy)', note: 'Adobe is moving panels to UXP; CEP availability depends on the Photoshop release.' },
    { id: 'extendscript', label: 'ExtendScript (.jsx)', note: 'Scripting, runs on the main thread.' },
  ]),
  adobeProfile('adobe.illustrator', 'Illustrator', ['Illustrator.exe'], 'CEP panel and ExtendScript today; confirm current UXP support in Adobe\'s documentation.', [
    { id: 'cep', label: 'CEP panel', note: 'Check the Illustrator release notes for CEP/UXP status.' },
    { id: 'extendscript', label: 'ExtendScript (.jsx)', note: 'Scripting.' },
  ], 'vendor-documented-partly-confirm'),
  adobeProfile('adobe.premiere', 'Premiere Pro', ['Adobe Premiere Pro.exe'], 'UXP plug-in (newer releases) or CEP panel, plus project-file exchange.', [
    { id: 'uxp', label: 'UXP plug-in', note: 'Newer Premiere Pro releases; scripting surface is narrower than Photoshop\'s.' },
    { id: 'cep', label: 'CEP panel (legacy)', note: 'Older releases.' },
  ], 'vendor-documented-partly-confirm'),
  adobeProfile('adobe.aftereffects', 'After Effects', ['AfterFX.exe'], 'ExtendScript / ScriptUI panels and C++ AEGP plug-ins; CEP panels.', [
    { id: 'extendscript', label: 'ExtendScript / ScriptUI panel', note: 'Scripts folder lives inside the program folder (administrator rights).' },
    { id: 'cep', label: 'CEP panel', note: 'Per-user or all-users extensions folder.' },
  ], 'vendor-documented-partly-confirm'),
  adobeProfile('adobe.indesign', 'InDesign', ['InDesign.exe'], 'UXP scripting/plug-ins, CEP panel and ExtendScript.', [
    { id: 'uxp', label: 'UXP plug-in or script', note: 'Supported in recent InDesign releases.' },
    { id: 'cep', label: 'CEP panel (legacy)', note: 'Older releases.' },
    { id: 'extendscript', label: 'ExtendScript (.jsx)', note: 'Scripts Panel folder.' },
  ], 'vendor-documented-partly-confirm'),
];

function adobeProfile(id: string, name: string, exe: string[], summary: string, technologies: HostProfile['technologies'], confidence: HostProfile['confidence'] = 'vendor-documented-partly-confirm'): HostProfile {
  return {
    id, vendor: 'Adobe', name, readiness: 'groundwork', exeNames: exe, processNames: exe,
    destinations: [
      { id: 'adobe-cep-user', label: 'Adobe CEP extensions (this user)', scope: 'user', admin: false, template: '%APPDATA%/Adobe/CEP/extensions', extensions: ['.html', '.js', '.jsx', '.json', '.xml', '.css', '.png', '.svg', '.txt'], maxFileBytes: 32 * MB, maxFiles: 200, technologies: ['cep'] },
      { id: 'adobe-cep-machine', label: 'Adobe CEP extensions (all users)', scope: 'machine', admin: true, template: '%COMMONPROGRAMFILES%/Adobe/CEP/extensions', extensions: ['.html', '.js', '.jsx', '.json', '.xml', '.css', '.png', '.svg', '.txt'], maxFileBytes: 32 * MB, maxFiles: 200, technologies: ['cep'] },
    ],
    supportedVersions: 'Creative Cloud desktop releases that still ship the technology listed; the exact range changes per release and must be confirmed per program version.',
    technologies,
    restart: 'unknown', restartNote: 'Panels are usually picked up when the program starts; UXP plug-ins installed through Creative Cloud may load without a restart. Confirm per program.',
    adminNote: 'Per-user folders need no administrator rights; all-users folders and folders inside the program\'s own folder do.',
    communication: `Panel or plug-in connects to the named pipe (or a loopback socket where the technology has no pipe access). ${summary}`,
    apiContext: 'Host scripting must be invoked through the host\'s own scripting entry point (main thread); UXP calls go through the plug-in\'s host APIs.',
    vendorInstall: 'Adobe\'s Unified Plugin Installer Agent / Creative Cloud installs signed .ccx and .zxp packages. CreateCraft guides this workflow instead of copying files for UXP.',
    restrictions: ['CEP panels that are not signed need PlayerDebugMode, which CreateCraft will not switch on silently.', 'A Creative Cloud licence is required for the program itself.'],
    docs: ['https://developer.adobe.com/uxp/', 'https://github.com/Adobe-CEP/CEP-Resources'], confidence,
  };
}

export const ALL_PROFILES: HostProfile[] = [SIMCAD_PROFILE, ...VENDOR_PROFILES];

export function profileById(id: string): HostProfile | null { return ALL_PROFILES.find((p) => p.id === id) ?? null; }

/** Resolves a destination folder from the installer's own table. Null when it cannot be resolved (unknown year or variable). */
export function resolveDestination(d: DestinationDef, env: InstallEnv, hostVersion: string | null): string | null {
  let t = d.template;
  if (t.includes('{year}')) {
    const year = yearOf(hostVersion);
    if (!year) return null;
    t = t.replace('{year}', year);
  }
  t = t.replace('{sim}', env.simHostRoot.replace(/\\/g, '/'));
  let missing = false;
  t = t.replace(/%([A-Za-z_]+)%/g, (_m, n: string) => {
    const v = env.vars[n.toUpperCase()] ?? env.vars[n];
    if (!v) { missing = true; return ''; }
    return v.replace(/\\/g, '/');
  });
  if (missing || /%|\{|\}/.test(t)) return null;
  return path.resolve(t);
}

/** "2027" from "2027", "2027.1.0", "27.0" (Revit-style short numbers become 2000+n). Null when not recognisable. */
export function yearOf(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d{2,4})/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n >= 2000 && n <= 2100) return String(n);
  if (n >= 10 && n <= 99) return String(2000 + n);
  return null;
}
