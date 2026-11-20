#!/usr/bin/env bash
# 在宿主机用户环境执行：安装/迁移 context-guard profile 插入项，
# 对齐官方 tool-result-pruner，并覆盖 minimal preset 提高 persistent-bash 输出上限。
# 工作区 AI 沙箱对 ~/.dsh 只读，因此本脚本由用户执行。
set -euo pipefail

HOME_DIR="${HOME:-/home/zh}"
DSH_HOME="${DSH_HOME:-$HOME_DIR/.dsh}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
PROFILE_NAMES=("web" "superagent")
SUPERAGENT_DIR="${DSH_SUPERAGENT_DIR:-$HOME_DIR/www/dsh-superagent}"
missing=0

# dsh 安装目录：.../node_modules/@deepseek-ai/dsh
DSH_INSTALL="$(cd "$(dirname "$(readlink -f "$(command -v dsh)")")/.." && pwd)"
PRESET_FILE="$DSH_INSTALL/node_modules/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml"
[[ -f "$PRESET_FILE" ]] || PRESET_FILE=""

for profile_name in "${PROFILE_NAMES[@]}"; do
  profile_dir="$DSH_HOME/profiles/$profile_name"
  profile="$profile_dir/cordis.patch.yml"
  [[ -f "$profile" ]] || { echo "跳过不存在的 profile: $profile"; continue; }

  if [[ ! -e "$profile_dir/node_modules/@fenghoer/dsh-context-guard" ]]; then
    echo "错误: $profile_name 未安装 @fenghoer/dsh-context-guard" >&2
    echo "请先执行: dsh plugin --profile $profile_name add link:$ROOT" >&2
    missing=1
    continue
  fi

  if [[ -L "$profile_dir/node_modules/dsh-superagent" && ! -e "$profile_dir/node_modules/dsh-superagent" ]]; then
    echo "错误: $profile_name 的 dsh-superagent link 已失效（目标不存在）" >&2
    if [[ -d "$SUPERAGENT_DIR" ]]; then
      echo "请执行: dsh plugin --profile $profile_name add link:$SUPERAGENT_DIR" >&2
    else
      echo "请把 DSH_SUPERAGENT_DIR 指向有效仓库后重试" >&2
    fi
    missing=1
    continue
  fi

  cp -a "$profile" "$profile.bak.context-guard-$STAMP"
  python3 - "$profile" "$PRESET_FILE" <<'PY'
import pathlib, re, sys

p = pathlib.Path(sys.argv[1])
preset = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else None
text = p.read_text()
changed = False


def delete_block(text, entry_id):
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith(f'- id: {entry_id}')), None)
    if start is None:
        return text, False
    end = start + 1
    while end < len(lines) and lines[end].startswith(' '):
        end += 1
    # 同时移除紧邻其上的 context-guard 注释块。
    while start > 0 and lines[start - 1].startswith('# context-guard'):
        start -= 1
    del lines[start:end]
    return '\n'.join(lines) + ('\n' if text.endswith('\n') else ''), True


# 1) 修复旧插入项：scoped 包名，compaction-archive -> context-guard。
before = text
text = text.replace('    - id: compaction-archive\n      name: dsh-compaction-archive\n',
                    "    - id: context-guard\n      name: '@fenghoer/dsh-context-guard'\n")
text = text.replace('    - id: context-guard\n      name: dsh-context-guard\n',
                    "    - id: context-guard\n      name: '@fenghoer/dsh-context-guard'\n")
text = text.replace('# compaction-archive：', '# context-guard：')
if text != before:
    changed = True

if '- id: context-guard' not in text:
    text = text.rstrip() + """
# context-guard：工具输出预算/落盘/去重 + 压缩前 STATUS 快照。
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
      config:
        maxCallsPerTurn: 80
        hardMaxCallsPerTurn: 160
"""
    changed = True

# 1b) 旧 context-guard 插入项补上显式阈值配置；已有配置不覆盖。
text = re.sub(
    r"(- id: context-guard\n      name: '@fenghoer/dsh-context-guard')\n(?=\n|$)",
    r"\1\n      config:\n        maxCallsPerTurn: 80\n        hardMaxCallsPerTurn: 160\n",
    text,
)
changed = True if 'hardMaxCallsPerTurn: 160' in text else changed

