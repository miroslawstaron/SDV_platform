param([switch]$NoBrowser,[switch]$NoBuild,[ValidateRange(10,900)][int]$StartupTimeoutSeconds=300)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Get-DockerMode {
    try {
        $mode=& docker info --format '{{.OSType}}' 2>$null
        if ($LASTEXITCODE -eq 0) { return $mode }
    } catch {}
    return $null
}
function Get-PlatformHealth([string]$BaseUrl) {
    try { return Invoke-RestMethod "$BaseUrl/api/v1/health" -TimeoutSec 5 } catch { return $null }
}
Push-Location $projectRoot
try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install Docker Desktop, then run this launcher again.' }
    if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
    $mode=Get-DockerMode
    if (-not $mode) {
        $desktop=Join-Path $env:ProgramFiles 'Docker/Docker/Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $desktop)) { throw 'Docker is unavailable and Docker Desktop could not be found. Start Docker Desktop, then retry.' }
        Write-Host 'Starting Docker Desktop; waiting for its engine...'
        Start-Process -FilePath $desktop -WindowStyle Hidden
        $deadline=[DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        do {
            Start-Sleep -Seconds 2
            $mode=Get-DockerMode
        } while (-not $mode -and [DateTime]::UtcNow -lt $deadline)
        if (-not $mode) { throw 'Docker did not become ready. Open Docker Desktop to inspect its startup error, then retry.' }
    }
    if ($mode -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then retry.' }
    $composeText=& docker compose config --format json
    if ($LASTEXITCODE -ne 0) { throw 'The Compose configuration is invalid. Check compose.yaml and .env.' }
    $configuration=$composeText | ConvertFrom-Json
    $port=$configuration.services.web.ports[0].published
    $dashboardUrl="http://localhost:$port"
    $existing=Get-PlatformHealth 'http://localhost:8000'
    if ($existing.active_run) {
        Write-Host "Drive $($existing.active_run) is already active; starting only its web displays."
        & docker compose up -d --no-deps --wait --wait-timeout $StartupTimeoutSeconds web instruments
    } else {
        Write-Host 'Starting the complete SDV platform...'
        $composeArgs=@('compose','up','-d','--wait','--wait-timeout',[string]$StartupTimeoutSeconds)
        if (-not $NoBuild) { $composeArgs+='--build' }
        & docker @composeArgs
    }
    if ($LASTEXITCODE -ne 0) { throw 'Container startup failed. Run docker compose logs --tail 80 to inspect the error.' }
    Write-Host 'Checking the dashboard and vehicle services...'
    $deadline=[DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        $health=Get-PlatformHealth $dashboardUrl
        # Active fault experiments may deliberately report degraded health.
        if ($health -and ($health.status -eq 'ready' -or $existing.active_run)) { break }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $health -or ($health.status -ne 'ready' -and -not $existing.active_run)) {
        throw 'The platform did not become ready. Run docker compose logs --tail 80 to inspect the failing service.'
    }
    & (Join-Path $PSScriptRoot 'Lock-Dependencies.ps1')
    Write-Host "Engineering dashboard: $dashboardUrl"
    Write-Host "Presentation: $dashboardUrl/presentation/"
    Write-Host "Vehicle instruments: $dashboardUrl/instruments/?run=RUN_ID"
    if ($configuration.services.web.ports[0].host_ip -notin @('127.0.0.1','::1')) {
        $hostName=[Net.Dns]::GetHostName()
        try { $hostName=[Net.Dns]::GetHostEntry($hostName).HostName } catch {}
        Write-Host "Network dashboard: http://${hostName}:$port"
    }
    if (-not $NoBrowser) { Start-Process $dashboardUrl }
} catch {
    Write-Host "SDV startup failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally { Pop-Location }
