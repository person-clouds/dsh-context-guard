---
audience: shared
status: current
---

# SPEC：dsh-context-guard

## 目标

把长工具输出挡在 DSH 上下文之外，同时保留完整证据；并提供单轮调用/输出门禁、命令形态拦截、风险确认、压缩归档与磁盘清理。

## 用户

- 长会话、频繁 `bash` 调用的 DSH 用户；
- 需要控制 token 成本、又不希望丢日志证据的开发者。

## 范围

1. 有界摘要：超预算输出完整落盘，上下文只留 head/tail、命令类型与路径；
2. 去重：同 session + tool + args 在 10 分钟内结果相同只回指针，变化只回行级 diff；
3. 单轮调用门禁：`maxCallsPerTurn`（默认 80，即第 80 次）返回一次 `ask`，达到 `hardMaxCallsPerTurn`（默认 160）拒绝；
4. 单轮累计输出门禁：超过 `maxTurnOutputChars`（默认 40000）后，后续超 800 字符结果只回摘要 + 路径；
5. 命令形态拦截：整文件 `cat`、无排除递归搜索、裸 `curl` API 默认 `deny`，可切 `ask`；替代命令与系统提示按当前工具面渲染文件工具（dsh-ops 的 `ops_*` 或官方 `read`/`grep`/`glob`）；
6. 风险命令确认；`rm` 白名单覆盖 `/tmp`、`/var/tmp`、`$TMPDIR`/`${TMPDIR}`、`~/opt`（含实际路径）下逐个列出的具体路径，不放行目录本身或通配；用户可把已解析的风险命令保存为精确命令、构建产物清理类（含产物目录内 `rm` 尾部通配与 `find ... -delete`）或链接主机窄规则，后续同类命令自动放行；压缩前后写 `STATUS.md`、指标统计、按保留期与配额清磁盘。
7. 压缩阈值配置自检：`scripts/apply-compaction.sh` 校验并在 DSH 升级后重放四个内置 preset 的 `compaction-basic` 阈值（`thresholdRatio`/`retainRatio`/`headroomTokens`），块与安装包不一致时报 FAIL。
8. 核验态与派单去重：会话标题命中 `sessionBudgets[].match`（默认 `^(?:TODO[：:]\s*)?V[：:]`）时切换预算（默认 25 次提醒 / 40 次硬拒 / 单轮 20000 字符），并 `deny` 该规则的 `denyTools`（默认 `write`、`edit`）与 `denyCommands`（装依赖、改仓库、重启服务）；派单类工具（`subagent`、`subagent_fork`、`workflow`）的 prompt 声明「快照：<sha>」时，同会话同指纹第二次派单直接 `deny`，prompt 含 `verify-again` 可放行。本插件不提供命令入口：`V：` / `V：计划：` 标题由外部客户端或手动改名写入，配套 `dsh-workflow-shortcuts` ≥ `0.4.0` 提供 `/V`（实施核验）与 `/VP`（计划核验），只装本插件时手动改名同样生效；默认 `sessionBudgets` 只是可被配置覆盖的示例规则，阈值只在 `lib/verify-mode.js` 维护；`/VP` 的计划核验提示词不写快照，同一计划可反复审、不参与派单去重（重复审查消耗核验预算）。

## 非目标

- 不改写工具参数（DSH 不支持在 `tools/pre-execute` 中改写参数），只拒绝并给出有界替代命令；
- 不跨 profile 自动安装；
- 不读取或上传用户凭据；
- 不替代 DSH 官方 `persistent-bash` 与 `tool-result-pruner`，只在其上叠加预算与门禁。

## 接口

- 插件入口 `index.js`，辅助模块在 `lib/`（`budget`、`dedup`、`metrics`、`risk`、`risk-allow`、`command-lint`、`archive`、`cleanup`、`turn-budget`、`verify-mode`、`continue-draft`）；文档提交门禁在 `index.js`；
- Client bundle：`client.js`（Web，pending 点与审批浮窗）；
- 配置键：`thresholdChars`、`headChars`、`tailChars`、`maxCallsPerTurn`、`hardMaxCallsPerTurn`、`maxTurnOutputChars`、`exhaustedOutputChars`、`commandLintMode`、`commandGuidanceEnabled`、`sessionBudgets`、`dispatchGuard`、`dispatchTools` 等，默认值见 `README.md`；
- 运维脚本：`scripts/apply-profile.sh`、`scripts/apply-compaction.sh`、`scripts/inspect.sh`、`scripts/install-linuxops.sh`。

## 运行方式

```bash
dsh plugin --profile web add link:/home/zh/www/dsh-context-guard
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

## 验收命令

```bash
npm test
```

## 约束

- 中文文档与注释；英文版同步维护 `README.en.md`；
- 写盘失败时回退原始结果，不丢证据；
- 发布流程见 `PUBLISHING.md`（npm 包名 `@fenghoer/dsh-context-guard`）。
