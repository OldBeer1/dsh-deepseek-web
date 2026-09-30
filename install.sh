#!/usr/bin/env bash
# DSH × DeepSeek Web plugin — installer (macOS / Linux)
#
# 只做一件事：把插件放到稳定位置，并打印"接下来该对 DSH 说的那句话"。
# 真正的安装由 DSH 自己的 plugin_manager 完成（唯一受支持的入口）。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$repo_root/packages/dsh-deepseek-web"

echo
echo "DSH x DeepSeek Web — installer"
echo "--------------------------------"

if [ ! -d "$src" ]; then
  echo "[X] packages/dsh-deepseek-web not found — run this script from the repository root." >&2
  exit 1
fi

dsh_home="${DSH_HOME:-$HOME/.dsh}"
if [ ! -d "$dsh_home" ]; then
  echo "[X] DSH directory not found: $dsh_home" >&2
  echo "    Is DSH Desktop installed? (expected ~/.dsh or \$DSH_HOME)" >&2
  exit 1
fi
echo "[1/3] DSH dir: $dsh_home"

dest="$dsh_home/plugins/dsh-deepseek-web"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
cp -R "$src" "$dest"
echo "[2/3] plugin placed at: $dest"

sentence="Install the bundle at \"$dest\" into the current profile."
echo "[3/3] done"
echo
echo "Next three steps:"
echo "  1. Open DSH and send this line to your DSH assistant:"
echo
echo "     $sentence"
echo
echo "  2. Quit DSH completely and reopen it (the host half loads only at startup)."
echo "  3. Click the new icon in the left rail -> Settings -> sign in with your phone number."
echo
echo "  Note: DeepSeek enforces a captcha, so the plugin's own SMS request is often rejected."
echo "        Open chat.deepseek.com in a browser, click 'Get code' once, paste the 6-digit code back."
echo
