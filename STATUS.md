# STATUS — dsh-context-guard

- 更新时间：2026-11-14
- 一句话：DSH 工具输出预算/落盘、去重、风险命令确认、只读诊断、压缩归档与指标。
- 位置：`task/dsh-context-guard/`；代码已完成，待宿主机执行 `scripts/apply-profile.sh` 迁移 profile。

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
- [x] `scripts/inspect.sh`：overview/service/app/logs/git/ports/docker/http/report，只读、有界输出、可选 linuxops 只读子命令；
- [x] `tools/pre-execute` 风险命令警示：删除/仓库删除、git 强推/重置、下载执行、未知链接、关机停服、容器/数据库删除、提权等返回 `ask` 让用户确认；不覆盖已有 deny/cancel/ask。

## 待办

| # | 事项 | 说明 |
|---|---|---|
| 1 | ~~创建公开 GitHub 仓库 `person-clouds/dsh-context-guard`~~ | 已创建：https://github.com/person-clouds/dsh-context-guard |
| 2 | 发布 npm `dsh-context-guard@0.3.0` | 需 npm 登录 |
| 3 | 提交 awesome-dsh-plugin 市场条目 | 仓库满 1 天后 |
| 4 | 宿主机执行 `scripts/apply-profile.sh` 并重启 web/superagent | 沙箱对 `~/.dsh` 只读 |
| 5 | 用真实长输出验证 `maxOutputChars` 与落盘完整性 | 需重启 DSH |

## 验证记录

| 时间 | 项 | 结果 |
|---|---|---|
| 2026-11-14 | `node test.mjs` | ok；压缩归档、预算裁剪、落盘、去重、diff、指标、清理、风险命令识别与 `ask` 门禁、inspect.sh 语法/帮助均通过 |
| 2026-11-14 | `dsh --profile web --dump-config` | `compaction-archive` 已出现在组合树 |
| 2026-11-14 | `dsh --profile superagent --dump-config` | 同上 |
| 2026-11-14 | `npm pack --dry-run --cache /tmp/npm-cache` | 14 files / 17.5 kB，通过 |
| 2026-11-14 | `scripts/apply-profile.sh` 临时 HOME 连跑两次 | 迁移正确且无重复条目 |
