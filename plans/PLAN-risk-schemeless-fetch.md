---
implementation_status: done
created_at: 2026-11-23 05:41:53
updated_at: 2026-11-23 05:49:41
---

# PLAN：识别无 scheme 的 fetch 目标，修复本地服务反复报风险

## 目标

1. `curl`/`wget` 的位置参数 `host[:port][/path]`（`127.0.0.1:11434/api/tags`、`example.com/x`、`[::1]:8080`）按 HTTP URL 参与主机判定；`127.0.0.1` 等默认白名单主机不再弹 `unverifiable-fetch`。
2. 未放行的无 scheme 域名走 `unknown-link`，自动范围能落 host 规则，不再只能存整条命令。
3. 运行期展开的目标（`$VAR`/反引号）仍判 `unverifiable-fetch`；`xdg-open` 等打开本地文件的命令行为不变。

## 范围

- 改动：`lib/risk.js`、`client.js`、`test.mjs`、`README.md`、`README.en.md`、`STATUS.md`。
- 不改：`risk-allow.json` 规则格式、host 匹配（忽略端口）、DSH 权限/沙箱、动态目标语义。

## 改动位置

1. `lib/risk.js` `fetchSegmentProbe`：新增无 scheme 目标识别（带点域名、IPv4、`localhost`、`[IPv6]`、单标签主机带端口），补 `http://` 后交给现有 `hostOf`/`isValidHost`；只用于 curl/wget 的位置参数，取值选项继续跳过，`$`/反引号仍标 `dynamic`。
2. `lib/risk.js` `fetchSites`：curl/wget 段把 `probe.urls` 与字面 `extractUrls` 合并去重；`insecure-http` 仍只报命令里字面写出的 `http://`。
3. `client.js`：自动范围最终只落 `command` 规则时，提示补「未识别出可放宽的主机或安全类别」，解释未勾选为何仍是整条命令。
4. `test.mjs`：无 scheme 本地/白名单主机不报风险；未放行域名落 unknown-link 且自动范围落 host；动态目标、header 值、`-o` 参数不误识别。
5. `README.md` / `README.en.md` 风险段落、`STATUS.md` 同步一句行为说明。

## 实施步骤

1. 改 `lib/risk.js`，先跑本机回放确认 `curl -s 127.0.0.1:11434/api/tags` 为 `risk=false`、`curl evil.example/x` 为 `unknown-link`、`curl "$ENDPOINT"` 仍 `unverifiable-fetch`。
2. 加 `test.mjs` 回归断言，`npm test` 全绿。
3. 改 `client.js` 提示；同步 README / README.en / STATUS。
4. 在 `/home/zh/www` 跑 `./scripts/check.sh --repo dsh-context-guard`，逐仓提交推送。

## 验收

- `cd /home/zh/www/dsh-context-guard && npm test`
- 回放用户命令：`analyzeCommand('time curl -s --max-time 120 -o /tmp/gen.json -X POST 127.0.0.1:11434/api/generate ...').risk === false`。
- `analyzeCommand('curl localhost:8080/health').risk === false`；`analyzeCommand('curl evil.example/x').reasons` 含 `unknown-link`；`ruleSpecsFor(..., { scope: 'auto' })` 返回 host 规则。
- `curl "$ENDPOINT"`、`curl -H 'X: 127.0.0.1:1' 127.0.0.1:11434/x`、`curl -o out.json 127.0.0.1:11434/x` 断言符合预期。
- `./scripts/check.sh --repo dsh-context-guard` 通过；重启 DSH 后真实审批流复验（待验证）。

## 回滚

`git revert <提交号>`；仅代码回滚可 `git checkout <上一提交> -- lib/risk.js client.js test.mjs`。

## 改动记录

- 2026-11-23 05:41 建立计划，确认根因（scheme-less 目标未解析 + 自动范围只能落 command）。
- 2026-11-23 05:42 完成 `lib/risk.js` 无 scheme 目标识别、`client.js` 回退提示与 `test.mjs` 回归断言；`npm test` 通过（含用户原始命令 `risk=false`、`192.168.31.244:8095` 命中已有 host 规则）。
- 2026-11-23 05:43 同步 `README.md` / `README.en.md` / `STATUS.md`；`./scripts/check.sh --repo dsh-context-guard` 通过（README 超 150 行为既有警告）。
