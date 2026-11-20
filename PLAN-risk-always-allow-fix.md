---
implementation_status: in_progress
created_at: 2026-11-20 20:30:00
updated_at: 2026-11-20 21:05:00
---

# PLAN：「始终允许」卡死修复与失败可见化

## 目标

消除风险审批「始终允许」点击后无反馈的问题：失败必须带错误码可见；在拿到真实失败原因后决定放行凭据的持久化形态。

## 已确认事实

- Host 路由与落盘正常：真实 token `POST /api/context-guard-risk-rule` 返回 200，规则写入 `context-guard/risk-allow.json`。
- 浏览器加载的就是当前 `client.js`；成功路径实机通过：规则落盘 → 审批卡关闭 → 命令执行。
- 失败路径（拦截接口返回 410）实机可见：右下角提示 + 控制台同文，审批卡保持可回答。
- 默认 preset「完全权限」为 `approval: never`，不会弹审批；触发风险卡必须切到「工作区内修改」（`approval: ask`）。
- 用户报告的原始「点击卡死」未在 A 阶段前复现，仍需真实错误码定位。

## 范围

- 已完成 A：`client.js` 失败可见化、2 秒阈值提示、15 秒硬超时、失败不误答、测试与文档。
- 待定 B：放行凭据持久化 / 按 `callId` 查找；仅依据真实错误码选型，不预先改协议。

## 改动位置

- `dsh-context-guard/client.js`：`saveRiskRuleAndAllow`、`showNotice`、`riskRuleFailure`。
- `dsh-context-guard/test.mjs`：客户端失败路径测试。
- `README.md`、`README.en.md`、`STATUS.md`：行为说明、验证记录与状态。
- B 阶段（未开始）预计改 `lib/risk-allow.js` 与 `index.js` 的 token 存储与查找。

## 实施步骤

### A（已完成）

1. 失败（缺 token / 网络错误 / 超时 / 非 2xx / `body.ok !== true`）统一显示
   `「始终允许」失败：<error>（HTTP <status>）`，并写浏览器控制台。
2. ≤2 秒直接等待；>2 秒先提示「仍在保存」，完成后提示结果；15 秒无响应按超时处理。
3. 失败后抛错让审批卡复位，仍可点「允许一次」；成功后 `answer('allowed-once')`。
4. 测试覆盖 410、网络错误、缺 token 三条路径；实机验证成功与失败两条路径。

### B（待真实错误码）

1. 若为 `approval-rule-expired`（410）：改为按审批 `callId` 查找待放行命令，并把待放行项短期持久化，避免插件重载/超时失效。
2. 若为网络错误或 404：核对反向代理与 Host 插件加载状态，必要时在 Host 侧补 `warn` 日志（含 pending 数量）。
3. 若为 `no-rule-parsed`（400）：放开命令长度上限或在提示里给出可执行替代。
4. 任何 B 改动都必须保持「规则只按安全类泛化，不按风险代码全量放行」的约束。

## 验收

- `npm test` 通过；`./scripts/check.sh --repo dsh-context-guard` 通过；
- 实机「工作区内修改」下点「始终允许」能落盘并继续执行；
- 失败时用户能看到具体错误码，审批卡不卡死。

## 回滚

`git revert <commit>`；A 回滚后恢复静默失败，B 回滚后恢复内存 token。

## 改动记录

- 2026-11-20 20:30 初稿：A 阶段（失败可见化 + 2 秒阈值提示）。
- 2026-11-20 20:40 完成 A：客户端提示与超时、三条失败路径测试、README/README.en/STATUS 同步。
- 2026-11-20 20:59 实机验证：成功路径 200 且规则落盘；注入 410 时提示与卡片复位均正常。
- 2026-11-20 21:05 扩为全任务计划：补已确认事实、B 的决策条件与默认 preset 前提。
