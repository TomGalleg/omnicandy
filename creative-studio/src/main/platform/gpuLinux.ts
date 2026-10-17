// GPU, Vulkan and ROCm detection for Linux. Read-only. Written from the documented formats of `lspci -mm -nn`, the amdgpu sysfs
// files and Vulkan ICD manifests; it has NOT been run on a Linux machine yet (tests use synthetic text), so every result stays
// "untested" like the Windows backends until a real generation passes.

import fs from 'node:fs/promises';
import path from 'node:path';
import { isIntegrated, vendorOf, type BackendProbe, type GpuInfo } from '@shared/localAi';

export type Run = (cmd: string, args: string[]) => Promise<string>;

export interface SysFs {
  readText(p: string): Promise<string | null>;
  list(p: string): Promise<string[]>;
  exists(p: string): Promise<boolean>;
}

export const realSysFs: SysFs = {
  readText: (p) => fs.readFile(p, 'utf8').catch(() => null),
  list: (p) => fs.readdir(p).catch(() => []),
  exists: (p) => fs.access(p).then(() => true, () => false),
};

/**
 * `lspci -mm -nn` display controllers -> map of "vendorid:deviceid" to a readable name. Line format (documented by pciutils):
 * `01:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 23 [Radeon RX 6600] [73ff]" ...`
 */
export function parseLspci(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lastId = (s: string) => /\[([0-9a-f]{4})\]\s*$/i.exec(s)?.[1]?.toLowerCase();
  const noId = (s: string) => s.replace(/\s*\[[0-9a-f]{4}\]\s*$/i, '').trim();
  for (const line of text.split('\n')) {
    const [cls, vendor, device] = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? '');
    if (!cls || !vendor || !device || !/VGA|3D controller|Display controller/i.test(cls)) continue;
    const vid = lastId(vendor);
    const did = lastId(device);
    if (!vid || !did) continue;
    const v = noId(vendor).replace(/\[AMD\/ATI\]/i, '').replace(/,? *(Inc\.?|Corporation)\s*$/i, '').replace(/Advanced Micro Devices/i, 'AMD').replace(/\s+/g, ' ').trim();
    const d = noId(device);
    const inner = /\[([^\]]+)\]\s*$/.exec(d)?.[1];
    out.set(`${vid}:${did}`, `${v} ${inner ?? d}`.replace(/\s+/g, ' ').trim());
  }
  return out;
}

const hex = (s: string | null) => (s ?? '').trim().replace(/^0x/i, '').toLowerCase().padStart(4, '0');
const VENDOR_NAME: Record<string, string> = { '1002': 'AMD', '10de': 'NVIDIA', '8086': 'Intel' };

/** GPUs from /sys/class/drm (card0, card1...). VRAM is only exposed by the amdgpu driver (mem_info_vram_total). */
export async function detectGpusLinux(run: Run, fsx: SysFs = realSysFs, drmDir = '/sys/class/drm'): Promise<GpuInfo[]> {
  let names = new Map<string, string>();
  try { names = parseLspci(await run('lspci', ['-mm', '-nn'])); } catch { /* lspci is optional */ }
  const gpus: GpuInfo[] = [];
  for (const entry of (await fsx.list(drmDir)).filter((e) => /^card\d+$/.test(e)).sort()) {
    const dev = path.posix.join(drmDir, entry, 'device');
    const vendor = hex(await fsx.readText(`${dev}/vendor`));
    const device = hex(await fsx.readText(`${dev}/device`));
    if (vendor === '0000') continue;
    const vram = Number((await fsx.readText(`${dev}/mem_info_vram_total`))?.trim());
    const name = names.get(`${vendor}:${device}`) ?? `${VENDOR_NAME[vendor] ?? `Vendor ${vendor}`} GPU ${device}`;
    const vramGb = Number.isFinite(vram) && vram > 0 ? Math.round((vram / 1024 ** 3) * 10) / 10 : null;
    gpus.push({ name, vendor: vendorOf(name), vramGb, integrated: isIntegrated(name, vramGb) });
  }
  return gpus;
}

