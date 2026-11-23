---
audience: shared
status: current
---

[中文](README.md) | [English](README.en.md)

# dsh-context-guard

给 DSH 加一道「上下文预算 + 风险兜底」：长输出不烧 token，危险命令先问一句。

长会话里的 `ls -la`、整文件 `cat`、`journalctl`、重复 `curl` 轮询都会被反复计费；DSH 官方 persistent-bash 默认还在 16,000 字符处截断，落盘也不完整。本插件把这些输出挡在上下文外，完整证据留在磁盘。能力总览与注册接口见 [`SPEC.md`](SPEC.md)；门禁、风险规则、去重、数据目录等细节见 [`docs/operations.md`](docs/operations.md)；安装与配置见 [`docs/configuration.md`](docs/configuration.md)。

## 能力一览

1. **有界摘要**：输出超过预算时完整文本写盘，上下文只保留 head/tail、命令类型和文件路径；写盘失败回退原始结果。
2. **去重**：同 session + tool + args 10 分钟内结果不变只回指针，变化只回行级 diff（详见[去重与 diff](docs/operations.md#去重与-diff)）。
3. **单轮门禁**：bash 调用与步数按阈值 `ask`/`deny`，压缩只提醒（详见[单轮门禁与命令提示](docs/operations.md#单轮门禁与命令提示)）。
4. **命令形态拦截**：整文件 `cat`、无排除递归搜索、裸 `curl .../api/...` 默认拒绝并给出有界替代（`jq`、`sed -n`、各工具面的文件读取/搜索工具），可切 `ask`。
5. **风险确认**：危险命令先 `ask`，「允许一次 / 始终允许」落窄规则（详见[风险命令警示](docs/operations.md#风险命令警示)）。
6. **只读诊断**：`scripts/inspect.sh` 用固定模式替代零散命令，只读、有界。
7. **压缩归档 + 指标 + 清理**：压缩前后写 `STATUS.md`，统计节省量，按保留期和配额清磁盘（详见[数据目录、指标与清理](docs/operations.md#数据目录指标与清理)）。
8. **文档提交门禁**：`git commit` 前按中央策略跑 `scripts/check.sh`，坏文档直接拒绝。
9. **压缩阈值自检**：`scripts/apply-compaction.sh` 检查并重放四个内置 preset 的压缩阈值。

## 安装

从 GitHub Release 安装（推荐，无需构建），也可从 npm 或本地源码安装：

```bash
dsh plugin --profile web add https://github.com/person-clouds/dsh-context-guard/releases/latest/download/dsh-context-guard.tgz
dsh plugin --profile web add @fenghoer/dsh-context-guard
dsh plugin --profile web add link:/home/zh/www/dsh-context-guard
```

然后在 `/home/zh/www` 下跑宿主机迁移脚本并核对配置（脚本行为见[安装细节](docs/configuration.md#安装细节)）：

```bash
dsh-context-guard/scripts/apply-profile.sh
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

## 风险命令警示

`tools/pre-execute` 在 DSH 自身权限策略通过后再做一层保底检查：命中规则返回 `ask`，由 DSH 审批端弹确认，不确认不执行。它不修改命令、不做沙箱，也不替代 DSH 权限/审批策略；规则是正则启发式，可能误报或漏报，高危操作仍建议人看一眼。默认检查 `bash` / `persistent-bash` / `terminal-bash` 与 `web_fetch`。

| 类别 | 例子 |
|---|---|
| 删除文件/仓库 | `rm -rf`、`rm -rf .git`、`find ... -delete`、`shred`、`truncate -s 0` |
| git 破坏操作 | `git reset --hard`、`git clean -fd`、`git push --force`、`git branch -D` |
| 下载即执行 | `curl ... \| bash`、`bash <(curl ...)` |
| 未知链接 | `curl` / `wget` / `xdg-open` 访问白名单外主机，或明文 HTTP |
| 系统破坏 | 关机、停服务、清防火墙、杀进程、删容器/数据卷/K8s 资源 |
| 数据库 | `DROP DATABASE/TABLE`、`TRUNCATE TABLE`、无 `WHERE` 的 `DELETE FROM` |
| 提权/清历史 | `sudo`、`doas`、`su -`、`history -c` |

放行边界（`/tmp`、测试目录、`~/opt`、只读 `sudo` 探测等）、链接扫描范围、「始终允许」落窄规则、白名单来源见 [`docs/operations.md`](docs/operations.md#风险命令警示)。

## 文档提交门禁

`git commit` 前按中央 `scripts/docs-policy.json` 跑 `scripts/check.sh --repo <repo>`，失败返回 `deny` 并附失败项，不自动改文件；非提交命令、未登记仓库不触发。配置项与细节见[文档提交门禁](docs/operations.md#文档提交门禁)。

## 数据目录、指标与清理

- 证据落盘：`${DSH_HOME:-~/.dsh}/tool-output/<session-id>/<timestamp>-<call-id>.log`
- 指标与状态：`${DSH_HOME:-~/.dsh}/context-guard/metrics/{<session-id>.jsonl,STATUS.md}`
- 压缩归档：`${DSH_HOME:-~/.dsh}/context-guard/archive/<session-id>/STATUS.md`
- 清理：保留 7 天；单会话 50MB / 300 文件；全局 500MB；目录 0700、文件 0600。

字段与估算口径见[数据目录、指标与清理](docs/operations.md#数据目录指标与清理)。

## 只读诊断脚本

```bash
dsh-context-guard/scripts/inspect.sh overview|ports|docker|report
dsh-context-guard/scripts/inspect.sh service nginx
dsh-context-guard/scripts/inspect.sh logs /var/log/syslog 80
```

不使用 sudo、不启停服务、每段输出有上限；检测到 `linuxops` 时只用其只读子命令，否则回退 `systemctl`/`journalctl`/`ss`。`inspect.sh` 不依赖 `linuxops`，未安装时自动回退；想统一输出格式可装插件的只读兼容层（不是上游项目，装到 `~/.local/bin/linuxops`）：

```bash
dsh-context-guard/scripts/install-linuxops.sh                      # B：只读兼容层
dsh-context-guard/scripts/install-linuxops.sh --binary ./linuxops  # C：自建/上游二进制
```

完整命令、方案对比与注意事项见[inspect.sh 与 linuxops](docs/operations.md#inspectsh-与-linuxops可选)。

## 压缩阈值自检

`~/.dsh/cordis.patch.yml` 覆盖了四个内置 preset 的 `compaction-basic` 阈值（`0.20/0.03/65536`；按窗口 1,048,576 计算触发线 209,715，压缩后余量约 15 万）。这份拷贝整段抄自安装包，DSH 升级后可能过期，用脚本自检/重放（`apply` 由用户在自己的终端执行，插件不会自动调用）：

```bash
bash dsh-context-guard/scripts/apply-compaction.sh check     # 只读自检，全部 PASS 退出 0
bash dsh-context-guard/scripts/apply-compaction.sh dry-run   # 看会改哪些 preset
bash dsh-context-guard/scripts/apply-compaction.sh apply     # 备份后原位重写，打印回滚命令
```

细节与升级后处理见 [`docs/context-compaction.md`](docs/context-compaction.md) 5.5 节。

## 核验态与派单去重

`V：` 会话只是收紧预算（默认 25 / 40 / 20000）并禁写工具，`/VP` 计划核验不写快照、可反复审。规则、入口、`D：` 会话与派单去重细节见[核验态与派单去重](docs/operations.md#核验态与派单去重)。

## 配置

全部配置项、`stepBudget`/`sessionBudgets` 等示例、本机权限预设与风险白名单落点见 [`docs/configuration.md`](docs/configuration.md)。

## 测试

```bash
cd dsh-context-guard && npm test
```

覆盖：压缩归档、命令分类/预算、有界渲染、大输出落盘、去重、行级 diff、单轮调用与累计输出门禁、硬上限自动「继续」标记与 3 次预算、命令形态 deny/ask 与合并 `ask`、指标、过期清理、风险命令识别与窄放行规则、文档提交门禁、核验态标题契约（`V：`、`TODO：V：`、`V：计划：` 命中，`D：`、`G：` 不命中）、`inspect.sh` 语法与帮助、Web 客户端语法。

## 边界

- 默认只处理 `bash` / `persistent-bash` / `terminal-bash`，其他工具可配 `toolNames`；
- 去重不跨进程持久化；
- 风险检查是启发式保底，不是安全沙箱；`ask` 由 DSH 审批服务裁决，无审批端时按 DSH 规则拒绝；
- 不做写操作诊断（kill、重启、cron、备份恢复等）；
- linuxops 不随包自动安装；可用 `scripts/install-linuxops.sh` 安装可选只读兼容层，或通过 `LINUXOPS_BIN` 接入自建二进制。
