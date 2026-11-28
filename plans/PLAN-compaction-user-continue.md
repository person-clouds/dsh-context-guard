---
implementation_status: done
created_at: 2026-11-23 13:13:09
updated_at: 2026-11-23 13:49:00
---

# PLAN：压缩不断服务、压缩后不连环压缩、步数提醒合并

> 压缩口径综合见 [PLAN-ai-flow-six.md](/home/zh/www/personalCloud/plans/doc/PLAN-ai-flow-six.md) R3：压缩只提醒、不作拒绝依据，0.20/0.03 阈值保留。

## 目标

1. **压缩永不 deny**：`compaction/summary` 之后工具始终可用，最多留 1 条提醒；限制只做辅助。
2. **压缩后不再连环压缩**：压缩完成到下次压缩之间留出 ≥10w token 余量（现状 2.4w），避免「刚压完又压」在几分钟内烧掉 2 次额度把会话锁死。
3. **提醒合并**：每轮最多 1 条提醒、1 条拒绝；提醒文案汇总会话步数 / 本轮步数 / 命令调用 / 压缩次数；会话硬线可由真人回复「继续」恢复 +30 步。

## 事实（2026-11-23 实测 `session-4a4b59bb`）

- 窗口 1,048,576（`request/context` seq 16），`maxTokens` 256,000，`headroomTokens` 65,536；阈值 83,886 = `floor(1M×0.08)`，压缩前实测 83,878 / 84,113。
- 压缩后整包占用：seq 266 = 60,101，seq 378 = 59,989；距阈值只剩 ~24k，约 5 分钟二次压缩，第 2 次后全拒（服务挂死）。
- 「2w」是压缩后保留的对话量（`shadowedTokenCount` 22,919），不是触发线；256k 是 `maxTokens` 输出预留，不是窗口（726 个会话日志中 `contextWindow` 只有 1,048,576 / 1,000,000）。
- 阈值来自内置 agent preset 的 `0.08/0.02`，home patch 无 `compaction-basic` 条目；`scripts/apply-compaction.sh` 负责把覆盖块写进 home patch，取值硬编码在 `:108-109`，校验断言在 `:331-334`。
- 门禁现状：`lib/turn-budget.js:11-12` 压缩 1/2；`:198-208` 回合 30/40、会话 60/90；`:211-244` 压缩第 2 次 deny；`index.js:857-873` 压缩 deny 优先短路；`index.js:950` 仅命令工具按 30/120 计调用；`index.js:59-61` 已有 `userText`，`session/event` 未处理 `user/message`。
- 文档 `docs/context-compaction.md:140-141` 仍按 1e6 算阈值 80,000，需改为 1,048,576 → 83,886。

## 范围

- 改 `dsh-context-guard`：`lib/turn-budget.js`、`index.js`、`test.mjs`、`scripts/apply-compaction.sh` + 5 份文档。
- 部署：用户执行 `scripts/apply-compaction.sh apply` 写 home patch（`~/.dsh` 在 AI 沙箱外），再重启 `dsh web`。
- 非目标：不改 DSH 核心与 compaction-basic 源码、不改 `headroomTokens`、不放开工具白名单、不自动发消息。

## 改动位置

| 文件 | 改动 |
|---|---|
| `lib/turn-budget.js` | ① `checkCompaction` 去掉 deny：任何次数都 `allow`，≥hard 附 `warning: true` 供 index 打 warn（不再有「0 关闭」语义，避免 `positiveInt` 把 0 当缺省）；② `noteCompaction` 记 `lastCompactionSeq`；③ 新增 `state.askTurnShown`（`startTurn` 重置），`checkStep` 与 `checkCall` 共用，每轮只放一条 ask；④ 新增 `resumeByUser()`：会话硬线 +30 步、可多次，未到硬线不生效 |
| `index.js` | ① `stepBudget` 增 `continueResume`（默认 true）、`continueGraceSessionSteps`（30）、`continueKeywords`；② `session/event` 处理 `user/message`：`source.kind === 'user'` 且命中继续词才 `resumeByUser`；③ 合并提醒为一条文案（会话步数 / 本轮步数 / 命令调用 / 压缩次数）；④ 删掉压缩 deny 分支，只在第 1 次与 ≥2 次各 warn 一次；⑤ 会话 deny 文案加「回复「继续」可恢复 +30 步」 |
| `scripts/apply-compaction.sh` | 注入值 `thresholdRatio 0.08 → 0.20`、`retainRatio 0.02 → 0.03`；`check --deep` 断言同步 |
| `test.mjs` | 压缩 2/3/10 次均 allow；每轮 ask 只 1 条；`user/message` 解除会话 deny、`goal`/`team-message` 不解除；`continueResume:false` 关闭 |
| `README.md`、`README.en.md`、`SPEC.md`、`STATUS.md`、`docs/context-compaction.md` | 阈值改 0.20/0.03，按 1,048,576 重算（209,715 / 余量 ≈15w）；删除「第 2 次起拒绝」表述，改为「压缩只提醒不拒绝，硬线可回复继续恢复」 |

