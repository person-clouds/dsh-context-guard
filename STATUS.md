# STATUS — dsh-context-guard

- 更新时间：2026-11-20
- 一句话：DSH 工具输出预算/落盘、去重、单轮调用/输出门禁、硬上限后 Web 自动填入「继续」、命令形态拦截、风险确认与窄规则自动放行、只读诊断、压缩归档与指标。
- 位置：`dsh-context-guard/`；web profile 已按 link 加载并完成「始终允许」实机验证，superagent profile 待重启后核对。

## 已完成

- [x] Host-only 插件：监听 `compaction/start` / `compaction/summary`；
- [x] 输出 `~/.dsh/context-guard/archive/<session-id>/STATUS.md` 与带时间戳历史文件；
- [x] 不额外调用模型，不改变压缩阈值；
- [x] 失败仅 warning，不阻塞压缩；
- [x] `test.mjs` 通过；
- [x] 发布规范化：`dsh.bundle.patch`、README、PUBLISHING、LICENSE、market 条目、`npm pack --dry-run` 通过；
- [x] 已更新 `doc/dsh-plugins.md` 与 `PROJECT_INDEX.md`；
- [x] `tools/post-execute` 输出预算收紧：默认 2000，硬顶 6000，按命令类型收紧，完整输出落盘；
- [x] 写盘失败回退原始结果；
- [x] 去重缓存：session+tool+args，TTL 10 分钟；相同结果只回指针；变化结果只回行级 diff；从不跳过命令执行；
- [x] 指标：`context-guard/metrics/<session>.jsonl` + `STATUS.md` 汇总，token 按 `chars/4` 估算；
- [x] 清理：7 天保留、单会话 50MB/300 文件、全局 500MB，删除最旧文件，保留当前会话最近 3 个；
- [x] `scripts/inspect.sh`：overview/service/app/logs/git/ports/docker/http/report，只读、有界输出、可选 linuxops 只读子命令；
- [x] `tools/pre-execute` 风险命令警示：删除/仓库删除、git 强推/重置、下载执行、未知链接（含 `web_fetch`）、关机停服、容器/数据库删除、提权等返回 `ask` 让用户确认；不覆盖已有 deny/cancel/ask。
- [x] 单轮 bash 调用门禁：第 80 次 `ask`（同一轮只问一次），第 160 次起 `deny`；`turn/start` 重置，缺事件时按 session 退化计数并 warning；
- [x] 软上限自动继续：单轮 bash 达到 `maxCallsPerTurn`（默认 80）即暂停本轮，deny reason 带 `context-guard:hard-limit-draft`；Web 客户端在输入框为空时写入 `继续`（无换行、不自动发送）；`hardMaxCallsPerTurn`（默认 160）仅兜底；同 session 最多 3 次、同 turn 最多 1 次；Desktop/TUI 静默降级；
- [x] 修复 Web 自动继续不生效：组件内改为访问插件级 `pluginCtx`；同时兼容真实拒绝事件形状（`data.message.content[].text` + `isError`）与 `data.error.reason`；打开会话时对最近 30 分钟事件补写；新增 VM 集成测试；
- [x] 临时目录/`~/opt` `rm` 豁免：目标全部位于 `/tmp`、`/var/tmp`、`$TMPDIR`/`${TMPDIR}`、`~/opt`（含实际路径 `/home/<user>/opt`）下时跳过 `destructive-rm`；只放行逐个列出的具体文件/目录，目录本身、`..`/通配符、`sudo`/`xargs`/命令替换仍拦截；门禁文案同时显示 bash 调用次数与 session step；
- [x] 风险误报收敛：`sudo -n true`（及 `sudo -n -v`）与 `sudo -n` 只读检查命令（如 `ls`、`systemctl status`）不再触发 `privilege-escalation`；`rm` 目标全部位于 `test`/`tests`/`__tests__`/`test-*` 等测试目录时与临时目录一样跳过 `destructive-rm`；`touch <write-test 文件> && rm <同一文件>`、`f=$(mktemp /tmp/...) && rm -f "$f"` 自清理写权限探测同样放行；
- [x] 单轮累计输出门禁：本轮 emitted 超过 40000 字符后，后续 >800 字符结果完整落盘，上下文只回 ≤800 字符摘要 + 路径；
- [x] 风险审批「始终允许」：Host 按短期 token 取回原始命令并重新解析，保存到 `context-guard/risk-allow.json`；构建产物清理按「项目前缀 + 产物目录」类规则泛化（如确认 `rm -rf ./node_modules` 后同项目 `./dist` 也放行），未知链接仅保存主机，无法证明安全类时退化为精确命令哈希；`./src`、`..`、`sudo` 等仍询问，产物目录内尾部通配与 `find ... -delete` 按同类规则处理；默认开启，可用 `riskAutoAllowEnabled`/`riskRuleFile` 配置；
- [x] 「始终允许」失败可见化：保存失败时页面右下角提示错误码与 HTTP 状态（如 `approval-rule-expired（HTTP 410）`）并写浏览器控制台；超过 2 秒先提示「仍在保存」、完成后提示结果，15 秒超时；失败不消耗审批，仍可「允许一次」；
- [x] 命令形态拦截：整文件 `cat`、无排除的 `~/.dsh`/家目录递归搜索、裸 `curl` API 默认返回 `deny` 并给 `read`/`grep`/`jq` 等替代；可配 `commandLintMode: ask`；同时注册系统提示引导；`ask` 模式下与风险规则合并为一次 `ask`；
- [x] 文档提交门禁：`tools/pre-execute` 解析 `git commit` 目标仓，已登记仓库按中央策略运行 `scripts/check.sh --repo`，失败 `deny`；配置 `docGuardEnabled`/`docGuardWorkspaceRoot`/`docGuardTimeoutMs`；不自动改文件；
- [x] `scripts/apply-profile.sh` 修复：检查 profile 已安装 scoped 包和失效的 `dsh-superagent` link；修正包名；删除顶层 `persistent-bash` 旧块，改为覆盖 minimal preset 的 `config.plugins` 并设 `maxOutputChars=65536`；`tool-result-pruner=6000/3000/1500`；重复执行幂等。
- [x] 中文 README 优先展示，补充英文 `README.en.md`；
- [x] linuxops 可选安装方案：不安装自动回退、插件只读兼容层、通过 `--binary` 接入自建/上游二进制；安装脚本不 sudo、不自动改 PATH；

