#!/usr/bin/env bash
# 自检/应用 DSH 自动压缩阈值：把内置 preset 覆盖块写进 home patch，
# 只给 compaction-basic 注入 config（thresholdRatio/retainRatio/headroomTokens）。
#
# 用法：
#   scripts/apply-compaction.sh check            # 默认，只读自检
#   scripts/apply-compaction.sh apply            # 备份后原位替换/追加
#   scripts/apply-compaction.sh dry-run          # 只打印将改动的 preset
#   兼容 --check / --apply / --dry-run 写法
#
# 工作区 AI 沙箱对 ~/.dsh 只读，因此 apply 由用户在自己的终端执行。
set -euo pipefail

HOME_DIR="${HOME:-/home/zh}"
DSH_HOME="${DSH_HOME:-$HOME_DIR/.dsh}"

usage() {
  cat <<'EOF'
用法: apply-compaction.sh [check|apply|dry-run] [选项]

子命令:
  check      （默认）检查 home patch 中每个内置 preset 的 compaction-basic 配置
  apply      备份 home patch 后，按内置 preset 重新生成覆盖块（原位替换，缺失则追加）
  dry-run    只打印 apply 会做哪些改动，不写盘

选项:
  --presets-dir <目录>  内置 preset 目录（默认从 dsh 可执行文件解析安装根）
  --patch <文件>        home patch 文件（默认 ${DSH_HOME}/cordis.patch.yml）
  --profile <名称>      与 --deep 搭配，指定要 dump-config 交叉核对的 profile
  --deep                追加 dsh --profile <p> --dump-config 核对（慢但最权威）
  -h, --help            显示本帮助

验收: check 全部 PASS 时退出 0；任一 preset FAIL 或 --deep 不符时退出非零。
EOF
}

error() { echo "错误: $*" >&2; exit 2; }

CMD="check"
PRESETS_DIR=""
PATCH=""
PROFILE=""
DEEP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    check|apply|dry-run) CMD="$1"; shift ;;
    --check) CMD="check"; shift ;;
    --apply) CMD="apply"; shift ;;
    --dry-run) CMD="dry-run"; shift ;;
    --presets-dir) PRESETS_DIR="${2:?--presets-dir 需要一个目录}"; shift 2 ;;
    --presets-dir=*) PRESETS_DIR="${1#*=}"; shift ;;
    --patch) PATCH="${2:?--patch 需要一个文件}"; shift 2 ;;
    --patch=*) PATCH="${1#*=}"; shift ;;
    --profile) PROFILE="${2:?--profile 需要一个 profile 名}"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --deep) DEEP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; error "未知参数: $1" ;;
  esac
done

PATCH="${PATCH:-$DSH_HOME/cordis.patch.yml}"

# 内置 preset 目录：.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets
if [[ -z "$PRESETS_DIR" ]]; then
  INSTALL_ROOT=""
  DSH_BIN="$(command -v dsh || true)"
  if [[ -n "$DSH_BIN" ]]; then
    INSTALL_ROOT="$(cd "$(dirname "$(readlink -f "$DSH_BIN")")/.." && pwd)"
  fi
  CANDIDATES=()
  [[ -n "$INSTALL_ROOT" ]] && CANDIDATES+=("$INSTALL_ROOT/node_modules/@deepseek-ai/dsh-web-app/presets")
  NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  [[ -n "$NPM_ROOT" ]] && CANDIDATES+=("$NPM_ROOT/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets")
  for candidate in "${CANDIDATES[@]}"; do
    if [[ -d "$candidate" ]]; then
      PRESETS_DIR="$candidate"
      break
    fi
  done
fi

[[ -n "$PRESETS_DIR" ]] || error "找不到内置 preset 目录，请用 --presets-dir 指定"
[[ -d "$PRESETS_DIR" ]] || error "内置 preset 目录不存在: $PRESETS_DIR"

if [[ "$CMD" == "check" || "$CMD" == "dry-run" || "$CMD" == "apply" ]]; then
  [[ -f "$PATCH" ]] || error "找不到 home patch: $PATCH"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

python3 - "$CMD" "$PRESETS_DIR" "$PATCH" "$PROFILE" "$DEEP" "$STAMP" <<'PY'
import os
import pathlib
import re
import shutil
import subprocess
import sys

