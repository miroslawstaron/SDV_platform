param([string]$ApiUrl='http://localhost:8000')
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    $images=@()
    foreach($image in @('sdv-python:local','sdv-native:local','sdv-platform-web','sdv-instruments:local','ghcr.io/eclipse-kuksa/kuksa-databroker:0.7.1')) {
        $info=docker image inspect $image | ConvertFrom-Json
        if($LASTEXITCODE -ne 0){throw "Image inspection failed: $image"}
        $images+=@{image=$image;id=$info[0].Id;digests=@($info[0].RepoDigests)}
    }
    $sumo=docker compose exec -T plant sumo --version
    $converter=docker compose exec -T maps python3 -c 'import os,json,hashlib,subprocess; from pathlib import Path; p=Path(os.environ["NETCONVERT_BINARY"]); print(json.dumps({"package":"eclipse-sumo==1.18.0","version":subprocess.check_output([str(p),"--version"],text=True).splitlines()[0],"sha256":hashlib.sha256(p.read_bytes()).hexdigest()}))' | ConvertFrom-Json
    $packages=docker compose exec -T api pip freeze
    $frontend=Get-Content -LiteralPath web/package.json -Raw | ConvertFrom-Json
    $lock=@{schema_version='1.0';recorded_at=[DateTime]::UtcNow.ToString('o');images=$images;sumo=$sumo[0];python_packages=@($packages);frontend_dependencies=$frontend.dependencies;frontend_dev_dependencies=$frontend.devDependencies;npm_lock_sha256=(Get-FileHash -LiteralPath web/package-lock.json -Algorithm SHA256).Hash;vss_sha256=(Get-FileHash -LiteralPath contracts/vss.json -Algorithm SHA256).Hash;osm_sha256=(Get-FileHash -LiteralPath backend/fixtures/gothenburg.osm.xml -Algorithm SHA256).Hash}
    $lock.presentation=@{repository='https://github.com/hakimel/reveal.js';version='6.0.2';license='MIT';runtime_sha256=(Get-FileHash -LiteralPath web/public/presentation/vendor/reveal.js -Algorithm SHA256).Hash;adaptation='Locally served Metriczone SDV guide with speaker notes and print layout'}
    $lock.netconvert=$converter
    $lock.visual_identity=@{logo_sha256=(Get-FileHash -LiteralPath web/public/assets/metriczone-logo.png -Algorithm SHA256).Hash;source='User supplied Metriczone measurement ecosystem logo; original file copied unchanged'}
    $lock.instruments=@{manifest_sha256=(Get-FileHash -LiteralPath instruments/manifest.json -Algorithm SHA256).Hash;image='sdv-instruments:local';contract='/?run={run_id}; GET /health; independent /api/v1 run stream'}
    $json=$lock | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath dependencies.lock.json -Value $json -Encoding utf8
    Invoke-RestMethod "$ApiUrl/api/v1/provenance" -Method Post -ContentType 'application/json' -Body $json | Out-Null
    Write-Host 'Image digests and dependency versions saved to dependencies.lock.json and run provenance.'
} finally {Pop-Location}
