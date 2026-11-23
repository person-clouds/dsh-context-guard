---
audience: shared
status: current
---

[中文](README.md) | [English](README.en.md)

# dsh-context-guard

给 DSH 加一道「上下文预算 + 风险兜底」：长输出不烧 token，危险命令先问一句。

长会话里的 `ls -la`、整文件 `cat`、`journalctl`、重复 `curl` 轮询都会被反复计费；DSH 官方 persistent-bash 默认还会在 16,000 字符处截断，落盘也不完整。这个插件把这些输出挡在上下文外，完整证据留在磁盘上。

## 先说最要紧的四件事

**1. 风险确认（最重要）**
`rm -rf`、`git reset --hard`、`curl | bash`、访问白名单外的主机、关机停服、删库、提权……执行前都会先弹审批。点「允许一次」只放这一条；点「始终允许」会写一条窄规则，下次同类命令不再打扰。它是在 DSH 自己的权限策略之后再兜一层，不替代权限和沙箱；规则是正则启发式，可能误报或漏报，真正的高危操作还是建议人看一眼。链接检查只认命令段首的取链动作（`curl`/`wget`/`xdg-open` 等），并先剥掉 `sudo`/`env`/`timeout`/`xargs`/`nice`/`stdbuf`/`busybox`/`watch`/`sh -c` 等前缀，以及子 shell、`$(…)`/反引号命令替换、`eval`/`find -exec`/`env -S`/`chroot`/`ssh` 等间接执行包装；文档正文、非执行型 heredoc 正文和引号内的模式串不算访问链接，但喂给 shell 执行的 heredoc（`bash <<EOF`、`… <<EOF | bash`）仍按命令扫描，未加引号终止符的 heredoc 正文按 bash 语义只扫其中的命令替换（`$(…)`/反引号），正文文字仍当文档。间接执行会先还原成真实命令再取链接：`ssh -p 22 host …` 会跳过主机前带取值的选项，`find … -exec sh -c '…'` 和 `eval '…'` 会补回引号分组。已保存 host 规则参与后续链接检查，卡片只列仍未放行的主机，也只给这些主机写规则。

**2. 去重**
同一 session + 同一工具 + 同一参数，10 分钟内结果没变，只回「上次那个」的指针；结果变了只回行级 diff。命令每次都真实执行，缓存只省上下文，不影响结果。

**3. 单轮调用门禁 80/160**
一轮里 bash 调到第 80 次，弹一次审批提醒（会话列表有黄色小点）；第 160 次直接拒绝，Web 会往输入框自动填「继续」，你按回车才继续。防的是模型原地打转，不是卡正常干活。

**4. 命令形态拦截**
整文件 `cat`、没排除目录的家目录递归搜索、裸 `curl .../api/...` 默认直接拒绝，并给出有界替代（dsh-ops 下是 `ops_inspect_local_file`/`ops_grep`，官方工具面是 `read`/`grep`，另附 `jq`、`sed -n`）。复杂 shell 流程不想被拦，把 `commandLintMode` 改成 `ask` 即可。

## 完整功能

1. **有界摘要**：输出超过预算时完整文本写盘，上下文只保留 head/tail、命令类型和文件路径；
2. **去重**：同 session + tool + args 结果相同只回指针，变化只回行级 diff；
3. **单轮调用门禁**：默认第 80 次 `ask`、第 160 次 `deny`，硬上限由 Web 自动填「继续」；
4. **单轮累计输出门禁**：本轮进入上下文超过 40KB 后，后续超过 800 字符的结果只回摘要 + 落盘路径；
5. **命令形态拦截**：默认 `deny`，可切 `ask`；同时注入系统提示，引导模型优先用文件读取/搜索工具和 `jq`；
6. **风险确认**：危险命令先 `ask`，支持「允许一次 / 始终允许」窄规则（含原因记录）；
7. **只读诊断**：`scripts/inspect.sh` 用固定模式替代零散命令，只读、有界；
8. **压缩归档 + 指标 + 清理**：压缩前后写 `STATUS.md`，统计节省量，按保留期和配额清磁盘；
9. **文档提交门禁**：`git commit` 前按中央策略跑 `scripts/check.sh`，坏文档直接拒绝；
10. **压缩阈值自检**：`scripts/apply-compaction.sh` 检查并重放四个内置 preset 的压缩阈值。

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

