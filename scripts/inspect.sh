#!/usr/bin/env bash
# dsh-context-guard 只读调查脚本。
# 原则：不 sudo、不写系统、不启停服务；每段输出有行数/字节上限。
set -u

VERSION='1.0'
MAX_LINES="${INSPECT_MAX_LINES:-120}"
MAX_BYTES="${INSPECT_MAX_BYTES:-12000}"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
LOCAL_EXT="$DSH_HOME_DIR/context-guard/inspect.local.sh"
LINUXOPS_BIN="${LINUXOPS_BIN:-$(command -v linuxops 2>/dev/null || true)}"

if [ -r "$LOCAL_EXT" ]; then
  # 本机扩展不允许覆盖只读原则，仅补充别名/路径。
  # shellcheck disable=SC1090
  . "$LOCAL_EXT"
fi

usage() {
  cat <<'USAGE'
用法: inspect.sh <mode> [args]

只读模式:
  overview                 系统概览
  service <unit>           systemd 服务状态
  app <name>               systemd 或 docker 应用状态
  logs <file|unit> [n]     文件 tail 或 journalctl -u
  git [dir]                分支、status、diff --stat、最近提交
  ports                    监听端口
  docker [name]            docker ps / 容器详情
  http <url>               HTTP 状态与耗时
  report                   概览 + 失败服务 + 端口 + docker + 磁盘

环境变量:
  INSPECT_MAX_LINES        每段最大行数（默认 120）
  INSPECT_MAX_BYTES        每段最大字节（默认 12000）
  LINUXOPS_BIN             linuxops 可执行文件路径（可选）
USAGE
}

section() {
  printf '\n## %s\n' "$*"
}

# 只允许由本脚本传入的 linuxops 只读子命令。
has_linuxops() {
  [ -n "${LINUXOPS_BIN:-}" ] && [ -x "$LINUXOPS_BIN" ]
}

run_bounded() {
  "$@" 2>&1 | head -n "$MAX_LINES" | head -c "$MAX_BYTES"
  printf '\n'
}

need_arg() {
  if [ "$#" -lt 1 ] || [ -z "$1" ]; then
    printf '缺少参数：%s\n' "$1" >&2
    usage >&2
    exit 2
  fi
}

check_name() {
  case "$1" in
    *[!A-Za-z0-9@._:-]*) printf '非法名称：%s\n' "$1" >&2; exit 2 ;;
  esac
}

overview() {
  section '系统'
  if has_linuxops; then
    run_bounded "$LINUXOPS_BIN" sysinfo
  else
    run_bounded uname -a
    run_bounded uptime
    run_bounded free -h
    run_bounded df -hT -x tmpfs -x devtmpfs
  fi
}

service_status() {
  need_arg "${1:-}"
  check_name "$1"
  section "服务 $1"
  if has_linuxops; then
    run_bounded "$LINUXOPS_BIN" service status --name "$1"
  else
    run_bounded systemctl status --no-pager --lines=30 "$1"
  fi
}

app_status() {
  need_arg "${1:-}"
  check_name "$1"
  section "应用 $1"
  if systemctl list-unit-files --no-pager --type=service 2>/dev/null | awk '{print $1}' | grep -qx "$1.service\|$1"; then
    service_status "$1"
    return
  fi
  if command -v docker >/dev/null 2>&1; then
    run_bounded docker ps -a --filter "name=$1" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
    run_bounded docker inspect --format 'restart={{.HostConfig.RestartPolicy.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"
    return
  fi
  printf '未找到 systemd 服务或 docker 容器：%s\n' "$1"
}

logs_cmd() {
  need_arg "${1:-}"
  local target="$1" lines="${2:-80}"
  case "$lines" in *[!0-9]*|'') lines=80 ;; esac
  section "日志 $target（最多 $lines 行）"
  if [ -f "$target" ]; then
    run_bounded tail -n "$lines" -- "$target"
  elif has_linuxops; then
    run_bounded "$LINUXOPS_BIN" service logs --name "$target" --lines "$lines"
  else
    run_bounded journalctl -u "$target" -n "$lines" --no-pager -o short-iso
  fi
}

git_cmd() {
  local dir="${1:-$PWD}"
  if ! git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf '不是 git 工作区：%s\n' "$dir" >&2
    exit 2
  fi
  section "Git $dir"
  printf '分支: '
  git -C "$dir" branch --show-current 2>/dev/null || true
  run_bounded git -C "$dir" status --short --branch
  run_bounded git -C "$dir" diff --stat
  run_bounded git -C "$dir" log -n 5 --oneline --decorate
}

ports_cmd() {
  section '监听端口'
  if has_linuxops; then
    run_bounded "$LINUXOPS_BIN" network ports
  elif command -v ss >/dev/null 2>&1; then
    run_bounded ss -lntup
  else
    run_bounded netstat -lntup
  fi
}

docker_cmd() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'docker 不可用\n'
    return
  fi
  if [ "$#" -gt 0 ] && [ -n "$1" ]; then
    check_name "$1"
    section "Docker $1"
    run_bounded docker ps -a --filter "name=$1" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
    run_bounded docker inspect --format 'restart={{.HostConfig.RestartPolicy.Name}} status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1"
    run_bounded docker logs --tail 60 "$1"
  else
    section 'Docker 容器'
    run_bounded docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}'
  fi
}

http_cmd() {
  need_arg "${1:-}"
  case "$1" in
    http://*|https://*) ;;
    *) printf '只允许 http/https URL：%s\n' "$1" >&2; exit 2 ;;
  esac
  section "HTTP $1"
  run_bounded curl -sS -L --max-time 10 -o /dev/null -w 'status=%{http_code} time=%{time_total}s size=%{size_download}B redirects=%{num_redirects}\n' "$1"
}

report_cmd() {
  overview
  section '失败的服务'
  run_bounded systemctl --failed --no-pager
  ports_cmd
  docker_cmd
  section '磁盘'
  run_bounded df -hT -x tmpfs -x devtmpfs
}

mode="${1:-overview}"
[ "$#" -gt 0 ] && shift || true
case "$mode" in
  overview) overview ;;
  service) service_status "$@" ;;
  app) app_status "$@" ;;
  logs) logs_cmd "$@" ;;
  git) git_cmd "$@" ;;
  ports) ports_cmd ;;
  docker) docker_cmd "$@" ;;
  http) http_cmd "$@" ;;
  report) report_cmd ;;
  -h|--help|help) usage ;;
  *) printf '未知模式：%s\n\n' "$mode" >&2; usage >&2; exit 2 ;;
esac
