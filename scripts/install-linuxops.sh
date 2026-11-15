#!/usr/bin/env bash
# 安装/卸载 linuxops 兼容层，或把用户自建的 linuxops 二进制安装到 ~/.local/bin。
# 默认只写用户目录，不需要 sudo。
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PREFIX="${HOME:-/home/zh}/.local/bin"
FORCE=0
UNINSTALL=0
BINARY=""

usage() {
  cat <<'USAGE'
用法: install-linuxops.sh [选项]

选项:
  --prefix <dir>     安装目录（默认: ~/.local/bin）
  --binary <path>    安装已有的 linuxops 二进制，而不是插件兼容层
  --force            覆盖已存在的目标文件
  --uninstall        删除 <prefix>/linuxops
  -h, --help         显示帮助

示例:
  scripts/install-linuxops.sh                 # 安装只读兼容层
  scripts/install-linuxops.sh --force         # 覆盖重装
  scripts/install-linuxops.sh --binary ./linuxops
  scripts/install-linuxops.sh --uninstall
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) shift; [ "$#" -gt 0 ] || { echo '缺少 --prefix 参数' >&2; exit 2; }; PREFIX="$1" ;;
    --binary) shift; [ "$#" -gt 0 ] || { echo '缺少 --binary 参数' >&2; exit 2; }; BINARY="$1" ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

TARGET="$PREFIX/linuxops"

if [ "$UNINSTALL" -eq 1 ]; then
  rm -f -- "$TARGET"
  echo "已删除 $TARGET"
  exit 0
fi

mkdir -p -- "$PREFIX"

if [ -e "$TARGET" ] && [ "$FORCE" -ne 1 ]; then
  echo "目标已存在：$TARGET" >&2
  echo "如需覆盖请加 --force；如需卸载请加 --uninstall。" >&2
  exit 1
fi

if [ -n "$BINARY" ]; then
  [ -f "$BINARY" ] || { echo "找不到二进制：$BINARY" >&2; exit 1; }
  install -m 0755 -- "$BINARY" "$TARGET"
  echo "已安装用户提供的二进制到 $TARGET"
else
  SRC="$SCRIPT_DIR/linuxops-shim.sh"
  [ -f "$SRC" ] || { echo "缺少兼容层脚本：$SRC" >&2; exit 1; }
  install -m 0755 -- "$SRC" "$TARGET"
  echo "已安装只读兼容层到 $TARGET"
fi

case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "提示：$PREFIX 不在 PATH 中，可执行 export PATH=\"$PREFIX:\$PATH\"" ;;
esac

"$TARGET" --version 2>/dev/null || true
echo "验证：LINUXOPS_BIN=$TARGET $SCRIPT_DIR/inspect.sh overview"
