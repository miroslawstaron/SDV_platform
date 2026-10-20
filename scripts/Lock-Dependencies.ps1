param([string]$ApiUrl='http://localhost:8000')
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Get-SdvSha256([string]$LiteralPath) {
    $stream=[IO.File]::OpenRead((Resolve-Path -LiteralPath $LiteralPath).ProviderPath)
    $algorithm=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','') }
    finally { $stream.Dispose();$algorithm.Dispose() }
}
Push-Location $projectRoot
try {
    $images=@()
    foreach($image in @('sdv-python:local','sdv-native:local','sdv-platform-web','sdv-instruments:local','ghcr.io/eclipse-kuksa/kuksa-databroker:0.7.1')) {
        $info=docker image inspect $image | ConvertFrom-Json
        if($LASTEXITCODE -ne 0){throw "Image inspection failed: $image"}
        $images+=@{image=$image;id=$info[0].Id;digests=@($info[0].RepoDigests)}
    }
    $sumo=docker compose exec -T plant sumo --version
    if($LASTEXITCODE -ne 0){throw 'SUMO version could not be read'}
    # Send Python on stdin so Windows PowerShell does not strip its quoted keys.
    $converterCode=@'
import os,json,hashlib,subprocess
from pathlib import Path
p=Path(os.environ["NETCONVERT_BINARY"])
print(json.dumps({"package":"eclipse-sumo==1.18.0","version":subprocess.check_output([str(p),"--version"],text=True).splitlines()[0],"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}))
'@
    $converterText=$converterCode | docker compose exec -T maps python3 -
    if($LASTEXITCODE -ne 0){throw 'Road converter version could not be read'}
    $converter=$converterText | ConvertFrom-Json
    $packages=docker compose exec -T api pip freeze
    if($LASTEXITCODE -ne 0){throw 'Python package versions could not be read'}
    $frontend=Get-Content -LiteralPath web/package.json -Raw | ConvertFrom-Json
    $lock=@{schema_version='1.0';recorded_at=[DateTime]::UtcNow.ToString('o');images=$images;sumo=$sumo[0];python_packages=@($packages);frontend_dependencies=$frontend.dependencies;frontend_dev_dependencies=$frontend.devDependencies;npm_lock_sha256=(Get-SdvSha256 web/package-lock.json);vss_sha256=(Get-SdvSha256 contracts/vss.json);osm_sha256=(Get-SdvSha256 backend/fixtures/gothenburg.osm.xml)}
    $lock.presentation=@{repository='https://github.com/hakimel/reveal.js';version='6.0.2';license='MIT';runtime_sha256=(Get-SdvSha256 web/public/presentation/vendor/reveal.js);adaptation='Locally served Metriczone SDV guide with speaker notes and print layout'}
    $lock.netconvert=$converter
    $lock.carla=@{version='0.9.16';world='Town10HD_Opt';runtime='Native Windows Vulkan (default); optional Docker host networking';cameras=@('driver','chase');battery='explicit EV energy estimate';scene='48 pedestrians, 8 traffic vehicles'}
    $nativeCarlaManifest=Join-Path $env:LOCALAPPDATA 'SDV/CARLA/0.9.16/sdv-process.json'
    if(Test-Path -LiteralPath $nativeCarlaManifest){
        $nativeCarla=Get-Content -LiteralPath $nativeCarlaManifest -Raw | ConvertFrom-Json
        $lock.carla.native_executable_sha256=Get-SdvSha256 $nativeCarla.executable
    }
    $lock.visual_identity=@{logo_sha256=(Get-SdvSha256 web/public/assets/metriczone-logo.png);source='User supplied Metriczone measurement ecosystem logo; original file copied unchanged'}
    $lock.instruments=@{manifest_sha256=(Get-SdvSha256 instruments/manifest.json);image='sdv-instruments:local';contract='/?run={run_id}; GET /health; independent /api/v1 run stream'}
    $json=$lock | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath dependencies.lock.json -Value $json -Encoding utf8
    Invoke-RestMethod "$ApiUrl/api/v1/provenance" -Method Post -ContentType 'application/json' -Body $json | Out-Null
    Write-Host 'Image digests and dependency versions saved to dependencies.lock.json and run provenance.'
} finally {Pop-Location}
