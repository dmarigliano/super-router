$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20 or newer is required."
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required to install the scoped package."
}

$NodeMajorText = node -p 'process.versions.node.split(".")[0]'
[int]$NodeMajor = 0
if (-not [int]::TryParse(($NodeMajorText | Select-Object -First 1), [ref]$NodeMajor)) {
  throw "Could not determine the installed Node.js version."
}
if ($NodeMajor -lt 20) {
  throw "Node.js 20 or newer is required; found $(node --version)."
}

$Version = if ($env:SUPER_ROUTER_VERSION) { $env:SUPER_ROUTER_VERSION } else { "0.8.0" }
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  throw "SUPER_ROUTER_VERSION must be an exact numeric semantic version (for example, 0.8.0)."
}

Write-Host "Installing @dmarigliano/super-router@$Version from npm..." -ForegroundColor Cyan
npm install --global "@dmarigliano/super-router@$Version"
Write-Host "Installed. Run: super-router doctor" -ForegroundColor Green
