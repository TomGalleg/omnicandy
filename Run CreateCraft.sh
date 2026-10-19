#!/usr/bin/env bash
# Rebuilds OmniCandy from source, then launches it (Linux development; see docs/linux-compatibility.md).
set -e
cd "$(dirname "$0")/creative-studio"
npx electron-vite build
node scripts/build-planner-mcp.mjs
exec npx electron . "$@"
