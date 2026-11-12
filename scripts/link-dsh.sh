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
link dsh-tools packages/core/tools
