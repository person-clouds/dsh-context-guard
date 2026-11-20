---
implementation_status: done
created_at: 2026-11-20 20:30:00
updated_at: 2026-11-20 21:12:00
---

# PLAN：「始终允许」卡死修复与失败可见化

## 目标

消除风险审批「始终允许」点击后无反馈的问题：失败必须带错误码可见；在拿到真实失败原因后决定放行凭据的持久化形态。

## 已确认事实

- Host 路由与落盘正常：真实 token `POST /api/context-guard-risk-rule` 返回 200，规则写入 `context-guard/risk-allow.json`。
- 浏览器加载的就是当前 `client.js`；成功路径实机通过：规则落盘 → 审批卡关闭 → 命令执行。
- 失败路径（拦截接口返回 410）实机可见：右下角提示 + 控制台同文，审批卡保持可回答。
- 默认 preset「完全权限」为 `approval: never`，不会弹审批；触发风险卡必须切到「工作区内修改」（`approval: ask`）。
- 用户报告的原始「点击卡死」未在 A 阶段前复现；A 之后仍未拿到用户侧真实错误码，B 按最可能的 token 失效路径（插件重载/超过 10 分钟）实现，未改既有字段语义。

## 范围

- 已完成 A：`client.js` 失败可见化、2 秒阈值提示、15 秒硬超时、失败不误答、测试与文档。
- 已完成 B：待放行项短期落盘（`risk-pending.json`，TTL 10 分钟）+ 按审批 `callId` 兜底取回；协议仅新增可选字段，旧客户端不受影响。
- 不做：按风险代码全量放行、长期保存待放行命令、改变「始终允许」的窄规则泛化策略。

## 改动位置

- `dsh-context-guard/client.js`：`saveRiskRuleAndAllow`、`showNotice`、`riskRuleFailure`。
- `dsh-context-guard/test.mjs`：客户端失败路径、待放行项落盘/过期、`callId` 兜底测试。
- `dsh-context-guard/lib/risk-allow.js`：`PendingRiskRules` 增加可选 `file` 落盘、TTL 清理与 `takeByCallId`。
- `dsh-context-guard/index.js`：路由先 `await pending.load()`，token 失效时按 `callId` 取回；`pre-execute` 写入 `exec.callId`。
- `README.md`、`README.en.md`、`STATUS.md`：行为说明、验证记录与状态。

## 实施步骤

### A（已完成）

1. 失败（缺 token / 网络错误 / 超时 / 非 2xx / `body.ok !== true`）统一显示
   `「始终允许」失败：<error>（HTTP <status>）`，并写浏览器控制台。
2. ≤2 秒直接等待；>2 秒先提示「仍在保存」，完成后提示结果；15 秒无响应按超时处理。
3. 失败后抛错让审批卡复位，仍可点「允许一次」；成功后 `answer('allowed-once')`。
4. 测试覆盖 410、网络错误、缺 token 三条路径；实机验证成功与失败两条路径。

### B（已完成）

1. 待放行项在 `risk-allow.json` 同目录短期落盘为 `risk-pending.json`（0600、目录 0700、最多 100 条、TTL 10 分钟）；插件重载后新实例 `load()` 合并未过期项，同一 token 仍可消费。
2. POST 体保留 `token` 并新增可选 `callId`；Host 先按 token 取回，失败再按 `callId` 兜底。两者都找不到才返回 `approval-rule-expired`（410）。
3. 落盘失败只 warning，不影响本次审批：内存态仍可完成「始终允许」。
4. 未取得真实错误码，因此未改 404/`no-rule-parsed` 分支；若后续仍报其它错误码，按原 B 决策条件继续。
5. 规则仍只按安全类泛化，不按风险代码全量放行；待放行项不参与匹配，只在用户确认后生成规则。

## 验收

- `npm test` 通过（含落盘跨实例、TTL 过期、`callId` 兜底、客户端失败提示）；
- `./scripts/check.sh --repo dsh-context-guard` 通过；
- 实机「工作区内修改」下点「始终允许」能落盘并继续执行（A 阶段已验证成功路径）；
- 失败时用户能看到具体错误码，审批卡不卡死。

## 回滚

`git revert <commit>`；A 回滚后恢复静默失败，B 回滚后恢复内存 token（会重新出现插件重载后 410）。

## 改动记录

- 2026-11-20 20:30 初稿：A 阶段（失败可见化 + 2 秒阈值提示）。
- 2026-11-20 20:40 完成 A：客户端提示与超时、三条失败路径测试、README/README.en/STATUS 同步。
- 2026-11-20 20:59 实机验证：成功路径 200 且规则落盘；注入 410 时提示与卡片复位均正常。
- 2026-11-20 21:05 扩为全任务计划：补已确认事实、B 的决策条件与默认 preset 前提。
- 2026-11-20 21:12 完成 B：待放行项落盘与 TTL 清理、`callId` 兜底、路由先加载落盘项、客户端带 `callId`；测试与文档同步。未取得真实错误码，按最可能的 token 失效路径实现。
