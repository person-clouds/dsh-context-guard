# PLAN: 硬上限后自动填入「继续」

## 目标

bash 调用达到 `hardMaxCallsPerTurn`（默认 40）被拒后，Web 输入框为空时自动写入 `继续`（无换行），用户按 Enter 即可继续。

## 范围

- 仅 Web；Desktop/TUI 静默降级为原始拒绝文案。
- 仅当输入框为空时写入；不覆盖、不追加、不自动发送。
- 同一 session 最多 3 次，同一 turn 最多 1 次。

## 改动位置

- `index.js`：硬上限 deny reason 追加 `context-guard:hard-limit-draft` 标记。
- `lib/continue-draft.js`：共享标记、`继续` 文本、每 session/turn 预算。
- `client.js`：Web 客户端入口，订阅当前 session `tool/result`，空输入框时调用 `inputActions.setDraft('继续')`。
- `package.json`：bump 0.4.0，增加 `./client` 导出与 `dsh.client.platform = web`。
- `test.mjs`、`README.md`、`README.en.md`。

## 实施步骤

1. 服务端 deny 原因加唯一标记。
2. 注册 `conversation.input.dock` 客户端座席，使用 `useInput` 读空态、`inputActions.setDraft` 写入。
3. 客户端按带标记的 `tool/result.data.turn` 做每 turn/每 session 限流。
4. 补测试与文档，运行 `npm test`。

## 验收

- 第 40 次 bash 被拒后，Web 空输入框出现 `继续`，无换行、不自动发送。
- 输入框已有内容时不写入。
- 同 session 第 4 次硬上限不再写入；同 turn 重复拒绝只写 1 次。
- Desktop/TUI 行为不变，仍只显示原拒绝文案。

## 回滚

移除 `client.js` 与 `package.json` 的 `dsh.client` 声明即可恢复纯服务端行为；服务端标记无副作用。
