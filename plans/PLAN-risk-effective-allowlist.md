---
implementation_status: in_progress
created_at: 2026-11-22 20:57:00
updated_at: 2026-11-22 21:33:00
---

# PLAN：已放行主机不再重复进入风险卡片与规则

## 目标

修复风险审批卡「同一个网址又问一次、又存一遍」：

- 现状：已保存的 host 规则只在 `filterRiskByRules` 的整条放行判定里使用，`analyzeCommand` 生成卡片和 `risk.links` 时只认静态白名单。同一命令同时访问「已放行主机 + 新主机」时，整条风险不消失，已放行主机继续出现在卡片上；保存路由又用静态白名单重新分析，把已放行主机重复写进规则（`lastUsedAt` 被更新）。
- 目标行为：卡片只列仍未放行/新出现的主机；「始终允许」只为这些主机写规则；已放行主机不重复出现、不重复落库。
- 安全边界不变：新主机仍必须确认；`curl "$ENDPOINT"`、`wget -i urls.txt` 等无法证明目标的 fetch 仍 `ask`；高危原因、构建产物与精确命令规则语义不变。

现场依据（2026-11-22 20:55 核对，仓库 `main`）：

- 会话 `session-91cbcb67-bae7-4425-bdbe-e8966eaa8766` 中，20:42:36 已保存 `registry.ollama.ai`，20:42:44 下一条命令同时访问 `registry.ollama.ai` 与新的 `ollama.com`，卡片仍列出两者；20:43:02 的第二次「始终允许」又把 `registry.ollama.ai` 的 `lastUsedAt` 更新了一遍。
- 用仓库代码回放：仅保留 `registry.ollama.ai` 规则时，第二条命令仍 `risk=true`，`links` 含两个主机；两条规则都在时，同命令 `risk=false`。说明匹配与持久化正常，问题在询问范围和落库范围。

## 范围

- 改动：`index.js`、`lib/risk-allow.js`、`test.mjs`、`README.md`、`README.en.md`、`STATUS.md`、`SPEC.md` 第 6 项。
- 不改：`lib/risk.js` 的风险判定与取链逻辑；`~/.dsh/context-guard/risk-allow.json` 的格式、内容与已有规则；`PendingRiskRules` 持久化格式；`MAX_RULES`、`MAX_LISTED_LINKS`。
- 不放宽：不因「命令里已有放行主机」就整条自动放行；不新增通配或按域名后缀匹配。
- `PROJECT_INDEX.md`：本次不新增仓库/入口，其 dsh-context-guard 条目只登记 `SPEC.md`/`README.md`，核验无变化则不改。
- 版本：`0.5.0` 尚未发布，随 `0.5.0` 交付，不单独 bump。

## 改动位置

行号按 20:57 现状，实施时以函数和代码块为准。

1. `lib/risk-allow.js`：新增并导出 `effectiveAllowHosts(allowHosts, store)`。语义：`allowHosts` 非空则用配置值，否则用 `DEFAULT_ALLOW_HOSTS`；再与 `store.allowedHosts()` 去重合并。规则库未加载或没有 host 规则时原样返回基名单。
2. `index.js:781-786`（`tools/pre-execute` 风险块）：先 `analyzeCommand` 得到初判；初判有风险且 `riskAutoAllowEnabled` 为真时，`await riskRuleStore.load()`，算出有效名单；保存的 host 规则非空时用有效名单再 `analyzeCommand` 一次，然后统一用有效名单调用 `filterRiskByRules`。卡片文案与 `risk.links` 因此只含未放行主机，`pendingRiskRules.add` 的落库范围同步收窄。保留「命中已放行规则」日志（`allowedBy` 为空时按 `host` 记录）。
3. `index.js:638`（规则保存路由）：`risk` 改为可重新赋值；首次分析仍有风险时 `await store.load()`，用有效名单重新分析并 `filterRiskByRules`；之后保留 `command-no-longer-risky` 检查，`ruleSpecsFor` 使用过滤后的 risk。确保第二次「始终允许」只生成新主机 spec，不更新已放行主机规则。
4. `test.mjs`：补回归断言（见验收）；导入 `effectiveAllowHosts` 与 `DEFAULT_ALLOW_HOSTS`。
5. 文档：`README.md` 第 17 行风险段落补一句「已保存 host 规则参与后续链接检查，卡片只列仍未放行的主机，也只给这些主机写规则」；`README.en.md` 对应段落等价翻译；`STATUS.md` 在「始终允许」相关条目后补一条；`SPEC.md` 第 6 项补半句「询问与落库范围按有效白名单收窄」。