mode, presets_dir, patch_path, profile, deep, stamp = sys.argv[1:7]
presets_dir = pathlib.Path(presets_dir)
patch_path = pathlib.Path(patch_path)
deep = deep == '1'

# 期望的 compaction-basic 配置；顺序即写盘顺序。
DESIRED = [
    ('thresholdRatio', '0.20'),
    ('retainRatio', '0.03'),
    ('headroomTokens', '65536'),
]
# 宿主在 apply-profile.sh 里给 preset-minimal 加的附加配置，重写时按原位置保留。
HOST_KEYS = {'maxOutputChars': 'persistent-bash'}


def indent_of(line):
    return len(line) - len(line.lstrip(' '))


def block_end(lines, start, end):
    """返回顶层块结束下标：缩进行与块内空行算块内，顶层注释/条目结束块。"""
    j = start + 1
    while j < end:
        line = lines[j]
        if line.strip() == '':
            k = j
            while k < end and lines[k].strip() == '':
                k += 1
            if k < end and lines[k].startswith(' '):
                j = k
                continue
            return j
        if line.startswith(' '):
            j += 1
            continue
        return j
    return end


def child_end(lines, start, end):
    base = indent_of(lines[start])
    j = start + 1
    while j < end:
        line = lines[j]
        if line.strip() == '':
            k = j
            while k < end and lines[k].strip() == '':
                k += 1
            if k < end and indent_of(lines[k]) > base:
                j = k
                continue
            return j
        if indent_of(line) > base:
            j += 1
            continue
        return j
    return end


def parse_preset_blocks(lines):
    blocks = []
    i = 0
    while i < len(lines):
        if lines[i].startswith('- id: preset-'):
            name = lines[i][len('- id: '):].strip()
            j = block_end(lines, i, len(lines))
            blocks.append((name, i, j))
            i = j
        else:
            i += 1
    return blocks


def compaction_entries(lines, start, end):
    out = []
    for i in range(start, end):
        if lines[i].strip().startswith('- id: compaction-basic'):
            out.append((i, child_end(lines, i, end)))
    return out


def find_line(lines, start, end, stripped):
    for i in range(start, end):
        if lines[i].strip() == stripped:
            return i
    return None


def config_fields(lines, start, end):
    """读取某项 config 的直接子键。"""
    cfg = find_line(lines, start, end, 'config:')
    if cfg is None:
        return None, None, {}
    cfg_end = child_end(lines, cfg, end)
    base = indent_of(lines[cfg])
    fields = {}
    for i in range(cfg + 1, cfg_end):
        line = lines[i]
        if not line.strip() or indent_of(line) != base + 2:
            continue
        m = re.match(r'^\s*([A-Za-z0-9_]+):\s*(.*?)\s*$', line)
        if m:
            fields[m.group(1)] = m.group(2)
    return cfg, cfg_end, fields


def ensure_config(lines, entry_start, entry_end):
    """确保条目有 config 行，返回其下标（需要时在 name 行后插入）。"""
    idx = find_line(lines, entry_start, entry_end, 'config:')
    if idx is not None:
        return idx
    insert_at = entry_start + 1
    for i in range(entry_start + 1, entry_end):
        if lines[i].strip().startswith('name:'):
            insert_at = i + 1
            break
    lines.insert(insert_at, ' ' * (indent_of(lines[entry_start]) + 2) + 'config:')
    return insert_at


def set_field(lines, entry_start, entry_end, key, value):
    # 插入会改变行数，每次按当前内容重算条目边界。
    entry_end = child_end(lines, entry_start, len(lines))
    cfg = ensure_config(lines, entry_start, entry_end)
    cfg_end = child_end(lines, cfg, entry_end)
    base = indent_of(lines[cfg])
    for i in range(cfg + 1, cfg_end):
        if re.match(r'^\s*' + re.escape(key) + r':', lines[i]):
            lines[i] = ' ' * (base + 2) + f'{key}: {value}'
            return
    # 新键插在已有压缩字段之后，保持 thresholdRatio/retainRatio/headroomTokens 的顺序。
    desired_keys = {name for name, _ in DESIRED}
    insert_at = cfg
    for i in range(cfg + 1, cfg_end):
        m = re.match(r'^\s*([A-Za-z0-9_]+):', lines[i])
        if m and m.group(1) in desired_keys:
            insert_at = i
    lines.insert(insert_at + 1, ' ' * (base + 2) + f'{key}: {value}')


