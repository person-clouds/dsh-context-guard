---
implementation_status: done
created_at: 2026-11-22 14:35:30
updated_at: 2026-11-22 16:45:00
---

# PLAN：链接检查限定到真实 fetch 段，放行只认可证明的 fetch

## 目标

消除两类误报，同时保持"真实 curl/wget 访问未知主机仍要确认"：

1. 纯文本/模式串被当成访问链接：文档正文、heredoc、Python `open(`、`grep -o 'https://…'` 触发 `unknown-link`；
2. 早期实现为了让「已放行主机 + 占位 URL」不误报，把不可解析主机排除在判定外，结果让看不见目标的 fetch 也能被静默放行；核验后改为：只要不能证明每条会执行的 fetch 都落在白名单里（占位/动态/非法主机、`curl "$ENDPOINT"` 这类无字面 URL 的段），就保持原判。

## 范围

- 改动：`lib/risk.js`、`lib/risk-allow.js`、`test.mjs`、`README.md` / `README.en.md` 的风险说明、`STATUS.md`。
- 不改：`~/.dsh/context-guard/risk-allow.json` 规则格式与内容、`RiskRuleStore` 缓存语义、可解析但未放行主机的判定。

## 改动位置

1. `lib/risk.js:9`：删除 `FETCH_OR_OPEN_RE`（裸 `open` 命中 Python `open(`）；新增 `FETCH_COMMANDS`、`COMMAND_PREFIXES`、`SHELL_COMMANDS` 常量。
2. `lib/risk.js`：新增 `commandHead(tokens)` 与 `extractFetchUrls(command)`——按 `splitShellSegments` 分段，只对首命令为 curl/wget/xdg-open 等的段取 URL；支持 `sudo`/`env`/`nohup`/`time`/`exec`/`timeout`/`xargs` 前缀与 `bash -c` 内层递归。
3. `lib/risk.js:439-452`：`analyzeCommand` 改用 `extractFetchUrls(raw)`，不再对全文 `extractUrls(raw)`。
4. `lib/risk-allow.js`：`filterRiskByRules` 用同一套 `extractFetchUrls` 取主机；任一主机取不出来、`hosts` 为空、或 `hasOpaqueFetch` 为真时保持原判，不放行；`ruleSpecsFor` 的 host 规则也只从真实 fetch 段提取。

## 实施步骤

1. 按上述位置改代码，导出 `extractFetchUrls` 供测试。
2. `test.mjs` 增回归用例：heredoc 文档写入、`grep -o 'https://...'`、真实 `curl "http://..."`、`sudo curl`、`bash -c "curl ..."`；同命令内“已放行主机 + 占位 URL / 同段动态参数”必须保持原判（不静默），只有能证明每条会执行的 fetch 都落在白名单里才放行。
3. `npm test` 全绿后，回放本次真实命令（两类）确认不再产生 risk。
4. 同步 README/README.en 风险段落一句边界说明；`STATUS.md` 记一条。
5. `./scripts/check.sh --repo dsh-context-guard`，逐仓提交推送。

## 验收

- `cd /home/zh/www/dsh-context-guard && npm test`
- 回放：文档写入命令与 `329a0f0e` 的 grep 模式命令，`analyzeCommand(...).risk === false`；`curl http://192.168.31.244:8095/` 在主机规则下 `filterRiskByRules(...).risk === false`；`curl http://evil.example/a` 仍 `risk === true`；`curl https://evil.example/a && curl -s "$ENDPOINT"` 在 evil.example 已放行时仍 `filterRiskByRules(...).risk === true`。
- `dsh web` 重启后同命令不再弹卡（需用户确认重启窗口）。
- `./scripts/check.sh --repo dsh-context-guard` 通过。

## 回滚

`git revert <提交号>`；仅代码回滚可 `git checkout eae8473 -- lib/risk.js lib/risk-allow.js test.mjs`。

## 改动记录

