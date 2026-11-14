# dsh-compaction-archive

DSH 插件：**自动压缩前**先落盘一份可读的上下文快照，**压缩后**把 DSH 自己生成的结构化摘要写成
`STATUS.md`，方便长任务或换会话后快速恢复目标、决定和改动。

> DSH 原生压缩只在会话日志里生成 `compaction/summary` checkpoint，不会写项目文件；
> 本插件只负责把这份已有摘要和压缩前快照落盘，不额外调用模型。

## 工作方式

| 事件 | 输出 |
|---|---|
| `compaction/start` | `STATUS.md`：标题、cwd、最近用户意图、最近工具调用 |
| `compaction/summary` | 用 DSH 的结构化摘要更新 `STATUS.md`，并另存一份带时间戳的历史文件 |

默认输出：

```text
${DSH_HOME:-$HOME/.dsh}/compaction-archive/<session-id>/STATUS.md
${DSH_HOME:-$HOME/.dsh}/compaction-archive/<session-id>/<UTC时间>-compaction.md
```

- 只有实际发生压缩的会话才会产生文件。
- 不改变压缩阈值，不替代 `@deepseek-ai/dsh-compaction-basic`。
- 写入失败只记 warning，不阻塞压缩。

## 安装

### 从插件市场 / npm（发布后）

```bash
dsh plugin --profile web add dsh-compaction-archive
```

在 DSH 插件管理器中安装 bundle，或在 profile 的 `cordis.patch.yml` 加入：

```yaml
- insert:
    - id: compaction-archive
      name: dsh-compaction-archive
```

### 本地 link 安装（开发）

```bash
dsh plugin --profile web add link:/home/zh/www/personalCloud/task/dsh-compaction-archive
```

然后把上面的 `insert` 写进 `~/.dsh/profiles/web/cordis.patch.yml`；
`superagent` profile 同理。

## 配置

当前无需配置。归档根目录跟随 `DSH_HOME`，也可在 profile patch 的插件行里传：

```yaml
- id: compaction-archive
  name: dsh-compaction-archive
  config:
    dir: /path/to/archive
```

实现读取 `config.dir`；未提供时使用 `${DSH_HOME:-$HOME/.dsh}/compaction-archive`。

## 验证

```bash
node task/dsh-compaction-archive/test.mjs
HOME=/home/zh /home/zh/opt/node24/bin/node \
  /home/zh/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile web --dump-config | grep -A2 compaction-archive
```

## 安全边界

- 只监听 `session/event`，不注册网络端口、不读凭据；
- 只写 `${DSH_HOME}/compaction-archive/` 下的 Markdown；
- 摘要内容来自 DSH 本地压缩结果，不额外上传。

## 发布

见 [`PUBLISHING.md`](PUBLISHING.md)。

## License

MIT
