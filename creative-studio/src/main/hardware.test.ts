// Hardware detection and tier rules. Uses fake Windows output: these tests prove the rules, not that any GPU can generate.
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_MODELS, modelFit, tierFor, warningsFor, type HardwareReport } from '@shared/localAi';
import { detectHardware, parseGpus, probeBackends } from './hardware';

const amdJson = JSON.stringify([
  { name: 'Intel(R) UHD Graphics 770', wmi: 2147479552, reg: null },
  { name: 'AMD Radeon RX 6650 XT', wmi: 4293918720, reg: 8573157376 },
  { name: 'Microsoft Basic Render Driver', wmi: 0, reg: null },
]);

const report = (o: Partial<HardwareReport> = {}): HardwareReport => ({
  os: 'Windows', cpu: { model: 'x', cores: 8, avx2: null }, ramGb: 32, gpus: parseGpus(amdJson), freeDiskGb: 200, modelDir: 'x',
  backends: [{ id: 'directml', label: 'DirectML', found: true, detail: '', state: 'untested' }, { id: 'cpu', label: 'CPU', found: true, detail: '', state: 'untested' }],
  checkedAt: '', ...o,
});

describe('hardware detection', () => {
  it('reads real VRAM from the registry value, not the 4 GB WMI cap, and skips virtual adapters', () => {
    const g = parseGpus(amdJson);
    expect(g.map((x) => x.name)).toEqual(['Intel(R) UHD Graphics 770', 'AMD Radeon RX 6650 XT']);
    expect(g[1]).toMatchObject({ vendor: 'amd', vramGb: 8, integrated: false });
    expect(g[0]).toMatchObject({ vendor: 'intel', integrated: true });
  });
  it('survives garbage output', () => {
    expect(parseGpus('not json')).toEqual([]);
    expect(parseGpus('{"name":"NVIDIA GeForce GTX 1060","wmi":4293918720}')[0]).toMatchObject({ vendor: 'nvidia', integrated: false });
  });
  it('classifies tiers from video memory and disk', () => {
    expect(tierFor(report())).toBe('standard');
    expect(tierFor(report({ gpus: [{ name: 'NVIDIA RTX 4070', vendor: 'nvidia', vramGb: 12, integrated: false }] }))).toBe('higher');
    expect(tierFor(report({ gpus: [{ name: 'GTX 1060', vendor: 'nvidia', vramGb: 6, integrated: false }] }))).toBe('lightweight');
    expect(tierFor(report({ gpus: [{ name: 'GT 1030', vendor: 'nvidia', vramGb: 2, integrated: false }] }))).toBe('experimental');
    expect(tierFor(report({ gpus: [] }))).toBe('experimental');
    expect(tierFor(report({ gpus: [], ramGb: 4 }))).toBe('none');
    expect(tierFor(report({ freeDiskGb: 3 }))).toBe('none');
  });
  it('warns that AMD is unverified and never reports a model as verified without a real run', () => {
    expect(warningsFor(report()).join(' ')).toMatch(/AMD graphics cards are not verified/);
    for (const m of LOCAL_MODELS) expect(m.verified).toEqual([]);
    expect(modelFit(LOCAL_MODELS[0]!, report()).verifiedHere).toBe(false);
  });
  it('model rules: big model refused on 8 GB, small one needs a backend and disk', () => {
    const ltx = LOCAL_MODELS.find((m) => m.id === 'wan-2.1-t2v-1.3b')!;
    const wan = LOCAL_MODELS.find((m) => m.id === 'wan-2.2-ti2v-5b')!;
    const withVk = report({ backends: [{ id: 'vulkan', label: 'Vulkan', found: true, detail: '', state: 'untested' }] });
    expect(modelFit(ltx, withVk).offered).toBe(true);
    const big = modelFit(wan, withVk);
    expect(big.offered).toBe(false);
    expect(big.reasons.join(' ')).toMatch(/video memory|better/);
    expect(modelFit(ltx, report({ backends: [] })).reasons.join(' ')).toMatch(/No compatible backend/);
    expect(modelFit(ltx, { ...withVk, freeDiskGb: 5 }).offered).toBe(false);
    expect(modelFit(ltx, { ...withVk, ramGb: 8 }).offered).toBe(false);
  });
  it('backends are found-not-tested; missing tools are reported plainly', async () => {
    const run = async () => { throw new Error('missing'); };
    const b = await probeBackends(parseGpus('{"name":"NVIDIA GeForce RTX 3060","reg":12884901888}'), run, { SystemRoot: 'C:\\Nope' });
    expect(b.find((x) => x.id === 'cuda')).toMatchObject({ found: false });
    expect(b.every((x) => x.state === 'untested')).toBe(true);
    expect(b.find((x) => x.id === 'cpu')!.found).toBe(true);
  });
  it('detectHardware assembles a report from injected output', async () => {
    const r = await detectHardware(path.join(os.tmpdir(), 'cs-models-test'), async (cmd) => { if (cmd === 'powershell.exe') return amdJson; throw new Error('no'); });
    expect(r.gpus).toHaveLength(2);
    expect(r.ramGb).toBeGreaterThan(0);
    expect(r.freeDiskGb).not.toBeNull();
  });
});
