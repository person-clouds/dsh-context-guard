#!/usr/bin/env bash
# 在宿主机用户环境执行：把 dsh-compaction-archive 的 profile 插入项迁移到 dsh-context-guard，
# 并提高官方 persistent-bash 的输出上限，避免 context-guard 只拿到被截断的 16K 文本。
# 工作区 AI 沙箱对 ~/.dsh 只读，因此本脚本由用户执行。
set -euo pipefail

HOME_DIR="${HOME:-/home/zh}"
DSH_HOME="${DSH_HOME:-$HOME_DIR/.dsh}"
STAMP="$(date +%Y%m%d-%H%M%S)"
PROFILES=("$DSH_HOME/profiles/web/cordis.patch.yml" "$DSH_HOME/profiles/superagent/cordis.patch.yml")

for profile in "${PROFILES[@]}"; do
  [[ -f "$profile" ]] || { echo "跳过不存在的 profile: $profile"; continue; }
  cp -a "$profile" "$profile.bak.context-guard-$STAMP"
  python3 - "$profile" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
text = p.read_text()
changed = False

old_block = """# compaction-archive：自动压缩前写 STATUS 快照，压缩后把 DSH 生成的结构化摘要落盘。
- insert:
    - id: compaction-archive
      name: dsh-compaction-archive
"""
new_block = """# context-guard：工具输出预算/落盘/去重 + 压缩前 STATUS 快照。
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
"""
if old_block in text:
    text = text.replace(old_block, new_block)
    changed = True
else:
    before = text
    text = text.replace('    - id: compaction-archive\n      name: dsh-compaction-archive\n',
                        '    - id: context-guard\n      name: \'@fenghoer/dsh-context-guard\'\n')
    text = text.replace('# compaction-archive：', '# context-guard：')
    if text != before:
        changed = True

# 原 persistent-bash 默认 maxOutputChars=16000，会先截断，导致插件无法归档完整输出。
extra = []
if not any(line.startswith('- id: persistent-bash') for line in text.splitlines()):
    extra.append("""
# context-guard：提高 bash 完整输出上限；插件会在超预算时落盘并只回摘要。
- id: persistent-bash
  config:
    maxOutputChars: 65536
""")
if not any(line.startswith('- id: tool-result-pruner') for line in text.splitlines()):
    extra.append("""
# context-guard：压缩触发后的官方结果裁剪参数与新插件预算对齐。
- id: tool-result-pruner
  config:
    thresholdChars: 8192
    headChars: 4096
    tailChars: 1024
""")
if extra:
    text = text.rstrip() + '\n' + ''.join(extra)
    changed = True

if not text.endswith('\n'):
    text += '\n'
p.write_text(text)
print(('已更新 ' if changed else '无变化 ') + str(p))
PY
done

echo
echo '完成。建议验证：'
echo '  dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"'
echo '  dsh --profile superagent --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"'
echo '然后重启对应 dsh profile。'