- 2026-11-22 14:35 建立计划，确认方案 D（分段识别 + 不可解析 URL 不阻塞放行）。
- 2026-11-22 14:36 完成 `lib/risk.js`/`lib/risk-allow.js` 改动与回归用例，`npm test` 通过。
- 2026-11-22 14:37 同步 README、README.en、STATUS，回放真实命令验证。
- 2026-11-22 15:20 交付前核验发现放行分支自身漏洞并修复：前缀/子 shell/路径包装（`/usr/bin/curl`、`env -i`、`timeout -s KILL 5`、`sudo -u`、`(curl …)`、`{ curl …; }`、`for … do curl`、`bash -lc`、`nice`/`stdbuf`/`busybox`、`$(…)` 命令替换）恢复识别；放行判定改用 `extractFetchUrls` 并对动态主机段保持原判；heredoc 正文剥离（引号内 `<<EOF` 不算）；`HTTP://` 计入明文；host 规则校验主机名非空。`test.mjs` 增回归断言覆盖上述形式，`npm test` 通过。
- 2026-11-22 15:40 二轮核验（fresh subagent 只看 diff）再发现 4 个 P1：白名单 URL 连带放行无字面链接的 fetch 段、authority 里的反引号地址漏报、执行型 heredoc（`bash <<EOF`、`… <<EOF | bash`）正文被误当文档剥掉、host 规则从 grep 模式串落库。修复：新增 `fetchSites`/`hasOpaqueFetch` 与 `eval`/`find -exec`/`env -S`/`chroot`/`ssh`/`watch`/`ksh`/`fish` 识别，heredoc 解析改为跨行引号状态 + 注释感知 + 精确终止符（仅 `<<-` 接受前导 tab）并保留执行型正文，`commandSubstitutions` 跳过注释，`extractUrls` 允许反引号，`ruleSpecsFor` 改用 `extractFetchUrls`；放行语义由「不可解析主机不参与」改为「不可证明就不放行」。`test.mjs` 同步回归断言，`npm test` 通过。
- 2026-11-22 15:43 自查（L1 真实入口回放）再补 3 处漏判：`ssh` 带取值选项（`-p 22`）时主机偏移算错、`find -exec sh -c '…'` 因 token 化丢引号导致取不到链接、未加引号终止符的 heredoc 正文里命令替换会真执行却被整段剥掉（改为只从正文提取 `$(…)`/反引号）。加 `requoteTokens`/`sshCommandOffset`，`fetchSites` 支持整段单 token 递归并加深度上限。`test.mjs` 增断言，`npm test` 通过。
- 2026-11-22 16:20 三轮核验（2 个 fresh subagent）按范围 C 修复：① 同一 fetch 段里字面链接 + 动态参数（`curl https://ok.example/ "$ENDPOINT"`）此前只按字面 URL 放行，改为按段标 `dynamic` 并让 `hasOpaqueFetch` 一并覆盖（`-H`/`-d`/`-o` 等取值选项里的 `$VAR` 不算）；② 执行型 heredoc 由 `| bash` 字面量改为结构化判定（`executesStdinCommand`：按段取命令头，覆盖 `dash`/`env bash`/`busybox sh`/`ssh host 'bash -s'`/`source /dev/stdin`，ssh/chroot 偏移复用同一套）；③ `<<-` 终止符带 CRLF 时不闭合导致后续命令被吞；④ `$((1 << n))`、裸 `((…))` 的移位运算符被当成 heredoc 起点；⑤ `ssh -- host …` 偏移差一、补 `-E/-B/-I/-P` 取值选项；⑥ `chroot --userspec/--groups` 与 `--` 之前硬编码偏移 2；⑦ 确认卡列出前 3 条未放行链接并标注总数，`ruleSpecsFor` 只给列出的链接下发 host 规则（新增 `MAX_LISTED_LINKS`、`risk.links`），删掉已被 `isAllowedHost('')` 覆盖的冗余判空。`test.mjs` 补 40 余条断言，`npm test` 通过。
- 2026-11-22 16:40 复核最终 diff 时发现同类静默放行仍在：`curl "$ENDPOINT"`、`wget -i urls.txt` 这类没有字面链接的 fetch，以及“字面链接全在白名单 + 动态参数”的命令，此前 `analyzeCommand` 直接返回 `risk=false`，审批环节根本不参与（README 早就写了「不静默放行」，行为与文档不一致）。新增 `hasUnverifiableFetch`（只算 curl/wget，`xdg-open "$f"` 打开本地文件不触发）与 `unverifiable-fetch` 原因；这类命令只能对整条命令「始终允许」，不写 host 规则。`test.mjs` 补 14 条断言（含 header/token/URL 路径里的 `$` 不误报、「始终允许」落成 command 规则）。
