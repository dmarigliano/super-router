# Super Router installer for Windows

$ErrorActionPreference = "Stop"

Write-Host "🚀 Installing Super Router..." -ForegroundColor Cyan

# Check if running from clone or remote
if (Test-Path "bin/install.js") {
  # Local install
  node bin/install.js $args
} else {
  # Remote install
  npx -y super-router $args
}
