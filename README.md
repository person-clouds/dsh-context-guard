# dsh-context-guard

DSH Host-only 插件：把长工具输出挡在上下文之外，同时保留完整证据。

解决的问题：长会话里 `bash` 输出（`ls -la`、整文件 `cat`、`journalctl`、重复的 `curl` 轮询）会被反复计费；DSH 官方 persistent-bash 默认还会在 16,000 字符处截断，导致落盘也不完整。

本插件做五件事：

1. **有界摘要**：输出超过预算时，完整文本写盘，上下文只保留 head/tail、命令类型和文件路径；
2. **去重**：同一 session + tool + args 在 10 分钟内结果相同，只回上一次 call 的指针；结果变化只回行级 diff；
3. **只读诊断**：`scripts/inspect.sh` 用固定模式替代零散命令；
4. **风险命令确认**：`rm -rf`、`git reset --hard`、`curl | bash`、未知链接、提权等执行前发警示，交给 DSH 审批端让用户确认；
5. **压缩归档 + 指标 + 清理**：压缩前后写 `STATUS.md`，统计节省量，按保留期和配额清磁盘。

## 安装

从 GitHub Release 安装（推荐，无需构建）：

```bash
dsh plugin --profile web add https://github.com/person-clouds/dsh-context-guard/releases/latest/download/dsh-context-guard.tgz
```

也可以从 npm 或本地源码安装：

```bash
dsh plugin --profile web add @fenghoer/dsh-context-guard
# 或
dsh plugin --profile web add link:/home/zh/www/personalCloud/task/dsh-context-guard
```

然后执行宿主机迁移脚本（会备份 profile）：

```bash
task/dsh-context-guard/scripts/apply-profile.sh
```

脚本做三件事：

- 把旧的 `compaction-archive` 插入项改成 `context-guard`；
- 给 `persistent-bash` 加 `maxOutputChars: 65536`，否则插件只能拿到被截断的 16K；
- 给官方 `tool-result-pruner` 设置 8192/4096/1024。

验证：

```bash
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## 输出预算

默认 `thresholdChars=3000`、`headChars=1200`、`tailChars=800`，硬顶 12000。

| 命令类型 | 示例 | 预算 |
|---|---|---:|
| 默认 | 普通 bash | 3000 |
| 快速状态 | `ps`、`df`、`free`、`ss`、`systemctl status` | 2500 |
| 有界日志 | `journalctl --since`、`tail`、`docker logs --tail` | 4000 |
| 有界源码 | `sed -n`、`rg`、`grep`、`git show` | 5000 |
| diff | `git diff` | 6000 |
| 构建/测试 | `npm test`、`go test`、`pytest` | 8000 |
| 错误结果 | 非零退出 | 至少 4000 |
| 显式声明 | 首行 `# dsh-budget=8000` | 最高 12000 |

无界命令（`cat`、没有 `--since`/`-n` 的 `journalctl`、`find /`、`du /`）压到 2500，并提示改用有界命令。

写盘失败时回退原始结果，不丢证据。

## 风险命令警示

`tools/pre-execute` 在 DSH 自身权限策略通过后再做一层保底检查。命中规则时返回 `ask`，由 DSH 审批端弹出确认；用户不确认则命令不执行。它不修改命令、不做沙箱，也不替代 DSH 的权限/审批策略。默认检查 `bash` / `persistent-bash` / `terminal-bash` 与 `web_fetch`。

默认覆盖：

| 类别 | 例子 |
|---|---|
| 删除文件/仓库 | `rm -rf`、`rm -rf .git`、`find ... -delete`、`shred`、`truncate -s 0` |
| git 破坏操作 | `git reset --hard`、`git clean -fd`、`git push --force`、`git branch -D` |
| 下载即执行 | `curl ... \| bash`、`bash <(curl ...)` |
| 未知链接 | `curl` / `wget` / `xdg-open` 访问白名单外主机，或明文 HTTP |
| 系统破坏 | 关机、停服务、清防火墙、杀进程、删容器/数据卷/K8s 资源 |
| 数据库 | `DROP DATABASE/TABLE`、`TRUNCATE TABLE`、无 `WHERE` 的 `DELETE FROM` |
| 提权/清历史 | `sudo`、`doas`、`su -`、`history -c` |

