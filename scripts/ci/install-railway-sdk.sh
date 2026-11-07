#!/usr/bin/env bash
# Make the `railway` npm SDK (imported by .railway/railway.ts) resolvable for `railway config plan`
# without a full pnpm workspace install. Installs the root devDependency range into a temp
# prefix and links it as ./node_modules. Run from the repository root.
set -euo pipefail

spec=$(node -p "require('./package.json').devDependencies.railway")
prefix="${RUNNER_TEMP:-$(mktemp -d)}/railway-sdk"
mkdir -p "$prefix"
npm install --prefix "$prefix" --ignore-scripts --no-audit --no-fund --no-package-lock "railway@$spec"
if [ -e node_modules ]; then
  echo "node_modules already exists; leaving it in place."
else
  ln -s "$prefix/node_modules" node_modules
fi
