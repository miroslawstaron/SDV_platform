param(
    [string]$InstallDirectory=(Join-Path $env:LOCALAPPDATA 'SDV\CARLA\0.9.16'),
    [ValidateSet('Low','Epic')][string]$Quality='Epic',
    [ValidateRange(2,300)][int]$IdleTimeoutSeconds=10,
    [string]$BaseUrl='http://localhost:8000'
)
$ErrorActionPreference='Stop'
$runtimeRoot=[IO.Path]::GetFullPath($InstallDirectory)
$launcher=Join-Path $PSScriptRoot 'Start-Carla.ps1'
$logPath=Join-Path $runtimeRoot 'sdv-watch.log'
$watchMutex=[Threading.Mutex]::new($false,'Local\SDV-CARLA-WATCH-0.9.16')
$watchLockTaken=$false
try {
    try{$watchLockTaken=$watchMutex.WaitOne(0)}
    catch [Threading.AbandonedMutexException]{$watchLockTaken=$true}
    if(-not $watchLockTaken){return}
    $idleSince=$null
    $lastRun=$null
    $carlaRun=$false
    while($true){
        try{
            $health=Invoke-RestMethod "$BaseUrl/api/v1/health" -TimeoutSec 5
            if($health.active_run){
                $run=Invoke-RestMethod "$BaseUrl/api/v1/runs/$($health.active_run)" -TimeoutSec 5
                $carlaRun=$run.route.backend -eq 'carla'
                $graphics=if($run.configuration.carla.graphics -eq 'low'){'low'}else{'high'}
                $requestedQuality=if($graphics -eq 'low'){'Low'}else{'Epic'}
                $lastRun=$health.active_run
            }
            $needsServer=$health.active_run -and $carlaRun
        }catch{
            # Do not stop a possibly active world while the API is unreachable.
            $idleSince=$null
            Start-Sleep -Seconds 2
            continue
        }
        try{
            $server=@(Get-CimInstance Win32_Process -Filter "Name = 'CarlaUE4-Win64-Shipping.exe'" | Where-Object {
                $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtimeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and
                $_.CommandLine -match '(?i)(?:^|\s)-carla-rpc-port=2000(?:\s|$)'
            })
            if($needsServer){
                $idleSince=$null
                if($run.status -eq 'starting' -and (-not $health.carla_client_runtime -or $health.carla_client_runtime -eq 'windows')){& (Join-Path $PSScriptRoot 'Start-CarlaClient.ps1') -InstallDirectory $runtimeRoot}
                $wrongQuality=@($server | Where-Object {$_.CommandLine -notmatch "(?i)(?:^|\s)-quality-level=$requestedQuality(?:\s|$)"})
                if($wrongQuality.Count -and $run.status -eq 'starting'){
                    & $launcher -InstallDirectory $runtimeRoot -Stop -ServerOnly
                    $server=@()
                }elseif($wrongQuality.Count){
                    throw 'The active CARLA server has a different graphics quality; stop this drive before changing it.'
                }
                if(-not $server.Count){
                    & $launcher -InstallDirectory $runtimeRoot -Quality $requestedQuality -ServerOnly
                    Add-Content -LiteralPath $logPath -Value "$([DateTime]::UtcNow.ToString('o')) Started CARLA ($requestedQuality) for drive $lastRun."
                }
                $ready=@{run_id=$lastRun;graphics=$graphics} | ConvertTo-Json
                Invoke-RestMethod "$BaseUrl/api/v1/carla/runtime/ready" -Method Post -ContentType 'application/json' -Body $ready -TimeoutSec 5 | Out-Null
            }elseif($server.Count){
                if(-not $idleSince){$idleSince=[DateTime]::UtcNow}
                if(([DateTime]::UtcNow-$idleSince).TotalSeconds -ge $IdleTimeoutSeconds){
                    # Recheck just before stopping so a new drive keeps its server.
                    $latest=Invoke-RestMethod "$BaseUrl/api/v1/health" -TimeoutSec 5
                    if(-not $latest.active_run){
                        & $launcher -InstallDirectory $runtimeRoot -Stop -ServerOnly
                        & (Join-Path $PSScriptRoot 'Start-CarlaClient.ps1') -InstallDirectory $runtimeRoot -Stop
                        Add-Content -LiteralPath $logPath -Value "$([DateTime]::UtcNow.ToString('o')) Stopped idle CARLA; RAM and GPU allocations released."
                    }
                    $idleSince=$null
                }
            }else{
                $idleSince=$null
            }
        }catch{
            Add-Content -LiteralPath $logPath -Value "$([DateTime]::UtcNow.ToString('o')) $($_.Exception.Message)"
        }
        Start-Sleep -Seconds 2
    }
} finally {
    if($watchLockTaken){$watchMutex.ReleaseMutex()}
    $watchMutex.Dispose()
}
