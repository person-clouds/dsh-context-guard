#!/bin/sh
# linuxops 兼容层：只实现 dsh-context-guard/scripts/inspect.sh 会调用的只读子命令。
# 不是上游 linuxops；不提供写操作、不 sudo、不启停服务。
set -u

usage() {
  cat <<'USAGE'
用法: linuxops <command> [args]

只读命令:
  sysinfo                         主机、内核、运行时间、内存、磁盘
  service status --name <unit>    服务状态
  service logs --name <unit> --lines <n>
                                  journalctl 最近日志
  network ports                   监听端口
  --version                       显示兼容层版本
USAGE
}

die() {
  printf 'linuxops: %s\n' "$*" >&2
  exit 2
}

check_name() {
  [ -n "${1:-}" ] || die '缺少服务名'
  case "$1" in
    *[!A-Za-z0-9@._:-]*) die "非法服务名：$1" ;;
  esac
}

check_lines() {
  case "${1:-}" in
    ''|*[!0-9]*) die "非法行数：$1" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 1000 ] || die "行数必须在 1-1000：$1"
}

sysinfo() {
  printf 'host: %s\n' "$(hostname 2>/dev/null || printf unknown)"
  printf 'kernel: %s\n' "$(uname -srm 2>/dev/null || printf unknown)"
  printf 'uptime: %s\n' "$(uptime -p 2>/dev/null || uptime 2>/dev/null || printf unknown)"
  printf '\n[memory]\n'
  free -h 2>/dev/null || printf 'free 不可用\n'
  printf '\n[disk]\n'
  df -hT -x tmpfs -x devtmpfs 2>/dev/null || df -h 2>/dev/null || printf 'df 不可用\n'
}

service_cmd() {
  sub="${1:-}"
  [ -n "$sub" ] || die '用法: linuxops service <status|logs> --name <unit>'
  shift || true
  name=''
  lines=50
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --name) shift; name="${1:-}" ;;
      --lines) shift; lines="${1:-}" ;;
      *) die "未知参数：$1" ;;
    esac
    shift || true
  done
  check_name "$name"
  check_lines "$lines"
  case "$sub" in
    status)
      command -v systemctl >/dev/null 2>&1 || die 'systemctl 不可用'
      exec systemctl status --no-pager --lines="$lines" "$name"
      ;;
    logs)
      command -v journalctl >/dev/null 2>&1 || die 'journalctl 不可用'
      exec journalctl -u "$name" -n "$lines" --no-pager -o short-iso
      ;;
    *) die "未知 service 子命令：$sub" ;;
  esac
}

network_cmd() {
  [ "${1:-}" = ports ] || die '用法: linuxops network ports'
  if command -v ss >/dev/null 2>&1; then
    exec ss -lntup
  elif command -v netstat >/dev/null 2>&1; then
    exec netstat -lntup
  else
    die 'ss/netstat 均不可用'
  fi
}

case "${1:-help}" in
  sysinfo) sysinfo ;;
  service) shift || true; service_cmd "$@" ;;
  network) shift || true; network_cmd "$@" ;;
  --version) printf 'linuxops-compat 1.0 (dsh-context-guard)\n' ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
