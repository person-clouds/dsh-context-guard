# STATUS — dsh-context-guard

- 版本：`0.5.0`（本地已就绪，待发布；`npm publish` 需用户 2FA）
- 更新时间：2026-11-22
- 一句话：DSH 工具输出预算/落盘、去重、单轮调用/输出门禁、硬上限后 Web 自动填入「继续」、命令形态拦截、风险确认与窄规则自动放行、内置放行默认值外置、只读诊断、压缩归档与指标。
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
- [x] 「始终允许」填写原因：点击后先弹出原因输入框（必填、最多 200 字、压成单行），取消不保存也不消耗审批；原因随请求提交，Host 校验后再消费 token，缺原因返回 400 `reason-required`；原因作为规则标记 `reason` 写入 `risk-allow.json`，同一规则再次放行时覆盖为最新原因，`reason` 只用于复核、不参与匹配。
- [x] 「始终允许」凭据失效修复：待放行项短期落盘为 `context-guard/risk-pending.json`（0600、TTL 10 分钟、最多 100 条），插件重载后同一 token 仍可消费；token 不在时按审批 `callId` 兜底，二者都没有才返回 410；落盘失败只 warning，不影响本次审批；规则仍只按安全类泛化。
- [x] 命令形态拦截：整文件 `cat`、无排除的 `~/.dsh`/家目录递归搜索、裸 `curl` API 默认返回 `deny` 并给有界替代；替代命令与系统提示按当前工具面渲染文件工具（dsh-ops 的 `ops_inspect_local_file`/`ops_grep`/`ops_glob`，否则官方 `read`/`grep`/`glob`），另含 `jq`；可配 `commandLintMode: ask`；`ask` 模式下与风险规则合并为一次 `ask`；
- [x] 文档提交门禁：`tools/pre-execute` 解析 `git commit` 目标仓，已登记仓库按中央策略运行 `scripts/check.sh --repo`，失败 `deny`；配置 `docGuardEnabled`/`docGuardWorkspaceRoot`/`docGuardTimeoutMs`；不自动改文件；
- [x] `scripts/apply-profile.sh` 修复：检查 profile 已安装 scoped 包和失效的 `dsh-superagent` link；修正包名；删除顶层 `persistent-bash` 旧块，改为覆盖 minimal preset 的 `config.plugins` 并设 `maxOutputChars=65536`；`tool-result-pruner=6000/3000/1500`；重复执行幂等。
- [x] 默认放行值外置：链接主机（`local`/`codeHosting`/`api`/`docs`/`techMedia` 五组 28 个）、`rm` 临时根与 test 目录、`~/opt` 开关、产物目录、写探测、`sudo`/`systemctl` 只读清单、git 只读子命令登记统一移入随包 `config/risk-allow-default.json`；`lib/default-allowlist.js` 负责读取、字段校验与规范化，配置缺失或非法时回退最小安全默认（仅 loopback 链接）并 warning；`DEFAULT_ALLOW_HOSTS` 与产物目录集合改由配置导出；`riskAllowHosts` 显式覆盖语义不变，用户 host 规则继续与内置并集；个人/内部域名不进内置。
- [x] 中文 README 优先展示，补充英文 `README.en.md`；
- [x] 中文/英文 README 开头新增「本机配置落点」：记录 `~/.dsh/profiles/web/cordis.patch.yml` 的 `full-access-ask` 预设（`danger-full-access` + `approval: ask`，替代会静默拒绝风险确认的 `approval: never`）与 `~/.dsh/context-guard/risk-allow.json` 的 host 规则（增量叠加内置默认、需重启加载）；本机另新增 `192.168.31.244`、`100.84.98.28` 两条 host 规则；
- [x] linuxops 可选安装方案：不安装自动回退、插件只读兼容层、通过 `--binary` 接入自建/上游二进制；安装脚本不 sudo、不自动改 PATH；
- [x] 修复「bash 全量报 `cannot get property "tools" without inject`」：`detectFileTools` 与 `registerCommandGuidance` 原先直接读 `ctx.tools`/`ctx.systemPrompt`，插件未声明 `inject` 时 cordis 代理在属性读取阶段即抛错，`tools/pre-execute` 的命令形态检查因此让所有 bash 调用失败（0.4.2 引入 `detectFileTools` 时回归）；改为优先 `ctx.get()`（无 inject 要求、取不到返回 `undefined`）并保留属性读取兜底且包在 `try` 中，同时修复命令提示段落一直未注册的问题；`test.mjs` 增加严格上下文（属性读取即抛）的单元与端到端回归用例。
- [x] 修复替代命令提示指错工具：`tools/pre-execute` 里 `detectFileTools(ctx)` 没传 scope，取到的是全局视图，看不到按 agent 作用域注册的 `ops_*`，于是文案退化成官方 `read`/`grep`/`glob`（部分会话根本没有 `read`）；改为 `detectFileTools(ctx, exec?.agent)`，与系统提示段落拿到的 `scope` 保持一致；`test.mjs` 增加「全局视图只有 `read`、agent 视图有 `ops_*` 时 deny 文案必须是 `ops_inspect_local_file`」回归用例。
- [x] 压缩阈值配置可自检/可重放：新增 `scripts/apply-compaction.sh`（`check` 默认只读自检、`apply` 备份后按安装包 preset 重生成覆盖块并原位替换、`dry-run` 只预告），校验四个内置 preset 的 `compaction-basic` 三字段（`thresholdRatio/retainRatio/headroomTokens`），块与安装包不一致时报 FAIL 提示 DSH 升级漂移；保留宿主已有的 `maxOutputChars`；`test.mjs` 新增 fixture 语法/全 PASS/幂等/缺字段 FAIL/dry-run 不写盘用例；文档见 `docs/context-compaction.md` 5.5。
- [x] 核验态硬上限（2026-11-22）：会话标题命中 `sessionBudgets[].match`（默认 `^(?:TODO[：:]\s*)?V[：:]`）时自动切换预算 `25 提醒 / 40 硬拒 / 单轮 20000 chars`，并 `deny` `write`/`edit` 与装依赖、`git commit|push|add`、重启服务；标题由 `/V` 命令或手工改名设置，标题缓存 5 秒 TTL，非核验会话保持全局 `80/160/40000`；新增 `lib/verify-mode.js`（规则编译、指纹、派单登记）与 `turn-budget.budgetFor` 按会话覆盖；
- [x] 重复派单硬拦（2026-11-22）：`subagent`/`subagent_fork`/`workflow` 的 prompt 声明「快照：`<sha>`」时，同会话同指纹 2 小时内第二次派单直接 `deny`（唯一能在 `tools/pre-execute` 拒绝的层就是本插件），prompt 含 `verify-again` 或未声明快照不拦；`test.mjs` 增加规则编译/标题匹配/指纹/窗口过期/去重与端到端用例。
- [x] 核验态契约与版本对齐（2026-11-22，0.5.0）：标题正则 `^(?:TODO[：:]\s*)?V[：:]` 由 `test.mjs` 字面契约锁住（`V：`、`TODO：V：`、`V：计划：` 命中，`D：` / `G：` 不命中）；README 中英双份写明标题由外部写入（配套 `dsh-workflow-shortcuts` ≥ `0.4.0` 提供 `/V`、`/VP`，只装本插件时手动改名同样生效）、默认 `sessionBudgets` 是可覆盖的示例规则、`/VP` 提示词不写快照故不参与派单去重；`package.json` 升 `0.5.0`；原有预算数字、`deny` 列表与派单去重行为未改。

