# AI Studio: providers, models and Quick AI

What is connected, what was verified and where, and how to add the next model. Checked against official documentation on 2026-10-27.

## The shape of it

| Piece | File | Job |
|---|---|---|
| Capability registry | `src/shared/providerCapabilities.ts` | What each provider and model can do. `wired` = usable now, `planned` = documented but not connected. The UI offers only what is listed here. |
| Presentation | `src/shared/studioCatalog.ts` | Categories, tasks ("what do you want to do?"), plain wording, price text, comparison rows, favourites. No capability decisions. |
| Higgsfield catalog + validation | `src/shared/higgsfield.ts` | Docs-verified endpoints, each model's parameters and inputs. The Create form is built from this. |
| Recraft | `src/shared/recraft.ts`, `src/shared/recraftTools.ts` | Generation models and picture tools. |
| Services (main process) | `src/main/higgsfield.ts`, `src/main/recraft.ts`, `src/main/generation.ts` | Keys, approval, spending limit, network, saving results. |
| Screens | `AiStudio.tsx`, `ModelGallery.tsx`, `CreateWorkspace.tsx`, `HiggsfieldForm.tsx`, `QuickAiPanel.tsx` | Explore, Create, Assets, Jobs, and the Quick AI panel. |
| Quick AI hosts | `src/shared/quickAi.ts` (`QUICK_HOSTS`) | Which apps get a panel and which actions each offers. |

## Rules every provider follows

- The key lives in the Windows-protected vault and is lent to one call at a time. It never reaches the window, logs, prompts or another provider.
- Every paid request shows a native approval card (cancel is the default) before anything is sent. The project spending limit is checked first.
- A paid request is sent once. A failure is never retried automatically.
- Results are downloaded at once (provider links expire) and saved as new originals with their prompt, model and settings. Nothing open is replaced.
- Gemini and GPT Image are untouched: their code paths, keys, catalog and request bodies are frozen by `generation.regression.test.ts`.

## What is connected

| Provider | Connected | Not connected (and why) |
|---|---|---|
| Gemini, GPT Image | everything that already worked | |
| Recraft | V4.1, V4.1 Pro, and their Vector models (real SVG); colours and background; vectorize; remove background; crisp and creative upscale; V3 edit with a prompt; V3 new background | inpaint, outpaint, erase region, generate background: they need a pixel-exact black and white mask and there is no mask painter yet. V4.1 Flash and styles: not confirmed well enough. Edit with V4.1: its price is not published. |
| Higgsfield (API) | Seedance 2.5 (text, picture, reference, edit video, extend video), Seedance 2.0 reference, Wan 3.0 reference, Genjutsu motion transfer, Kling 2.5 Turbo (text, two picture tiers), Hailuo 2.3 text | Soul: the docs name two different endpoints. Seedance 2.0 text/picture/edit/extend, Wan 2.6/2.7, Hailuo picture: pages not read. Kling 3 and anything else: not in the docs. |
| Higgsfield (MCP) | nothing | A remote server that signs in with the Higgsfield account and uses subscription credits. OmniCandy's MCP client is local-only and has no sign-in, so this is a separate decision. |

Higgsfield publishes no model-list call, no price list, no estimate call and no balance call. The registry is the catalog, the price shows as "not published", and a project with a spending limit refuses Higgsfield requests (the limit cannot be checked against an unknown price).

## Quick AI

Available in PhotoCraft and FilmCraft as a collapsible column beside the app window.

- PhotoCraft: generate, edit, variations, remove background, upscale, animate. Results open as their own document. Inserting as a layer is not offered: OmniCandy's command allowlist deliberately blocks placing files into an open document, and it cannot read which layers are selected.
- FilmCraft: generate video, animate a still, extend, B-roll, insert into the timeline (asks first, adds at the end, undoable). Enhancing video has no connected model yet and says so.

"Open in AI Studio" hands over model, prompt, file and Higgsfield inputs through the `cs-studio-draft` session key.

## Adding a model

1. Read its official docs page. Write only what it says.
2. Higgsfield: add an `HfModel` to `HF_MODELS` (parameters, inputs, source URL). It appears in Explore, Create, Quick AI and the comparison with no other change.
3. Recraft tool: add a `RecraftTool` to `RECRAFT_TOOLS`.
4. A new provider: add a `StudioProvider`, its models, and a service in `src/main`. Wire three IPC lines (`shared/ipc.ts`, `preload/index.ts`, `main/ipc.ts`).
5. Add a test with mocked network. Never test against a paid API without asking.

## Adding a Quick AI host

Add an entry to `QUICK_HOSTS` and mount `QuickAiPanel` beside that app's window. The app's command allowlist decides what "insert" can mean.

## Verified live?

No. Everything above was tested with mocked network. No paid request has been made to Recraft or Higgsfield from this code. The first real request of each should be a single cheap one the user approves in the app.