## 实施步骤

1. `apply-compaction.sh`：改注入值，`dry-run` 确认 4 个 preset 都变 `0.20/0.03`；交付用户在宿主执行 `apply` 并重启。
2. `turn-budget.js`：压缩永不 deny、每轮单条 ask、`resumeByUser`。
3. `index.js`：`user/message` 恢复、合并文案、deny 文案与 warn 频率。
4. `test.mjs` 补用例，`npm test` 全绿。
5. 同步 5 份文档；`./scripts/check.sh --repo dsh-context-guard`。
6. 实机复核：新会话压缩后工具不拒；压缩后连续用 5w token 内不再压；会话 90 步后说「继续」恢复。

## 验收

- 单测：压缩 2 次后 `checkCompaction` 返回 `allow`；累计 10 次仍 `allow`；同一轮 ask 计数 = 1；会话 90 步 deny → `resumeByUser` → allow → 120 步再 deny；非 user kind 不恢复。
- 配置：`scripts/apply-compaction.sh check --deep` PASS，`--dump-config` 中 `compaction-basic` 均为 `thresholdRatio: 0.20`。
- 余量复算：阈值 = `floor(1,048,576×0.20)` = **209,715**（< 727,040 压力预算）；压缩后实测 60,101，**余量 149,614 ≈ 现状 24k 的 6.2 倍**。
- 实机：压缩后连续工作 5w token 不再触发压缩；已有 2 次以上压缩的会话工具不被拒。
- `./scripts/check.sh --repo dsh-context-guard` PASS。

## 回滚

- 配置：改回 `0.08/0.02` 后重跑 `scripts/apply-compaction.sh apply`，或 `git revert` 脚本改动后重放。
- 代码：`git revert` 本次提交即恢复「压缩第 2 次起 deny」；`stepBudget.continueResume: false` 可只关「继续恢复」。

## 风险与遗留

1. 0.20 让单次摘要输入最大 21w token，压缩成本约 2.5 倍，但压缩次数大幅下降；若成本敏感可退到 0.15（阈值 157,286、余量 ≈9.7w）。
2. 压缩后余量取决于固定开销（约 3.6w）+ 摘要长度；system prompt 更大的会话余量会下降，需按 `--dump-config` 复算。
3. `user/message` 与 `tools/pre-execute` 的事件顺序、`source.kind` 取值需实机确认，标「待验证」。
4. `retainRatio 0.02 → 0.03` 会让压缩后保留对话略多；若发现摘要质量下降，可单独回退这一项。

## 改动记录

- 2026-11-23 13:13 新建 v1：仅「压缩/会话硬线支持用户显式继续」。
- 2026-11-23 13:42 重写 v2：合并用户三点要求（压缩不 deny、压缩后留足余量、提醒合并），依据 §事实 的会话实测；v1 的「继续恢复」并入本计划。
- 2026-11-23 13:49 实施完成：`turn-budget.js`（压缩永不 deny / 每轮单 ask / `resumeByUser` / `summary`）、`index.js`（user/message 恢复、合并文案、warn 频率、deny 文案）、`apply-compaction.sh`（`0.20/0.03` 与 `--deep` 断言）、`test.mjs`（新增 6 组用例）、5 份文档同步；`npm test` ok。部署仍需用户在宿主 `apply` + 重启 `dsh web`。
