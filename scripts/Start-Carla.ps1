param([switch]$Stop,[string]$InstallDirectory=(Join-Path $env:LOCALAPPDATA 'SDV\CARLA\0.9.16'),[ValidateSet('Low','Epic')][string]$Quality='Epic',[switch]$ServerOnly)
$ErrorActionPreference='Stop'
$runtimeRoot=[IO.Path]::GetFullPath($InstallDirectory)
$manifest=Join-Path $runtimeRoot 'sdv-process.json'
$watchManifest=Join-Path $runtimeRoot 'sdv-watch-process.json'
$watchScript=Join-Path $PSScriptRoot 'Watch-Carla.ps1'
$runtimeMutex=[Threading.Mutex]::new($false,'Local\SDV-CARLA-0.9.16')
$runtimeLockTaken=$false
try {
    try{$runtimeLockTaken=$runtimeMutex.WaitOne([TimeSpan]::FromSeconds(180))}
    catch [Threading.AbandonedMutexException]{$runtimeLockTaken=$true}
    if(-not $runtimeLockTaken){throw 'Another CARLA launcher is still running. Retry after it finishes.'}

function Get-CarlaWatcher {
    if(Test-Path -LiteralPath $watchManifest){
        $saved=Get-Content -LiteralPath $watchManifest -Raw | ConvertFrom-Json
        $watcher=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$saved.process_id)"
        if($watcher -and $watcher.Name -match '^(pwsh|powershell)\.exe$' -and $watcher.CommandLine -like "*$watchScript*" -and $watcher.CommandLine -like "*$runtimeRoot*"){
            return $watcher
        }
    }
}
function Start-CarlaWatcher {
    if($ServerOnly -or (Get-CarlaWatcher)){return}
    $shellPath=(Get-Process -Id $PID).Path
    $arguments=@('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$watchScript+'"'),'-InstallDirectory',('"'+$runtimeRoot+'"'),'-Quality',$Quality)
    $watcher=Start-Process -FilePath $shellPath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    @{process_id=$watcher.Id;script=$watchScript} | ConvertTo-Json | Set-Content -LiteralPath $watchManifest -Encoding utf8
}
function Confirm-CarlaVulkan([System.Diagnostics.Process]$ServerProcess) {
    $modules=@($ServerProcess.Modules | ForEach-Object {$_.ModuleName})
    if($modules -notcontains 'vulkan-1.dll' -or $modules -notcontains 'nvoglv64.dll'){
        throw "CARLA process $($ServerProcess.Id) has not loaded the NVIDIA Vulkan driver. Stop that server before starting Vulkan."
    }
    @{version='0.9.16';runtime='windows';graphics_api='vulkan';gpu_preference='nvidia';executable=$ServerProcess.Path;process_ids=@($ServerProcess.Id);started_at=$ServerProcess.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
}
function Get-ManagedCarlaProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'CarlaUE4-Win64-Shipping.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtimeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and
        $_.CommandLine -match '(?i)(?:^|\s)-carla-rpc-port=2000(?:\s|$)'
    } | ForEach-Object {Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}
}
function Confirm-CarlaPorts([int]$ServerProcessId) {
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort 2000,2001,2002 -ErrorAction SilentlyContinue)
    $ports=@($listeners | ForEach-Object {$_.LocalPort})
    if($ports -notcontains 2000 -or $ports -notcontains 2001 -or @($listeners | Where-Object {$_.OwningProcess -ne $ServerProcessId}).Count){
        throw 'CARLA ports 2000 and 2001 must belong to the same server. Stop CARLA with scripts/Start-Carla.ps1 -Stop, then start it again while no drive is active.'
    }
}
if($Stop){
    if(-not $ServerOnly){
        $watcher=Get-CarlaWatcher
        if($watcher){Stop-Process -Id $watcher.ProcessId -Force}
    }
    # A previous interrupted/concurrent startup can leave a process absent from
    # the manifest. Include every server owned by this installation on port 2000.
    $processIds=@(Get-ManagedCarlaProcesses | ForEach-Object {$_.Id})
    if(Test-Path -LiteralPath $manifest){
        $saved=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        $processIds+=@($saved.process_ids)
    }
    foreach($carlaProcessId in @($processIds | Sort-Object -Unique)){
            $process=Get-Process -Id $carlaProcessId -ErrorAction SilentlyContinue
            if($process -and $process.Path -and $process.Path.StartsWith($runtimeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
                Stop-Process -Id $process.Id -Force
                if(-not $process.WaitForExit(10000)){throw "CARLA process $($process.Id) did not exit; another server will not be started."}
            }
    }
    return
}
$probe=[Net.Sockets.TcpClient]::new()
try{$connecting=$probe.ConnectAsync('127.0.0.1',2000);$alreadyReady=$connecting.Wait(1000) -and $probe.Connected}catch{$alreadyReady=$false}finally{$probe.Dispose()}
if($alreadyReady){
    if(@(Get-ManagedCarlaProcesses).Count -gt 1){throw 'Multiple managed CARLA servers are running. While no drive is active, run scripts/Start-Carla.ps1 -Stop, then start CARLA again.'}
    $listener=Get-NetTCPConnection -LocalPort 2000 -State Listen | Select-Object -First 1
    Confirm-CarlaPorts $listener.OwningProcess
    Confirm-CarlaVulkan (Get-Process -Id $listener.OwningProcess)
    Start-CarlaWatcher
    Write-Host 'Reusing CARLA with the NVIDIA Vulkan driver on port 2000.'
    return
}
if(@(Get-ManagedCarlaProcesses).Count){throw 'A managed CARLA process is still starting or shutting down. Wait for it to finish before retrying.'}
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$executable=Join-Path $runtimeRoot 'WindowsNoEditor\CarlaUE4.exe'
if(-not (Test-Path -LiteralPath $executable)){
    $executable=Join-Path $runtimeRoot 'CarlaUE4.exe'
}
if(-not (Test-Path -LiteralPath $executable)){
    $archive=Join-Path $runtimeRoot 'CARLA_0.9.16.zip'
    Write-Host 'Downloading the official Windows CARLA 0.9.16 release (7.3 GiB)...'
    if(-not (Test-Path -LiteralPath $archive) -or (Get-Item -LiteralPath $archive).Length -lt 7812252810){
        & curl.exe --fail --location --retry 3 --continue-at - --output $archive 'https://downloads.carlasim.com/Windows/CARLA_0.9.16.zip'
        if($LASTEXITCODE -ne 0){throw 'CARLA download failed; rerun the launcher to resume.'}
    }
    Write-Host 'Extracting CARLA...'
    & tar.exe -xf $archive -C $runtimeRoot
    if($LASTEXITCODE -ne 0){throw 'CARLA extraction failed.'}
    $executable=Join-Path $runtimeRoot 'WindowsNoEditor\CarlaUE4.exe'
    if(-not (Test-Path -LiteralPath $executable)){$executable=Join-Path $runtimeRoot 'CarlaUE4.exe'}
    if(-not (Test-Path -LiteralPath $executable)){throw "CARLA executable missing under $runtimeRoot"}
}
Write-Host 'Starting CARLA 0.9.16 with the native Windows graphics driver...'
$packageRoot=Split-Path $executable
$shippingDirectory=Join-Path $packageRoot 'CarlaUE4\Binaries\Win64'
if(Test-Path -LiteralPath (Join-Path $shippingDirectory 'CarlaUE4-Win64-Shipping.exe')){
    # The bootstrapper requires a machine-wide DirectX install even when DLLs
    # are shipped beside the application. Use official app-local redist DLLs.
    if(-not (Test-Path -LiteralPath (Join-Path $shippingDirectory 'xinput1_3.dll'))){
        $directxRoot=Join-Path $runtimeRoot 'directx'
        $directxExtract=Join-Path $directxRoot 'extracted'
        New-Item -ItemType Directory -Path $directxExtract -Force | Out-Null
        $redist=Join-Path $directxRoot 'directx_Jun2010_redist.exe'
        & curl.exe --fail --location --retry 3 --output $redist 'https://download.microsoft.com/download/8/4/A/84A35BF1-DAFE-4AE8-82AF-AD2AE20B6B14/directx_Jun2010_redist.exe'
        if($LASTEXITCODE -ne 0){throw 'DirectX redistributable download failed.'}
        $signature=Get-AuthenticodeSignature -LiteralPath $redist
        if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation'){throw 'DirectX redistributable signature is invalid.'}
        $unpack=Start-Process -FilePath $redist -ArgumentList @('/Q',"/T:$directxExtract") -WindowStyle Hidden -PassThru
        $unpack.WaitForExit()
        if($unpack.ExitCode -ne 0){throw 'DirectX extraction failed.'}
        Get-ChildItem -LiteralPath $directxExtract -Filter '*x64.cab' | ForEach-Object {
            & expand.exe -F:*.dll $_.FullName $shippingDirectory | Out-Null
            if($LASTEXITCODE -ne 0){throw 'DirectX library extraction failed.'}
        }
    }
    $executable=Join-Path $shippingDirectory 'CarlaUE4-Win64-Shipping.exe'
}
# Windows Vulkan requires a window surface. RenderOffScreen fails with
# VK_ERROR_SURFACE_LOST_KHR; create the surface while keeping the window hidden.
$launched=Start-Process -FilePath $executable -WorkingDirectory (Split-Path $executable) -ArgumentList @('-windowed','-nosound',"-quality-level=$Quality",'-ResX=640','-ResY=360','-vulkan','-preferNvidia','-unattended','-carla-rpc-port=2000') -WindowStyle Hidden -PassThru
$deadline=[DateTime]::UtcNow.AddSeconds(180)
do{
    Start-Sleep -Seconds 2
    $launched.Refresh()
    if($launched.HasExited){throw "CARLA exited during Vulkan startup (exit code $($launched.ExitCode)). Inspect its crash report under LOCALAPPDATA/CarlaUE4/Saved/Crashes."}
    $probe=[Net.Sockets.TcpClient]::new()
    try{$connecting=$probe.ConnectAsync('127.0.0.1',2000);$ready=$connecting.Wait(1000) -and $probe.Connected}catch{$ready=$false}finally{$probe.Dispose()}
}while(-not $ready -and [DateTime]::UtcNow -lt $deadline)
if(-not $ready){Stop-Process -Id $launched.Id;throw 'Native CARLA did not expose port 2000 within 180 seconds. Inspect its Saved/Logs directory.'}
Confirm-CarlaPorts $launched.Id
Confirm-CarlaVulkan $launched
Start-CarlaWatcher
Write-Host 'CARLA Vulkan is ready on localhost:2000 with the NVIDIA GPU; the platform uses host.docker.internal.'
} finally {
    if($runtimeLockTaken){$runtimeMutex.ReleaseMutex()}
    $runtimeMutex.Dispose()
}
