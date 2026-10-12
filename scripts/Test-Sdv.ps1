param([switch]$Live,[switch]$Browser)
$ErrorActionPreference='Stop'
$projectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $projectRoot
try {
    $testArgs=@('compose','run','--rm','--no-deps')
    if($Live){$testArgs+=@('-e','SDV_LIVE=1')}
    $testArgs+=@('-v',"${projectRoot}/backend/tests:/tests:ro",'api','python3','-m','pytest','/tests','-q','-p','no:cacheprovider')
    & docker @testArgs
    if($LASTEXITCODE -ne 0){throw 'Backend tests failed'}
    Push-Location web
    try {
        npm.cmd ci --no-audit --no-fund
        npm.cmd test
        if($LASTEXITCODE -ne 0){throw 'Browser helper tests failed'}
        npm.cmd run build
        if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
        if($Browser){
            if(-not $env:PLAYWRIGHT_CHROMIUM_EXECUTABLE){npx.cmd playwright install chromium;if($LASTEXITCODE -ne 0){throw 'Chromium installation failed'}}
            npm.cmd run test:browser
            if($LASTEXITCODE -ne 0){throw 'Browser acceptance tests failed'}
        }
    } finally {Pop-Location}
} finally {Pop-Location}
