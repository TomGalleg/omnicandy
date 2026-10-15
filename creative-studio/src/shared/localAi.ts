// Free local AI video: hardware report types, tier rules and the model registry. Pure data and
// rules (no Electron, no processes). Availability (a model exists and can be downloaded) is kept
// apart from verified compatibility (a real clip came out on that hardware): `verified` is only
// ever added by a real run, and is empty today.

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other';
export type LocalTier = 'none' | 'experimental' | 'lightweight' | 'standard' | 'higher';

export interface GpuInfo {
  name: string;
  vendor: GpuVendor;
  /** Dedicated video memory in GB; null when it could not be read. */
  vramGb: number | null;
  /** Integrated graphics share system memory. */
  integrated: boolean;
}

export interface BackendProbe {
  id: 'cuda' | 'rocm' | 'directml' | 'cpu';
  label: string;
  /** What was seen on this PC, not whether generation works. */
  found: boolean;
  detail: string;
  /** Always 'untested' until a real self-test generation passes. */
  state: 'untested' | 'verified' | 'failed';
}

export interface HardwareReport {
  os: string;
  cpu: { model: string; cores: number; avx2: boolean | null };
  ramGb: number;
  gpus: GpuInfo[];
  /** Free space in GB on the drive that would hold models. */
  freeDiskGb: number | null;
  modelDir: string;
  backends: BackendProbe[];
  checkedAt: string;
}

export const vendorOf = (name: string): GpuVendor =>
  /nvidia|geforce|quadro|rtx|gtx/i.test(name) ? 'nvidia' : /amd|radeon|ati\b/i.test(name) ? 'amd' : /intel|iris|uhd|arc\b/i.test(name) ? 'intel' : 'other';

export const isIntegrated = (name: string, vramGb: number | null) =>
  /\bintel\b.*(uhd|iris|hd graphics)|radeon.*graphics$|vega \d+$/i.test(name) || (vramGb !== null && vramGb < 1 && !/nvidia|geforce|rtx|gtx/i.test(name));

/** The GPU a local model would use: the one with most dedicated memory, discrete first. */
export function bestGpu(gpus: GpuInfo[]): GpuInfo | null {
  return gpus.slice().sort((a, b) => Number(a.integrated) - Number(b.integrated) || (b.vramGb ?? 0) - (a.vramGb ?? 0))[0] ?? null;
}

/**
 * Tier from memory only, and a ceiling, not a promise: nothing here says a model runs.
 * Shared-memory (integrated) GPUs and unknown VRAM stay experimental.
 */
export function tierFor(r: Pick<HardwareReport, 'ramGb' | 'gpus' | 'freeDiskGb'>): LocalTier {
  if (r.freeDiskGb !== null && r.freeDiskGb < 8) return 'none';
  const g = bestGpu(r.gpus);
  const v = g && !g.integrated ? g.vramGb : null;
  if (v === null) return r.ramGb >= 8 ? 'experimental' : 'none';
  if (v >= 12) return 'higher';
  if (v >= 8) return 'standard';
  if (v >= 6) return 'lightweight';
  return 'experimental';
}

export const TIER_LABEL: Record<LocalTier, string> = {
  none: 'Not enough free disk space or memory',
  experimental: 'Experimental',
  lightweight: 'Lightweight',
  standard: 'Standard (entry level)',
  higher: 'Higher quality',
};

export interface VerifiedRun { gpu: string; backend: BackendProbe['id']; width: number; height: number; frames: number; date: string }