然后跑宿主机迁移脚本（会先检查包已安装、备份 profile）：

```bash
dsh-context-guard/scripts/apply-profile.sh
```

脚本做四件事：

- 把旧的 `compaction-archive` 插入项改成 `context-guard`，并修正为 scoped 包名；profile 里缺包时提示先 `dsh plugin --profile <p> add link:...` 并以非零退出；
- 删掉会报 `patch: entry "persistent-bash" not found` 的顶层旧块，改为覆盖 `minimal` preset 的完整 `config.plugins`，并把 `maxOutputChars` 对齐为 `65536`（DSH 升级后需重跑）；
- 把顶层官方 `tool-result-pruner` 对齐为 `6000/3000/1500`；
- 若 `node_modules/dsh-superagent` 是失效 link，提示用 `dsh plugin --profile <p> add link:/home/zh/www/dsh-superagent` 修复。

验证：

```bash
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## 本机配置落点

本机（2026-11-22 起）按「完全权限 + 需要时弹审批」运行，靠两处配置配合，改完都要重启 `dsh-web`：

- **权限预设**：`~/.dsh/profiles/web/cordis.patch.yml` 里 `permission` 插件的 `full-access-ask` 预设（`sandbox: danger-full-access` + `approval: ask`），并用 `defaultPreset: full-access-ask` 设为新会话默认。原来的 `danger-full-access` 是 `approval: never`，会让风险确认在毫秒内被自动拒绝，报 `the user rejected tool "bash"`。
- **风险白名单**：`~/.dsh/context-guard/risk-allow.json` 里 `kind: "host"` 规则（与审批卡「始终允许」同一文件），增量叠加内置默认 `config/risk-allow-default.json`，例如 `192.168.31.244`、`100.84.98.28`、`zh-gem-r7.tailb6e152.ts.net`。host 规则只在一条命令里每条会执行的 fetch 都能证明主机在白名单内时才摘掉 `unknown-link`/`insecure-http`；主机段取不出来的 URL（占位符/模式串/运行期动态展开/非法端口）、整条命令没有可解析主机、以及存在看不到字面链接的 fetch 段（`curl "$ENDPOINT"`、`… | xargs curl`）、以及同一段里字面链接之外还带动态参数（`curl https://ok.example/ "$ENDPOINT"`，但 `-H`/`-d`/`-o` 这类取值选项里的 `$VAR` 不算）时都保持原判，不静默放行。放行判定与分析判定用同一套「真实 fetch 段」提取：`grep` 模式串和文档型 heredoc 正文既不会污染主机集合，也不会被写成 host 规则。确认卡最多列出 3 条未放行链接（更多时标注总数），点「始终允许」只给列出来的这些链接下发 host 规则，卡片看到什么就放宽什么。`RiskRuleStore` 只在进程启动时读一次，手工编辑后需重启。`curl`/`wget` 的无 scheme 目标（`127.0.0.1:11434/api/tags`、`example.com/x`、`[::1]:8080`）也按 HTTP 取主机，端口可省略，白名单内主机直接放行；`xdg-open` 等打开本地文件的命令不按 URL 处理。连字面链接都没有的 `curl`/`wget`（`curl "$ENDPOINT"`、`wget -i urls.txt`）按 `unverifiable-fetch` 直接确认：看不到主机就不写 host 规则，「始终允许」只记这一条命令。

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

无界命令（`cat`、没有 `--since`/`-n` 的 `journalctl`、`find /`、`du /`）压到 1500，并提示改用有界命令。写盘失败时回退原始结果，不丢证据。

## 单轮门禁与命令提示

