#!/bin/zsh
cd "${0:A:h}" || exit 1
NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" && -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
  NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ -z "$NODE_BIN" ]]; then
  print "Install Node.js 24, then follow OPEN-ME-FIRST.txt."
  read "?Press Enter to close."
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print "First install dependencies using the steps in OPEN-ME-FIRST.txt."
  read "?Press Enter to close."
  exit 1
fi
if [[ ! -f .env ]]; then
  print "First copy .env.example to .env and add your settings. See OPEN-ME-FIRST.txt."
  read "?Press Enter to close."
  exit 1
fi
export NODE_ENV=development DEMO_MODE=false PORT=3000
print "Knovera: open http://localhost:3000 after startup. Keep this window open."
"$NODE_BIN" --env-file-if-exists=.env server/index.mjs
read "?Press Enter to close."
