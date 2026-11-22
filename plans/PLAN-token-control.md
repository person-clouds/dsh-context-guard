---
implementation_status: done
created_at: 2026-11-22 10:59:06
updated_at: 2026-11-22 13:35:00
---

# PLAN：接收 token-control 的压缩阈值治理

## 目标

把 `personalCloud/task/dsh-token-control/` 已验证的自动压缩阈值治理收进本仓，变成可重复执行、可自检、有文档归属的能力：

- 阈值：`thresholdRatio: 0.08` / `retainRatio: 0.02` / `headroomTokens: 65536`（约 8 万 token 触发压缩）；
- 实测：日均 token 391.5M → 99.8M，每步 cacheRead 203.8k → 47.1k（约 −74.5%）；
- 现状问题：配置补丁只存在于临时任务脚本，DSH 升级后 preset 内容变化会让补丁失配或静默回落默认值，没有自检；
- 本次形态：**脚本 + 自检 + 文档**，不做插件运行时能力（插件改不了 agent preset 配置）。

## 非目标

- 不搬 superagent 的 `maxTokens` 1M（属 `dsh-superagent` 仓）；
- 不搬 `ops-ptc` 补丁（该 preset 已随 dsh-ops 消失，内置目录只剩 `standard/minimal/ptc/cordis`）；
- 不做运行时上下文压力提示、不扩展运行时 metrics；
- 不修改 `personalCloud/task/dsh-token-control/`（只在文档里指向它作为实测依据）；
- 脚本不自动执行，不改 `~/.dsh` 以外的任何宿主配置。

## 依据

- 实测与归因：[README.md](../../personalCloud/task/dsh-token-control/README.md)、[ANALYSIS-20261118-token-consumption-drop.md](../../personalCloud/task/dsh-token-control/ANALYSIS-20261118-token-consumption-drop.md)。
- 压缩机制与调参：[docs/context-compaction.md](../docs/context-compaction.md)（5.1–5.3 已有原理与当时的修复记录）。
- 补丁规则：agent preset 的 `plugins` 按 id 取第一个匹配项，覆盖必须整段重写 preset；顶层按 id 打补丁打不到组内条目。
- 现有同类先例：[scripts/apply-profile.sh](../scripts/apply-profile.sh) 已负责重写 profile 与 `preset-minimal`，本计划把压缩字段的职责收进来。

## 改动位置

| 文件 | 改动 |
|---|---|
| `scripts/apply-compaction.sh` | 新增。bash 入口 + 内嵌 python 文本处理，子命令 `check`（默认）/`apply`/`dry-run`；参数 `--presets-dir`、`--patch`、`--profile`、`--deep` |
| `test.mjs` | 增加脚本静态检查与 fixture 场景测试 |
| `docs/context-compaction.md` | 5.3 改为指向仓内脚本与用法；修正归档路径；补「升级后自检」小节 |
| `README.md` | 「压缩与归档」段落补一条脚本入口 |
| `SPEC.md` | 范围补「压缩阈值配置的应用与自检」 |
| `STATUS.md` | 收尾记录版本与实机验收结果 |

## 实施步骤

1. `apply-compaction.sh check`
   - 定位内置 preset 目录：默认从 `dsh` 可执行文件解析安装根，`--presets-dir` 可覆盖；
   - 解析内置 `*.patch.yml` 与 home 补丁（默认 `~/.dsh/cordis.patch.yml`，`--patch` 可覆盖）里所有 `preset-*` 块；
   - 对每个含 `compaction-basic` 的 preset 校验三字段，缺失或不符即报 `FAIL: preset-<name>` 并非零退出；
   - 报告重复的 `preset-*` 块（后写块会被静默忽略）；
   - `--deep` 追加 `dsh --profile <p> --dump-config` 交叉核对，慢但最权威。
2. `apply-compaction.sh apply`
   - 先 `cp` 备份为 `cordis.patch.yml.bak.compaction-<时间戳>`；
   - 从内置 preset 重新生成每个目标 preset 的完整块，只给 `compaction-basic` 注入 config，按原位置替换同 id 块，保留块外内容与顺序；
   - 幂等：连跑两次不产生 diff；`dry-run` 只打印将改动的 preset。
3. 文档
   - 修 `docs/context-compaction.md:181` 过期路径：`compaction-archive/` → `context-guard/archive/`；
   - 5.3 的「可重复执行脚本在 task/dsh-token-control」改为本仓脚本，任务目录只留实测数据链接；
   - 补「DSH 升级后跑 `--check`，失败再 `--apply`」。
4. 测试
   - `test.mjs` 增加：脚本语法检查；临时目录 fixture 覆盖「全 PASS」「缺字段 FAIL」「apply 后 PASS 且幂等」「dry-run 不写盘」；
   - 不改 `~/.dsh` 的测试路径由 `--patch`/`--presets-dir` 注入。
5. 收尾
   - 更新 README/STATUS/SPEC，跑 `npm test` 与 `./scripts/check.sh --repo dsh-context-guard`。

## 验收

- `bash scripts/apply-compaction.sh --check` 在本机退出 0，四个 preset 均 PASS；
- 手工在 fixture 中删掉 `thresholdRatio` 后 `--check` 退出非零并指名 preset；
- `--apply` 后 `--check` 通过，连跑两次 `diff` 为空，备份文件存在；
- `--dry-run` 不修改补丁文件；
- `npm test` 通过，`check.sh --repo dsh-context-guard` 无 FAIL。

## 风险与处理

- 整段重写依赖安装包 preset 版本：`check` 必须能在 DSH 升级后立刻报出差异，作为主要防线。
- `apply-profile.sh` 也可能重写 `preset-minimal`：两脚本同 id 块以先出现者生效。本脚本检测到重复块时只报告，不自动删；实施时若本机已有两份，人工合并后保留一份。
- 脚本要写 `~/.dsh/cordis.patch.yml`：只由用户执行，仓库不提供自动 hook；`apply` 必须备份并打印回滚命令。
- `dsh --dump-config` 慢且依赖 profile 存在：只在 `--deep` 时使用。

## 回滚

- 配置：`cp ~/.dsh/cordis.patch.yml.bak.compaction-<时间戳> ~/.dsh/cordis.patch.yml` 后重启对应 profile；
- 代码：`git revert` 本次提交即可，脚本无运行期副作用。

## 改动记录

- 2026-11-22 10:59 初稿，范围收敛为「只做压缩阈值 apply/check + 文档」。
- 2026-11-22 13:35 实施完成：新增 `scripts/apply-compaction.sh`（check/apply/dry-run），
  `test.mjs` 增加 fixture 回归；`docs/context-compaction.md` 改写 5.3 并新增 5.5；
  README/README.en/SPEC/STATUS 同步。实现时补了两处计划外但必要的约束：
  ① 比较时忽略注释与引号风格（home patch 与安装包引号不一致，否则误报漂移）；
  ② 重写 preset 块时保留宿主已有的 `maxOutputChars`（apply-profile.sh 会加，不能丢）。
  未对 `~/.dsh` 执行 apply，配置层保持原样。
