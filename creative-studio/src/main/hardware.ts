// Hardware check for Free local AI video. Read-only: asks Windows what is installed and looks for
// backend runtimes. It never generates anything, so every backend is reported "untested" until a
// real self-test generation passes (a later stage).

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { currentOs, type OsId } from '@shared/platform';
import { isIntegrated, vendorOf, type BackendProbe, type GpuInfo, type HardwareReport } from '@shared/localAi';

import { detectGpusLinux, hasAvx2, probeBackendsLinux, realSysFs, type SysFs } from './platform/gpuLinux';

export type Run = (cmd: string, args: string[]) => Promise<string>;

const defaultRun: Run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
});

// Display adapters from WMI (AdapterRAM is capped at 4 GB there) and the driver's registry entry
// (qwMemorySize is the real dedicated memory).
const GPU_SCRIPT = [
  "$r=@{}",
  "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
  "Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object { $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if($p.DriverDesc -and $p.'HardwareInformation.qwMemorySize'){ $r[$p.DriverDesc]=[double]$p.'HardwareInformation.qwMemorySize' } }",
  "$g=@(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name=$_.Name; wmi=[double]$_.AdapterRAM; reg=$r[$_.Name] } })",
  "ConvertTo-Json -InputObject $g -Compress",
].join('; ');

interface RawGpu { name?: string; wmi?: number | null; reg?: number | null }

export function parseGpus(json: string): GpuInfo[] {
  let raw: RawGpu[] = [];
  try {
    const j = JSON.parse(json) as RawGpu | RawGpu[];
    raw = Array.isArray(j) ? j : [j];
  } catch { return []; }
  const seen = new Set<string>();
  const out: GpuInfo[] = [];
  for (const g of raw) {
    const name = (g.name ?? '').trim();
    if (!name || seen.has(name) || /basic render|remote display|virtual|microsoft basic/i.test(name)) continue;
    seen.add(name);
    const bytes = g.reg && g.reg > 0 ? g.reg : g.wmi && g.wmi > 0 && g.wmi < 4_290_000_000 ? g.wmi : null;
    const vramGb = bytes === null ? null : Math.round((bytes / 1024 ** 3) * 10) / 10;
    out.push({ name, vendor: vendorOf(name), vramGb, integrated: isIntegrated(name, vramGb) });
  }
  return out;
}

async function exists(p: string) { return fs.access(p).then(() => true, () => false); }

export async function probeBackends(gpus: GpuInfo[], run: Run, env: NodeJS.ProcessEnv = process.env): Promise<BackendProbe[]> {
  const out: BackendProbe[] = [];
  let nv: string | null = null;
  if (gpus.some((g) => g.vendor === 'nvidia')) {
    try { nv = (await run('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'])).trim().split(/\r?\n/)[0] ?? null; } catch { nv = null; }
  }
  out.push({ id: 'cuda', label: 'NVIDIA CUDA', found: !!nv, state: 'untested', detail: nv ? `NVIDIA driver ${nv} found.` : gpus.some((g) => g.vendor === 'nvidia') ? 'NVIDIA card seen but the driver tool (nvidia-smi) was not found.' : 'No NVIDIA card.' });
  const hip = env.HIP_PATH && (await exists(env.HIP_PATH));
  out.push({ id: 'rocm', label: 'AMD ROCm / HIP', found: !!hip, state: 'untested', detail: hip ? `HIP SDK at ${env.HIP_PATH}.` : 'AMD HIP SDK not installed (ROCm on Windows supports only some newer Radeon cards).' });
  const hasDx = gpus.length > 0 && (await exists(path.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'DirectML.dll')));
  out.push({ id: 'directml', label: 'DirectML', found: hasDx, state: 'untested', detail: hasDx ? 'Windows DirectML runtime present (works with most GPUs; needs a model runner to use it).' : 'DirectML runtime not found.' });
  const sys32 = path.join(env.SystemRoot ?? 'C:\\Windows', 'System32');
  const vk = gpus.length > 0 && (await exists(path.join(sys32, 'vulkan-1.dll')));
  out.push({ id: 'vulkan', label: 'Vulkan', found: vk, state: 'untested', detail: vk ? 'Vulkan loader present (used by stable-diffusion.cpp on AMD, NVIDIA and Intel GPUs).' : 'Vulkan loader not found; update the graphics driver.' });
  out.push({ id: 'cpu', label: 'CPU', found: true, state: 'untested', detail: 'Always available, but very slow for video.' });
  return out;
}

export async function detectHardware(modelDir: string, run: Run = defaultRun, osId: OsId = currentOs(), fsx: SysFs = realSysFs): Promise<HardwareReport> {
  let gpus: GpuInfo[] = [];
  if (osId === 'linux') gpus = await detectGpusLinux(run, fsx).catch(() => []);
  else try { gpus = parseGpus(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', GPU_SCRIPT])); } catch { gpus = []; }
  let freeDiskGb: number | null = null;
  try {
    await fs.mkdir(modelDir, { recursive: true });
    const s = await fs.statfs(modelDir);
    freeDiskGb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch { freeDiskGb = null; }
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: { model: cpus[0]?.model.trim() ?? 'unknown', cores: cpus.length, avx2: osId === 'linux' ? hasAvx2(await fsx.readText('/proc/cpuinfo')) : null },
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpus, freeDiskGb, modelDir,
    backends: osId === 'linux' ? await probeBackendsLinux(gpus, run, fsx) : await probeBackends(gpus, run),
    checkedAt: new Date().toISOString(),
  };
}
