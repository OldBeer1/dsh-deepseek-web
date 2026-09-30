#!/usr/bin/env bash
# DSH x DeepSeek Web plugin - installer (macOS / Linux)
# DSH x DeepSeek 网页版插件 —— 安装脚本（macOS / Linux）
#
# What it does / 它做什么:
#   copies the plugin to a stable location and prints the sentence you must give to DSH.
#   The real install is done by DSH's own plugin_manager tool -- DSH ships no CLI installer.
#   把插件复制到稳定位置，并打印"该对 DSH 说的那句话"。
#   真正的安装由 DSH 自己的 plugin_manager 完成（DSH 没有命令行安装器）。
#
# NOTE: this file must stay UTF-8 **without** BOM (a BOM would break `bash`).
# 注意：本文件必须是**不带 BOM** 的 UTF-8（带 BOM 会让 bash 报错）。
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$repo_root/packages/dsh-deepseek-web"

echo
echo "DSH x DeepSeek Web - installer"
echo "------------------------------"

if [ ! -d "$src" ]; then
  echo "[X] packages/dsh-deepseek-web not found - run this script from the repository root." >&2
  echo "    找不到 packages/dsh-deepseek-web —— 请在仓库根目录运行本脚本。" >&2
  exit 1
fi

dsh_home="${DSH_HOME:-$HOME/.dsh}"
if [ ! -d "$dsh_home" ]; then
  echo "[X] DSH directory not found: $dsh_home" >&2
  echo "    没找到 DSH 目录 —— 确认已安装 DSH（应为 ~/.dsh 或 \$DSH_HOME）。" >&2
  exit 1
fi
echo "[1/3] DSH home : $dsh_home"

dest="$dsh_home/plugins/dsh-deepseek-web"
mkdir -p "$(dirname "$dest")"
rm -rf "$dest"
cp -R "$src" "$dest"
echo "[2/3] placed at: $dest"

sentence="Install the bundle at \"$dest\" into the current profile."
echo "[3/3] done"

echo
echo "Next three steps / 接下来三步:"
echo "  1. Open DSH and send this line to your DSH assistant:"
echo "     打开 DSH，把这行发给你的 DSH 助手（中文助手直接说「把上面那个目录作为插件包装进当前 profile」）："
echo
echo "     $sentence"
echo
echo "  2. Quit DSH completely and reopen it."
echo "     完全退出 DSH 再打开 —— 宿主端只在启动时加载，刷新页面不算。"
echo "  3. Click the new icon in the left rail -> Settings -> sign in with your phone."
echo
echo "  Note / 注意: DeepSeek enforces a captcha, so the plugin's own SMS request is often"
echo "  rejected. Open chat.deepseek.com in a browser, click 'Get code' once, then paste the"
echo "  6-digit code back into the panel."
echo "  官方强制人机验证，插件代发短信大概率被挡：到浏览器点一次「获取验证码」，把 6 位码填回面板。"
echo
echo "  Uninstall / 卸载: ask your DSH assistant to remove this bundle from the profile."
echo
