param([switch]$Stop,[string]$InstallDirectory=(Join-Path $env:LOCALAPPDATA 'SDV\CARLA\0.9.16'))
$ErrorActionPreference='Stop'
$clientMutex=[Threading.Mutex]::new($false,'Local\SDV-CARLA-CLIENT-0.9.16')
$clientLockTaken=$false
try {
try{$clientLockTaken=$clientMutex.WaitOne([TimeSpan]::FromSeconds(180))}
catch [Threading.AbandonedMutexException]{$clientLockTaken=$true}
if(-not $clientLockTaken){throw 'Another native CARLA client launcher is still running.'}
$runtimeRoot=[IO.Path]::GetFullPath($InstallDirectory)
# Store Python redirects LOCALAPPDATA. A user-profile directory is shared by
# both the launcher and the interpreter without that filesystem redirection.
$venv=Join-Path $env:USERPROFILE '.sdv\carla-client-0.9.16'
$python=Join-Path $venv 'Scripts\python.exe'
$manifest=Join-Path $runtimeRoot 'sdv-client-process.json'
$projectRoot=Split-Path $PSScriptRoot
$managed=$null
if(Test-Path -LiteralPath $manifest){
    $saved=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    $candidate=Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$saved.process_id)"
    if($candidate -and $candidate.CommandLine -like '*-m sdv.carla_service*' -and $candidate.CommandLine.Contains($python)){$managed=$candidate}
}
if($Stop){
    if($managed){
        # Windows multiprocessing children use the same isolated interpreter.
        $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($managed.ProcessId)" | Where-Object {$_.ExecutablePath -and $_.ExecutablePath.StartsWith($venv+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)})
        foreach($child in $children){Stop-Process -Id $child.ProcessId -ErrorAction SilentlyContinue}
        Stop-Process -Id $managed.ProcessId -ErrorAction SilentlyContinue
    }
    return
}
if($managed){
    try{$health=Invoke-RestMethod 'http://127.0.0.1:2003/health' -TimeoutSec 3;if($health.status -eq 'ready'){return}}catch{}
    throw 'The native CARLA client is not responding. Stop and restart the SDV platform.'
}
if(Get-NetTCPConnection -LocalPort 2003 -State Listen -ErrorAction SilentlyContinue){throw 'Port 2003 is already occupied by another service.'}
if(-not (Test-Path -LiteralPath $python)){
    Write-Host 'Preparing an isolated Windows Python 3.12 CARLA client...'
    if(-not (Get-Command py.exe -ErrorAction SilentlyContinue)){throw 'The native CARLA client needs Python 3.12 (py -3.12).'}
    & py.exe -3.12 -m venv $venv
    if($LASTEXITCODE -ne 0){throw 'Could not create the CARLA Python 3.12 environment.'}
}
$packageRoot=if(Test-Path -LiteralPath (Join-Path $runtimeRoot 'PythonAPI')){$runtimeRoot}else{Join-Path $runtimeRoot 'WindowsNoEditor'}
$wheel=Join-Path $packageRoot 'PythonAPI\carla\dist\carla-0.9.16-cp312-cp312-win_amd64.whl'
if(-not (Test-Path -LiteralPath $wheel)){throw "Native CARLA SDK wheel missing: $wheel"}
$packagesReady=Join-Path $venv 'sdv-packages-v1.ready'
if(-not (Test-Path -LiteralPath $packagesReady)){
    $localWheel=Join-Path $venv (Split-Path $wheel -Leaf)
    Copy-Item -LiteralPath $wheel -Destination $localWheel -Force
    & $python -m pip install --disable-pip-version-check $localWheel 'fastapi==0.115.12' 'uvicorn==0.34.2' 'httpx==0.28.1' 'pillow==11.3.0' 'pydantic==2.11.4'
    if($LASTEXITCODE -ne 0){throw 'Native CARLA client package installation failed.'}
    & $python -c 'import carla,fastapi,uvicorn,httpx,PIL'
    if($LASTEXITCODE -ne 0){throw 'Native CARLA client imports failed.'}
    Set-Content -LiteralPath $packagesReady -Value 'CARLA 0.9.16 / Python 3.12'
}
$original=@{}
$variables=@{PYTHONPATH=(Join-Path $projectRoot 'backend');CARLA_HOST='127.0.0.1';CARLA_PORT='2000';CARLA_RENDERER='nvidia';CARLA_FRAME_TRANSPORT='http';CARLA_CAMERA_INTERVAL='.1';CARLA_CAMERA_ROOT=(Join-Path $venv 'frames');PYTHONUNBUFFERED='1'}
try{
    foreach($entry in $variables.GetEnumerator()){$original[$entry.Key]=[Environment]::GetEnvironmentVariable($entry.Key,'Process');[Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process')}
    $client=Start-Process -FilePath $python -ArgumentList @('-m','sdv.carla_service') -WorkingDirectory $venv -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtimeRoot 'sdv-client.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'sdv-client.stderr.log')
}finally{foreach($entry in $original.GetEnumerator()){[Environment]::SetEnvironmentVariable($entry.Key,$entry.Value,'Process')}}
@{process_id=$client.Id;python=$python} | ConvertTo-Json | Set-Content -LiteralPath $manifest -Encoding utf8
$deadline=[DateTime]::UtcNow.AddSeconds(30)
do{
    Start-Sleep -Milliseconds 300
    $client.Refresh()
    if($client.HasExited){throw "Native CARLA client exited. Inspect $runtimeRoot/sdv-client.stderr.log"}
    try{$health=Invoke-RestMethod 'http://127.0.0.1:2003/health' -TimeoutSec 1;if($health.status -eq 'ready'){return}}catch{}
}while([DateTime]::UtcNow -lt $deadline)
throw 'Native CARLA client did not become ready on port 2003.'
}finally{
    if($clientLockTaken){$clientMutex.ReleaseMutex()}
    $clientMutex.Dispose()
}