- **调用门禁**：同一轮 bash 每 80 次返回一次 `ask`（第 80 次），第 160 次起 `deny`；拒绝结果带标记 `context-guard:hard-limit-draft`，Web 在输入框为空时自动写入「继续」（不自动发送，按 Enter 才继续，同 session 最多 3 次、同 turn 最多 1 次，打开会话时对 30 分钟内事件补写；Desktop/TUI 静默降级）。`turn/start` 清零；缺少该事件时退化为按 session 计数并记 warning。文案同时显示「本轮 bash 调用次数」和当前 `session step`，两者口径不同。
- **步数门禁**：按 `step/start` 事件计步（同一 step 内多次工具调用只算 1 步），单回合第 30 步 / 会话累计第 60 步提醒，第 40 / 90 步起 `deny`；`ask` 每回合最多一条，并与调用提醒合并成同一条文案（汇总本轮步数 / 会话步数 / 本轮 bash 调用 / 压缩次数），会话步数提醒每会话仅一次。缺少 `step/start` 事件时退化为按工具调用计步（结果标 `approx`）。回合硬拒保留 `context-guard:hard-limit-draft` 标记，可按 Enter 续一轮；会话硬拒不写该标记，文案提示可回复「继续」恢复 +30 步（仅 `source.kind=user` 的短回复生效，可多次；`stepBudget.continueResume: false` 可关闭）。
- **压缩提醒**：`compaction/summary` 只累计压缩次数，**从不 `deny`**；次数并入每轮提醒文案，达到 `hardMaxCompactions` 只记 warning。压缩后余量由阈值保证，见下文「压缩阈值自检」。
- **核验态步数**：`V：` 会话单回合收紧到第 25 步提醒 / 第 40 步硬拒；会话阈值仍用全局 60 / 90，压缩阈值仍用 1 / 2 且只告警。
- **累计输出门禁**：本轮实际进入上下文超过 `maxTurnOutputChars=40000` 后，后续超过 `exhaustedOutputChars=800` 的结果完整落盘，上下文只留 ≤800 字符摘要 + 路径。
- **命令拦截**：默认 `commandLintMode: deny`。整文件 `cat` 提示改用当前文件工具按段读（`ops_inspect_local_file({ path, offset, limit })` 或官方 `read`）或 `sed -n '1,120p'`；无排除递归搜索提示改用 `ops_grep`/`grep` 或加 `--glob '!**/node_modules/**'`；裸 `curl .../api/...` 提示改用 `| jq '{field1,field2}'` 或 `-o /tmp/out.json` 后再查询。
- DSH 不支持在 `tools/pre-execute` 中改写工具参数，所以插件不会自动把 `cat` 换成文件读取工具；它只拒绝当前调用，并在模型可见的 `reason` 里给出替代命令，由模型重新发起有界调用。
- 复杂 shell 流程可设 `commandLintMode: ask` 降级为确认；`commandGuidanceEnabled: true` 会同时注册系统提示，引导模型优先使用文件读取/搜索工具与 `jq`。
- 命令 lint 为 `ask` 时与风险规则合并成一个 `ask`，不会一次调用弹两次；lint 为 `deny` 或已有 `deny`/`cancel` 时直接拒绝。

## 风险命令警示

`tools/pre-execute` 在 DSH 自身权限策略通过后再做一层保底检查。命中规则时返回 `ask`，由 DSH 审批端弹确认；不确认就不执行。它不修改命令、不做沙箱，也不替代 DSH 权限/审批策略。默认检查 `bash` / `persistent-bash` / `terminal-bash` 与 `web_fetch`。

| 类别 | 例子 |
|---|---|
| 删除文件/仓库 | `rm -rf`、`rm -rf .git`、`find ... -delete`、`shred`、`truncate -s 0` |
| git 破坏操作 | `git reset --hard`、`git clean -fd`、`git push --force`、`git branch -D` |
| 下载即执行 | `curl ... \| bash`、`bash <(curl ...)` |
| 未知链接 | `curl` / `wget` / `xdg-open` 访问白名单外主机，或明文 HTTP |
| 系统破坏 | 关机、停服务、清防火墙、杀进程、删容器/数据卷/K8s 资源 |
| 数据库 | `DROP DATABASE/TABLE`、`TRUNCATE TABLE`、无 `WHERE` 的 `DELETE FROM` |
| 提权/清历史 | `sudo`、`doas`、`su -`、`history -c` |

放行边界：

