#!/usr/bin/env bash
# Links the host packages this plugin imports into ./node_modules, pointing at
# the same physical directories the DSH checkout loads, so the plugin shares
# the host's module instances (LlmAdapter, LlmError) when loaded through a
# --patch overlay by absolute path. A profile install (`dsh plugin add`)
# resolves these as peers and does not need it.
set -euo pipefail
DSH_ROOT="${DSH_ROOT:-$(cd "$(dirname "$0")/../../deepseek-harness" && pwd)}"
cd "$(dirname "$0")/.."
mkdir -p node_modules/@deepseek-ai
link() { ln -sfn "$DSH_ROOT/$2" "node_modules/@deepseek-ai/$1"; echo "@deepseek-ai/$1 -> $DSH_ROOT/$2"; }
link cordis vendor/cordis
link schemastery vendor/schemastery
link dsh-brand packages/util/brand
link dsh-llm packages/llm/llm
link dsh-session packages/core/session
link dsh-tools packages/core/tools

react_pkg="$(ls -d "$DSH_ROOT"/node_modules/.pnpm/react@*/node_modules/react 2>/dev/null | tail -1 || true)"
react_types="$(ls -d "$DSH_ROOT"/node_modules/.pnpm/@types+react@*/node_modules/@types/react 2>/dev/null | tail -1 || true)"
csstype_pkg="$(ls -d "$DSH_ROOT"/node_modules/.pnpm/csstype@*/node_modules/csstype 2>/dev/null | tail -1 || true)"
if [[ -n "$react_pkg" ]]; then
  ln -sfn "$react_pkg" node_modules/react
fi
if [[ -n "$react_types" ]]; then
  mkdir -p node_modules/@types
  ln -sfn "$react_types" node_modules/@types/react
fi
if [[ -n "$csstype_pkg" ]]; then
  ln -sfn "$csstype_pkg" node_modules/csstype
fi
