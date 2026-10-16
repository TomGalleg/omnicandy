// "dotnet-addin" and "uxp-plugin" templates: source for code that runs INSIDE the program. Today these produce SOURCE FOR REVIEW
// ONLY: CreateCraft does not compile add-ins against vendor SDKs, and its plug-in bridge is a Windows named pipe that Adobe UXP
// plug-ins cannot open, so nothing generated here can be installed or connected yet. The templates still do the useful safe
// part: lay the sources out, derive the capability contract from the blueprint, and refuse sources that touch processes, files,
// the registry or the network.

import type { Blueprint } from '../blueprint';

const buf = (s: string) => Buffer.from(s, 'utf8');

/** Files of the source bundle, keyed by path under plugin-src/. */
export function renderPluginSource(bp: Blueprint): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const p = bp.plugin;
  if (!p) return out;
  for (const f of p.files) out.set(`plugin-src/${f.path}`, buf(f.content));
  out.set('plugin-src/bridge-contract.json', buf(`${JSON.stringify({
    note: 'The capabilities this add-in may register with CreateCraft. CreateCraft refuses anything not listed here and anything whose permissions the user did not approve.',
    application: bp.application.name, hostProfile: bp.decision.hostProfile, technology: p.technology,
    capabilities: p.capabilities,
    commands: bp.commands.map((c) => ({ command: c.id, capability: c.plugin?.capability ?? null, permissions: c.permissions })),
  }, null, 2)}\n`));
  if (p.technology === 'uxp' && !p.files.some((f) => f.path === 'manifest.json')) {
    out.set('plugin-src/manifest.json', buf(`${JSON.stringify({
      manifestVersion: 5, id: `custom.${bp.application.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}.createcraft`, name: `${bp.application.name} for CreateCraft`, version: '1.0.0',
      main: 'index.html', host: { app: 'TO_BE_CONFIRMED_BY_THE_USER', minVersion: '0' }, requiredPermissions: {},
      note: 'Generated scaffold: confirm the host id and minimum version in the vendor documentation before loading this plug-in.',
    }, null, 2)}\n`));
  }
  out.set('plugin-src/README.md', buf(`# ${bp.application.name} add-in (generated source, not installable yet)\n\nTechnology: ${p.technology}\n\nThis folder is a review copy. CreateCraft cannot build, install or connect it today. See the integration's limitations in the app.\n`));
  return out;
}

const CS_DENIED: Array<[RegExp, string]> = [
  [/\bProcess\s*\.\s*Start\b|System\.Diagnostics\.Process\b|\bProcessStartInfo\b/, 'starts processes'],
  [/\bFile\s*\.\s*(Delete|Move|Replace|WriteAll\w*|Create)\b|\bDirectory\s*\.\s*(Delete|CreateDirectory|Move)\b|\bFileStream\b|\bStreamWriter\b/, 'writes or deletes files'],
  [/\bWebClient\b|\bHttpClient\b|\bSocket\b|\bTcpClient\b|\bWebRequest\b|\bHttpWebRequest\b|System\.Net\b/, 'uses the network'],
  [/\bAssembly\s*\.\s*(Load\w*|UnsafeLoad\w*)\b|\bActivator\s*\.\s*CreateInstance\b|\bDllImport\b|\bMarshal\s*\.\s*GetDelegateForFunctionPointer\b|\bCSharpScript\b|\bCodeDom\b/, 'loads or generates code'],
  [/\bRegistry\b|\bMicrosoft\.Win32\b|\bEnvironment\s*\.\s*(Exit|SetEnvironmentVariable|FailFast)\b|\bSendKeys\b/, 'touches the registry, environment or keyboard'],
];
const JS_DENIED: Array<[RegExp, string]> = [
  [/require\s*\(\s*['"](child_process|fs|os|net|http|https|dgram|worker_threads|vm)['"]\s*\)|from\s+['"](child_process|net|http|https)['"]/, 'imports process, network or file modules'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\s*\.\s*sendBeacon\b/, 'uses the network (CreateCraft has no network transport for UXP yet)'],
  [/\beval\s*\(|\bnew\s+Function\s*\(|\bsetTimeout\s*\(\s*['"]/, 'runs text as code'],
  [/\bshell\s*\.\s*(openExternal|openPath)\b|\blocalFileSystem\b|\bstorage\s*\.\s*localFileSystem\b/, 'opens external programs or reads the disk'],
];

export interface PluginFinding { file: string; problems: string[] }

export function pluginSourceFindings(bp: Blueprint): PluginFinding[] {
  const p = bp.plugin;
  if (!p) return [];
  return p.files.map((f) => {
    const problems: string[] = [];
    const isCs = /\.cs$/i.test(f.path);
    const isJs = /\.(js|mjs|cjs|jsx)$/i.test(f.path);
    if (isCs) {
      for (const [re, why] of CS_DENIED) if (re.test(f.content)) problems.push(`the source ${why}`);
      let depth = 0;
      for (const c of f.content.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')) { if (c === '{') depth++; else if (c === '}') depth--; if (depth < 0) break; }
      if (depth !== 0) problems.push('braces are not balanced');
    } else if (isJs) {
      for (const [re, why] of JS_DENIED) if (re.test(f.content)) problems.push(`the source ${why}`);
    } else if (/\.json$/i.test(f.path)) {
      try { JSON.parse(f.content); } catch (e) { problems.push(`not valid JSON: ${(e as Error).message}`); }
    }
    return { file: f.path, problems: [...new Set(problems)] };
  });
}