默认链接白名单：`localhost`、`127.0.0.1`、`[::1]`、`github.com`、`gitee.com`、`raw.githubusercontent.com`；可用 `riskAllowHosts` 覆盖。规则是正则启发式，可能误报或漏报，高风险生产操作仍应人工复核。

## 去重与 diff

- 缓存键：`session + tool + args`；
- TTL：10 分钟，最近使用会续期；
- 只处理 ≥800 字符的非错误结果，避免用指针替代 `ok` 反而更贵；
- **每次都真实执行命令**，不做执行缓存（持久 shell 的 cwd/env 状态不可靠）；
- 相同结果：`[context-guard:dedup]` + 上次 call 指针；
- 变化结果：`[context-guard:diff]`，只显示前后缀之间的变化块；
- 缓存是进程内内存，重启后失效；这是安全的有意选择。

## 数据目录

```text
${DSH_HOME:-$HOME/.dsh}/tool-output/<session-id>/<timestamp>-<call-id>.log
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/<session-id>.jsonl
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/STATUS.md
${DSH_HOME:-$HOME/.dsh}/compaction-archive/<session-id>/STATUS.md
```

清理策略：保留 7 天；单会话 50MB / 300 文件；全局 500MB；删除最旧文件；当前会话保留最近 3 个。目录 0700、文件 0600。

## 指标

JSONL 字段：`session`、`call`、`tool`、`cmdType`、`originalChars`、`emittedChars`、`savedChars`、`dedup`、`diffSummary`、`isError`、`archived`。

token 节省按 `chars/4` 估算，并在 `STATUS.md` 明确标注 `estimateMethod` 等价说明；当前只统计，不展示 UI。

## inspect.sh

```bash
task/dsh-context-guard/scripts/inspect.sh overview
task/dsh-context-guard/scripts/inspect.sh service nginx
task/dsh-context-guard/scripts/inspect.sh app qbittorrent
task/dsh-context-guard/scripts/inspect.sh logs /var/log/syslog 80
task/dsh-context-guard/scripts/inspect.sh git /home/zh/www/personalCloud
task/dsh-context-guard/scripts/inspect.sh ports
task/dsh-context-guard/scripts/inspect.sh docker
task/dsh-context-guard/scripts/inspect.sh http http://127.0.0.1:3082/
task/dsh-context-guard/scripts/inspect.sh report
```

原则：不使用 sudo、不启停服务、每段输出有行数/字节上限。检测到 `linuxops` 时只调用 `sysinfo`、`network ports`、`service status/logs` 等只读子命令，不存在则回退 `systemctl`/`journalctl`/`ss`。

本机私有扩展放 `~/.dsh/context-guard/inspect.local.sh`，不随插件发布。

## 配置示例

```yaml
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
      config:
        thresholdChars: 3000
        headChars: 1200
        tailChars: 800
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        # riskToolNames: [bash, persistent-bash, terminal-bash, web_fetch]
        # riskAllowHosts: [localhost, 127.0.0.1, github.com]
        retentionDays: 7
        maxSessionBytes: 52428800
        maxTotalBytes: 524288000
        maxFilesPerSession: 300
```

## 测试

```bash
cd task/dsh-context-guard && npm test
```

测试覆盖：压缩归档、命令分类/预算、有界渲染、大输出落盘、去重、行级 diff、指标、过期清理、风险命令识别与 `ask` 门禁、`inspect.sh` 语法与帮助。

## 边界

- 默认只处理 `bash` / `persistent-bash` / `terminal-bash`，其他工具可配 `toolNames`；
- 去重不跨进程持久化；
- 风险检查是启发式保底，不是安全沙箱；`ask` 由 DSH 审批服务裁决，无审批端时按 DSH 规则拒绝；
- 不做写操作诊断（kill、重启、cron、备份恢复等）；
- linuxops 不打包，只作为可选本机工具。
