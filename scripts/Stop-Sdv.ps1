$ErrorActionPreference = 'Stop'
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
try {
    docker compose down
    & (Join-Path $PSScriptRoot 'Start-Carla.ps1') -Stop
} finally { Pop-Location }
