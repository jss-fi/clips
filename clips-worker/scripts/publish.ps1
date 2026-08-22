param(
    [string]$Version,
    [string]$Bucket,
    [ValidateSet('nightly', 'stable', 'both')]
    [string]$Channel = 'nightly',
    [switch]$WaitForArchive
)

$ErrorActionPreference = 'Stop'
$workerRoot = Split-Path $PSScriptRoot -Parent
$projectRoot = Split-Path $workerRoot -Parent
$dist = Join-Path $projectRoot 'dist'
$envFile = Join-Path $projectRoot '.env'
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*(CLIPS_UPDATE_BUCKET|CLIPS_R2_ACCOUNT_ID|CLIPS_R2_ACCESS_KEY_ID|CLIPS_R2_SECRET_ACCESS_KEY)\s*=\s*(.+?)\s*$') {
            $name = $Matches[1]
            $value = $Matches[2].Trim('"', "'")
            if ($name -eq 'CLIPS_UPDATE_BUCKET' -and -not $Bucket) {
                $Bucket = $value
            } elseif (-not [Environment]::GetEnvironmentVariable($name, 'Process')) {
                [Environment]::SetEnvironmentVariable($name, $value, 'Process')
            }
        }
    }
}
if (-not $Bucket) { throw 'CLIPS_UPDATE_BUCKET is missing. Copy .env.example to .env and configure it.' }

if (-not $Version) {
    $Version = (Get-Content (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
}

$installerName = "jss-clips-update-$Version-x64.exe"
$appPackageName = "jss-clips-app-$Version-x64.zip"
$sourceName = "jss-clips-source-$Version.zip"
$currentArtifacts = @($installerName, "$installerName.blockmap", $appPackageName, $sourceName)
if ($Version -notmatch '-') { $currentArtifacts += "jss-clips-setup-$Version-x64.exe" }
$files = @(
    @{ Name = $installerName; Type = 'application/octet-stream'; Cache = 'public, max-age=31536000, immutable' },
    @{ Name = "$installerName.blockmap"; Type = 'application/octet-stream'; Cache = 'public, max-age=31536000, immutable' },
    @{ Name = $appPackageName; Type = 'application/zip'; Cache = 'public, max-age=31536000, immutable' },
    @{ Name = $sourceName; Type = 'application/zip'; Cache = 'public, max-age=31536000, immutable' },
    @{ Name = 'latest.yml'; Type = 'text/yaml; charset=utf-8'; Cache = 'no-store, max-age=0' },
    @{ Name = 'latest.json'; Type = 'application/json; charset=utf-8'; Cache = 'no-store, max-age=0' }
)

foreach ($artifact in $currentArtifacts) {
    if (-not (Test-Path -LiteralPath (Join-Path $dist $artifact) -PathType Leaf)) { throw "Missing release artifact: $artifact" }
}

$latest = Get-Content (Join-Path $dist 'latest.yml') -Raw
if ($latest -notmatch "(?m)^version:\s+$([regex]::Escape($Version))\s*$" -or $latest -notmatch [regex]::Escape($installerName)) {
    throw "dist\latest.yml does not describe update $Version."
}
$stagedLatest = Get-Content (Join-Path $dist 'latest.json') -Raw | ConvertFrom-Json
if ($stagedLatest.version -ne $Version -or $stagedLatest.url -ne $appPackageName -or -not $stagedLatest.signature) {
    throw "dist\latest.json does not describe staged update $Version."
}
& node (Join-Path $workerRoot 'scripts\publish-r2.mjs') $dist $Bucket $Channel $Version
if ($LASTEXITCODE -ne 0) { throw 'R2 publishing failed.' }
& node (Join-Path $projectRoot 'scripts\verify-public-release.mjs') $dist $Channel $Version
if ($LASTEXITCODE -ne 0) { throw 'Public CDN verification failed; release artifacts remain safely on R2.' }
& node (Join-Path $workerRoot 'scripts\publish-r2.mjs') $dist $Bucket $Channel $Version mark
if ($LASTEXITCODE -ne 0) { throw 'Published-release marker failed; release artifacts remain safely on R2.' }

$archiveScript = Join-Path $projectRoot 'scripts\archive-release-background.mjs'
if ($WaitForArchive) {
    & node $archiveScript $dist $Bucket $Channel $Version
    if ($LASTEXITCODE -ne 0) { throw 'GitHub archival failed; release artifacts remain safely on R2.' }
    Write-Host "Published Clips $Version and completed GitHub archival."
} else {
    $logRoot = Join-Path $dist 'archive-logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $safeVersion = $Version -replace '[^0-9A-Za-z.-]', '_'
    $stdout = Join-Path $logRoot "$safeVersion.out.log"
    $stderr = Join-Path $logRoot "$safeVersion.err.log"
    $node = (Get-Command node -ErrorAction Stop).Source
    # The child owns its log handles. Start-Process redirection makes PowerShell
    # wait for those handles to close, accidentally turning archival synchronous.
    $process = Start-Process -FilePath $node -ArgumentList @($archiveScript, $dist, $Bucket, $Channel, $Version, $stdout, $stderr) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Write-Host "Clips $Version is live from R2. GitHub archival continues in background (PID $($process.Id))."
    Write-Host "Archive logs: $stdout"
}
