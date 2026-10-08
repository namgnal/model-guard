$ErrorActionPreference = 'Stop'
$guardRoot = Split-Path -Parent $PSScriptRoot
$guardData = if ($env:MODEL_GUARD_DATA) { $env:MODEL_GUARD_DATA } elseif ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME 'model-guard' } else { Join-Path $env:USERPROFILE '.codex/model-guard' }
$connectionPath = Join-Path $guardData 'server.json'
function Get-GuardUrl {
    if (-not (Test-Path -LiteralPath $connectionPath)) { return $null }
    try {
        $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
        $uri = [uri]$connection.url
        if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -ne 'http') { return $null }
        $probe = Invoke-RestMethod -Uri ($uri.GetLeftPart([System.UriPartial]::Authority) + '/api/state') -Headers @{Authorization = 'Bearer ' + $uri.Fragment.TrimStart('#')} -TimeoutSec 2
        if ($probe.product -eq 'model-guard') { return $connection.url }
    } catch { return $null }
    return $null
}
$guardUrl = Get-GuardUrl
if (-not $guardUrl) {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $entry = Join-Path $PSScriptRoot 'guard.mjs'
    Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entry + '"'), 'serve') -WorkingDirectory $guardRoot -WindowStyle Hidden
    for ($attempt=0; $attempt -lt 20 -and -not $guardUrl; $attempt++) { Start-Sleep -Milliseconds 250; $guardUrl = Get-GuardUrl }
}
if (-not $guardUrl) { throw '守望未能启动。请在此目录运行 node scripts/guard.mjs serve 查看错误。' }
Start-Process $guardUrl
