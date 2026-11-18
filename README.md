---
audience: shared
status: current
---

[中文](README.md) | [English](README.en.md)

# dsh-context-guard

DSH Host-only 插件：把长工具输出挡在上下文之外，同时保留完整证据。

解决的问题：长会话里 `bash` 输出（`ls -la`、整文件 `cat`、`journalctl`、重复的 `curl` 轮询）会被反复计费；DSH 官方 persistent-bash 默认还会在 16,000 字符处截断，导致落盘也不完整。

本插件做七件事：

1. **有界摘要**：输出超过预算时，完整文本写盘，上下文只保留 head/tail、命令类型和文件路径；
2. **去重**：同一 session + tool + args 在 10 分钟内结果相同，只回上一次 call 的指针；结果变化只回行级 diff；
3. **单轮调用门禁**：单轮 bash 每达到 `maxCallsPerTurn`（默认 20，即 20/40/60）返回一次 `ask` 审批提醒，会话列表显示黄色待处理点；达到 `hardMaxCallsPerTurn`（默认 80）时拒绝并由 Web 自动填入「继续」；
4. **单轮累计输出门禁**：本轮累计进入上下文超过 40KB 后，后续超过 800 字符的结果只回摘要 + 落盘路径；
5. **命令形态拦截**：整文件 `cat`、无排除的家目录递归搜索、裸 `curl` API 默认 `deny` 并提示 `read`/`grep`/`jq` 等有界替代；可切 `ask`；同时注入系统提示引导；
6. **只读诊断**：`scripts/inspect.sh` 用固定模式替代零散命令；
7. **风险确认 + 压缩归档 + 指标 + 清理**：风险命令执行前确认；压缩前后写 `STATUS.md`，统计节省量，按保留期和配额清磁盘。

## 安装

从 GitHub Release 安装（推荐，无需构建）：

```bash
dsh plugin --profile web add https://github.com/person-clouds/dsh-context-guard/releases/latest/download/dsh-context-guard.tgz
```

也可以从 npm 或本地源码安装：

```bash
dsh plugin --profile web add @fenghoer/dsh-context-guard
# 或
dsh plugin --profile web add link:/home/zh/www/dsh-context-guard
```

然后执行宿主机迁移脚本（会先检查包已安装、备份 profile）：

```bash
dsh-context-guard/scripts/apply-profile.sh
```

脚本做三件事：

- 把旧的 `compaction-archive` 插入项改成 `context-guard`，并修正为 scoped 包名 `@fenghoer/dsh-context-guard`；如果对应 profile 的 `node_modules/@fenghoer/dsh-context-guard` 不存在，会提示先执行 `dsh plugin --profile <p> add link:...` 并以非零退出；
- 删除会报 `patch: entry "persistent-bash" not found` 的顶层旧块，改为覆盖 `minimal` preset 的完整 `config.plugins`，并把其中 `persistent-bash` 的 `maxOutputChars` 对齐为 `65536`；DSH 升级后需重跑脚本；
- 把顶层官方 `tool-result-pruner` 对齐为 `6000/3000/1500`；
- 若 `node_modules/dsh-superagent` 是指向不存在路径的 link，会提示用 `dsh plugin --profile <p> add link:/home/zh/www/dsh-superagent` 修复。

验证：

```bash
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## 输出预算

默认 `thresholdChars=2000`、`headChars=1200`、`tailChars=800`，硬顶 6000。

| 命令类型 | 示例 | 预算 |
|---|---|---:|
| 默认 | 普通 bash | 2000 |
| 快速状态 | `ps`、`df`、`free`、`ss`、`systemctl status` | 1500 |
| 有界日志 | `journalctl --since`、`tail`、`docker logs --tail` | 2500 |
| 有界源码 | `sed -n`、`rg`、`grep`、`git show` | 3000 |
| diff | `git diff` | 3000 |
| 构建/测试 | `npm test`、`go test`、`pytest` | 3000 |
| 错误结果 | 非零退出 | 至少 2500 |
| 显式声明 | 首行 `# dsh-budget=8000` | 最高 6000 |

无界命令（`cat`、没有 `--since`/`-n` 的 `journalctl`、`find /`、`du /`）压到 1500，并提示改用有界命令。

## 单轮门禁与命令提示

