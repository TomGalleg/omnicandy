import type { OsId } from './platform';
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
  id: 'cuda' | 'rocm' | 'directml' | 'vulkan' | 'cpu';
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

export interface LocalModelFile {
  /** Path inside the model folder. */
  path: string;
  url: string;
  bytes: number;
  /** Expected SHA-256 when the host publishes one (Hugging Face does for large files). */
  sha256?: string;
  /** Unpack this file into the model folder after it is verified. */
  extract?: 'zip';
}

export interface LocalModel {
  /** Which runtime runs it. 'runtime' entries are the engine itself, not a model. */
  kind: 'model' | 'runtime';
  engine: 'sdcpp' | 'diffusers' | null;
  /** sd.cpp: model files (paths inside the model folder) for the command line. */
  sdcpp?: { diffusion: string; vae: string; textEncoder: string; flowShift: number; cfg: number; defaultSteps: number };
  /** Files to download. Empty = not downloadable through OmniCandi yet. */
  files: LocalModelFile[];
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

const HF = 'https://huggingface.co/Lightricks/LTX-Video/resolve/main/';

const WAN = 'https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/';
const UMT5 = 'https://huggingface.co/city96/umt5-xxl-encoder-gguf/resolve/main/';

export const LOCAL_MODELS: LocalModel[] = [
  {
    kind: 'model', engine: 'sdcpp',
    sdcpp: { diffusion: 'wan2.1_t2v_1.3B_fp16.safetensors', vae: 'wan_2.1_vae.safetensors', textEncoder: 'umt5-xxl-encoder-Q4_K_M.gguf', flowShift: 3, cfg: 6, defaultSteps: 20 },
    files: [
      { path: 'wan2.1_t2v_1.3B_fp16.safetensors', url: WAN + 'split_files/diffusion_models/wan2.1_t2v_1.3B_fp16.safetensors', bytes: 2838303560, sha256: 'be531024cd9018cb5b48c40cfbb6a6191645b1c792eb8bf4f8c1c6e10f924dc5' },
      { path: 'wan_2.1_vae.safetensors', url: WAN + 'split_files/vae/wan_2.1_vae.safetensors', bytes: 253815318, sha256: '2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b' },
      { path: 'umt5-xxl-encoder-Q4_K_M.gguf', url: UMT5 + 'umt5-xxl-encoder-Q4_K_M.gguf', bytes: 3655145312, sha256: '17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40' },
    ],
    id: 'wan-2.1-t2v-1.3b', name: 'Wan 2.1 T2V 1.3B (test model)', version: '2.1',
    sourceUrl: 'https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B', license: 'Apache 2.0',
    licenseNote: 'Permissive; keep the license notice. Files are the ComfyUI repackaged copies; text encoder is a Q4 GGUF of umt5-xxl.',
    downloadGb: 6.7, minVramGb: 6, minRamGb: 16, backends: ['vulkan', 'cuda', 'cpu'], capabilities: ['text-to-video'],
    minTier: 'experimental', note: 'Small text-to-video model run by stable-diffusion.cpp (Vulkan, no Python). 480p-class, short clips. The first model to try on AMD and older GPUs.', verified: [{ gpu: 'AMD Radeon RX 6650 XT', backend: 'vulkan', width: 320, height: 192, frames: 17, date: '2026-10-15' }],
  },
  {
    kind: 'model', engine: 'diffusers',
    files: [
      { path: 'ltxv-2b-0.9.8-distilled.safetensors', url: HF + 'ltxv-2b-0.9.8-distilled.safetensors', bytes: 6340744492, sha256: '76aa8c4786af752fa6f951947129d5290c3c6c0b2fadcadea6b5e114ae2cad8f' },
      { path: 'vae/config.json', url: HF + 'vae/config.json', bytes: 501 },
      { path: 'vae/diffusion_pytorch_model.safetensors', url: HF + 'vae/diffusion_pytorch_model.safetensors', bytes: 1676798532, sha256: '265ca87cb5dff5e37f924286e957324e282fe7710a952a7dafc0df43883e2010' },
      { path: 'text_encoder/config.json', url: HF + 'text_encoder/config.json', bytes: 781 },
      { path: 'text_encoder/model.safetensors.index.json', url: HF + 'text_encoder/model.safetensors.index.json', bytes: 19886 },
      { path: 'text_encoder/model-00001-of-00004.safetensors', url: HF + 'text_encoder/model-00001-of-00004.safetensors', bytes: 4989319680, sha256: '7a68b2c8c080696a10109612a649bc69330991ecfea65930ccfdfbdb011f2686' },
      { path: 'text_encoder/model-00002-of-00004.safetensors', url: HF + 'text_encoder/model-00002-of-00004.safetensors', bytes: 4999830656, sha256: 'b8ed6556d7507e38af5b428c605fb2a6f2bdb7e80bd481308b865f7a40c551ca' },
      { path: 'text_encoder/model-00003-of-00004.safetensors', url: HF + 'text_encoder/model-00003-of-00004.safetensors', bytes: 4865612720, sha256: 'c831635f83041f83faf0024b39c6ecb21b45d70dd38a63ea5bac6c7c6e5e558c' },
      { path: 'text_encoder/model-00004-of-00004.safetensors', url: HF + 'text_encoder/model-00004-of-00004.safetensors', bytes: 4194506688, sha256: '02a5f2d69205be92ad48fe5d712d38c2ff55627969116aeffc58bd75a28da468' },
      { path: 'tokenizer/added_tokens.json', url: HF + 'tokenizer/added_tokens.json', bytes: 2593 },
      { path: 'tokenizer/special_tokens_map.json', url: HF + 'tokenizer/special_tokens_map.json', bytes: 2543 },
      { path: 'tokenizer/spiece.model', url: HF + 'tokenizer/spiece.model', bytes: 791656, sha256: 'd60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86' },
      { path: 'tokenizer/tokenizer_config.json', url: HF + 'tokenizer/tokenizer_config.json', bytes: 20618 },
      { path: 'scheduler/scheduler_config.json', url: HF + 'scheduler/scheduler_config.json', bytes: 418 },
      { path: 'model_index.json', url: HF + 'model_index.json', bytes: 412 },
    ],
    id: 'ltx-video-2b-distilled-0.9.8', name: 'LTX-Video 2B distilled', version: '0.9.8',
    sourceUrl: 'https://huggingface.co/Lightricks/LTX-Video', license: 'LTX-Video Open Weights License',
    licenseNote: 'Not a plain open-source license: read its terms before using output commercially.',
    downloadGb: 27, minVramGb: 6, minRamGb: 16, backends: ['cuda'], capabilities: ['text-to-video', 'image-to-video'],
    minTier: 'experimental', note: 'Needs a PyTorch runner OmniCandi does not have (torch-directml is stale: torch 2.4.1, Python 3.12 or older, last release Sept 2024), so it is only offered with NVIDIA CUDA. Smallest and fastest candidate. The download is the 6.3 GB model plus its 19 GB text encoder and 1.7 GB VAE (file sizes read from the Hugging Face listing). Resolution divisible by 32, frames 8n+1, best under 720x1280.', verified: [],
  },
  {
    kind: 'model', engine: 'sdcpp',
    files: [],
    id: 'wan-2.2-ti2v-5b', name: 'Wan 2.2 TI2V 5B', version: '2.2',
    sourceUrl: 'https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B', license: 'Apache 2.0',
    licenseNote: 'Permissive; keep the license notice.',
    downloadGb: 20, minVramGb: 16, minRamGb: 32, backends: ['cuda'], capabilities: ['text-to-video', 'image-to-video'],
    minTier: 'higher', note: 'The model card targets 24 GB cards with offloading. Not offered on smaller GPUs.', verified: [],
  },
];

/** The engine itself (not a model). A 30 MB zip from the project's GitHub release. */
export const SDCPP_RUNTIME: LocalModel = {
  kind: 'runtime', engine: null,
  files: [{
    path: 'sd-master-1d0a58a-bin-win-vulkan-x64.zip', extract: 'zip', bytes: 30155040,
    url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-964-1d0a58a/sd-master-1d0a58a-bin-win-vulkan-x64.zip',
    sha256: '74211cb5c382aec2aeb086b64f2fdf525efec5faec4200a2d3257bc2328954ab',
  }],
  id: 'sdcpp-vulkan-runtime', name: 'stable-diffusion.cpp (Vulkan)', version: 'master-964-1d0a58a',
  sourceUrl: 'https://github.com/leejet/stable-diffusion.cpp', license: 'MIT', licenseNote: 'Open-source engine; runs on AMD, NVIDIA and Intel GPUs through Vulkan.',
  downloadGb: 0.03, minVramGb: 0, minRamGb: 0, backends: ['vulkan'], capabilities: [], minTier: 'experimental', note: 'Runs the models below. Not tested on this PC yet.', verified: [],
};

/**
 * The same engine for Ubuntu 24.04 x86-64 (the official release asset; size and SHA-256 are the ones GitHub reports for it).
 * It keeps the same id so everything else treats it as "the engine". It has NOT been downloaded or run on a Linux computer yet.
 */
export const SDCPP_RUNTIME_LINUX: LocalModel = {
  ...SDCPP_RUNTIME,
  files: [{
    path: 'sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip', extract: 'zip', bytes: 37028134,
    url: 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-964-1d0a58a/sd-master-1d0a58a-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip',
    sha256: 'bade142929edfa7aad56aba46376e55142d14390262b904f4a2deb3a03ceb21d',
  }],
  downloadGb: 0.04, note: 'Linux build (Ubuntu 24.04 x86-64, Vulkan). Needs libvulkan1 and a Vulkan driver (mesa-vulkan-drivers for AMD). Not tested on Linux yet.', verified: [],
};

/** The engine download for this system, or null when there is none (macOS). */
export const sdcppRuntime = (os: OsId): LocalModel | null => (os === 'win32' ? SDCPP_RUNTIME : os === 'linux' ? SDCPP_RUNTIME_LINUX : null);

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
  const usable = m.backends.length === 0 ? [] : r.backends.filter((b) => b.found && m.backends.includes(b.id));
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
  if (r.freeDiskGb !== null && r.freeDiskGb < 15) w.push(`Only ${r.freeDiskGb} GB is free where models are stored; models are 20 GB or more.`);
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

export const totalBytes = (m: LocalModel) => m.files.reduce((n, f) => n + f.bytes, 0);

export interface DownloadState {
  modelId: string;
  state: 'idle' | 'downloading' | 'verifying' | 'installed' | 'failed' | 'cancelled';
  doneBytes: number;
  totalBytes: number;
  file: string | null;
  message: string;
}
