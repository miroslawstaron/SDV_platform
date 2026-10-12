param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
    docker info | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop in Linux container mode.' }
    docker compose up --build -d --wait --wait-timeout 240
    if ($LASTEXITCODE -ne 0) { throw 'Startup failed. Inspect docker compose logs.' }
    & (Join-Path $PSScriptRoot 'Lock-Dependencies.ps1')
    Write-Host 'Engineering dashboard: http://localhost:8080'
    Write-Host 'Presentation: http://localhost:8080/presentation/'
    Write-Host 'Vehicle instruments: http://localhost:8081/?run=RUN_ID'
    if (-not $NoBrowser) { Start-Process 'http://localhost:8080' }
} finally { Pop-Location }