def builtin_presets():
    presets = {}
    for path in sorted(presets_dir.glob('*.patch.yml')):
        lines = path.read_text().splitlines()
        insert = find_line(lines, 0, len(lines), '- insert:')
        if insert is None:
            continue
        child = lines[insert + 1:]
        while child and child[-1].strip() == '':
            child.pop()
        child = [line[4:] if line.startswith('    ') else line for line in child]
        for name, start, end in parse_preset_blocks(child):
            presets[name.strip()] = child[start:end]
    return presets


def has_compaction(block):
    return any(line.strip().startswith('- id: compaction-basic') for line in block)


def build_desired(builtin_block, existing_block):
    lines = list(builtin_block)
    entries = compaction_entries(lines, 0, len(lines))
    if len(entries) != 1:
        raise SystemExit(f'内置 preset 中 compaction-basic 出现 {len(entries)} 次，预期 1 次')
    for key, value in DESIRED:
        set_field(lines, entries[0][0], entries[0][1], key, value)
    # 保留宿主已有的附加配置值（当前仅 maxOutputChars）。
    if existing_block:
        for key, entry_id in HOST_KEYS.items():
            found = None
            for line in existing_block:
                m = re.match(r'^\s*' + re.escape(key) + r':\s*(\S+)\s*$', line)
                if m:
                    found = m.group(1)
                    break
            if found is None:
                continue
            idx = find_line(lines, 0, len(lines), '- id: ' + entry_id)
            if idx is None:
                continue
            set_field(lines, idx, child_end(lines, idx, len(lines)), key, found)
    return lines


def normalized(lines):
    out = []
    for line in lines:
        if not line.strip() or line.strip().startswith('#'):
            continue
        out.append(line.rstrip().replace('"', '').replace("'", ''))
    return out


def compaction_problems(block):
    """返回 (problems, 定位信息)；problems 为空表示三字段齐全且正确。"""
    problems = []
    count = sum(1 for line in block if line.strip().startswith('- id: compaction-basic'))
    if count == 0:
        return ['缺少 compaction-basic 条目（该 preset 不会自动压缩）'], None
    if count > 1:
        return [f'compaction-basic 出现 {count} 次，预期 1 次'], None
    start = next(i for i, line in enumerate(block) if line.strip().startswith('- id: compaction-basic'))
    end = child_end(block, start, len(block))
    cfg, _, fields = config_fields(block, start, end)
    if cfg is None:
        return ['compaction-basic 缺少 config 段'], None
    for key, value in DESIRED:
        if key not in fields:
            problems.append(f'缺少 {key}（期望 {value}）')
        elif fields[key].strip() != value:
            problems.append(f'{key}={fields[key].strip()}，期望 {value}')
    return problems, fields


def deep_check(presets):
    if not profile:
        print('FAIL: --deep 需要同时给 --profile <名称>')
        return 1
    dump = subprocess.run(['dsh', '--profile', profile, '--dump-config'],
                          capture_output=True, text=True)
    if dump.returncode != 0:
        print(f'FAIL: dsh --profile {profile} --dump-config 失败（退出 {dump.returncode}）')
        print((dump.stderr or '').strip()[:2000])
        return 1
    failed = 0
    checked = 0
    lines = dump.stdout.splitlines()
    for i, line in enumerate(lines):
        # 只看条目行，避免把 `- id: command-compact` 等相近名字算进来。
        if not re.search(r'^\s*- id: compaction-basic\s*$', line):
            continue
        window = '\n'.join(lines[i:i + 8])
        # 基础插件表里可能有 `disabled: true` 的空壳条目（已被 preset 覆盖），跳过。
        if re.search(r'^\s*disabled:\s*true\s*$', window, re.M):
            continue
        # dump-config 会把数值 0.20 压成 0.2，两种写法都算通过。
        if re.search(r'thresholdRatio:\s*0\.2(?:0)?\b', window):
            checked += 1
            continue
        failed = 1
        print(f'FAIL: --dump-config 中 compaction-basic（第 {i + 1} 行起）未见 thresholdRatio: 0.20')
    if checked == 0:
        failed = 1
        print('FAIL: --dump-config 中没有启用的 compaction-basic 条目带 thresholdRatio: 0.20')
    return failed


if not patch_path.is_file():
    raise SystemExit(f'找不到 home patch: {patch_path}')

