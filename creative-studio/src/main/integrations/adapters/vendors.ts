// Vendor adapter groupings: Autodesk, Adobe and other desktop software. These are honest
// placeholders. They make discovery and the integration screen aware of the program and record the
// planned extension technology, but declare NO commands and cannot connect. Replacing a stub with a
// real adapter means keeping its id, filling in commands and raising maturity; the router and UI
// need no change.

import { ADAPTER_SDK_VERSION, type AdapterManifest } from '@shared/integrations';
import type { AdapterFactory, ExternalAdapter } from '../sdk';

interface StubSpec { id: string; name: string; vendor: string; exe: string[]; display: string; plan: string }

const STUBS: StubSpec[] = [
  { id: 'autodesk.revit', name: 'Revit', vendor: 'Autodesk', exe: ['Revit.exe'], display: '^Autodesk Revit', plan: 'Planned: C#/.NET add-in per Revit year (version-specific module), local pipe to OmniCandi, commands run inside Revit\'s API context (ExternalEvent). Needs the add-in installed with the user\'s approval and a Revit restart.' },
  { id: 'autodesk.autocad', name: 'AutoCAD', vendor: 'Autodesk', exe: ['acad.exe'], display: '^AutoCAD', plan: 'Planned: .NET/AutoLISP bridge plus script (.scr) execution; DXF exchange with CADCraft works without it.' },
  { id: 'autodesk.fusion', name: 'Fusion', vendor: 'Autodesk', exe: ['Fusion360.exe'], display: '^Autodesk Fusion', plan: 'Planned: Fusion Python add-in (local HTTP bridge).' },
  { id: 'autodesk.inventor', name: 'Inventor', vendor: 'Autodesk', exe: ['Inventor.exe'], display: '^Autodesk Inventor', plan: 'Planned: Inventor COM API (out-of-process).' },
  { id: 'autodesk.3dsmax', name: '3ds Max', vendor: 'Autodesk', exe: ['3dsmax.exe'], display: '^Autodesk 3ds Max', plan: 'Planned: MAXScript/Python listener plugin.' },
  { id: 'adobe.photoshop', name: 'Photoshop', vendor: 'Adobe', exe: ['Photoshop.exe'], display: '^Adobe Photoshop', plan: 'Planned: UXP plugin (layers, selections) with a local WebSocket bridge; requires Adobe\'s UXP Developer Tool or a signed plugin, and a Creative Cloud licence.' },
  { id: 'adobe.illustrator', name: 'Illustrator', vendor: 'Adobe', exe: ['Illustrator.exe'], display: '^Adobe Illustrator', plan: 'Planned: ExtendScript/UXP, scripting via COM.' },
  { id: 'adobe.premiere', name: 'Premiere Pro', vendor: 'Adobe', exe: ['Adobe Premiere Pro.exe'], display: '^Adobe Premiere Pro', plan: 'Planned: UXP/CEP panel plus project file exchange.' },
  { id: 'adobe.aftereffects', name: 'After Effects', vendor: 'Adobe', exe: ['AfterFX.exe'], display: '^Adobe After Effects', plan: 'Planned: ExtendScript (aerender for batch).' },
  { id: 'adobe.indesign', name: 'InDesign', vendor: 'Adobe', exe: ['InDesign.exe'], display: '^Adobe InDesign', plan: 'Planned: UXP scripting.' },
  { id: 'freecad', name: 'FreeCAD', vendor: 'FreeCAD', exe: ['FreeCAD.exe', 'FreeCADCmd.exe'], display: '^FreeCAD', plan: 'Planned: FreeCADCmd background Python, like the Blender adapter.' },
  { id: 'godot', name: 'Godot', vendor: 'Godot Engine', exe: ['Godot.exe'], display: '^Godot', plan: 'Planned: headless GDScript runs (--headless --script).' },
  { id: 'unreal', name: 'Unreal Engine', vendor: 'Epic Games', exe: ['UnrealEditor.exe'], display: '^Unreal Engine', plan: 'Planned: editor Python / Remote Control API.' },
  { id: 'unity', name: 'Unity', vendor: 'Unity Technologies', exe: ['Unity.exe'], display: '^Unity', plan: 'Planned: batch-mode editor scripts.' },
];

function stubFactory(s: StubSpec): AdapterFactory {
  const manifest: AdapterManifest = {
    id: s.id, name: s.name, vendor: s.vendor, sdkVersion: ADAPTER_SDK_VERSION, maturity: 'stub',
    exeNames: s.exe, displayNames: [s.display], versions: {}, methods: [], capabilities: ['detect', 'inspectCapabilities'], commands: [],
    notes: s.plan,
  };
  const adapter: ExternalAdapter = {
    probe: async () => ({ version: null }),
    connect: async () => { throw new Error(`${s.name} integration is not built yet.`); },
    disconnect: async () => undefined,
    healthCheck: async () => ({ ok: false, detail: 'Not implemented.' }),
    execute: async () => { throw new Error(`${s.name} integration is not built yet.`); },
    dispose: async () => undefined,
  };
  return { manifest, create: () => adapter };
}

export const vendorStubs: AdapterFactory[] = STUBS.map(stubFactory);