## 实施步骤

1. 新增 `effectiveAllowHosts` 并导出，不改 `analyzeCommand` 的公开语义。
2. 按第 2、3 条改 `index.js` 两处调用；规则加载失败时保持现状（记录 warning 后继续询问，不放行）。
3. 补 `test.mjs`：
   - `effectiveAllowHosts` 合并内置/配置与已保存 host 规则；配置非空时不被默认名单覆盖。
   - 会话第二条真实命令在只有 `registry.ollama.ai` 规则时：`risk.risk === true`，`risk.links` 只有 `https://ollama.com/library/qwen2.5/tags`，`unknown-link` 文案不含 `registry.ollama.ai`；`ruleSpecsFor` 只产出 `host:ollama.com`。
   - 路由：store 已有 `registry.ollama.ai`，待放行项为第二条命令，POST 允许后只新增 `ollama.com`，`registry.ollama.ai` 的 `reason`/`lastUsedAt` 不变。
   - 安全回归：`evil.example` 已放行时，`curl https://evil.example/a && curl "$ENDPOINT"` 仍 `risk=true`；两条 ollama 规则都在时，会话两条真实命令均 `risk=false`。
4. 同步 README/README.en/STATUS/SPEC。
5. 运行 `npm test` 与 `./scripts/check.sh --repo dsh-context-guard`；按单仓规则提交并推送。
6. 重启 `dsh web` 做实机复测（需用户确认重启窗口）；未复测前不把计划标记为 `done`。

## 验收

- `cd /home/zh/www/dsh-context-guard && npm test` 全绿，新增断言覆盖上述行为。
- `cd /home/zh/www && ./scripts/check.sh --repo dsh-context-guard` 通过。
- 回放会话第二条命令（仅 `registry.ollama.ai` 规则）：`analyzeCommand` 返回的非放行链接只有 `ollama.com`，`ruleSpecsFor` 只有 `host:ollama.com`；已放行主机不出现在 `links` 和 `unknown-link` 文案中。
- 路由回放：允许后 `risk-allow.json` 不新增 `registry.ollama.ai` 条目，其 `lastUsedAt` 不变；新增 `ollama.com`。
- 安全：不可证明 fetch 仍 `ask`；已放行主机 + 新主机时只对新主机询问；两条命令在规则齐全后均不再询问。
- 实机（待验证，需重启窗口）：复现「先允许 A，再执行 A+B」，卡片只显示 B；「始终允许」只新增 B；重跑 A+B 不再弹卡。
- 文档：README/README.en/STATUS/SPEC 已同步；`PROJECT_INDEX.md` 核验后无变化。

## 回滚

`git revert <提交号>`。本次不改规则文件、不做数据迁移，回滚只恢复旧的提示范围与落库范围，已保存规则继续有效；若需单独回代码，可 `git checkout <改动前提交> -- index.js lib/risk-allow.js test.mjs`，再另行回滚文档。

## 改动记录

- 2026-11-22 20:57 建立计划：定位为卡片与规则落库未使用已保存 host 规则，采用「配置/内置 + 已保存 host 合并为有效白名单」方案，待确认后实施。
- 2026-11-22 21:24 实施：新增 `effectiveAllowHosts`；`tools/pre-execute` 与规则保存路由按有效名单收窄；补 `test.mjs` 回归与 README/README.en/STATUS/SPEC；路由保留 command/artifact 规则再放行更新原因的既有语义，只对 host 维度做最终过滤。

## 核验记录

```text
轮次：1
对象：dsh-context-guard 有效名单变更（index.js、lib/risk-allow.js、test.mjs、README/README.en/STATUS/SPEC）
命令：cd dsh-context-guard && npm test；cd /home/zh/www && ./scripts/check.sh --repo dsh-context-guard
结论：不阻塞（P0/P1=0；F1/F4 为既有或低风险行为差异，F2 待重启实机复测）
遗留风险：运行中 dsh web 早于改动启动，实机表现未验；规则库按进程加载一次，跨进程新规则可见性不变
状态：已核验（实机待办）
开销：L1、L2 各 1 个只读 subagent
```