- `rm` 目标全部位于 `/tmp`、`/var/tmp`、`$TMPDIR`/`${TMPDIR}`、`~/opt`（含 `/home/<user>/opt`），或全部位于测试目录（`test`、`tests`、`__tests__`、`test-*`、`*-test`、`*.test`、`*.spec`）时跳过 `destructive-rm`；只放行逐个列出的具体文件/目录，根目录本身与通配（`/tmp/*`、`~/opt/*`）仍拦截，含 `..`/`*`/`?`/`[`、`sudo`、`xargs`、命令替换/反引号也不放行。
- `sudo -n true`、`sudo -n -v` 及 `sudo -n` + 只读检查命令（`ls`、`stat`、`cat`、`grep`、`systemctl status` 等）不触发 `privilege-escalation`；`touch <探测文件> && rm <同一文件>`、`f=$(mktemp /tmp/...) && rm -f "$f"` 这类自清理写探测不触发 `destructive-rm`。
- 以上临时根、测试目录、`~/opt`、产物目录、写探测和 `sudo`/`systemctl` 只读清单都来自 [`config/risk-allow-default.json`](config/risk-allow-default.json)，改 JSON 即可调整。

链接白名单同样来自该文件，按 `local`、`codeHosting`、`api`、`docs`、`techMedia` 分组，共 28 个主机；分组只影响文档与复核，运行时不区分来源。`riskAllowHosts` 显式设置时覆盖内置，用户「始终允许」保存的 host 规则与内置取并集；个人/内部域名（如 Tailscale 主机）不进内置。配置缺失或字段非法时回退最小安全默认（仅 `localhost`、`127.0.0.1`、`[::1]`）并告警，方向只会更严格。取链接时先剥掉末尾的 `,`、`.`、`;` 和未配对的 `)`（`Foo_(bar)` 这类成对括号保留），再按 URL 主机名校验：含空格/括号/引号/`$` 等取不出合法主机的 URL 不写 host 规则，也不会静默放行。

「始终允许」在 Host 侧用审批 reason 里的短期 token 取回原始命令、重新解析后，把窄规则存进 `${DSH_HOME:-~/.dsh}/context-guard/risk-allow.json`：

- 点击后先要求填写放行原因（必填、最多 200 字），原因作为规则标记 `reason` 写入同一 JSON，仅供复核、不参与匹配；明文落盘，别填密码/Token。
- 构建产物清理按「项目前缀 + 产物目录」泛化：确认 `rm -rf ./node_modules` 后，同项目的 `rm -rf ./dist`、`rm -rf packages/a/build` 自动放行；`./src`、`..`、`sudo`/`xargs`/命令替换仍询问；产物目录内的尾部通配和 `find ... -delete` 按同类规则处理。
- 当前目录下的临时清理单独记一条 `temp-rm`：确认 `rm -rf .tmp-build` 后，只在该 cwd 下对 `.tmp*` 路径生效（`cwd` 取自 `exec.arguments.cwd`/`workdir`，无 cwd 时不生成也不匹配）；`/tmp` 等内置临时根仍直接放行、不重复造规则；`.tmp*/node_modules` 这类仍按构建产物规则处理。`..`、通配、尾部 `/`、`~`、`sudo`/`xargs`、重定向、复合命令（`cd … && rm`）、`.git` 内路径以及软链接逃出 cwd 的目标都不算临时清理。
- 风险仅来自未知链接时只保存该主机；无法证明安全类时退化为完全相同的规范化命令哈希。卡片可勾选「仅记住这条完整命令」强制只落哈希、跳过类别放宽。保存成功后右下角提示实际写入的规则类型（host / command / artifact-rm / artifact-find / temp-rm）。命令形态拦截和 DSH 权限策略仍照常生效。
- 可用 `riskAutoAllowEnabled: false` 关闭按钮与自动放行，`riskRuleFile` 改规则文件位置，删除 JSON 即整体撤销。
- 待放行项内存保留 10 分钟；为避免插件重载丢 token，会短期写入同目录 `risk-pending.json`（0600、过期自动清理），token 失效时按审批 `callId` 兜底。
- 保存失败时页面右下角显示错误码与 HTTP 状态（如 `approval-rule-expired（HTTP 410）`）并写控制台；超过 2 秒先提示「仍在保存」，15 秒按超时处理。失败不消耗审批，仍可点「允许一次」。

## 去重与 diff

- 缓存键：`session + tool + args`；TTL 10 分钟，最近使用会续期；
- 只处理 ≥800 字符的非错误结果，避免用指针替代 `ok` 反而更贵；
- **每次都真实执行命令**，不做执行缓存（持久 shell 的 cwd/env 状态不可靠）；
- 相同结果：`[context-guard:dedup]` + 上次 call 指针；
- 变化结果：`[context-guard:diff]`，只显示前后缀之间的变化块；
- 缓存是进程内内存，重启后失效；这是有意的安全选择。

