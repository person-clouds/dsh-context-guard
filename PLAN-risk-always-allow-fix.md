---
implementation_status: done
created_at: 2026-11-20 20:30:00
updated_at: 2026-11-20 20:40:00
---

# PLAN：「始终允许」失败可见化与错误码取证

## 目标

点击「始终允许」失败时给出可见提示与可复制的错误码；超过 2 秒的保存改为后台提示，完成后再告知结果，避免审批卡长时间无反馈。

## 范围

- 只改点击处理与提示，不改放行规则解析、Host 路由与规则文件格式。
- B 阶段（是否改 token 形态）待本次拿到真实错误码后再定。

## 改动位置

- `dsh-context-guard/client.js`：`saveRiskRuleAndAllow`、新增 `showNotice`。
- `dsh-context-guard/test.mjs`：客户端失败路径与超时路径测试。
- `dsh-context-guard/README.md`、`README.en.md`、`STATUS.md`：行为说明与验证记录。

## 实施步骤

1. 保留 `POST /api/context-guard-risk-rule`；新增 2 秒慢提示与 15 秒硬超时（AbortController）。
2. 失败（reason 无 token / 网络错误 / 超时 / 非 2xx / `body.ok !== true`）统一写成
   `「始终允许」失败：<error>（HTTP <status>）`，同时 `console.error` 与页面右下角提示；提示 8 秒后隐藏。
3. 失败后重新抛错，共享审批卡复位，用户仍可点「允许一次」。
4. 测试：模拟 410 与网络异常，断言抛错文案与提示文本。

## 验收

- `npm test` 通过；
- 浏览器点击失败时可见错误码（如 `approval-rule-expired`）；
- `./scripts/check.sh --repo dsh-context-guard` 通过。

## 回滚

`git revert <commit>`；客户端恢复静默失败。

## 改动记录

- 2026-11-20 20:30 初稿：A 阶段（失败可见化 + 2 秒阈值提示）。
- 2026-11-20 20:40 完成 A：client.js 提示与超时、三条失败路径测试、README/README.en/STATUS 同步；`npm test` 与 `check.sh` 通过。
