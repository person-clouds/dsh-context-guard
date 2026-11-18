# dsh-context-guard 计划与实施步骤

> 状态：代码已实现（L1-L6），待宿主机执行 `scripts/apply-profile.sh` 并做真实会话验证。
> 原则：只做一个插件，能力统一收进 `dsh-context-guard`，不再拆 `dsh-bash-stats`、`dsh-tool-budget`、`dsh-output-archive`。

## 1. 目标

解决长会话中工具输出反复进入上下文导致的 token 膨胀，重点不是简单限制 bash 次数，而是：

1. 工具结果超过预算时，完整输出落盘，上下文只留摘要和路径；
2. 相同命令的重复结果去重，变化结果只回增量摘要；
3. 提供固定只读调查脚本 `inspect.sh`，减少零散 bash 调用；
4. 统计原始输出、实际进入上下文字节、去重命中、落盘与清理数据；
5. 对删除、强推、下载执行、未知链接等风险命令发警示，由用户确认后再执行；
6. 保留压缩归档能力，继续写 `STATUS.md`。

## 2. 非目标

- 不硬性限制单轮 bash 调用次数；
- 不跳过命令执行做“执行缓存”（持久 shell 有 cwd/env 状态，风险高）；
- 不打包上游 linuxops；提供可选只读兼容层，但绝不自动安装；
- 不替代 DSH 自动压缩；
- 风险检查只做正则启发式保底，不充当安全沙箱；
- 不提供写操作诊断（重启、kill、cron、备份恢复等一律不做）。

## 3. 命名与目录

```text
dsh-context-guard/
├── package.json          # name=@fenghoer/dsh-context-guard，dsh.bundle.patch
├── cordis.patch.yml      # insert id=context-guard
├── index.js              # Host 插件入口
├── lib/                  # 预算、去重、落盘、指标、清理、风险识别
├── scripts/inspect.sh    # 只读固定调查脚本
├── scripts/install-linuxops.sh  # 可选安装兼容层/自建二进制
├── scripts/linuxops-shim.sh     # 只读兼容层
├── test.mjs              # 无外部依赖测试
├── README.md
├── PLAN.md
├── PUBLISHING.md
├── STATUS.md
├── LICENSE
└── market/person-clouds__dsh-context-guard.yml
```

默认数据目录：

```text
${DSH_HOME:-$HOME/.dsh}/compaction-archive/<session-id>/STATUS.md   # 原归档，保持兼容
${DSH_HOME:-$HOME/.dsh}/tool-output/<session-id>/<time>-<call-id>.log
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/<session-id>.jsonl
```

## 4. 工具输出预算

默认 `thresholdChars=3000`、`headChars=1200`、`tailChars=800`。

| 命令类型 | 示例 | 预算 |
|---|---|---:|
| 默认/未知 | 普通 bash | 3000 |
| 快速状态 | `ps`、`df`、`free`、`ss`、`systemctl status` | 2500 |
| 有界日志 | `tail`、`journalctl --since`、`docker logs --tail` | 4000 |
| 有界源码 | `sed -n`、`rg -C`、`git show` | 5000 |
| diff | `git diff` | 6000 |
| 构建/测试 | `npm test`、`go test`、`pytest` | 8000 |
| 错误结果 | 非零退出或 `isError` | 至少 4000，保留尾部 |
| 显式声明 | 首行 `# dsh-budget=8000` | 最高硬顶 12000 |

无界命令（`cat`、无 `--since` 的 `journalctl`、`find /`、`du /`、无路径 `git diff`）强制压到 2500，并提示改用有界命令。

执行前只做命令分类，不改参数、不阻断执行；执行后按真实输出量裁剪。

## 4.1 风险命令警示

- `tools/pre-execute` 先执行 `next()`，已有 deny/cancel/ask 不覆盖；
- 默认检查 `bash` / `persistent-bash` / `terminal-bash` 与 `web_fetch`；
- 命中删除、强推、下载执行、未知链接、关机/停服、容器删除、数据库清空、提权等规则时返回 `ask`；
- `displayReason` 提供中英文说明，命令预览截断到 300 字符；
- 链接白名单可配 `riskAllowHosts`；
- 不做沙箱、不改参数；无审批端时由 DSH 按拒绝处理。

## 5. 去重与增量摘要

- 缓存键：session + tool + 命令参数；
- 同一命令正常执行，按完整输出 hash 比较；
- TTL 默认 10 分钟；
- hash 相同：只返回 `[deduped] 与 call_xxx 相同` + 完整日志路径；
- hash 不同：行级前后缀 diff，变化小则只回变化块；变化大回退 head/tail；
- 不跳过执行。

## 6. 指标

每调用一条 JSONL，记录 `originalChars`、`emittedChars`、`savedChars`、`dedup`、`diffSummary`、`isError`、`cmdType`。会话汇总写 `STATUS.md`，先统计不展示 UI。token 优先用 `tokenMeter`；不可用时按字符估算并标注方法。

## 7. 清理

- `retentionDays=7`
- `maxSessionBytes=50MB`
- `maxTotalBytes=500MB`
- `maxFilesPerSession=300`
- 只按时间和配额清理，不对“非当前会话”一刀切；
- 当前会话保留最近文件；
- 清理失败只 warning。

## 8. inspect.sh

只读模式：`overview`、`service <name>`、`app <name>`、`logs <file|unit>`、`git [path]`、`ports`、`docker [name]`、`http <url>`、`report`。

- 每段有行数/字节上限；
- 有 `linuxops` 时仅使用只读子命令，没有则回退系统命令；
- 安装三选一：不安装、插件只读兼容层、自建/上游二进制（`--binary`）；
- 不包含 cloudctl；本机扩展放 `~/.dsh/context-guard/inspect.local.sh`，不发布；
- 不自动 sudo，不执行写操作。

## 9. 实施步骤

1. 改名迁移：目录、包名、cordis 条目、market、测试；
2. 输出预算与落盘；
3. 去重与增量摘要；
4. 指标与清理；
5. `inspect.sh`；
6. 风险命令警示与 `ask` 门禁；
7. 文档、索引、profile 迁移脚本与最终验证。

每一步完成后运行 `npm test`，提交一次 git commit。

## 10. 不做/未来可选

| 名称 | 当前结论 | 说明 |
|---|---|---|
| `dsh-bash-stats` | 不做 | 统计已并入本插件 |
| `dsh-tool-budget` | 不做 | 预算已并入本插件 |
| `dsh-output-archive` | 不做 | 落盘已并入本插件 |
| `dsh-tool-budget` 硬限制 | 不做 | 只统计，不限制单轮调用次数 |
| subagent 调查 | 暂缓 | 先看 inspect.sh 与去重效果 |

## 11. 验证与回滚

- 单元测试：`npm test`；
- 配置验证：`dsh --profile web --dump-config`；
- 实际输出测试：>30KB 命令、重复命令、变化命令、清理配额；
- 风险测试：`rm -rf`、`git reset --hard`、`curl | bash`、未知链接、安全命令放行、已有 deny 不被覆盖；
- 回滚：profile 条目改回旧插件名，或删除本插件条目；数据目录可手工保留/删除。