/** Vulkan ICD manifests tell which driver would serve Vulkan (RADV for AMD through Mesa, the NVIDIA and Intel drivers, llvmpipe = CPU). */
export function describeIcds(files: string[]): { names: string[]; hasAmd: boolean; hasSoftwareOnly: boolean } {
  const names = files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  const hasAmd = names.some((n) => /^radeon_icd|^amd_icd|^amdvlk/i.test(n));
  const real = names.some((n) => /^(radeon_icd|amd_icd|amdvlk|nvidia_icd|intel_icd|intel_hasvk_icd|lvp_icd)/i.test(n) && !/^lvp_icd/i.test(n));
  return { names, hasAmd, hasSoftwareOnly: names.length > 0 && !real };
}

const LOADER_DIRS = ['/usr/lib/x86_64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib/x86_64-linux-gnu'];
const ICD_DIRS = ['/usr/share/vulkan/icd.d', '/etc/vulkan/icd.d', '/usr/local/share/vulkan/icd.d'];

export async function probeBackendsLinux(gpus: GpuInfo[], run: Run, fsx: SysFs = realSysFs): Promise<BackendProbe[]> {
  const out: BackendProbe[] = [];
  let nv: string | null = null;
  if (gpus.some((g) => g.vendor === 'nvidia')) {
    try { nv = (await run('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader'])).trim().split(/\r?\n/)[0] ?? null; } catch { nv = null; }
  }
  out.push({ id: 'cuda', label: 'NVIDIA CUDA', found: !!nv, state: 'untested', detail: nv ? `NVIDIA driver ${nv} found.` : gpus.some((g) => g.vendor === 'nvidia') ? 'An NVIDIA card is present but nvidia-smi is missing or failed (driver not installed?).' : 'No NVIDIA card.' });
  const rocm = (await fsx.exists('/opt/rocm')) || (await fsx.exists('/dev/kfd'));
  out.push({ id: 'rocm', label: 'AMD ROCm / HIP', found: rocm, state: 'untested', detail: rocm ? 'ROCm (/opt/rocm or /dev/kfd) is present. Not used yet.' : 'ROCm is not installed (not required: AMD GPUs work through Vulkan).' });
  let loader: string | null = null;
  for (const d of LOADER_DIRS) { if (await fsx.exists(`${d}/libvulkan.so.1`)) { loader = d; break; } }
  const icds: string[] = [];
  for (const d of ICD_DIRS) icds.push(...(await fsx.list(d)));
  const icd = describeIcds(icds);
  const found = !!loader && gpus.length > 0 && icd.names.length > 0;
  const detail = !loader ? 'The Vulkan loader (libvulkan1) was not found. Install "libvulkan1" and "mesa-vulkan-drivers" (AMD, Intel) or the NVIDIA driver.'
    : icd.names.length === 0 ? 'The Vulkan loader is present but no driver (ICD) is installed. Install "mesa-vulkan-drivers" for AMD or Intel GPUs.'
      : icd.hasSoftwareOnly ? 'Only the software Vulkan renderer (llvmpipe) was found: that is the CPU, not the GPU.'
        : `Vulkan loader found with drivers: ${icd.names.join(', ')}${icd.hasAmd ? ' (AMD through Mesa RADV or AMDVLK)' : ''}. Used by stable-diffusion.cpp. Not tested on this computer yet.`;
  out.push({ id: 'vulkan', label: 'Vulkan', found: found && !icd.hasSoftwareOnly, state: 'untested', detail });
  out.push({ id: 'cpu', label: 'CPU', found: true, state: 'untested', detail: 'Always available, but very slow for video.' });
  return out;
}

/** AVX2 from /proc/cpuinfo flags (null when unreadable). */
export function hasAvx2(cpuinfo: string | null): boolean | null {
  if (!cpuinfo) return null;
  const flags = /^flags\s*:\s*(.*)$/m.exec(cpuinfo)?.[1];
  return flags ? flags.split(/\s+/).includes('avx2') : null;
}
