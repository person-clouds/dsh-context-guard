# STATUS — dsh-context-guard

- 更新时间：2026-11-14
- 一句话：DSH 工具输出预算/落盘 + 压缩归档；后续补去重、指标、清理与 inspect.sh。
- 位置：`task/dsh-context-guard/`；已改名，待更新 profile link。

## 已完成

- [x] Host-only 插件：监听 `compaction/start` / `compaction/summary`；
- [x] 输出 `~/.dsh/compaction-archive/<session-id>/STATUS.md`（路径保持兼容） 与带时间戳历史文件；
- [x] 不额外调用模型，不改变压缩阈值；
- [x] 失败仅 warning，不阻塞压缩；
- [x] `test.mjs` 通过；
- [x] 发布规范化：`dsh.bundle.patch`、README、PUBLISHING、LICENSE、market 条目、`npm pack --dry-run` 通过；
- [x] 已更新 `doc/dsh-plugins.md` 与 `PROJECT_INDEX.md`；
- [x] `tools/post-execute` 输出预算：默认 3000，按命令类型放宽，完整输出落盘；
- [x] 写盘失败回退原始结果；
- [x] 去重缓存：session+tool+args，TTL 10 分钟；相同结果只回指针；变化结果只回行级 diff；从不跳过命令执行；
- [x] 指标：`context-guard/metrics/<session>.jsonl` + `STATUS.md` 汇总，token 按 `chars/4` 估算；
- [x] 清理：7 天保留、单会话 50MB/300 文件、全局 500MB，删除最旧文件，保留当前会话最近 3 个；
- [x] `scripts/inspect.sh`：overview/service/app/logs/git/ports/docker/http/report，只读、有界输出、可选 linuxops 只读子命令。

## 待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | 创建公开 GitHub 仓库 `person-clouds/dsh-context-guard` | 见 `PUBLISHING.md` |
| 2 | 发布 npm `dsh-context-guard@0.2.0` | 需 npm 登录 |
| 3 | 提交 awesome-dsh-plugin 市场条目 | 仓库满 1 天后 |

## 验证记录

| 时间 | 项 | 结果 |
|---|---|---|
| 2026-11-14 | `node test.mjs` | ok；压缩归档、预算裁剪、落盘、去重、diff、指标、清理、inspect.sh 语法/帮助均通过 |
| 2026-11-14 | `dsh --profile web --dump-config` | `compaction-archive` 已出现在组合树 |
| 2026-11-14 | `dsh --profile superagent --dump-config` | 同上 |
| 2026-11-14 | `npm pack --dry-run` | 5 files / 4.3 kB，通过 |
