// Builds the OmniCandy add-in for Autodesk Revit 2027 (addins/revit/CreateCraft.Revit) and copies the result into the
// connector package folder (fixtures/revit-adapter/plugin). Needs the .NET SDK and a Revit 2027 installation, but only to
// reference Revit's API assemblies: none of Autodesk's files are copied or shipped.
//
//   node scripts/build-revit-addin.mjs [--revit "C:\Program Files\Autodesk\Revit 2027"]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const ri = args.indexOf('--revit');
const proj = path.join(root, 'addins', 'revit', 'CreateCraft.Revit', 'CreateCraft.Revit.csproj');
const dotnetArgs = ['build', proj, '-c', 'Release', '--nologo', '-v', 'q'];
if (ri >= 0) dotnetArgs.push(`-p:RevitInstall=${args[ri + 1]}`);
const r = spawnSync('dotnet', dotnetArgs, { stdio: 'inherit' });
if (r.status !== 0) { console.error('dotnet build failed (is the .NET SDK installed and Revit 2027 present?)'); process.exit(r.status ?? 1); }
const out = path.join(path.dirname(proj), 'bin', 'Release', 'net10.0-windows', 'CreateCraft.Revit.dll');
const dest = path.join(root, 'fixtures', 'revit-adapter', 'plugin', 'CreateCraft.Revit.dll');
fs.copyFileSync(out, dest);
console.log(`copied ${path.relative(root, dest)} (${fs.statSync(dest).size} bytes)`);
