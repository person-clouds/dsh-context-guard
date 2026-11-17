# PLAN — dsh-context-guard 调用限制与安装修复

## 目标

1. 修复 `web` / `superagent` 两个 profile 的加载失败，让插件真正生效。
2. 收紧单次工具输出预算，保留完整落盘证据。
3. 单轮 bash 调用门禁：第 21 次起 `ask`（每轮一次），第 40 次起 `deny`。
4. 单轮累计输出门禁：累计进入上下文超过 40KB 后，后续结果只留 800 字符 + 落盘路径。
5. 对整文件 `cat`、递归 `grep`、裸 `curl` 大响应做 `ask` 提示，并给出替代命令。

## 范围

- 代码：`task/dsh-context-guard/`
- 配置：`~/.dsh/profiles/web/cordis.patch.yml`、`~/.dsh/profiles/superagent/cordis.patch.yml`
- 安装：两个 profile 都 `dsh plugin add link:...`
- 不改 DSH 核心代码；不自动改写用户命令；不替代 DSH 权限/审批策略。

## 根因

- profile 写的是 `name: dsh-context-guard`，包实际名为 `@fenghoer/dsh-context-guard`，且 profile 未安装该包。
- 启动日志：`Cannot find package 'dsh-context-guard' imported from /home/zh/.dsh/profiles/web/`。
- `~/.dsh/context-guard/metrics` 与 `~/.dsh/tool-output` 无该会话数据，插件从未执行。
- 当前只有事后裁剪与去重，没有调用次数或单轮累计输出限制。

## 改动位置

| 文件 | 改动 |
|---|---|
| `lib/budget.js` | 默认值：default 2000、unbounded 1500、source 3000、status 1500、logs 2500、diff 3000、build 3000、hardMax 6000、error 2500 |
| `lib/turn-budget.js`（新增） | 按 session 记录单轮调用数、已输出字符数；`turn/start` 重置；提供 `checkCall()` / `consumeOutput()` |
| `lib/command-lint.js`（新增） | 识别整文件 `cat`、递归 `grep`/`rg`（目标为 `~/.dsh`、家目录且无排除）、裸 `curl` API；返回 `ask` 原因和替代命令 |
| `index.js` | 配置项、`session/event` 重置、`tools/pre-execute` 调用门禁与命令提示、`tools/post-execute` 累计输出上限；`ask` 原因合并，避免同一次调用弹两次 |
| `test.mjs` | 预算、调用门禁、累计输出、命令提示、配置默认值测试 |
| `scripts/apply-profile.sh` | 修正为 scoped 包名；检查安装；把 `tool-result-pruner` 对齐到 6000/3000/1500；重复执行不产生重复条目 |
| `README.md` / `README.en.md` / `STATUS.md` | 记录新配置、门禁行为、安装修复与验证结果 |

新增配置默认值：

```yaml
maxCallsPerTurn: 20
hardMaxCallsPerTurn: 40
maxTurnOutputChars: 40000
exhaustedOutputChars: 800
commandLintEnabled: true
```

## 实施步骤

1. 调整 `lib/budget.js` 默认值，补预算单元测试。
2. 新增 `lib/turn-budget.js`：按 session 计数；`session/event` 的 `turn/start` 清零；无 turn 事件时退化为按 session 计数并在日志 warning。
3. 在 `tools/pre-execute` 执行 `next()` 后检查：
   - 第 21 次：返回 `ask`，提示“本轮已 20 次 bash，是否继续”；同一轮只问一次；
   - 第 40 次：返回 `deny`，提示拆任务或先汇报；
   - 命令 lint 与风险规则命中时合并为一个 `ask`。
4. 在 `tools/post-execute` 记录实际 emitted chars；单轮累计超过 40000 后，后续超 800 字符的结果完整落盘，上下文只回 800 字符摘要和路径。
5. 新增命令 lint 提示与替代命令：
   - `cat file` → `sed -n '1,120p' file` / `rg -n '关键词' file`
   - `grep -R pattern ~/.dsh` → `rg -n --glob '!**/node_modules/**' pattern ~/.dsh`
   - 裸 `curl .../api/...` → `curl ... | jq '{field1,field2}'` 或 `-o /tmp/out.json` 后再查询
6. 更新 `scripts/apply-profile.sh`：统一 scoped 包名；检测 `node_modules/@fenghoer/dsh-context-guard`；缺失时输出安装命令并以非零退出；已有条目只改不重复加。
7. 宿主机执行：
   ```bash
   dsh plugin --profile web add link:/home/zh/www/personalCloud/task/dsh-context-guard
   dsh plugin --profile superagent add link:/home/zh/www/personalCloud/task/dsh-context-guard
   task/dsh-context-guard/scripts/apply-profile.sh
   ```
   然后重启 web / superagent 的 DSH 进程（由用户执行）。
8. 跑测试、验证 dump-config、更新文档，提交并报告 commit hash 与回滚命令。

## 验收

- `cd task/dsh-context-guard && npm test` 通过。
- `dsh --profile web --dump-config` 与 `--profile superagent` 均包含 `@fenghoer/dsh-context-guard`，启动日志无 `ERR_MODULE_NOT_FOUND`。
- 合成会话验证：第 21 次 bash 出现一次 `ask`；第 40 次为 `deny`；单轮 emitted 超过 40000 后仅回 800 字符 + 落盘路径。
- 回放 `session-277f61e5...` 的 77 条命令/结果：原始 205,616 chars，预计 emitted ≤ 60,000 chars（当前预算约 153,465，收紧后约 112,862，加单轮累计门禁后进一步下降）。
- 重启后跑一条小命令，`~/.dsh/context-guard/metrics/<session>.jsonl` 出现新记录。

## 追加：命令形态硬拦截（2026-11-17）

按后续要求，把命令形态从单纯 `ask` 升级为默认 `deny`：

- 新增配置 `commandLintMode: deny|ask`，默认 `deny`；
- 新增 `commandGuidanceEnabled: true`，通过 `systemPrompt.section` 注入 `read`/`grep`/`jq` 使用引导；
- `deny` 的 `reason` 包含替代命令，并明确 DSH 不会自动改写参数；
- 复杂流程可显式设 `commandLintMode: ask` 降级为一次确认；
- 整文件 `cat` 进入管道时不再误报；已有测试覆盖 `deny`、`ask`、系统提示和合并 `ask`。

## 回滚

1. 代码：`git revert <本次 commit>`。
2. Profile：恢复 `~/.dsh/profiles/{web,superagent}/cordis.patch.yml.bak.context-guard-*`。
3. 安装：用 `dsh plugin --profile <profile> remove @fenghoer/dsh-context-guard` 移除（以 `dsh plugin --help` 实际语法为准）。
4. 重启对应 DSH 进程。
