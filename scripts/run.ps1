param([string]$Task = 'start')
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$bunPath = Join-Path $projectPath 'node_modules\bun\bin\bun.exe'
if (-not (Test-Path -LiteralPath $bunPath)) { throw 'Execute bun install --frozen-lockfile primeiro.' }
Push-Location $projectPath
try { & $bunPath run $Task; $taskExitCode = $LASTEXITCODE }
finally { Pop-Location }
exit $taskExitCode
