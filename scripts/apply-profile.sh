#!/usr/bin/env bash
# 在宿主机用户环境执行：安装/迁移 context-guard profile 插入项，
# 并提高官方 persistent-bash 输出上限、对齐 tool-result-pruner 参数。
# 工作区 AI 沙箱对 ~/.dsh 只读，因此本脚本由用户执行。
set -euo pipefail

HOME_DIR="${HOME:-/home/zh}"
DSH_HOME="${DSH_HOME:-$HOME_DIR/.dsh}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"
PROFILE_NAMES=("web" "superagent")
missing=0

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

  cp -a "$profile" "$profile.bak.context-guard-$STAMP"
  python3 - "$profile" <<'PY'
import pathlib, re, sys

p = pathlib.Path(sys.argv[1])
text = p.read_text()
changed = False

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
"""
    changed = True

def upsert_block(text, block_id, values):
    """按顶层 block id 更新/补齐 config 键，返回 (text, changed)。"""
    lines = text.splitlines()
    try:
        start = lines.index(f'- id: {block_id}')
    except ValueError:
        extra = [f'- id: {block_id}', '  config:'] + [f'    {key}: {value}' for key, value in values.items()]
        return text.rstrip() + '\n' + '\n'.join(extra) + '\n', True
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith('- ')), len(lines))
    block = lines[start:end]
    config_index = next((i for i, line in enumerate(block) if line == '  config:'), None)
    if config_index is None:
        block.insert(1, '  config:')
        config_index = 1
    changed = False
    for key, value in values.items():
        pattern = re.compile(rf'^    {re.escape(key)}:.*$')
        key_index = next((i for i, line in enumerate(block) if pattern.match(line)), None)
        new_line = f'    {key}: {value}'
        if key_index is None:
            block.insert(config_index + 1, new_line)
            config_index += 1
            changed = True
        elif block[key_index] != new_line:
            block[key_index] = new_line
            changed = True
    if not changed:
        return text, False
    lines[start:end] = block
    return '\n'.join(lines) + ('\n' if text.endswith('\n') else ''), True

# 2) 官方 persistent-bash 先截断会导致插件拿不到全文。
text, block_changed = upsert_block(text, 'persistent-bash', {'maxOutputChars': '65536'})
changed = changed or block_changed

# 3) 官方 tool-result-pruner 预算与新插件默认值对齐。
text, block_changed = upsert_block(text, 'tool-result-pruner', {
    'thresholdChars': '6000',
    'headChars': '3000',
    'tailChars': '1500',
})
changed = changed or block_changed

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