- 调用门禁：同一轮 bash 每 20 次返回一次 `ask` 提醒（默认 20/40/60），会话列表显示黄色 pending 点，审批浮窗可点继续或取消；第 80 次起 `deny`。监听 `session/event` 的 `turn/start` 清零；缺少该事件时退化为按 session 计数并记 warning。门禁文案同时显示“本轮 bash 调用次数”和当前 `session step`，两者不是同一口径。
- 累计输出门禁：本轮实际进入上下文的字符数超过 `maxTurnOutputChars=40000` 后，后续超过 `exhaustedOutputChars=800` 的结果完整落盘，上下文只留 800 字符以内摘要 + 路径。
- 命令拦截：默认 `commandLintMode: deny`。整文件 `cat` 提示改用 `read` 工具（或 `sed -n '1,120p'`）；无排除递归搜索提示改用 `grep`/`glob` 工具或加 `--glob '!**/node_modules/**'`；裸 `curl .../api/...` 提示改用 `| jq '{field1,field2}'` 或 `-o /tmp/out.json` 后再查询。
- DSH 不支持在 `tools/pre-execute` 中改写工具参数，所以插件不会自动把 `cat` 替换成 `read`；它只拒绝当前调用，并在模型可见的 `reason` 中给出替代命令，由模型重新发起有界调用。
- 复杂 shell 流程可设 `commandLintMode: ask` 降级为确认；`commandGuidanceEnabled: true` 会同时注册系统提示，引导模型优先使用 `read`/`grep`/`jq`。
- 命令 lint 为 `ask` 时与风险规则合并成一个 `ask`，不会一次调用弹两次；lint 为 `deny` 或已有 `deny`/`cancel` 时直接拒绝。

写盘失败时回退原始结果，不丢证据。

## 每 20 次提醒与硬上限自动填入「继续」

单轮 bash 每达到 `maxCallsPerTurn`（默认 20）时返回一次 `ask` 审批提醒；该提醒会进入 DSH 的待处理交互，会话列表对应会话名前面会显示黄色小点。打开会话后可在审批浮窗点“允许一次”继续，或取消本次调用。达到 `hardMaxCallsPerTurn`（默认 80）时，本轮返回带机器标记 `context-guard:hard-limit-draft` 的拒绝结果。Web 客户端检测到该标记且输入框为空时，自动写入 `继续`；不会自动发送，按 Enter 才继续。同一 session 最多自动写入 3 次，同一 turn 最多 1 次。Web 只在会话打开时提供输入框；打开会话时若最近 30 分钟内已有该事件、输入框为空，也会补写，因此事后打开不会错过。更新插件后需重启 DSH Web 并刷新页面。Desktop/TUI 不加载 Web 客户端，静默降级为原始拒绝文案。
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

`rm` 目标全部位于 `/tmp`、`/var/tmp`、`$TMPDIR` / `${TMPDIR}` 下，或全部位于测试目录（`test`、`tests`、`__tests__`、`test-*`、`*-test`、`*.test`、`*.spec`）时跳过 `destructive-rm`；目标等于临时目录本身、含 `..`/`*`/`?`/`[`，或使用 `sudo`、`xargs`、命令替换/反引号时不放行。`repo-delete`、`find-delete` 等规则不受影响。`sudo -n true`（及 `sudo -n -v`）这类无副作用探测，以及 `sudo -n` 加只读检查命令（如 `ls`、`stat`、`cat`、`grep`、`systemctl status` 等）不触发 `privilege-escalation`，其他 `sudo` 命令仍会提示；`touch <write-test 文件> && rm <同一文件>`、`f=$(mktemp /tmp/...) && rm -f "$f"` 这类自清理写权限探测也不触发 `destructive-rm`。

默认链接白名单：`localhost`、`127.0.0.1`、`[::1]`、`github.com`、`gitee.com`、`raw.githubusercontent.com`；可用 `riskAllowHosts` 覆盖。规则是正则启发式，可能误报或漏报，高风险生产操作仍应人工复核。

## 去重与 diff

- 缓存键：`session + tool + args`；
- TTL：10 分钟，最近使用会续期；
- 只处理 ≥800 字符的非错误结果，避免用指针替代 `ok` 反而更贵；
- **每次都真实执行命令**，不做执行缓存（持久 shell 的 cwd/env 状态不可靠）；
- 相同结果：`[context-guard:dedup]` + 上次 call 指针；
- 变化结果：`[context-guard:diff]`，只显示前后缀之间的变化块；
- 缓存是进程内内存，重启后失效；这是安全的有意选择。

## 文档提交门禁

`tools/pre-execute` 识别 `git commit`（含 `git -C <dir> commit` 与 `cd <dir> && git commit`），解析目标仓；目标仓存在 `docs-policy.json` 时调用工作区 `scripts/check.sh --repo <repo>`。检查失败返回 `deny`，附失败项，不自动执行 `--tag`，也不猜 `implementation_status`。非提交命令、无 `docs-policy.json` 的仓库不触发。