## 文档提交门禁

`tools/pre-execute` 识别 `git commit`（含 `git -C <dir> commit` 与 `cd <dir> && git commit`），解析目标仓；已登记仓库按中央 `scripts/docs-policy.json` 调用 `scripts/check.sh --repo <repo>`。失败返回 `deny` 并附失败项，不自动改文件；非提交命令、未登记仓库不触发。

配置：`docGuardEnabled`（默认 `true`）、`docGuardWorkspaceRoot`（默认 `/home/zh/www`）、`docGuardTimeoutMs`（默认 `30000`）。修改后重启 DSH profile 生效。

## 数据目录

```text
${DSH_HOME:-$HOME/.dsh}/tool-output/<session-id>/<timestamp>-<call-id>.log
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/<session-id>.jsonl
${DSH_HOME:-$HOME/.dsh}/context-guard/metrics/STATUS.md
${DSH_HOME:-$HOME/.dsh}/context-guard/archive/<session-id>/STATUS.md
```

清理策略：保留 7 天；单会话 50MB / 300 文件；全局 500MB；删除最旧文件；当前会话保留最近 3 个。目录 0700、文件 0600。

## 指标

JSONL 字段：`session`、`call`、`tool`、`cmdType`、`originalChars`、`emittedChars`、`savedChars`、`dedup`、`diffSummary`、`isError`、`archived`。

token 节省按 `chars/4` 估算，`STATUS.md` 里标注 `estimateMethod`；当前只统计，不展示 UI。

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

原则：不使用 sudo、不启停服务、每段输出有行数/字节上限。检测到 `linuxops` 时只调用 `sysinfo`、`network ports`、`service status/logs` 等只读子命令，否则回退 `systemctl`/`journalctl`/`ss`。本机私有扩展放 `~/.dsh/context-guard/inspect.local.sh`，不随插件发布。

## linuxops（可选）

`inspect.sh` 不依赖 `linuxops`：未安装时自动回退到系统命令。想统一输出格式，三选一：

| 方案 | 适合谁 | 命令 |
|---|---|---|
| A. 不安装 | 只用系统自带命令 | 无需操作，自动回退 |
| B. 插件只读兼容层 | 没有上游二进制，想要统一输出 | `dsh-context-guard/scripts/install-linuxops.sh` |
| C. 安装自建/上游二进制 | 已构建或下载了可信 `linuxops` | `dsh-context-guard/scripts/install-linuxops.sh --binary /path/to/linuxops` |

方案 B 安装的是插件自带的只读兼容层，**不是上游 linuxops 项目**，只实现 `inspect.sh` 用到的四个接口：

```text
linuxops sysinfo
linuxops service status --name <unit>
linuxops service logs --name <unit> --lines <n>
linuxops network ports
```

```bash
# B：安装到 ~/.local/bin/linuxops（不需要 sudo）
dsh-context-guard/scripts/install-linuxops.sh
# C：构建好后交给安装脚本，插件不复制、不覆盖上游源码
dsh-context-guard/scripts/install-linuxops.sh --binary ./linuxops --force

# 不在 PATH 时显式指定，或覆盖重装 / 卸载
LINUXOPS_BIN="$HOME/.local/bin/linuxops" dsh-context-guard/scripts/inspect.sh overview
dsh-context-guard/scripts/install-linuxops.sh --force
dsh-context-guard/scripts/install-linuxops.sh --uninstall
```

注意：`inspect.sh` 只调用上述只读子命令；兼容层和安装脚本都不使用 `sudo`、不写系统、不启停服务；兼容层不是安全边界，权限仍由运行用户决定。

## 压缩阈值自检

`~/.dsh/cordis.patch.yml` 覆盖了四个内置 preset 的 `compaction-basic` 阈值（`0.20/0.03/65536`；按窗口 1,048,576 计算触发线 209,715，压缩后余量约 15 万）。这份拷贝整段抄自安装包，DSH 升级后可能过期，用脚本自检/重放：

```bash
bash dsh-context-guard/scripts/apply-compaction.sh check     # 只读自检，全部 PASS 退出 0
bash dsh-context-guard/scripts/apply-compaction.sh dry-run   # 看会改哪些 preset
bash dsh-context-guard/scripts/apply-compaction.sh apply     # 备份后原位重写，打印回滚命令
```

