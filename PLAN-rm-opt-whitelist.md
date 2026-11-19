---
implementation_status: done
created_at: 2026-11-19 21:45:00
updated_at: 2026-11-19 22:10:00
---

# PLAN：rm 白名单补 `/tmp` 与 `~/opt`（仅具体路径）

## 目标

1. `rm` 的目标逐个列出、且全部位于 `/tmp`、`/var/tmp`、`$TMPDIR` 或 `~/opt` 下的具体文件/目录时，不再触发 `destructive-rm` 风险确认。
2. 不放行任何通配：`rm -rf /tmp/*`、`rm -rf ~/opt/*` 仍拦截，避免误删其他会话正在使用的文件。
3. 白名单只覆盖目录内容，不覆盖目录本身：`rm -rf /tmp`、`rm -rf ~/opt` 仍拦截。
4. 现有安全边界不变：`sudo`、`xargs`、命令替换/反引号、`..`、`?`/`[` 仍拦截；`find -delete`、`.git` 等规则不受影响。

## 范围

- 目标仓：`/home/zh/www/dsh-context-guard`
- 代码：`lib/risk.js`、`test.mjs`
- 文档：`README.md`、`README.en.md`、`STATUS.md`、`SPEC.md`
- 不新增配置项；白名单为 `/tmp`、`/var/tmp`、`$TMPDIR`（已有）与 `~/opt`（新增）。
- 不改 DSH 审批策略、不改插件其他门禁。

## 改动位置与步骤

1. `lib/risk.js`：在 `isSafeRmPath` 中增加家目录 `opt` 判断。
   - 先把 `~`、`$HOME`、`${HOME}` 展开为 `os.homedir()`，同时接受实际绝对路径（如 `/home/zh/opt/...`）。
   - 目标必须严格位于 `/home/<user>/opt/` 之下；等于 `~/opt` 本身不放行。
   - 沿用现有约束：含 `*`、`?`、`[`、`..` 的目标不放行；`sudo`、`doas`、`xargs`、命令替换、反引号不豁免；所有目标都通过才豁免。
2. `lib/risk.js`：`repo-delete` 规则不改。`rm -rf /tmp/*`、`rm -rf ~/opt/*` 继续被该规则拦截，符合“删除必须列出具体文件/目录”的要求。
3. `test.mjs`：
   - 保持 `rm -rf /tmp`、`rm -rf /tmp/*`、`rm -rf /tmp/../home/zh/foo` 为拦截。
   - 新增放行：`rm -rf /home/zh/opt/ollama-dl /home/zh/opt/aria2-test`、`rm -f /home/zh/opt/ollama-pull.log /home/zh/opt/ollama-pull2.log`、`rm ~/opt/foo`、`rm -f "$HOME/opt/foo.log"`。
   - 新增仍拦截：`rm -rf ~/opt`、`rm -rf ~/opt/*`、`rm -rf /home/zh/opt/*`、`rm -rf /home/zh/opt/../www`、`rm -rf /home/zh/opt-backup`、`sudo rm -rf /home/zh/opt/foo`、`rm -rf /home/zh/opt/foo /home/zh/www/foo`。
4. 文档同步：
   - `README.md`、`README.en.md`：风险命令一节的白名单列表加入 `~/opt`，明确“只放行逐个列出的具体路径，不放行通配，目录本身仍拦截”。
   - `STATUS.md`：完成项与验证记录各加一行。
   - `SPEC.md`：第 6 条“风险命令确认”补充该白名单与“禁用通配”的边界。

## 验收

- `npm test` 通过。
- 用 `node` 直接调用 `analyzeCommand` 核对：上列具体路径为 `risk: false`；通配、根目录、`..`、`sudo`、混合非白名单目标为 `risk: true`。
- 提交前在 `/home/zh/www` 执行 `./scripts/check.sh --repo dsh-context-guard`，失败不提交。

## 回滚

- 单次提交完成，`git revert <commit>` 即可；无配置/数据迁移。

## 改动记录

- 2026-11-19：按“只放行具体路径、不放行通配”修订计划，待确认后实施。
- 2026-11-19：`lib/risk.js` 增加 `expandHomePath` / `isHomeOptPath`，`isSafeRmPath` 合并 `~/opt` 白名单；`test.mjs` 新增 12 条放行/拦截断言；README 中英文、STATUS、SPEC 同步；`npm test` 通过。
