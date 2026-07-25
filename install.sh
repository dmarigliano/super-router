#!/bin/bash
# Super Router installer for Unix-like systems

set -e

echo "🚀 Installing Super Router..."

# Check if running from clone or remote
if [ -f "bin/install.js" ]; then
  # Local install
  node bin/install.js "$@"
else
  # Remote install
  npx -y super-router "$@"
fi
