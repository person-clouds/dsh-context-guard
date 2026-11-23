---
audience: shared
status: current
---

# 安装与配置

> README 只保留安装命令与结论；本文件放 `apply-profile.sh` 的完整行为、全部配置示例和本机配置落点。

## 安装细节

从 GitHub Release（推荐，无需构建）、npm 或本地源码安装后，在 `/home/zh/www` 下执行宿主机迁移脚本并验证：

```bash
dsh-context-guard/scripts/apply-profile.sh
dsh --profile web --dump-config | grep -E "context-guard|maxOutputChars|tool-result-pruner"
```

`apply-profile.sh` 会：

- 把旧的 `compaction-archive` 插入项改成 `context-guard` 并修正为 scoped 包名；profile 缺包时提示 `dsh plugin --profile <p> add link:...` 并以非零退出；
- 删掉会报 `patch: entry "persistent-bash" not found` 的顶层旧块，改为覆盖 `minimal` preset 的完整 `config.plugins`，`maxOutputChars` 对齐 `65536`，顶层官方 `tool-result-pruner` 对齐 `6000/3000/1500`（DSH 升级后需重跑）；
- 写入 `D：` / `TODO D：` 核验规则（25/40，不设 `denyTools`）；
- 若 `node_modules/dsh-superagent` 是失效 link，提示用 `dsh plugin --profile <p> add link:/home/zh/www/dsh-superagent` 修复。

## 配置示例

```yaml
- insert:
    - id: context-guard
      name: '@fenghoer/dsh-context-guard'
      config:
        thresholdChars: 2000
        headChars: 1200
        tailChars: 800
        hardMaxChars: 6000
        maxCallsPerTurn: 80              # 第 80 次弹一次审批提醒
        hardMaxCallsPerTurn: 160         # 第 160 次硬拒绝并自动填「继续」
        maxTurnOutputChars: 40000
        exhaustedOutputChars: 800
        stepBudget:                      # 步数与压缩提醒；enabled: false 整体关闭
          enabled: true
          maxStepsPerTurn: 30            # 单回合提醒（与调用提醒每轮合并一条）
          hardMaxStepsPerTurn: 40        # 单回合硬拒绝
          maxStepsPerSession: 60         # 会话累计提醒
          hardMaxStepsPerSession: 90     # 会话累计硬拒绝，可回复「继续」+30
          maxCompactions: 1              # 压缩 1 次后仅 warning
          hardMaxCompactions: 2          # 压缩 2 次后仅 warning，从不拒绝
          continueResume: true           # 允许用户回复「继续」恢复会话硬线
          continueGraceSessionSteps: 30  # 每次恢复的步数
          # continueKeywords: [继续, continue]
        # sessionBudgets: 整体替换默认规则；见「核验态与派单去重」，默认 V: 会话 25/40/20000
        # dispatchGuard: {enabled: true, windowMs: 7200000, overrideToken: verify-again}
        commandLintEnabled: true
        commandLintMode: deny      # deny（默认，硬拦截）| ask（复杂流程确认）
        commandGuidanceEnabled: true
        dedupeMinChars: 800
        dedupTtlMs: 600000
        riskCheckEnabled: true
        riskAutoAllowEnabled: true
        # riskRuleFile: /home/zh/.dsh/context-guard/risk-allow.json
        docGuardEnabled: true
        docGuardWorkspaceRoot: /home/zh/www
        docGuardTimeoutMs: 30000
        # riskToolNames: [bash, persistent-bash, terminal-bash, web_fetch]
        # riskAllowHosts: [localhost, 127.0.0.1, github.com]
        retentionDays: 7
        maxSessionBytes: 52428800
        maxTotalBytes: 524288000
        maxFilesPerSession: 300
```

## 本机配置落点

本机（2026-11-22 起）按「完全权限 + 需要时弹审批」运行，靠两处配置配合，改完都要重启 `dsh-web`：

- **权限预设**：`~/.dsh/profiles/web/cordis.patch.yml` 里 `permission` 插件的 `full-access-ask` 预设（`sandbox: danger-full-access` + `approval: ask`），并用 `defaultPreset: full-access-ask` 设为新会话默认。原来的 `danger-full-access` 是 `approval: never`，会让风险确认在毫秒内被自动拒绝，报 `the user rejected tool "bash"`。
- **风险白名单**：`~/.dsh/context-guard/risk-allow.json` 里的 `kind: "host"` 规则（规则格式见[「始终允许」落规则](operations.md#始终允许落规则)），增量叠加内置默认 `config/risk-allow-default.json`，例如 `192.168.31.244`、`100.84.98.28`、`zh-gem-r7.tailb6e152.ts.net`。
