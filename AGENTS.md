---
audience: ai
status: current
---

# AGENTS.md

> 本仓是独立的 DSH 插件仓库「dsh-context-guard」。跨仓规则以 [`/home/zh/www/AGENTS.md`](../AGENTS.md) 为准；本文件只补充本仓规则。

## 0. 阅读顺序

1. 本文件；
2. [`SPEC.md`](SPEC.md)：七项能力、接口、非目标与验收命令；
3. [`README.md`](README.md) / [`README.en.md`](README.en.md)：配置项与运维脚本；
4. [`STATUS.md`](STATUS.md)、[`PUBLISHING.md`](PUBLISHING.md)；
5. 进行中的 `PLAN-*.md`。

## 1. 硬约束

- 中文；英文版 `README.en.md` 同步维护。
- 最小变更：只改被要求的内容，不顺手重构。
- 不改写工具参数（DSH 不支持在 `tools/pre-execute` 中改写参数），只能拒绝并给出有界替代命令。
- 写盘失败时回退原始结果，不丢证据。
- 不读取或上传用户凭据；不跨 profile 自动安装。
- 提交信息用 `type(scope): 摘要`；每个提交只含本任务文件。

## 2. 改代码后必须验证

```bash
npm test
```

宿主机迁移：`dsh-context-guard/scripts/apply-profile.sh`（在 `/home/zh/www` 下执行），之后用
`dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"` 核对。

## 3. 文档与提交门禁

- 本仓受检 Markdown 必须有 `audience`/`status` frontmatter（见 `docs-policy.json`）。
- 提交前在 `/home/zh/www` 执行 `./scripts/check.sh --repo dsh-context-guard`，失败不得提交。
- 改动同步 `README.md`、`README.en.md`、`STATUS.md`。

## 4. 发布

npm 包名 `@fenghoer/dsh-context-guard`；构建与发布流程见 [`PUBLISHING.md`](PUBLISHING.md)。
