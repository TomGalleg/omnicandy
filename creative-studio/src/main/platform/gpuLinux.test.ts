// SYNTHETIC inputs written from the documented formats (pciutils, amdgpu sysfs, Vulkan ICD folders). They prove the parsing and the
// decisions, not that a real Linux machine behaves this way: nothing here was captured from Linux.
import { describe, expect, it } from 'vitest';
import { detectHardware } from '../hardware';
import { describeIcds, detectGpusLinux, hasAvx2, parseLspci, probeBackendsLinux, type SysFs } from './gpuLinux';

const LSPCI = [
  '00:02.0 "VGA compatible controller [0300]" "Intel Corporation [8086]" "UHD Graphics 630 [3e92]" -r02 "Dell [1028]" "UHD Graphics 630 [0870]"',
  '03:00.0 "VGA compatible controller [0300]" "Advanced Micro Devices, Inc. [AMD/ATI] [1002]" "Navi 23 [Radeon RX 6600/6600 XT/6600M] [73ff]" -rc1 "Sapphire [1da2]" "Pulse [e445]"',
  '00:1f.3 "Audio device [0403]" "Intel Corporation [8086]" "Cannon Lake PCH cAVS [a348]"',
].join('\n');

function fakeFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): SysFs {
  return {
    readText: async (p) => files[p] ?? null,
    list: async (p) => dirs[p] ?? [],
    exists: async (p) => p in files || p in dirs,
  };
}

const drm = fakeFs({
  '/sys/class/drm/card0/device/vendor': '0x8086\n', '/sys/class/drm/card0/device/device': '0x3e92\n',
  '/sys/class/drm/card1/device/vendor': '0x1002\n', '/sys/class/drm/card1/device/device': '0x73ff\n', '/sys/class/drm/card1/device/mem_info_vram_total': String(8 * 1024 ** 3) + '\n',
}, { '/sys/class/drm': ['card0', 'card0-HDMI-A-1', 'card1', 'renderD128', 'version'] });

describe('Linux GPU detection (synthetic inputs)', () => {
  it('parses lspci -mm -nn into readable names keyed by PCI ids', () => {
    const m = parseLspci(LSPCI);
    expect(m.get('8086:3e92')).toBe('Intel UHD Graphics 630');
    expect(m.get('1002:73ff')).toBe('AMD Radeon RX 6600/6600 XT/6600M');
    expect(m.size).toBe(2); // the audio device is not a GPU
  });
  it('reads cards from sysfs, with VRAM for the amdgpu card and names from lspci', async () => {
    const g = await detectGpusLinux(async () => LSPCI, drm);
    expect(g.map((x) => x.name)).toEqual(['Intel UHD Graphics 630', 'AMD Radeon RX 6600/6600 XT/6600M']);
    expect(g[1]).toMatchObject({ vendor: 'amd', vramGb: 8, integrated: false });
    expect(g[0]?.vramGb).toBeNull();
  });
  it('still lists GPUs when lspci is missing, naming them by vendor id', async () => {
    const g = await detectGpusLinux(async () => { throw new Error('not found'); }, drm);
    expect(g.map((x) => x.name)).toEqual(['Intel GPU 3e92', 'AMD GPU 73ff']);
  });
  it('classifies Vulkan drivers: RADV present, software-only, missing loader, missing driver', async () => {
    expect(describeIcds(['radeon_icd.x86_64.json', 'intel_icd.x86_64.json']).hasAmd).toBe(true);
    expect(describeIcds(['lvp_icd.x86_64.json']).hasSoftwareOnly).toBe(true);
    const gpus = await detectGpusLinux(async () => LSPCI, drm);
    const run = async () => { throw new Error('x'); };
    const ok = await probeBackendsLinux(gpus, run, fakeFs({ '/usr/lib/x86_64-linux-gnu/libvulkan.so.1': '' }, { '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] }));
    expect(ok.find((b) => b.id === 'vulkan')).toMatchObject({ found: true, state: 'untested' });
    expect(ok.find((b) => b.id === 'vulkan')?.detail).toMatch(/RADV/);
    const sw = await probeBackendsLinux(gpus, run, fakeFs({ '/usr/lib/x86_64-linux-gnu/libvulkan.so.1': '' }, { '/usr/share/vulkan/icd.d': ['lvp_icd.x86_64.json'] }));
    expect(sw.find((b) => b.id === 'vulkan')).toMatchObject({ found: false });
    expect(sw.find((b) => b.id === 'vulkan')?.detail).toMatch(/CPU/);
    const noLoader = await probeBackendsLinux(gpus, run, fakeFs({}));
    expect(noLoader.find((b) => b.id === 'vulkan')?.detail).toMatch(/libvulkan1/);
    const noIcd = await probeBackendsLinux(gpus, run, fakeFs({ '/usr/lib/x86_64-linux-gnu/libvulkan.so.1': '' }));
    expect(noIcd.find((b) => b.id === 'vulkan')?.detail).toMatch(/mesa-vulkan-drivers/);
  });
  it('detects AVX2 from cpuinfo flags', () => {
    expect(hasAvx2('processor : 0\nflags\t\t: fpu sse avx avx2 bmi1')).toBe(true);
    expect(hasAvx2('flags : fpu sse')).toBe(false);
    expect(hasAvx2(null)).toBeNull();
  });
  it('detectHardware uses the Linux path (no PowerShell) when told the OS is Linux', async () => {
    const calls: string[] = [];
    const r = await detectHardware('/tmp/cc-models-test', async (cmd) => { calls.push(cmd); return cmd === 'lspci' ? LSPCI : ''; }, 'linux', fakeFs({ ...{}, '/proc/cpuinfo': 'flags : avx2' }, {}));
    expect(calls.some((c) => /powershell/i.test(c))).toBe(false);
    expect(r.cpu.avx2).toBe(true);
    expect(r.backends.map((b) => b.id)).toEqual(['cuda', 'rocm', 'vulkan', 'cpu']);
  });
});
