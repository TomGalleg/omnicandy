# Free local video: Stage A research and recommendation (2026-10-14)

Status: **research only. Nothing below has been run on this PC. No hardware is claimed to work.**
Sources are official model cards and AMD/ComfyUI pages read on this date; items marked *unverified*
could not be confirmed from them.

## What CreateCraft already has

* Cloud video is `VideoService` (`src/main/videoGeneration.ts`) with a model catalogue in `src/shared/video.ts`
  (Veo verified, Runway built but untested). Every paid call goes through the approval dialog and the
  project spending limit, and finished clips become library assets with provenance.
* The workflow engine's AI step is images only; Claude has `generate_video` for the cloud providers.
* New in Stage B: **Motion Effects** (`src/shared/motionEffects.ts`, `src/main/motionEffects.ts`). It is not
  a provider: no key, no approval, no ledger entry.
* Recommended shape for local AI: a new `local` provider kind next to `gemini` / `runway`, with the
  same job record (saved in `work/video/jobs.json`), but no approval dialog (a free action) and a
  separate "download this model" consent. The backend sits behind a small interface
  (`detect()`, `selfTest()`, `generate(job, onProgress, signal)`), so engines can be swapped.

## Candidate models

| Model | Size / variants | License | Notes |
|---|---|---|---|
| LTX-Video 2B distilled (0.9.8) | 2B, FP8 variant | LTX-Video Open Weights License (read it before shipping: not a plain OSI license) | Smallest and fastest; best results under 720x1280, resolution divisible by 32, frames 8n+1. No VRAM figure on the card. Runs in diffusers, ComfyUI-LTXVideo, or its own `inference.py` (tested with CUDA PyTorch). |
| LTX-Video 13B distilled / FP8 | 13B | same | Higher quality, needs more memory; only for 12 GB+ cards. |
| Wan 2.2 TI2V 5B | 5B dense | Apache 2.0 | 720p (1280x704) at 24 fps. The card's own single-GPU command with offloading targets 24 GB (RTX 4090 class). Community ComfyUI/GGUF workflows exist for less memory but those figures are *unverified* here. |
| Wan 2.2 14B (A14B) | 14B | Apache 2.0 | Out of reach for a 6650 XT; only for large cards. |

## Backends on Windows

| Backend | NVIDIA | AMD RX 6650 XT (gfx1032, 8 GB) | CPU only |
|---|---|---|---|
| PyTorch CUDA (own runtime or ComfyUI) | Works where CUDA PyTorch runs (the reference path for all models above). | n/a | n/a |
| PyTorch ROCm on Windows (ComfyUI Desktop v0.7.0+, ROCm 7.1.1, beta) | n/a | **Not supported.** AMD's Windows requirements page lists RX 7000 and RX 9000, Radeon PRO and Ryzen AI parts only; RX 6000 is marked unsupported. | n/a |
| ROCm on WSL2 | n/a | Same support list applies (supported cards only); *unverified* for RX 6000. Adds WSL setup, which is a poor fit for a normal-user app. | n/a |
| DirectML (torch-directml / ONNX Runtime DirectML) | Works, slower than CUDA | Only route that targets RX 6000 on Windows in principle, but no video-diffusion pipeline for LTX or Wan on it was found in the sources read. *Unverified; would need a real test.* | n/a |
| CPU (PyTorch) | Works | Works | Possible for a few frames at tiny sizes; minutes per frame likely. *Unverified.* Use Motion Effects instead. |

## Compatibility matrix (what to expect, not what is proven)

| Target | LTX 2B distilled | Wan 2.2 5B | Larger models | Motion Effects |
|---|---|---|---|---|
| NVIDIA 12 GB+ | Expected to run (CUDA) | Expected with offload | 13B FP8 plausible | Works (verified) |
| NVIDIA 8 GB | Expected, low resolution (FP8 / offload) | Doubtful | No | Works |
| NVIDIA 4-6 GB | Experimental | No | No | Works |
| AMD RX 7000/9000 | Possible via ROCm-Windows ComfyUI (beta) | Possible, heavy | No | Works |
| **AMD RX 6650 XT** | **Unproven.** ROCm-Windows unsupported; DirectML path untested | **Unproven**, likely out of reach | No | **Works (verified)** |
| CPU / iGPU | Experimental, impractical | No | No | Works |

"Works (verified)" for Motion Effects means a real FilmCraft render was made on this PC (see below). Every
other cell is an expectation until a real clip comes out.

## Recommendation

1. **Ship Motion Effects now (done, Stage B).** It is the only mode proven here and runs on any PC that has
   FilmCraft, with no GPU requirement.
2. **First local-AI engine: LTX-Video 2B distilled through a small bundled-free Python/diffusers runner**,
   started and monitored by CreateCraft, installed only after user consent. Reasons: smallest model, fastest
   distilled schedule, and the most modest stated needs. ComfyUI is not required; add it as an
   *optional* second backend only if it proves a measurable advantage (it gives the AMD ROCm-Windows build
   for supported Radeon cards and ready-made offload nodes).
3. **Do not promise the RX 6650 XT.** ROCm-Windows does not list it. Plan one time-boxed experiment: LTX 2B
   through DirectML at ~512x320 and 25 frames. If a clip plays, record it as "tested on this configuration";
   otherwise the card stays on Motion Effects. Never present AMD as supported before that.
4. Wan 2.2 5B as a second model only for NVIDIA 16-24 GB cards after the runner exists.
5. Model registry keeps availability separate from verified compatibility (a `verified` list of
   `{gpu, backend, resolution, frames, seconds, date}` entries that only a real run can add).

## Stage B result: what Motion Effects actually does

* One picture to one MP4 through FilmCraft's headless engine: Ken Burns zoom in/out and pan left/right/up/down,
  three strengths, 16:9 / 9:16 / 1:1, 720p or 1080p, 24 or 30 fps, 2 to 20 s. Always covers the frame.
* Saved as a new version of the picture (`origin: generated`, no provider), labelled
  "Motion Effects ... not AI-generated"; no cost, no ledger entry, no network.
* Real run on this PC: `sunset-still.jpg`, zoom-in 16:9 (3 s, in the unit test) and pan-left 9:16 720x1280 4 s: frames
  verified to change over time and fill the frame; H.264/AAC MP4 written.
* **Not built (spec items):** layered parallax and depth motion, crossfade sequences of several pictures,
  atmospheric overlays, title animation. FilmCraft has the primitives (opacity, transitions, graphics) so
  these are feasible as follow-ups. Claude has no Motion Effects tool yet and the workflow engine has no
  such node yet (both belong to a later stage).
