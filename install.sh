#!/usr/bin/env sh

set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required to install the scoped package." >&2
  exit 1
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
case "$node_major" in
  ""|*[!0-9]*)
    echo "Could not determine the installed Node.js version." >&2
    exit 1
    ;;
esac
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node --version)." >&2
  exit 1
fi

version="${SUPER_ROUTER_VERSION:-0.8.0}"
if ! node -e 'if (!/^\d+\.\d+\.\d+$/.test(process.argv[1] ?? "")) process.exit(1)' "$version"; then
  echo "SUPER_ROUTER_VERSION must be an exact numeric semantic version (for example, 0.8.0)." >&2
  exit 1
fi

echo "Installing @dmarigliano/super-router@$version from npm..."
npm install --global "@dmarigliano/super-router@$version"
echo "Installed. Run: super-router doctor"
