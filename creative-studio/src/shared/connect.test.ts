import { describe, expect, it } from 'vitest';
import { approvalDetail, chipText, classifyApp, explainConnectFailure, installRoot, PERMISSION_PLAIN, sameInstall, type AdapterOffer } from './connect';
import { PERMISSION_LABEL, type ExternalAppInfo, type IntegrationStatus, type Permission } from './integrations';

const app = (over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  key: 'c:\\x\\app.exe', name: 'App', publisher: null, version: '1.0', exePath: 'C:\\x\\app.exe', installType: 'installed', source: 'registry',
  adapterId: 'app', adapterName: 'App', maturity: 'verified', methods: ['scripting'], status: 'available', statusDetail: 'Ready to connect.', commands: [],
  granted: [], permissionsNeeded: ['read-info'], notes: null, adapterVersion: null, origin: 'built-in', trust: 'built-in', requirements: [], selfContained: false, ...over,
});
const offer: AdapterOffer = { source: 'bundled', path: 'C:\\c\\a.ccadapter', adapterId: 'app', name: 'App', version: '1.0.0', publisherName: 'P', signature: 'valid', publisherTrusted: false, permissions: ['read-info'] };
const cls = (a: ExternalAppInfo, o: AdapterOffer | null = null) => classifyApp({ app: a, offer: o, forgettable: false });

describe('classifyApp: every status in plain words', () => {
  it('ready, connected, experimental-connected', () => {
    expect(cls(app())).toMatchObject({ group: 'ready', selectable: true, adapterState: 'installed', experimental: false });
    expect(cls(app({ status: 'connected' }))).toMatchObject({ group: 'connected', selectable: false, headline: 'Connected and tested' });
    expect(cls(app({ status: 'limited', maturity: 'experimental' }))).toMatchObject({ group: 'connected', experimental: true, headline: 'Connected (experimental)' });
  });

  it('experimental but not connected yet (Resolve): selectable and labelled', () => {
    const e = cls(app({ maturity: 'experimental', adapterId: 'davinci.resolve' }));
    expect(e).toMatchObject({ group: 'ready', experimental: true, selectable: true });
    expect(e.headline).toMatch(/experimental/);
    expect(e.explanation).toMatch(/limited or untested/);
  });

  it('not running, scripting off and needs-repair can be retried; incompatible cannot', () => {
    expect(cls(app({ status: 'not-running', statusDetail: 'Resolve is not running.' }))).toMatchObject({ group: 'attention', selectable: true, headline: 'Open the program first' });
    expect(cls(app({ status: 'api-unavailable', statusDetail: 'Turn on external scripting.' }))).toMatchObject({ group: 'attention', selectable: true });
    expect(cls(app({ status: 'api-unavailable', statusDetail: 'Turn on external scripting.' })).explanation).toMatch(/Turn on external scripting/);
    expect(cls(app({ status: 'needs-repair' }))).toMatchObject({ group: 'attention', selectable: true });
    const inc = cls(app({ status: 'incompatible', statusDetail: 'Version 2.0 is older than the supported 3.6-4.9.' }));
    expect(inc).toMatchObject({ group: 'incompatible', selectable: false });
    expect(inc.explanation).toMatch(/older than the supported/);
  });

  it('a detected program with a connector that can be installed is selectable and says what happens', () => {
    const e = cls(app({ adapterId: null, adapterName: null, maturity: null, status: 'unsupported', name: 'FreeCAD' }), offer);
    expect(e).toMatchObject({ group: 'needs-adapter', adapterState: 'available', selectable: true, headline: 'Connector available' });
    expect(e.explanation).toMatch(/you review it first/);
  });

  it('a detected program without any connector is explained simply and is not selectable', () => {
    const none = cls(app({ adapterId: null, adapterName: null, maturity: null, status: 'unsupported', name: 'Gimp' }));
    expect(none).toMatchObject({ group: 'unsupported', adapterState: 'none', selectable: false });
    expect(none.explanation).toMatch(/has no connector for it/);
    expect(none.explanation).not.toMatch(/badapterb|bAPIb|script/i);
    const planned = cls(app({ maturity: 'stub', status: 'unsupported', name: 'Revit' }));
    expect(planned).toMatchObject({ group: 'unsupported', adapterState: 'planned', selectable: false });
    expect(planned.explanation).toMatch(/cannot control it yet/);
  });

  it('beginner wording never leaks framework jargon in headlines or explanations', () => {
    const statuses: IntegrationStatus[] = ['detected', 'available', 'connected', 'limited', 'unsupported', 'needs-repair', 'incompatible', 'not-running', 'api-unavailable'];
    for (const status of statuses) {
      for (const o of [null, offer]) {
        const e = cls(app({ status, ...(status === 'unsupported' ? { adapterId: null, maturity: null } : {}) }), o);
        expect(`${e.headline} ${e.explanation}`.replace(e.statusDetail, '')).not.toMatch(/\badapter\b|\bAPI\b|scripting|JSON|manifest/i);
        expect(chipText(e).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('plain-language permissions', () => {
  it('every permission has a plain title that is different from the technical label, and a level', () => {
    for (const p of Object.keys(PERMISSION_LABEL) as Permission[]) {
      expect(PERMISSION_PLAIN[p].title.length).toBeGreaterThan(8);
      expect(PERMISSION_PLAIN[p].title).not.toBe(PERMISSION_LABEL[p]);
      expect(['low', 'medium', 'high']).toContain(PERMISSION_PLAIN[p].level);
    }
  });

  it('the native question is plain first and keeps the technical names for advanced users', () => {
    const t = approvalDetail({ command: { description: 'Make a cube.' }, params: { name: 'cube' }, needed: ['execute-scripts', 'write-files'], destructive: false });
    expect(t).toContain('Make a cube.');
    expect(t).toContain('Run automation steps inside the program');
    expect(t).toContain('Technical: run scripts inside the application; write or export files.');
    expect(t).toContain('Settings: name cube');
    expect(t).toMatch(/existing files are not changed/);
    const d = approvalDetail({ command: { description: 'Delete.' }, params: {}, needed: [], destructive: true, untrusted: true });
    expect(d).toMatch(/already allowed/);
    expect(d).toMatch(/NOT signed/);
    expect(d).toMatch(/asked every time/);
  });
});

describe('same installation', () => {
  it('treats two executables of one install as the same, and different versions as different', () => {
    expect(sameInstall('E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', 'E:\\FreeCAD 1.1\\bin\\FreeCADCmd.exe')).toBe(true);
    expect(sameInstall('E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', 'e:/freecad 1.1/FreeCADCmd.exe')).toBe(true);
    expect(sameInstall('E:\\FreeCAD 1.1\\bin\\FreeCAD.exe', 'E:\\FreeCAD 0.21\\bin\\FreeCAD.exe')).toBe(false);
    expect(installRoot('C:\\a\\bin\\x.exe')).toBe('c:\\a');
  });
});

describe('failure wording', () => {
  it('turns raw failures into what to do', () => {
    expect(explainConnectFailure('not-running', 'DaVinci Resolve', 'x').detail).toMatch(/Open DaVinci Resolve/);
    expect(explainConnectFailure('api-unavailable', 'R', 'Studio only.').detail).toMatch(/Studio only/);
    expect(explainConnectFailure('needs-repair', 'R', 'spawn error').headline).toBe('Could not connect to R');
  });
});
