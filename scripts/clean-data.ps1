$ErrorActionPreference = 'Stop'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js is not installed or not in PATH. Install Node.js 22.13 or newer.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$winRunner = Join-Path $projectRoot 'node_modules\.bin\tsx.cmd'
$unixRunner = Join-Path $projectRoot 'node_modules/.bin/tsx'
$runner = if (Test-Path -LiteralPath $winRunner -PathType Leaf) {
  $winRunner
} elseif (Test-Path -LiteralPath $unixRunner -PathType Leaf) {
  $unixRunner
} else {
  $null
}

if (-not $runner) {
  throw 'Dependencies are missing. Run npm ci in the LLMCP project root first.'
}

Push-Location -LiteralPath $projectRoot
try {
  Write-Host 'Cleaning all personal data, chats, prompts, RAG DB, File Repo uploads, and memories...'
  & $runner scripts/clean-data.ts
  $cleanExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $cleanExitCode