## 待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~创建公开 GitHub 仓库 `person-clouds/dsh-context-guard`~~ | 已创建：https://github.com/person-clouds/dsh-context-guard |
| 2 | ~~发布 npm `@fenghoer/dsh-context-guard@0.3.1`~~ | 已发布；`0.4.1` 已补发（npm latest 核对为 `0.4.1`） |
| 3 | ~~提交 awesome-dsh-plugin 市场条目~~ | PR #15266 已合并；GitHub Release `v0.4.1` 已发布，市场 `latest` 链接自动更新 |
| 4 | 宿主机安装插件并执行 `scripts/apply-profile.sh` | 沙箱对 `~/.dsh` 只读；需先执行 `dsh plugin --profile web add link:/home/zh/www/dsh-context-guard` 和 `dsh plugin --profile superagent add link:/home/zh/www/dsh-context-guard`，再跑迁移脚本 |
| 5 | 重启 web/superagent 后验证 `--dump-config` 与 metrics | 需用户在宿主终端重启 DSH |
| 6 | 用真实长输出验证 `maxOutputChars`、单轮门禁与落盘完整性 | 需重启 DSH |
| 7 | 「始终允许」真实故障取证 | A 阶段已上线错误码提示；需一次真实失败时的提示/控制台原文，再定 B（token 持久化 / 按 `callId` 查找）；计划见 [PLAN-risk-always-allow-fix.md](PLAN-risk-always-allow-fix.md) |

## 验证记录