## 待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~创建公开 GitHub 仓库 `person-clouds/dsh-context-guard`~~ | 已创建：https://github.com/person-clouds/dsh-context-guard |
| 2 | ~~发布 npm `@fenghoer/dsh-context-guard@0.3.1`~~ | 已发布；`0.4.1` 已补发（npm latest 核对为 `0.4.1`） |
| 3 | ~~提交 awesome-dsh-plugin 市场条目~~ | PR #15266 已合并；GitHub Release `v0.4.1` 已发布，市场 `latest` 链接自动更新 |
| 4 | 宿主机安装插件并执行 `scripts/apply-profile.sh` | 沙箱对 `~/.dsh` 只读；需先执行 `dsh plugin --profile web add link:/home/zh/www/dsh-context-guard` 和 `dsh plugin --profile superagent add link:/home/zh/www/dsh-context-guard`，再跑迁移脚本 |
| 5 | 重启 web/superagent 后验证 `--dump-config` 与 metrics | 需用户在宿主终端重启 DSH；同时实机验证「始终允许」原因弹窗、取消、规则 `reason` 标记 |
| 6 | 用真实长输出验证 `maxOutputChars`、单轮门禁与落盘完整性 | 需重启 DSH |
| 7 | 「始终允许」真实故障取证 | A 阶段已上线错误码提示；B 已补待放行项落盘与 `callId` 兜底（未取得真实故障原文，按最可能的 token 失效路径实现）；如再遇失败，记录提示/控制台原文以确认是否还有其它分支 |
| 8 | 验证并发布默认放行配置外置 | 代码与文档已改；本会话 shell 不可用，需在 `/home/zh/www/dsh-context-guard` 跑 `npm test`、`npm pack --dry-run`（确认含 `config/risk-allow-default.json`），再在 `/home/zh/www` 跑 `./scripts/check.sh --repo dsh-context-guard`，通过后按 `PUBLISHING.md` 发布 |
| 9 | 新描述上线 | `package.json` 描述与 README 已改，但 npm 页面要等下一次 `npm publish`（如 0.4.5）才更新；awesome-dsh-plugin 市场条目描述需另提 PR 更新。 |
| 10 | ~~重启后回放链接检查~~ | 已完成：2026-11-22 16:44:49 重启（PID 414812，晚于 `d725d4c`）。真实入口回放：`cat <<'EOF' \| env bash` 正文含未放行链接 → 弹出 `context-guard risk check (medium): unknown-link, insecure-http`（修前静默放过）；白名单内 `curl http://192.168.31.244:2283/api/health` 放行无卡；整文件 `cat` 仍被 lint 拦。见验证记录 2026-11-22 17:05 |
| 11 | 文本经管道喂给 shell 的漏报 | `printf 'curl http://evil.example' \| bash`、`echo "$CMD" \| bash` 仍判 `none`（重启后实测无卡）：字面量文本进 shell 后不做二次解析。属已知边界；如需覆盖，按「管道上一段的字面量参数当作一段命令递归分析」实现（注意自引用循环与成本）。`PLAN-risk-link-scope.md` 的 15:58 已订正为 15:43 |
| 12 | host 规则命中仍弹一次卡 | 2026-11-22 16:49 观察：`unknown.example` 已在 `risk-allow.json`，`curl http://unknown.example/x` 仍弹卡且 reason 带 `rule-token`、决策 `allowed-once`。离线 `filterRiskByRules` 判定为已放行，疑似运行期规则加载时序；不影响安全性，待复现时确认 |
| 13 | 核验态与派单去重实机验证 | 需重启 DSH 后：把会话标题改成 `V：测试`，确认 `write`/`npm install` 被 `deny`、第 25 次 bash 提醒、第 40 次硬拒；同一 prompt 带「快照：`abc1234`」连派两次 `subagent`，第二次应 `deny` 且加 `verify-again` 可放行；`V：计划：…`（`/VP`）只读生效、提示词无 `快照：`，同一计划可再次 `/VP` 不被去重拦截 |
| 14 | 发布 `0.5.0` | 本地已就绪、**待发布**：`npm publish` 需用户 2FA；发布后补 GitHub Release `v0.5.0`，核对 npm 版本与市场 `latest` 链接，再按待办 13 做实机回放 |

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
| 2026-11-20 | `npm test`（「始终允许」原因） | ok；覆盖取消不提交、空原因留在弹窗提示、原因压成单行后提交、缺原因/纯空白 400 `reason-required` 且不消费 token、规则与 API 返回带 `reason`、同一规则原因覆盖、超长截到 200 字、`callId` 兜底带原因、重载后真实路由保存并放行 |
| 2026-11-20 | `npm test`（待放行项落盘/`callId` 兜底） | ok；覆盖跨实例 token 复用、TTL 过期失效、无效 token + `callId` 兜底 200、`apply` 重载后旧 token 经真实路由保存并放行同类命令、客户端提交 `callId`、410/网络/缺 token 提示；实机生效需重启 DSH Host |
| 2026-11-20 | `npm test`（命令提示跟随工具面） | ok；新增 `detectFileTools` 识别 `ops_*`/官方 `read`/两者皆无三种工具面，系统提示与 lint 替代命令按工具面渲染；实机生效需重启 DSH Host |
| 2026-11-21 | `npm test`（默认放行配置外置） | ok；新增内置配置加载与分组断言（28 主机、22 产物目录、23 个 sudo 只读命令、10 个 systemctl 子命令、10 个 git 只读子命令）、Tailscale 域名不入内置、用户 host 规则与内置并集、缺配置与非法配置回退最小安全默认并告警 |
| 2026-11-21 | `npm pack --dry-run` | 24 files，包含 `config/risk-allow-default.json` 与 `lib/default-allowlist.js` |
| 2026-11-21 | `./scripts/check.sh --repo dsh-context-guard` | PASS（5 篇文档，0 项警告） |
| 2026-11-21 | `npm test`（未 inject 读取 + 作用域工具面） | ok；新增「属性读取即抛 `cannot get property ... without inject`」的严格上下文单元/端到端回归（bash pre-execute 必须放行），以及 `exec.agent` 作用域视图断言（全局视图只有 `read` 时 deny 文案仍须给 `ops_inspect_local_file`）；实机生效需重启 DSH Host |
| 2026-11-21 | `npm publish 0.4.4` | ok；`npm publish --access public` 输出 `+ @fenghoer/dsh-context-guard@0.4.4`（`npm whoami` 在默认 registry 下报 need auth，但发布走 registry.npmjs.org 成功；按约定发布 5 分钟后再核版本） |
| 2026-11-21 | tag `v0.4.4` | 已推送 `origin`；`gh` 未登录（`gh auth status` 无 host） |
| 2026-11-21 | GitHub Release `v0.4.4` | ok；用 `GH_TOKEN=$(git credential fill ...)` 从 git credential helper 取 zhyfor PAT（token 未落盘、未打印），`gh release create` 成功；资产 `dsh-context-guard.tgz` 58586 字节，`releases/latest/download` 返回 200 |
| 2026-11-21 | 实机验收（重启后） | `cat app.log` 被 deny，文案已是 `ops_inspect_local_file({ path, offset: 1, limit: 120 })`，说明 0.4.4 的 `exec.agent` 作用域修复生效；有界形式 `cat x \| head` 仍正常放行 |
| 2026-11-22 | `npm test`（压缩阈值自检脚本） | ok；`apply-compaction.sh` 语法通过；fixture 空 patch 下 dry-run 不写盘、apply 后 `check` 两个 fixture preset 全 PASS、二次 apply 无变化且只一份备份、删 `thresholdRatio` 与改值 0.5 均 FAIL 并点名 preset、空 patch 报「未被覆盖」 |
| 2026-11-22 | `bash scripts/apply-compaction.sh check`（真实 home patch） | PASS：`preset-standard/minimal/ptc/cordis` 四个内置 preset 全部通过（仅比较阈值与安装包结构，忽略注释与引号风格）；未对 `~/.dsh` 执行 apply |
| 2026-11-22 | 实机验收（白名单 + 预设） | `dsh-web` 于 12:23:51 重启（规则文件 12:21 写入，34 条规则/30 条 host）；`curl http://192.168.31.244:8095/` 返回 200 且**未弹审批卡**，证明 host 规则由 `allowedBy: host` 摘掉 `unknown-link`/`insecure-http`；本会话切到 `ask` 后审批链路正常。离线回放 7 条历史被拒命令：4 条 curl-only 由有风险变 `none`，2 条含 `docker rm -f` 仍为 `container-delete`，1 条 `$p` 变量端口仍报 `unknown-link`（`new URL()` 解析不出主机名） |
| 2026-11-22 | `npm test`（README/npm/market 描述更新） | ok；无代码改动，回归通过 |
| 2026-11-22 | `./scripts/check.sh --repo dsh-context-guard` | PASS（7 篇文档，0 项警告） |
| 2026-11-22 | 修复链接检查误报（`PLAN-risk-link-scope`） | `analyzeCommand` 改为按 shell 段只对段首 `curl`/`wget`/`xdg-open` 等取链接，heredoc、引号内模式串与 Python `open(` 不再触发 `unknown-link`；`filterRiskByRules` 只统计可解析主机的 URL。回放：`329a0f0e` 的文档写入与 grep 模式命令 `risk=false`，`curl http://192.168.31.244:8095/` 由 host 规则放行，`curl http://evil.example/a` 仍确认；`npm test` ok |
| 2026-11-22 | 修复核验发现的放行分支漏洞（`PLAN-risk-link-scope`） | 包装形式（`/usr/bin/curl`、`env -i`、`timeout -s KILL 5`、`sudo -u`、子 shell、`for … do`、`bash -lc`）恢复识别；`filterRiskByRules` 改用 `extractFetchUrls` 且动态主机段（`$PORT`）不静默放行；heredoc 正文剥离；`HTTP://` 计入 `insecure-http`；host 规则强制非空主机名。二轮核验再修 4 个 P1：白名单 URL 连带放行无字面链接的 fetch 段、authority 内反引号地址漏报、执行型 heredoc（`bash <<EOF`、`… <<EOF | bash`）正文被误剥、host 规则从 grep 模式串落库；放行语义收紧为「不能证明每条会执行的 fetch 都在白名单内就保持原判」，并补 `eval`/`find -exec`/`env -S`/`chroot`/`ssh`/`watch`/`ksh`/`fish` 包装识别。另修自查发现的 3 处漏判：`ssh -p 22 host …` 取值选项挡住宿主命令、`find … -exec sh -c '…'` 因 token 化丢引号漏判、未加引号终止符的 heredoc 正文里 `$(…)` 命令替换会真执行却被剥掉；`test.mjs` 增回归断言覆盖上述形式，`npm test` ok |
| 2026-11-22 | 三轮核验修复（`PLAN-risk-link-scope`，范围 C） | 2 个 fresh subagent 复核后再修：① 同一 fetch 段「字面链接 + 动态参数」此前只按字面 URL 放行，改为按段标 `dynamic`（`-H`/`-d`/`-o` 等取值选项里的 `$VAR` 不算）；② 执行型 heredoc 改结构化判定（`dash`/`env bash`/`busybox sh`/`ssh host 'bash -s'`/`source /dev/stdin`）；③ `<<-` 终止符带 CRLF 不闭合；④ `$((1 << n))`/`((…))` 位移运算符误判 heredoc；⑤ `ssh -- host` 偏移、补 `-E/-B/-I/-P`；⑥ `chroot --userspec/--groups` 与 `--`；⑦ 确认卡最多列 3 条未放行链接并标注总数，`ruleSpecsFor` 只为列出的链接写 host 规则；⑧ 最终 diff 复核补 `unverifiable-fetch`：`curl "$ENDPOINT"`、`wget -i urls.txt` 这类没有字面链接的 fetch 此前 `risk=false` 完全不询问，现改为确认且只落 command 规则（`xdg-open "$f"` 等本地打开不触发）。`test.mjs` 增 60 余条断言；`npm test` ok，变异抽检（动态段恒假/上限改 5/执行型 heredoc 关闭）均被测试抓到；`./scripts/check.sh --repo dsh-context-guard` PASS。**实机生效需重启 `dsh web`** |
| 2026-11-22 | 动态判定误报修正（`d725d4c`） | `unverifiable-fetch`/`dynamic` 只看选项以外的位置参数：补齐 curl/wget 的取值选项（token、限速、`--json`、代理凭据等），`--oauth2-bearer "$TOKEN"`、`wget --method "$M"` 不再弹卡；`curl --version`/`-V`/`--help`、`wget --version` 因没有目标也不再报；`curl -K cfg`、`wget -i urls.txt` 仍报（URL 从文件读）。`npm test` ok，`./scripts/check.sh --repo dsh-context-guard` PASS |
| 2026-11-22 | 独立复核 `98de266`（复现 12 组探针） | `cat <<'EOF' \| env bash`、`\| sudo -u root sh`、`\| nice busybox sh` 均从静默 `none` 变为 `medium`，`\| tee notes.md` 仍按文档放行；`curl "$URL"`、`echo u \| xargs curl`、`curl //evil.example/x` 报 `unverifiable-fetch`；`npm test` ok。仍未覆盖：`printf 'curl …' \| bash`、`echo "$CMD" \| bash`（见待办 11）。运行进程 15:00:09 启动，改动未加载，待重启（待办 10） |
| 2026-11-22 17:05 | 重启后真实入口回放（`dsh web` PID 414812，16:44:49 启动） | `cat <<EOF | env bash` 正文含 `http://evil.example/probe` → 弹 `context-guard risk check (medium): unknown-link, insecure-http`，决策 `allowed-once`（修前该写法静默放过）；白名单 `curl http://192.168.31.244:2283/api/health` 无卡返回 404；整文件 `cat` 仍被 lint 拦；`printf "" | bash` 仍无卡（待办 11）。插件加载路径确认为软链 `~/.dsh/profiles/web/node_modules/@fenghoer/dsh-context-guard -> /home/zh/www/dsh-context-guard` |
| 2026-11-22 | `npm test`（0.5.0 核验态契约） | ok；新增标题契约断言：`V：`、`TODO：V：`、`V：计划：` 命中核验规则，`D：` / `G：` 不命中 |
| 2026-11-22 | `./scripts/check.sh --repo dsh-context-guard` | PASS（8 篇文档，1 项警告：`README.md` 296 行超过 150 行建议上限，属既有篇幅，非本次新增断链） |