builtin = builtin_presets()
targets = [name for name, block in builtin.items() if has_compaction(block)]
if not targets:
    raise SystemExit(f'{presets_dir} 中没有任何含 compaction-basic 的 preset，无法检查')

patch_text = patch_path.read_text()
patch_lines = patch_text.splitlines()
blocks = parse_preset_blocks(patch_lines)
by_name = {}
duplicates = []
for name, start, end in blocks:
    if name in by_name:
        duplicates.append((name, start + 1))
    else:
        by_name[name] = (start, end)

if mode in ('check', 'dry-run'):
    failed = 0
    if mode == 'check':
        for name in targets:
            if name not in by_name:
                failed = 1
                print(f'FAIL: {name} 未被 home patch 覆盖，会回落默认阈值（0.8）')
                continue
            start, end = by_name[name]
            block = patch_lines[start:end]
            problems, _ = compaction_problems(block)
            if problems:
                failed = 1
                for problem in problems:
                    print(f'FAIL: {name} {problem}')
                continue
            expected = build_desired(builtin[name], block)
            if normalized(expected) != normalized(block):
                failed = 1
                print(f'FAIL: {name} 与安装包 preset 不一致（DSH 可能已升级），执行 --apply 同步')
                continue
            print(f'PASS: {name}')
        for name, start, end in blocks:
            if name not in builtin and has_compaction(patch_lines[start:child_end(patch_lines, start, len(patch_lines))]):
                problems, _ = compaction_problems(patch_lines[start:child_end(patch_lines, start, len(patch_lines))])
                if problems:
                    failed = 1
                    for problem in problems:
                        print(f'FAIL: {name}（非内置 preset）{problem}')
                else:
                    print(f'PASS: {name}（非内置 preset，仅校验阈值）')
    for name, line in duplicates:
        print(f'WARN: home patch 第 {line} 行重复出现 {name}，后写块会被静默忽略，请人工合并')
    if mode == 'check' and deep and deep_check(targets):
        failed = 1
    if mode == 'check':
        print(f"\n摘要: {len(targets)} 个内置 preset，{'全部通过' if not failed else '存在 FAIL'}")
        sys.exit(1 if failed else 0)
    # dry-run
    changes = []
    for name in targets:
        if name not in by_name:
            changes.append(('追加', name))
            continue
        start, end = by_name[name]
        block = patch_lines[start:end]
        expected = build_desired(builtin[name], block)
        if normalized(expected) != normalized(block):
            changes.append(('原位替换', name))
    for action, name in changes:
        print(f'将{action} {name}')
    if not changes:
        print('无变化')
    print('（dry-run：未写入）')
    sys.exit(0)

# apply：先按行号从大到小做原位替换（避免偏移互相影响），再追加缺失的 preset。
new_lines = list(patch_lines)
changed = []
replacements = []
appends = []
for name in targets:
    if name not in by_name:
        appends.append((name, build_desired(builtin[name], None)))
        changed.append(('追加', name))
        continue
    start, end = by_name[name]
    block = build_desired(builtin[name], patch_lines[start:end])
    if normalized(block) != normalized(patch_lines[start:end]):
        replacements.append((start, end, block))
        changed.append(('原位替换', name))
for start, end, block in sorted(replacements, key=lambda item: item[0], reverse=True):
    new_lines[start:end] = block
for name, block in appends:
    if new_lines and new_lines[-1].strip() != '':
        new_lines.append('')
    new_lines.append(f'# compaction：覆盖 {name} 的完整 plugins 列表，只给 compaction-basic 加阈值；DSH 升级后重跑本脚本。')
    new_lines.extend(block)

if not changed:
    print('无变化')
    sys.exit(0)

new_text = '\n'.join(new_lines)
if patch_text.endswith('\n') or not new_text.endswith('\n'):
    new_text += '\n'
backup = patch_path.with_name(patch_path.name + f'.bak.compaction-{stamp}')
shutil.copy2(patch_path, backup)
patch_path.write_text(new_text)
for action, name in changed:
    print(f'已{action} {name}')
print(f'已备份: {backup}')
print('回滚: cp ' + str(backup) + ' ' + str(patch_path) + ' 然后重启对应 dsh profile')
PY

if [[ "$CMD" == "apply" ]]; then
  echo
  echo '建议验证：'
  echo "  bash $0 --check"
  echo '  dsh --profile <名称> --dump-config | grep -A3 "compaction-basic"'
fi
