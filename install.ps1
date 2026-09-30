<#
  DSH x DeepSeek Web plugin - installer (Windows)

  What it does: copies the plugin to a stable location (out of Downloads)
  and puts the sentence you must give DSH onto your clipboard.

  The actual install is done by DSH's own plugin_manager tool - that is the
  only supported entry point (DSH ships no command-line installer).

  Output is intentionally ASCII-only: Windows PowerShell 5.1 reads scripts as
  ANSI, so non-ASCII text would show up garbled.
#>
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$src = Join-Path $repoRoot 'packages\dsh-deepseek-web'

Write-Host ''
Write-Host 'DSH x DeepSeek Web - installer'
Write-Host '------------------------------'

if (-not (Test-Path $src)) {
  Write-Host '[X] packages\dsh-deepseek-web not found.' -ForegroundColor Red
  Write-Host '    Run this script from the repository root.' -ForegroundColor Red
  exit 1
}

# 1) locate DSH
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
if (-not (Test-Path $dshHome)) {
  Write-Host "[X] DSH directory not found: $dshHome" -ForegroundColor Red
  Write-Host '    Is DSH Desktop installed? (expected %USERPROFILE%\.dsh or %DSH_HOME%)' -ForegroundColor Red
  exit 1
}
Write-Host "[1/3] DSH home : $dshHome"

# 2) place the plugin
$dest = Join-Path $dshHome 'plugins\dsh-deepseek-web'
New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Copy-Item $src $dest -Recurse -Force
Write-Host "[2/3] placed at: $dest"

# 3) clipboard
$sentence = "Install the bundle at `"$dest`" into the current profile."
try {
  Set-Clipboard -Value $sentence -ErrorAction Stop
  Write-Host '[3/3] install sentence copied to clipboard' -ForegroundColor Green
} catch {
  Write-Host '[3/3] could not reach the clipboard - copy the line below manually' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Next three steps:' -ForegroundColor Cyan
Write-Host '  1. Open DSH and send this line to your DSH assistant:'
Write-Host ''
Write-Host "     $sentence" -ForegroundColor White
Write-Host ''
Write-Host '     (A Chinese assistant understands this too:'
Write-Host "      ba shangmian nage mulu zuowei chaji bao zhuangjin dangqian profile)"
Write-Host '  2. Quit DSH completely and reopen it. The host half loads only at startup,'
Write-Host '     so refreshing the page is not enough.'
Write-Host '  3. Click the new icon in the left rail -> Settings -> sign in with your phone.'
Write-Host ''
Write-Host '  Note: DeepSeek enforces a captcha, so the plugin''s own SMS request is often'
Write-Host '        rejected. Open chat.deepseek.com in a browser, click "Get code" once,'
Write-Host '        then paste the 6-digit code back into the panel.'
Write-Host ''
Write-Host '  Uninstall: ask your DSH assistant to remove this bundle from the profile.'
Write-Host ''
