# Creative Studio — Claude Code handoff

## Objective
Build a Windows-first, professional creative editing desktop studio with Claude acting as an optional **Creative Partner**, capable of coordinating supported ArtCraft apps and user-selected image/video generation providers. Build a **working, testable vertical slice** first; do not attempt the entire product in one pass.

## Getting started in Claude Code
1. Copy this entire folder into the intended source-code workspace.
2. Open a terminal in that workspace, start Claude Code, and paste `CLAUDE_CODE_START_PROMPT.md`.
3. Let Claude Code inspect the environment and verify actual ArtCraft integration capabilities before coding integrations.
4. Require milestone reports with commands, test evidence, screenshots, and known limitations.

## Files
- `CLAUDE_CODE_START_PROMPT.md`: first prompt to paste into Claude Code
- `PRODUCT_SPEC.md`: complete feature, UX and behavior requirements
- `TECHNICAL_PLAN.md`: architecture, interface contracts, phase gates and acceptance criteria

## Key principles
- Live software means **real application windows**, not a fake canvas or periodic static screenshot passed off as live.
- Visible ArtCraft edits can happen via native application integration even without cursor movement.
- Keep imported originals immutable; edits are versioned.
- User API keys never enter Claude prompts, tool output, renderer state or logs.
- Approval for major creative changes; explicit consent for configured paid calls and destructive actions.
- Timelines only when media is time-based.
- Full dark, light, system appearance and accent selection.
