param(
  [ValidateRange(1024, 65535)]
  [int]$Port = $(if ($env:PORT) { [int]$env:PORT } else { 3000 }),

  [string]$HostAddress = $(if ($env:HOST) { $env:HOST } else { '' })
)

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

$llamaEndpoint = if ($env:LLAMA_CPP_BASE_URL) { $env:LLAMA_CPP_BASE_URL } else { 'http://127.0.0.1:8080' }
$cliArgs = @('server.ts', '--port', "$Port")
if ($HostAddress -and $HostAddress.Trim().Length -gt 0) {
  $cliArgs += @('--host', $HostAddress.Trim())
}

Push-Location -LiteralPath $projectRoot
try {
  $bindLabel = if ($HostAddress -and $HostAddress.Trim().Length -gt 0) { $HostAddress.Trim() } else { '0.0.0.0' }
  Write-Host "Starting LLMCP at http://localhost:$Port (bind: $bindLabel, llama.cpp router: $llamaEndpoint)."
  & $runner @cliArgs
  $serverExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $serverExitCode
