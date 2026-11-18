# PLAN — 临时目录 rm 豁免与调用口径说明

## 目标

1. 当一条命令中的 `rm` 目标全部位于 `/tmp`、`/var/tmp`、`$TMPDIR` 内时，不再触发 `destructive-rm` 风险确认；其余情况保持原拦截。
2. 调用门禁文案明确为“bash 调用次数”，并附带当前 session step；门禁阈值和计数逻辑不变。

## 范围

- 代码：`/home/zh/www/dsh-context-guard/`
- 文件：`lib/risk.js`、`lib/turn-budget.js`、`index.js`、`test.mjs`、`README.md`、`README.en.md`
- 不加配置项，临时目录白名单硬编码为 `/tmp`、`/var/tmp`、`$TMPDIR` / `${TMPDIR}`。

## 改动位置与步骤

1. `lib/risk.js`：增加临时目录目标判断。
   - 仅普通 `rm` 可豁免；`xargs rm`、`find -delete`、`sudo rm`、命令替换/反引号不豁免。
   - 每个目标都必须在临时目录下；路径不能等于临时目录根本身，不能含 `..`、`*`、`?`、`[`。
   - 全部目标通过才跳过 `destructive-rm`；混合非临时目标仍告警。
   - `repo-delete`、`find-delete` 等其他规则不变。
2. `lib/turn-budget.js`：记录当前 session step；`checkCall()` 返回 `step`，不改变 20/40 阈值和计数方式。
3. `index.js`：监听 `session/event` 的 `step/start` 更新 step；`ask`/`deny` 文案改为“本轮 bash 调用 N 次（session step M）”，明确两者不是同一口径。
4. `test.mjs`：补临时目录放行和仍拦截用例；补门禁文案包含 bash 调用次数与 step 的断言。
5. README 中英文同步一句行为说明。

## 验收

- `npm test` 通过。
- `rm -rf /tmp/foo`、`rm -rf /var/tmp/foo`、`rm -rf "$TMPDIR/foo"` 不触发风险 `ask`。
- `rm -rf /tmp`、`rm -rf /tmp/*`、`rm -rf /tmp/../home/zh/foo`、`rm -rf /tmp/foo /home/zh/foo` 仍触发 `ask`。
- 第 21 次 bash 仍 `ask`、第 40 次仍 `deny`；文案同时显示 bash 调用次数和 session step。

## 回滚

- 单次提交内完成；回滚直接 `git revert <commit>`，无配置迁移或数据格式变更。