配置：`docGuardEnabled`（默认 `true`）、`docGuardWorkspaceRoot`（默认 `/home/zh/www`）、`docGuardTimeoutMs`（默认 `30000`）。修改后重启 DSH profile 生效。

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
dsh-context-guard/scripts/inspect.sh overview
dsh-context-guard/scripts/inspect.sh service nginx
dsh-context-guard/scripts/inspect.sh app qbittorrent
dsh-context-guard/scripts/inspect.sh logs /var/log/syslog 80
dsh-context-guard/scripts/inspect.sh git /home/zh/www/personalCloud
dsh-context-guard/scripts/inspect.sh ports
dsh-context-guard/scripts/inspect.sh docker
dsh-context-guard/scripts/inspect.sh http http://127.0.0.1:3082/
dsh-context-guard/scripts/inspect.sh report
```

原则：不使用 sudo、不启停服务、每段输出有行数/字节上限。检测到 `linuxops` 时只调用 `sysinfo`、`network ports`、`service status/logs` 等只读子命令，不存在则回退 `systemctl`/`journalctl`/`ss`。

本机私有扩展放 `~/.dsh/context-guard/inspect.local.sh`，不随插件发布。

## linuxops（可选）

`inspect.sh` 不依赖 `linuxops`：未安装时会自动回退到 `systemctl`、`journalctl`、`ss`、`uname`、`free`、`df`。如果想统一输出格式，可以三选一。

| 方案 | 适合谁 | 命令 |
|---|---|---|
| A. 不安装 | 只想用系统自带命令 | 无需操作；`inspect.sh` 自动回退 |
| B. 插件只读兼容层 | 没有上游二进制，想直接获得统一输出 | `dsh-context-guard/scripts/install-linuxops.sh` |
| C. 安装自建/上游二进制 | 已按上游 README 构建或下载了可信的 `linuxops` | `dsh-context-guard/scripts/install-linuxops.sh --binary /path/to/linuxops` |

方案 B 安装的是本插件自带的只读兼容层，**不是上游 linuxops 项目**。它只实现 `inspect.sh` 用到的四个接口：

```text
linuxops sysinfo
linuxops service status --name <unit>
linuxops service logs --name <unit> --lines <n>
linuxops network ports
```

安装、验证与卸载：

```bash
# 安装到 ~/.local/bin/linuxops（不需要 sudo）
dsh-context-guard/scripts/install-linuxops.sh

# 不在 PATH 时按提示加入，或直接显式指定
export PATH="$HOME/.local/bin:$PATH"
linuxops --version
LINUXOPS_BIN="$HOME/.local/bin/linuxops" dsh-context-guard/scripts/inspect.sh overview

# 覆盖重装 / 卸载
dsh-context-guard/scripts/install-linuxops.sh --force
dsh-context-guard/scripts/install-linuxops.sh --uninstall
```

方案 C 的构建步骤以你选择的 linuxops 上游 README 为准；构建完成后把二进制交给安装脚本，插件不复制、不覆盖上游源码：

```bash
# 示例：先在你信任的源码目录构建，产物为 ./linuxops
dsh-context-guard/scripts/install-linuxops.sh --binary ./linuxops --force
LINUXOPS_BIN="$HOME/.local/bin/linuxops" dsh-context-guard/scripts/inspect.sh report
```

注意：

- `inspect.sh` 只调用上面的只读子命令；上游 linuxops 如果接口不同，请使用 `LINUXOPS_BIN` 指向兼容的二进制，或选择方案 A。
- 兼容层和安装脚本都不使用 `sudo`、不写系统、不启停服务。
- 兼容层不是安全边界；它只是把系统命令的输出格式统一，权限仍由运行用户决定。

## 配置示例

```yaml
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
      config:
        thresholdChars: 2000
        headChars: 1200
        tailChars: 800
        hardMaxChars: 6000
        maxCallsPerTurn: 20              # 每 20 次弹一次审批提醒
        hardMaxCallsPerTurn: 80          # 第 80 次硬拒绝并自动填「继续」
        maxTurnOutputChars: 40000
        exhaustedOutputChars: 800
        commandLintEnabled: true
        commandLintMode: deny      # deny（默认，硬拦截）| ask（复杂流程确认）
        commandGuidanceEnabled: true
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        docGuardEnabled: true
        docGuardWorkspaceRoot: /home/zh/www
        docGuardTimeoutMs: 30000
        # riskToolNames: [bash, persistent-bash, terminal-bash, web_fetch]
        # riskAllowHosts: [localhost, 127.0.0.1, github.com]
        retentionDays: 7
        maxSessionBytes: 52428800
        maxTotalBytes: 524288000
        maxFilesPerSession: 300
```

## 测试

```bash
cd dsh-context-guard && npm test
```

测试覆盖：压缩归档、命令分类/预算、有界渲染、大输出落盘、去重、行级 diff、单轮调用与累计输出门禁、硬上限自动「继续」标记与 3 次预算、命令形态 deny/ask 与合并 `ask`、指标、过期清理、风险命令识别、文档提交门禁（坏文档拒绝、修复后放行）、`inspect.sh` 语法与帮助、Web 客户端语法。

## 边界

- 默认只处理 `bash` / `persistent-bash` / `terminal-bash`，其他工具可配 `toolNames`；
- 去重不跨进程持久化；
- 风险检查是启发式保底，不是安全沙箱；`ask` 由 DSH 审批服务裁决，无审批端时按 DSH 规则拒绝；
- 不做写操作诊断（kill、重启、cron、备份恢复等）；
- linuxops 不随包自动安装；可用 `scripts/install-linuxops.sh` 安装可选只读兼容层，或通过 `LINUXOPS_BIN` 接入自建二进制。
