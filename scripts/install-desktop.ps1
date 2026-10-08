param([switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$guardProject = Split-Path -Parent $PSScriptRoot
$guardPackage = Get-Content -LiteralPath (Join-Path $guardProject 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$guardInstaller = Join-Path $guardProject ('dist/Model-Guard-Setup-' + $guardPackage.version + '-x64.exe')
if (-not (Test-Path -LiteralPath $guardInstaller)) { throw '请先运行 npm run desktop:build 生成安装包。' }
$guardProfile = Join-Path $env:APPDATA 'Model Guard'
$guardConfigFile = Join-Path $guardProfile 'desktop-config.json'
if (-not (Test-Path -LiteralPath $guardConfigFile)) {
    $guardCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
    $guardData = if ($env:MODEL_GUARD_DATA) { $env:MODEL_GUARD_DATA } else { Join-Path $guardCodexHome 'model-guard' }
    $guardConfig = @{ codexHome = $guardCodexHome; dataDirectory = $guardData }
    if ($env:MODEL_GUARD_CODEX_PATH) { $guardConfig.codexPath = $env:MODEL_GUARD_CODEX_PATH }
    elseif ($env:MODELTRACE_CODEX_PATH) { $guardConfig.codexPath = $env:MODELTRACE_CODEX_PATH }
    [IO.Directory]::CreateDirectory($guardProfile) | Out-Null
    [IO.File]::WriteAllText($guardConfigFile, ($guardConfig | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
$guardInstall = Start-Process -FilePath $guardInstaller -ArgumentList '/S' -WindowStyle Hidden -PassThru
$guardInstall.WaitForExit()
if ($guardInstall.ExitCode -ne 0) { throw ('安装未完成，退出码：' + $guardInstall.ExitCode) }
$guardMenuLink = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs/守望 Model Guard.lnk'
if (-not (Test-Path -LiteralPath $guardMenuLink)) { throw '安装后未找到开始菜单快捷方式。' }
$guardShell = New-Object -ComObject WScript.Shell
$guardInstalled = $guardShell.CreateShortcut($guardMenuLink)
if (-not (Test-Path -LiteralPath $guardInstalled.TargetPath)) { throw '安装后的桌面程序不存在。' }
$guardDesktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) '守望 Model Guard.lnk'
foreach ($guardLinkPath in @($guardDesktopLink, (Join-Path $guardProject '打开守望.lnk'))) {
    $guardLink = $guardShell.CreateShortcut($guardLinkPath)
    $guardLink.TargetPath = $guardInstalled.TargetPath
    $guardLink.WorkingDirectory = Split-Path -Parent $guardInstalled.TargetPath
    $guardLink.Arguments = ''
    $guardLink.IconLocation = $guardInstalled.TargetPath + ',0'
    $guardLink.WindowStyle = 1
    $guardLink.Description = '打开守望独立桌面窗口'
    $guardLink.Save()
}
Write-Output ('桌面版已安装：' + $guardInstalled.TargetPath)
if (-not $NoLaunch) { Start-Process -FilePath $guardInstalled.TargetPath -WorkingDirectory (Split-Path -Parent $guardInstalled.TargetPath) -WindowStyle Normal }
