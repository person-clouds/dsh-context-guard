---
implementation_status: done
created_at: 2026-11-21 05:38:00
updated_at: 2026-11-21 06:16:00
---

# PLAN：风险默认放行白名单配置文件

## 目标

把当前写死在 `lib/risk.js` / `lib/risk-allow.js` 的默认放行项，以及本机已放行的通用主机，整理成随插件发布的 `config/risk-allow-default.json`，按主机、rm、探测、只读命令、git 分组；运行时与用户 `risk-allow.json` 取并集。发布前由你复核并移除个人域名。

## 范围

- 只改 `dsh-context-guard` 仓；**不改** `~/.dsh/context-guard/risk-allow.json`。
- 不新增风险规则，不放宽 rm/git 破坏形态；git 只读命令行为不变。
- 不改 `riskAllowHosts` 现有“显式覆盖”语义；用户 host 规则继续与内置并集。
- 本次只出计划、审阅稿和配置说明；代码实施由新会话进行。

## 现状（已核对）

- 内置主机 6 个，硬编码在 `lib/risk.js:5` 的 `DEFAULT_ALLOW_HOSTS`。
- rm 安全路径（临时目录、test 目录、`~/opt`）、artifact 目录硬编码在 `lib/risk.js` / `lib/risk-allow.js`。
- `sudo` 只读命令、`systemctl` 只读子命令硬编码在 `lib/risk.js:258` / `lib/risk.js:264`。
- 本机用户规则：25 个 host + 4 个精确命令；4 个命令是本机测试/探测残留，本次不动。
- 合并逻辑已存在：`filterRiskByRules` 会把内置主机与用户 host 规则取并集（`lib/risk-allow.js:527-531`），本次把内置来源改为配置文件。
- 安装方式：web / superagent profile 均软链到本仓；profile 未配置 `riskAllowHosts`。

## 个人域名与排除项

| 主机 | 处理 |
|---|---|
| `zh-gem-r7.tailb6e152.ts.net`（Tailscale） | 不进内置，保留在用户配置 |

`docs.romm.app` 是 RomM 的文档站，按第三方文档站进内置。其余 24 个用户主机进内置；加上原内置中用户文件没有的 4 个（`localhost`、`[::1]`、`gitee.com`、`raw.githubusercontent.com`），内置共 28 个主机。审阅稿的 `review.excludedHosts` 记录排除项。

非 loopback 的裸 IP 也按个人服务处理；当前 28 个主机中只有 loopback 的 `127.0.0.1`、`[::1]`，按通用本地默认保留。若要把 loopback IP 也排除，把这两项移到 `review.excludedHosts`。

## 改动位置

1. 新增 `plans/risk-allow-default.draft.json`：供你逐项审阅的配置稿（含 `review` 段）。
2. 新增 `config/risk-allow-default.json`：由审阅稿去掉 `review` 段后落地。
3. 新增 `lib/default-allowlist.js`：同步读取、校验、展平配置；文件缺失或非法时回退最小安全默认并告警。
4. `lib/risk.js`：`DEFAULT_ALLOW_HOSTS` 改为从配置模块导出；rm 临时根、test 目录、`~/opt`、`sudo`/`systemctl` 只读列表改读配置。
5. `lib/risk-allow.js`：`ARTIFACT_DIR_NAMES` 改读配置；host 并集逻辑保持。
6. `test.mjs`：新增配置加载、分组齐全、个人域名不在内置、用户 host 并集、缺配置回退测试。
7. `package.json`：`files` 增加 `config`；版本 `0.4.1` → `0.4.2`。
8. `README.md` / `README.en.md` / `STATUS.md`：补配置位置、分组、合并语义与复核方法。

## 配置审阅

审阅稿：[plans/risk-allow-default.draft.json](/home/zh/www/dsh-context-guard/plans/risk-allow-default.draft.json)

- `hosts`：local 3、codeHosting 5、api 1、docs 1、techMedia 18，共 28 个。
- `rm`：4 个临时根、3 个 test 目录名 + 3 条正则、22 个 artifact 目录、`~/opt` 开关。
- `probes`：mktemp 根与至少 3 个 X、写探测文件名正则、touch/mktemp 自清理开关。
- `commands`：23 个 sudo 只读命令、10 个 systemctl 只读子命令。
- `git`：10 个只读子命令，仅登记，不参与放行。
- `review.excludedHosts`：当前仅 Tailscale 一项。
- `review.classificationRules`：裸 IP 先按个人服务处理，loopback 保留为本地默认。

审阅方式：直接改 JSON；要排除某个主机，把它从 `hosts.*` 移到 `review.excludedHosts` 并写原因。实施会话按最终稿生成正式配置，并删除 `review` 段。

## 实施步骤

1. 建配置与加载器；把现有硬编码值原样迁入，先保证行为不变。
2. 接入 hosts：内置 = 配置全部主机；`riskAllowHosts` 显式设置时仍覆盖；用户 host 规则继续并集。
3. 接入 rm/probes/commands/artifact：逐项替换常量，跑现有测试确认无回归。
4. 将 24 个通用用户主机加入内置；Tailscale 1 个不加；4 个精确命令仍只在用户文件。
5. 补测试与文档；执行验收命令。
6. 停在复核点：给出逐项清单，确认个人域名和分组后再提交/发布。

## 验收

- `cd /home/zh/www/dsh-context-guard && npm test` 全绿。
- `cd /home/zh/www && ./scripts/check.sh --repo dsh-context-guard` 无 FAIL。
- `cd /home/zh/www/dsh-context-guard && npm pack --dry-run` 包含 `config/risk-allow-default.json`。
- 断言：内置主机不含 Tailscale 域名；用户规则存在时并集生效；临时/test/artifact rm 行为与改前一致；`sudo` 与 git 破坏形态仍 ask。

## 回滚

- 删除新增 `config/` 与 `lib/default-allowlist.js`，恢复 `lib/risk.js`、`lib/risk-allow.js`、`package.json` 与文档改动；`git checkout -- <files>`。
- 用户 `risk-allow.json` 全程不改，无需回滚。

## 改动记录

- 2026-11-21 05:38 创建计划，待确认后实施。
- 2026-11-21 06:05 按确认调整：`docs.romm.app` 改为第三方文档站进内置；新增审阅稿；实施改由新会话进行。
- 2026-11-21 06:15 补充规则：非 loopback 裸 IP 先按个人服务处理，loopback 保留为本地默认。
- 2026-11-21 06:16 落地代码与文档：新增 `config/risk-allow-default.json`（审阅稿去掉 `review` 段）与 `lib/default-allowlist.js`（读取、校验、规范化、缺失/非法回退最小安全默认并 warning）；`lib/risk.js`、`lib/risk-allow.js` 改读配置；`test.mjs` 补配置加载/分组/回退/并集断言；`package.json` 的 `files` 增加 `config`；README/README.en/STATUS 同步。
- 2026-11-21 06:35 验证通过：`npm test` ok、`npm pack --dry-run` 24 files（含 `config/risk-allow-default.json`）、`./scripts/check.sh --repo dsh-context-guard` PASS；按此提交。
