---
implementation_status: done
created_at: 2026-11-22 14:35:30
updated_at: 2026-11-22 14:37:10
---

# PLAN：链接检查限定到真实 fetch 段并容忍不可解析 URL

## 目标

消除两类误报，同时保持"真实 curl/wget 访问未知主机仍要确认"：

1. 纯文本/模式串被当成访问链接：文档正文、heredoc、Python `open(`、`grep -o 'https://…'` 触发 `unknown-link`；
2. 一个不可解析的占位 URL（如 `https://…ts.net:8082`）使整条主机白名单失效，卡片改报同命令里已放行的 `http://192.168.31.244:2283`。

## 范围

- 改动：`lib/risk.js`、`lib/risk-allow.js`、`test.mjs`、`README.md` / `README.en.md` 的风险说明、`STATUS.md`。
- 不改：`~/.dsh/context-guard/risk-allow.json` 规则格式与内容、`RiskRuleStore` 缓存语义、可解析但未放行主机的判定。

## 改动位置

1. `lib/risk.js:9`：删除 `FETCH_OR_OPEN_RE`（裸 `open` 命中 Python `open(`）；新增 `FETCH_COMMANDS`、`COMMAND_PREFIXES`、`SHELL_COMMANDS` 常量。
2. `lib/risk.js`：新增 `commandHead(tokens)` 与 `extractFetchUrls(command)`——按 `splitShellSegments` 分段，只对首命令为 curl/wget/xdg-open 等的段取 URL；支持 `sudo`/`env`/`nohup`/`time`/`exec`/`timeout`/`xargs` 前缀与 `bash -c` 内层递归。
3. `lib/risk.js:439-452`：`analyzeCommand` 改用 `extractFetchUrls(raw)`，不再对全文 `extractUrls(raw)`。
4. `lib/risk-allow.js:521-527`：`allHostsAllowed` 只统计 `hostOf(url) !== ''` 的 URL；无可解析主机时保持原判，不放行。

## 实施步骤

1. 按上述位置改代码，导出 `extractFetchUrls` 供测试。
2. `test.mjs` 增回归用例：heredoc 文档写入、`grep -o 'https://...'`、真实 `curl "http://..."`、`sudo curl`、`bash -c "curl ..."`、同命令内“已放行主机 + 占位 URL”应静默、仅占位 URL 仍确认。
3. `npm test` 全绿后，回放本次真实命令（两类）确认不再产生 risk。
4. 同步 README/README.en 风险段落一句边界说明；`STATUS.md` 记一条。
5. `./scripts/check.sh --repo dsh-context-guard`，逐仓提交推送。

## 验收

- `cd /home/zh/www/dsh-context-guard && npm test`
- 回放：文档写入命令与 `329a0f0e` 的 grep 模式命令，`analyzeCommand(...).risk === false`；`curl http://192.168.31.244:8095/` 在主机规则下 `filterRiskByRules(...).risk === false`；`curl http://evil.example/a` 仍 `risk === true`。
- `dsh web` 重启后同命令不再弹卡（需用户确认重启窗口）。
- `./scripts/check.sh --repo dsh-context-guard` 通过。

## 回滚

`git revert <提交号>`；仅代码回滚可 `git checkout eae8473 -- lib/risk.js lib/risk-allow.js test.mjs`。

## 改动记录

- 2026-11-22 14:35 建立计划，确认方案 D（分段识别 + 不可解析 URL 不阻塞放行）。
- 2026-11-22 14:36 完成 `lib/risk.js`/`lib/risk-allow.js` 改动与回归用例，`npm test` 通过。
- 2026-11-22 14:37 同步 README、README.en、STATUS，回放真实命令验证。