| 时间 | 项 | 结果 |
|---|---|---|
| 2026-11-14 | `node test.mjs` | ok；压缩归档、预算裁剪、落盘、去重、diff、指标、清理、风险命令识别与 `ask` 门禁、inspect.sh 语法/帮助均通过 |
| 2026-11-14 | `dsh --profile web --dump-config` | `compaction-archive` 已出现在组合树 |
| 2026-11-14 | `dsh --profile superagent --dump-config` | 同上 |
| 2026-11-14 | `npm pack --dry-run --cache /tmp/npm-cache` | 15 files / 21.2 kB，通过 |
| 2026-11-14 | GitHub Release `v0.3.0` | `dsh-context-guard.tgz` 已上传，latest/download 返回 200 |
| 2026-11-14 | `awesome-dsh-plugin` PR | 已创建 #15266，等待仓库年龄门槛后的自动重跑 |
| 2026-11-14 | npm Registry | `@fenghoer/dsh-context-guard@0.3.1` 可查询 |
| 2026-11-14 | `scripts/apply-profile.sh` 临时 HOME 连跑两次 | 迁移正确且无重复条目 |
| 2026-11-14 | `scripts/install-linuxops.sh` 临时 HOME 安装/卸载 | 兼容层可执行，`inspect.sh overview` 通过 `LINUXOPS_BIN` 联调成功 |
| 2026-11-15 | `node test.mjs` | 通过（0.3.1 文档更新回归） |
| 2026-11-15 | `npm pack --dry-run` | 包含 `README.md` / `README.en.md` |
| 2026-11-17 | `node test.mjs` | ok；新增预算收紧、调用门禁、累计输出门禁、命令形态 `deny`/`ask`、系统提示与合并 `ask` 测试 |
| 2026-11-17 | `scripts/apply-profile.sh` 临时 `DSH_HOME` 连跑两次 | 包名修正、`dsh-superagent` link 可解析、顶层 `persistent-bash` 删除、minimal preset 内 `maxOutputChars=65536`、`6000/3000/1500` 对齐、第二次“无变化”幂等通过 |
| 2026-11-17 | `dsh plugin --profile web add link:...` | 失败：沙箱 `~/.dsh` 为 EROFS；需宿主机执行 |
| 2026-11-17 | 回放 `session-277f61e5...` 77 条工具结果 | 原始 205,616 chars → emitted 48,800 chars（-76.3%），低于 ≤60,000 目标 |
| 2026-11-17 | `npm pack --dry-run` | 20 files / 32.2 kB；包含新增 `lib/turn-budget.js`、`lib/command-lint.js` |
| 2026-11-17 | `dsh --profile web --dump-config` | 失败：沙箱写 `~/.dsh/profiles/web/cordis.yml` EROFS；待宿主机重启后验证 |
| 2026-11-17 | `node test.mjs` | ok；新增临时目录 rm 豁免边界、session step 记录与门禁文案断言 |
| 2026-11-17 | `node test.mjs`（文档门禁） | ok；fixture 超限/缺 frontmatter 的 `git -C <repo> commit` 被 deny，修复后放行；非 commit 不触发 |
| 2026-11-17 | `scripts/docs-watch.sh --once` | ok；只读巡检通过，报告写入 `personalCloud/.run/docs-watch/latest.md`；通知因沙箱 `~/.config` EROFS 改用 `.run/docs-watch.env` 测试成功 |
| 2026-11-17 | 临时 fixture `check.sh --repo` | 断链/非法 PLAN 状态 FAIL，行数超限默认 WARN |
| 2026-11-17 | `node test.mjs`（硬上限自动继续） | ok；覆盖标记、同 turn 去重、同 session 3 次上限与 Web client 语法；待宿主机 Web 实机验收 |
| 2026-11-18 | 真实会话 `session-4766b047...` 拒绝事件 + VM 集成测试 | 修复前脚本复现 `ctx is not defined` 且事件形状不匹配；修复后挂载即写入 `["继续"]`；`npm test` ok |
| 2026-11-18 | 提醒/硬上限调整 | 单轮每 20 次 bash 返回一次 `ask`（黄色 pending 点）；第 80 次 deny + marker 并自动填「继续」；`maxCallsPerTurn=20`/`hardMaxCallsPerTurn=80` 显式写入 profile 模板与 `apply-profile.sh`；`npm test` ok |
| 2026-11-19 | `npm test`（风险放行规则） | ok；覆盖构建产物类规则跨命令放行（./node_modules → ./dist、packages/a/build）、非产物目录/通配符/sudo 仍询问、链接规则只放行同一主机、下载执行仍拦截、审批 token 一次性消费与 Web「始终允许」按钮提交 |
| 2026-11-18 | `npm test`（风险误报收敛） | ok；新增 `sudo -n true`/`-v` 与 `sudo -n` 只读命令、write-test 与 mktemp 自清理探测放行、test 目录 `rm` 豁免与危险边界断言 |
| 2026-11-19 | `npm test`（`~/opt` rm 白名单） | ok；`~/opt`、`$HOME/opt`、`/home/zh/opt` 下逐个列出的具体路径放行；目录本身、`/tmp/*`、`~/opt/*`、`..`、`sudo`、混合非白名单目标仍拦截 |
| 2026-11-20 | 提醒/硬上限放宽 | 单轮 bash 第 80 次返回一次 `ask`（黄色 pending 点）；第 160 次 deny + marker 并自动填「继续」；`maxCallsPerTurn=80`/`hardMaxCallsPerTurn=160` 同步到代码默认值、profile 模板、`apply-profile.sh`（含 20/80 → 80/160 迁移）与 web/superagent profile；`npm test` ok |
| 2026-11-20 | `npm test` | ok（0.4.1 发布前回归） |
| 2026-11-20 | npm publish `0.4.1` | ok（曾因 token/IP 报 403、404；用户更新 token 后发布成功，`npm view` 为 `0.4.1`） |
| 2026-11-20 | GitHub Release `v0.4.1` | 资产 `dsh-context-guard.tgz` 51055 字节，`latest/download` 返回 200 |
| 2026-11-20 | `npm test`（「始终允许」失败可见化） | ok；覆盖 HTTP 410、网络错误、缺 token 三条失败路径的提示与抛错，失败时不误答审批 |
| 2026-11-20 | Playwright 实机（web GUI） | 成功路径：新建会话→切「工作区内修改」→触发 `rm -f` 风险→点「始终允许」→POST 200、规则落盘、卡片关闭、命令执行；失败路径：拦截接口返回 410 时右下角提示 `approval-rule-expired（HTTP 410）` 且审批卡保持可回答；默认「完全权限」preset 为 `approval: never`，不会弹审批 |