# 1c) 旧默认阈值（20/80）升级为 80/160，重复执行幂等。
text_before_upgrade = text
text = text.replace('maxCallsPerTurn: 20', 'maxCallsPerTurn: 80')
text = text.replace('hardMaxCallsPerTurn: 80', 'hardMaxCallsPerTurn: 160')
if text != text_before_upgrade:
    changed = True

# 2) persistent-bash 不在 profile 顶层，旧写法会报 patch: entry not found。
#    删除旧块，改为覆盖 minimal preset 的完整 plugins 列表。
text, removed = delete_block(text, 'persistent-bash')
changed = changed or removed

# 3) 顶层 tool-result-pruner 与插件预算对齐。
lines = text.splitlines()
start = next((i for i, line in enumerate(lines) if line.startswith('- id: tool-result-pruner')), None)
if start is not None:
    end = start + 1
    while end < len(lines) and lines[end].startswith(' '):
        end += 1
    block = [
        '- id: tool-result-pruner',
        "  name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
        '  config:',
        '    thresholdChars: 6000',
        '    headChars: 3000',
        '    tailChars: 1500',
    ]
    if lines[start:end] != block:
        lines[start:end] = block
        changed = True
    text = '\n'.join(lines) + ('\n' if text.endswith('\n') else '')

# 4) 从安装包读取 minimal preset，生成 preset-minimal 覆盖块。
if preset is not None and preset.is_file():
    preset_lines = preset.read_text().splitlines()
    try:
        plugins_index = next(i for i, line in enumerate(preset_lines) if line.strip() == 'plugins:')
    except StopIteration:
        plugins_index = None
    if plugins_index is not None:
        child = preset_lines[plugins_index + 1:]
        while child and not child[-1].strip():
            child.pop()
        persistent_index = next((i for i, line in enumerate(child) if line.strip() == '- id: persistent-bash'), None)
        if persistent_index is not None:
            config_index = next((i for i in range(persistent_index + 1, len(child)) if child[i].strip() == 'config:'), None)
            if config_index is not None:
                indent = ' ' * (len(child[config_index]) - len(child[config_index].lstrip()) + 2)
                existing = next((i for i in range(config_index + 1, len(child)) if child[i].strip().startswith('maxOutputChars:')), None)
                if existing is not None:
                    child[existing] = indent + 'maxOutputChars: 65536'
                else:
                    child.insert(config_index + 1, indent + 'maxOutputChars: 65536')
        child = [line[4:] if line.startswith('    ') else line for line in child]
        override = [
            '# context-guard:preset-minimal-begin',
            '# 覆盖 minimal preset 的完整 plugins 列表；DSH 升级后请重跑本脚本。',
            '- id: preset-minimal',
            '  config:',
            '    id: minimal',
            '    order: 3',
            '    plugins:',
            *child,
            '# context-guard:preset-minimal-end',
        ]
        marker_start = text.find('# context-guard:preset-minimal-begin')
        marker_end = text.find('# context-guard:preset-minimal-end')
        if marker_start != -1 and marker_end != -1:
            marker_end = text.find('\n', marker_end)
            marker_end = len(text) if marker_end == -1 else marker_end + 1
            prefix = text[:marker_start].rstrip('\n')
            suffix = text[marker_end:].lstrip('\n')
            new_text = prefix + '\n\n' + '\n'.join(override) + '\n'
            if suffix:
                new_text += '\n' + suffix
        else:
            new_text = text.rstrip('\n') + '\n\n' + '\n'.join(override) + '\n'
        if new_text != text:
            text = new_text
            changed = True

if not text.endswith('\n'):
    text += '\n'
p.write_text(text)
print(('已更新 ' if changed else '无变化 ') + str(p))
PY
done

if [[ "$missing" -ne 0 ]]; then
  exit 1
fi

echo
echo '完成。建议验证：'
echo '  dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"'
echo '  dsh --profile superagent --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"'
echo '然后重启对应 dsh profile。'