`apply` 由用户在自己的终端执行（AI 沙箱对 `~/.dsh` 只读），插件不会自动调用。细节与升级后处理见 [`docs/context-compaction.md`](docs/context-compaction.md) 5.5 节。

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
        maxCallsPerTurn: 80              # 第 80 次弹一次审批提醒
        hardMaxCallsPerTurn: 160         # 第 160 次硬拒绝并自动填「继续」
        maxTurnOutputChars: 40000
        exhaustedOutputChars: 800
        stepBudget:                      # 步数与压缩提醒；enabled: false 整体关闭
          enabled: true
          maxStepsPerTurn: 30            # 单回合提醒（与调用提醒每轮合并一条）
          hardMaxStepsPerTurn: 40        # 单回合硬拒绝
          maxStepsPerSession: 60         # 会话累计提醒
          hardMaxStepsPerSession: 90     # 会话累计硬拒绝，可回复「继续」+30
          maxCompactions: 1              # 压缩 1 次后仅 warning
          hardMaxCompactions: 2          # 压缩 2 次后仅 warning，从不拒绝
          continueResume: true           # 允许用户回复「继续」恢复会话硬线
          continueGraceSessionSteps: 30  # 每次恢复的步数
          # continueKeywords: [继续, continue]
        # sessionBudgets: 整体替换默认规则；见「核验态与派单去重」，默认 V: 会话 25/40/20000
        # dispatchGuard: {enabled: true, windowMs: 7200000, overrideToken: verify-again}
        commandLintEnabled: true
        commandLintMode: deny      # deny（默认，硬拦截）| ask（复杂流程确认）
        commandGuidanceEnabled: true
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        riskAutoAllowEnabled: true
        # riskRuleFile: /home/zh/.dsh/context-guard/risk-allow.json
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

## 核验态与派单去重

只有会话标题命中 `sessionBudgets[].match` 才进入核验态。默认规则是一条示例：`^(?:TODO[：:]\s*)?V[：:]`——`V` 后全角、半角冒号都命中，`TODO：` / `TODO:` 前缀不影响；`D：`、`G：` 等其它标题不命中，保持全局默认。默认规则可被配置里的 `sessionBudgets` 覆盖（`match` / `denyTools` / `denyCommands` 按规则整体替换）。

- 入口：guard 不提供命令入口。装配套 `dsh-workflow-shortcuts` ≥ `0.4.0` 后由 `/V`（实施核验，标题 `V：…`）与 `/VP`（计划核验，标题 `V：计划：…`）写入标题；只装 guard 时手动把会话标题改成 `V：…` 同样生效，任何客户端写入的标题都按同一正则匹配。
- 预算收紧：默认第 25 次 `bash` 提醒、第 40 次硬拒、单轮输出超过 20000 字符后只留摘要；
- 只读：`denyTools`（默认 `write`、`edit`，以及 dsh-ops 写工具 `ops_write_file`、`ops_edit_file`、`ops_replace`、`ops_remove`、`ops_move`、`ops_copy`、`ops_batch`）与 `denyCommands`（装依赖、`git commit/push/add`、重启服务）直接 `deny`；PTC 的 `run_code` 不在默认拒绝列表，启用 PTC 的会话不要在 `V：` 态里用。
- 非 `V：` 会话保持全局默认（80 / 160 / 40000）。
- `D：` 会话：`scripts/apply-profile.sh` 额外写入一条 `D：` / `TODO D：` 规则（25 / 40，不设 `denyTools`，允许写计划）；`sessionBudgets` 整体替换默认，自定义时须同时保留 `V：` 规则。

上面的 25 / 40 / 20000 只是默认规则的取值说明，改配置即失效；默认值只在 `lib/verify-mode.js` 的 `DEFAULT_SESSION_BUDGETS` 维护，profile 写入 `sessionBudgets` 后以配置为准。

派单去重：`dispatchTools`（默认 `subagent`、`subagent_fork`、`workflow`）的 prompt 里声明「快照：`<sha>`」时，同会话同指纹 2 小时内的第二次派单直接 `deny`，避免同一 diff 重复核验；prompt 含 `verify-again` 或未声明快照时不拦。`/VP` 的计划核验提示词刻意不写 `快照：<sha>`，同一计划可反复审、不参与派单去重；代价是重复审查会消耗核验预算。

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
