#!/usr/bin/env bash
# 把铁律钩子装到本机(全局生效于所有仓库): ~/.githooks + core.hooksPath。
# 换机器/换电脑后, 在这个仓库里跑一次:  ./git-hooks/install.sh
# 卸载:  git config --global --unset core.hooksPath
set -eu
src="$(cd "$(dirname "$0")" && pwd -P)"
dst="$HOME/.githooks"
mkdir -p "$dst"
stamp="$(date +%Y%m%d%H%M%S)"
for f in ai-trailer-guard.py commit-msg pre-push; do
  if [ -e "$dst/$f" ] && ! cmp -s "$src/$f" "$dst/$f"; then
    cp "$dst/$f" "$dst/$f.bak-$stamp"
    echo "  备份旧文件: $dst/$f.bak-$stamp"
  fi
  cp "$src/$f" "$dst/$f"
  chmod +x "$dst/$f"
  echo "  安装: $dst/$f"
done
git config --global core.hooksPath "$dst"
echo "  已设置 core.hooksPath = $dst"
echo
echo "自检(三条都该过):"
echo "  printf 'x\n\nCo-Authored-By: <AI> <noreply@example.com>\n' >/tmp/m.txt && $dst/commit-msg /tmp/m.txt && cat /tmp/m.txt"
