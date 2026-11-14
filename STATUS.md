# STATUS — dsh-context-guard

- 更新时间：2026-11-14
- 一句话：DSH 压缩前落盘上下文快照，压缩后用 DSH 结构化摘要更新 `STATUS.md`。
- 位置：`task/dsh-context-guard/`；已改名，待更新 profile link。

## 已完成

- [x] Host-only 插件：监听 `compaction/start` / `compaction/summary`；
- [x] 输出 `~/.dsh/compaction-archive/<session-id>/STATUS.md`（路径保持兼容） 与带时间戳历史文件；
- [x] 不额外调用模型，不改变压缩阈值；
- [x] 失败仅 warning，不阻塞压缩；
- [x] `test.mjs` 通过；
- [x] 发布规范化：`dsh.bundle.patch`、README、PUBLISHING、LICENSE、market 条目、`npm pack --dry-run` 通过；
- [x] 已更新 `doc/dsh-plugins.md` 与 `PROJECT_INDEX.md`。

## 待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | 创建公开 GitHub 仓库 `person-clouds/dsh-context-guard` | 见 `PUBLISHING.md` |
| 2 | 发布 npm `dsh-context-guard@0.2.0` | 需 npm 登录 |
| 3 | 提交 awesome-dsh-plugin 市场条目 | 仓库满 1 天后 |

## 验证记录

| 时间 | 项 | 结果 |
|---|---|---|
| 2026-11-14 | `node test.mjs` | ok；压缩前快照与压缩后摘要均写入 |
| 2026-11-14 | `dsh --profile web --dump-config` | `compaction-archive` 已出现在组合树 |
| 2026-11-14 | `dsh --profile superagent --dump-config` | 同上 |
| 2026-11-14 | `npm pack --dry-run` | 5 files / 4.3 kB，通过 |
