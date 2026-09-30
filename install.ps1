<#
  DSH x DeepSeek Web plugin - installer (Windows)
  DSH x DeepSeek 网页版插件 —— 安装脚本（Windows）

  What it does / 它做什么:
    copies the plugin to a stable location, and puts the sentence you must give to DSH
    onto your clipboard. The real install is done by DSH's own plugin_manager tool --
    DSH ships no command-line installer.
    把插件复制到稳定位置，并把"该对 DSH 说的那句话"放进剪贴板。
    真正的安装由 DSH 自己的 plugin_manager 完成（DSH 没有命令行安装器）。

  This file is saved as UTF-8 **with BOM** on purpose: Windows PowerShell 5.1 reads
  scripts as ANSI otherwise, and the Chinese lines would show up garbled.
  本文件特意保存为带 BOM 的 UTF-8：否则 PowerShell 5.1 会按 ANSI 读，中文会乱码。
#>
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$src = Join-Path $repoRoot 'packages\dsh-deepseek-web'

Write-Host ''
Write-Host 'DSH x DeepSeek Web - installer'
Write-Host '------------------------------'

if (-not (Test-Path $src)) {
  Write-Host '[X] packages\dsh-deepseek-web not found.' -ForegroundColor Red
  Write-Host '    找不到 packages\dsh-deepseek-web —— 请在仓库根目录运行本脚本。' -ForegroundColor Red
  exit 1
}

# 1) locate DSH / 定位 DSH
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $dshHome)) {
  Write-Host "[X] DSH directory not found: $dshHome" -ForegroundColor Red
  Write-Host '    没找到 DSH 目录 —— 确认已安装 DSH 桌面版（应为 %USERPROFILE%\.dsh 或 %DSH_HOME%）。' -ForegroundColor Red
  exit 1
}
Write-Host "[1/3] DSH home : $dshHome"

# 2) place the plugin / 放置插件
$dest = Join-Path $dshHome 'plugins\dsh-deepseek-web'
New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse -Force
Write-Host "[2/3] placed at: $dest"

# 3) clipboard / 剪贴板
$sentence = "Install the bundle at `"$dest`" into the current profile."
try {
  Set-Clipboard -Value $sentence -ErrorAction Stop
  Write-Host '[3/3] install sentence copied to clipboard / 安装指令已复制到剪贴板' -ForegroundColor Green
} catch {
  Write-Host '[3/3] clipboard unavailable - copy the line below manually' -ForegroundColor Yellow
  Write-Host '      （剪贴板不可用，请手动复制下面这行）' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next three steps / 接下来三步:' -ForegroundColor Cyan
Write-Host '  1. Open DSH and send this line to your DSH assistant:'
Write-Host '     打开 DSH，把这行发给你的 DSH 助手（中文助手直接说"把上面那个目录作为插件包装进当前 profile"）：'
Write-Host ''
Write-Host "     $sentence" -ForegroundColor White
Write-Host ''
Write-Host '  2. Quit DSH completely and reopen it.'
Write-Host '     完全退出 DSH 再打开 —— 宿主端只在启动时加载，刷新页面不算。'
Write-Host '  3. Click the new icon in the left rail -> Settings -> sign in with your phone.'
Write-Host ''
Write-Host '  Note / 注意: DeepSeek enforces a captcha, so the plugin''s own SMS request is often'
Write-Host '  rejected. Open chat.deepseek.com in a browser, click "Get code" once, then paste the'
Write-Host '  6-digit code back into the panel.'
Write-Host '  官方强制人机验证，插件代发短信大概率被挡：到浏览器点一次「获取验证码」，把 6 位码填回面板。'
Write-Host ''
Write-Host '  Uninstall / 卸载: ask your DSH assistant to remove this bundle from the profile.'
Write-Host ''
