---
implementation_status: in_progress
created_at: 2026-11-22 23:12:00
updated_at: 2026-11-22 23:13:00
---

# PLAN：D 会话预算硬拦

## 目标

给标题以 `D：` / `TODO D：` 开头的排查会话加单轮预算：第 25 次 `bash` 提醒、第 40 次硬拒，遏制「根因已明仍继续取证」。只改 profile 配置，不动插件代码。

## 范围

- 改 `dsh-context-guard/scripts/apply-profile.sh`：幂等注入 `sessionBudgets`（D 规则 + 默认 V 规则）。
- 同步 `README.md` / `README.en.md` / `STATUS.md`。
- 生效方式：用户在宿主执行脚本后重启 `dsh web`；工作区不改 `~/.dsh`。
- 非目标：不扩计数口径（文件工具、`web_fetch`/`web_search` 仍不计），不改插件默认值。

## 改动位置

| 文件 | 改动 |
|---|---|
| `scripts/apply-profile.sh` | 新增 1d 步注入 `sessionBudgets`；1c 旧阈值迁移收窄到 context-guard 块，避免把 web 已调的 40/80 改成 40/160 |
| `README.md` / `README.en.md` | 核验态一节说明 D 规则、配置整体替换默认须同时保留 V 规则 |
| `STATUS.md` | 能力清单与验证记录各一条 |

## 实施步骤

1. `apply-profile.sh`：在 context-guard 配置块内检测不到 `sessionBudgets:` 时，于 `config:` 后插入两条规则：
   - `D[：:]`：`maxCallsPerTurn: 25`、`hardMaxCallsPerTurn: 40`，不设 `denyTools`（D 会话要写计划）。
   - `V[：:]`：沿用插件默认的 25/40/20000 + `denyTools` + `denyCommands`（配置整体替换默认，缺这条会丢核验态）。
2. 1c 迁移只在块内出现 `maxCallsPerTurn: 20` 时生效，其余保留。
3. 文档三处同步。
4. 验证：`bash -n`、fixture 跑脚本比对、`npm test`、`./scripts/check.sh --repo dsh-context-guard --changed`。
5. 用户执行 `bash scripts/apply-profile.sh` 后重启 `dsh web`，用 `dsh --profile web --dump-config | rg -A12 sessionBudgets` 复核。

## 验收

- `bash -n scripts/apply-profile.sh` 退出 0；fixture 产物含两条 `sessionBudgets`，且除新增段外无差异。
- `npm test` ok；`check.sh --repo dsh-context-guard --changed` 退出 0。
- 重启后 dump-config 命中 `D[：:]` 与 25/40；新开 `D：` 会话第 25 次 bash 弹提醒、第 40 次硬拒，`V：` 会话行为不变。
- 回滚：删 profile 中 `sessionBudgets` 段并重启，或 `git revert` 本计划提交。

## 遗留

1. 计数仍只含 `bash` / `persistent-bash` / `terminal-bash`；文件读取与 `web_fetch` 刷次数抓不住，需代码级 `countTools`，另立计划。
2. 60 秒审批超时、2 轮修订、压缩后重复读无法硬拦，仍靠 `agent-action.md` §5 软规则。

## 改动记录

- 2026-11-22 23:12 新建：按 PLAN-diagnosis-efficiency 遗留 1 拆分，范围收窄为配置级 D：25/40。
- 2026-11-22 23:13 实施：脚本 1c 收窄 + 1d 注入；fixture 实跑、`matchBudget` 契约、`npm test`、`check.sh` 均通过。待用户执行脚本并重启 `dsh web` 后复核生效。