export interface LocalModel {
  id: string;
  name: string;
  version: string;
  sourceUrl: string;
  license: string;
  licenseNote: string;
  downloadGb: number;
  /** Rough needs, from the model cards; estimates, not measurements on this PC. */
  minVramGb: number;
  minRamGb: number;
  backends: BackendProbe['id'][];
  capabilities: Array<'text-to-video' | 'image-to-video'>;
  /** Smallest tier this model is offered on. */
  minTier: LocalTier;
  note: string;
  /** Real runs only. Empty = no hardware is verified for this model. */
  verified: VerifiedRun[];
}

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'ltx-video-2b-distilled-0.9.8', name: 'LTX-Video 2B distilled', version: '0.9.8',
    sourceUrl: 'https://huggingface.co/Lightricks/LTX-Video', license: 'LTX-Video Open Weights License',
    licenseNote: 'Not a plain open-source license: read its terms before using output commercially.',
    downloadGb: 8, minVramGb: 6, minRamGb: 16, backends: ['cuda', 'directml', 'cpu'], capabilities: ['text-to-video', 'image-to-video'],
    minTier: 'experimental', note: 'Smallest and fastest candidate. Resolution divisible by 32, frames 8n+1, best under 720x1280.', verified: [],
  },
  {
    id: 'wan-2.2-ti2v-5b', name: 'Wan 2.2 TI2V 5B', version: '2.2',
    sourceUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B', license: 'Apache 2.0',
    licenseNote: 'Permissive; keep the license notice.',
    downloadGb: 20, minVramGb: 16, minRamGb: 32, backends: ['cuda'], capabilities: ['text-to-video', 'image-to-video'],
    minTier: 'higher', note: 'The model card targets 24 GB cards with offloading. Not offered on smaller GPUs.', verified: [],
  },
];

const TIER_ORDER: LocalTier[] = ['none', 'experimental', 'lightweight', 'standard', 'higher'];

export interface ModelFit { model: LocalModel; offered: boolean; reasons: string[]; verifiedHere: boolean }

/** Which models may be offered here and why not. Offered means "could be tried", never "works". */
export function modelFit(m: LocalModel, r: HardwareReport): ModelFit {
  const reasons: string[] = [];
  const tier = tierFor(r);
  if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(m.minTier)) reasons.push(`Needs a ${TIER_LABEL[m.minTier].toLowerCase()} PC or better; this one is ${TIER_LABEL[tier].toLowerCase()}.`);
  if (r.ramGb < m.minRamGb) reasons.push(`Needs about ${m.minRamGb} GB of memory; this PC has ${r.ramGb} GB.`);
  if (r.freeDiskGb !== null && r.freeDiskGb < m.downloadGb + 2) reasons.push(`Needs about ${m.downloadGb} GB of free disk; ${r.freeDiskGb} GB free.`);
  const g = bestGpu(r.gpus);
  if (g && !g.integrated && g.vramGb !== null && g.vramGb < m.minVramGb) {
    // Below the stated minimum it may still be tried with offloading, but only as experimental.
    if (m.minTier !== 'experimental') reasons.push(`Needs about ${m.minVramGb} GB of video memory; this GPU has ${g.vramGb} GB.`);
  }
  const usable = r.backends.filter((b) => b.found && m.backends.includes(b.id));
  if (!usable.length) reasons.push('No compatible backend was found on this PC.');
  const verifiedHere = !!g && m.verified.some((v) => v.gpu === g.name);
  return { model: m, offered: reasons.length === 0, reasons, verifiedHere };
}

/** Plain-language caveats for the setup screen. */
export function warningsFor(r: HardwareReport): string[] {
  const w: string[] = [];
  const g = bestGpu(r.gpus);
  if (!g) w.push('No graphics card was detected.');
  else if (g.vendor === 'amd') w.push('AMD graphics cards are not verified yet. On Windows, AMD only lists its newest Radeon cards for the standard GPU toolkit (older RX 6000 cards are not on the list). A real test generation is needed before AMD is called supported.');
  else if (g.integrated) w.push('This is integrated graphics that shares system memory. Local AI video is likely to be too slow to be useful; Motion Effects is the practical choice.');
  else if (g.vramGb === null) w.push('The amount of video memory could not be read, so only the experimental tier is offered.');
  if (r.freeDiskGb !== null && r.freeDiskGb < 15) w.push(`Only ${r.freeDiskGb} GB is free where models are stored; models are 8 GB or more.`);
  if (r.ramGb < 16) w.push(`This PC has ${r.ramGb} GB of memory; 16 GB or more is recommended.`);
  return w;
}

export interface LocalAiStatus {
  report: HardwareReport;
  tier: LocalTier;
  tierLabel: string;
  warnings: string[];
  models: ModelFit[];
  /** False until a backend has passed a real self-test generation. */
  generationAvailable: boolean;
  note: string;
}
