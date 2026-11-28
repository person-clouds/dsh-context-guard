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
          maxStepsPerTurn: 30            # 旧口径：单回合提醒（阶梯模式下不再单独提醒，仅保留回合硬拒）
          hardMaxStepsPerTurn: 40        # 单回合硬拒绝（阶梯模式下仍生效）
          maxStepsPerSession: 60         # 统一阶梯：会话步数每满该值提醒一次，是唯一提醒来源
          hardMaxStepsPerSession: 90     # 会话累计硬拒绝，可回复「继续」+30
          stepReminderLadder: true       # 默认开启统一阶梯；false 回退旧三套提醒（回合/会话/每 N 次调用）
          # 本机（web profile）覆盖为 60/90/60/120，见 personalCloud/plans/doc/archive/PLAN-token-budget-guard-and-agent-rules.md
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
        riskCheckEnabled: true       # false = 整块风险检查跳过（不弹卡、不生成 token）；lint/文档门禁/步数不受影响
        riskAutoAllowEnabled: true   # false = 关闭「始终允许」写规则按钮，风险仍询问
        # oneClickAllow: {enabled: true, maxHours: 168, defaultHours: 8}  # 一键放行；GUARD_ALLOW=steps|risk|all 预置默认
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

## 风险总开关与一键放行

| 键 | 默认 | 说明 |
|---|---|---|
| `riskCheckEnabled` | `true` | `false` 时整块风险检查跳过（不识别、不弹卡、不生成 rule-token）。文档门禁、步数/调用门禁、`commandLint`、核验态只读不受影响 |
| `riskAutoAllowEnabled` | `true` | 控制审批卡「始终允许」写窄规则；`false` 只去按钮，风险仍询问 |
| `oneClickAllow.enabled` | `true` | 是否注册放行面板与 `POST /api/context-guard-allow` |
| `oneClickAllow.maxHours` | `168` | 填小时数的上限，超过按上限截断 |
| `oneClickAllow.defaultHours` | `8` | 输入框默认小时数 |
| `GUARD_ALLOW` | 空 | 环境变量 `steps\|risk\|all`：仅给第一次出现的会话预置默认放行（面板可收回） |

- 放行状态**只挂单个 `sessionId`**、纯内存，不落盘、不跨 DSH 重启；「本会话」放行在会话事件结束时清空，「N 小时」按 `expiresAt` 折算。
- 放行后仍询问的**灾难级**命令：`rm -rf /`、`rm -rf /*`、`dd of=/dev/*`、`mkfs.*`、`fdisk/parted/wipefs /dev/*`、关机/重启、`chmod -R 777 /`、根级目录通配删除；`rm -rf /tmp/x`、`rm -rf ~/tmp/x`、`rm -rf node_modules` 不命中。
- 放行步数后：不再有回合/会话步数硬线与 160 次调用硬拒，但仍按 `maxCallsPerTurn`（默认 80）每满一轮给一条提醒；计数照常累加，面板显示真实进度。
- 优先级：**核验态（`V：` 标题）始终最高**，文档门禁与 `commandLint` 不受放行影响。

## 本机配置落点

本机（2026-11-22 起）按「完全权限 + 需要时弹审批」运行，靠两处配置配合，改完都要重启 `dsh-web`：

- **权限预设**：`~/.dsh/profiles/web/cordis.patch.yml` 里 `permission` 插件的 `full-access-ask` 预设（`sandbox: danger-full-access` + `approval: ask`），并用 `defaultPreset: full-access-ask` 设为新会话默认。原来的 `danger-full-access` 是 `approval: never`，会让风险确认在毫秒内被自动拒绝，报 `the user rejected tool "bash"`。
- **风险白名单**：`~/.dsh/context-guard/risk-allow.json` 里的 `kind: "host"` 规则（规则格式见[「始终允许」落规则](operations.md#始终允许落规则)），增量叠加内置默认 `config/risk-allow-default.json`，例如 `192.168.31.244`、`100.84.98.28`、`zh-gem-r7.tailb6e152.ts.net`。
