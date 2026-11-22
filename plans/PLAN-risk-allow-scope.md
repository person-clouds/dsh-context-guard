---
implementation_status: done
created_at: 2026-11-22 23:06:17
updated_at: 2026-11-22 23:45:00
---

# PLAN：风险放行范围收敛与临时目录清理

## 目标

解决「同一个域名/同一条 rm 反复询问」的三类剩余原因：

1. URL 末尾标点、`http://$(...)` 被当成静态主机，导致同一域名生成不同 host 规则，动态命令被静默放行；
2. 普通 rm 只落到精确命令，工作区 `.tmp*` 下每次新路径都重新询问；`/tmp` 已由现有 `tempRoots` 在 analyze 阶段免询问，本计划不重复造规则；
3. 用户不知道「始终允许」实际保存了什么。

目标行为：链接只放行主机，不引入 URL 前缀/正则；`/tmp` 保持现有免询问；工作区 `.tmp*` 的简单 rm 放行临时清理；临时规则必须同时满足「命令只由 rm 段组成、cwd 可确认、解析后的真实路径不逃出 cwd」；其他情况仍退化为整条命令；保存后通知规则类型；可勾选「仅此命令」强制最窄规则。`.tmp*` 指目录名以 `.tmp` 开头的字面路径，不是 shell 通配符。

## 范围

改动：`lib/risk.js`、`lib/risk-allow.js`、`index.js`、`client.js`、`test.mjs`、`README.md`、`README.en.md`、`STATUS.md`、`SPEC.md`。

不改：规则文件版本、`MAX_RULES`、host 子域语义、默认白名单；现有 `/var/tmp`、`$TMPDIR`、test 目录、`~/opt` 等临时豁免保持不变（比本次确认更宽，是否收敛另议）；不引入正则/glob 输入；不物理删除现有坏规则（只在匹配时忽略，删除另行确认）；混合原因（如 rm + 未知链接）沿用现有「只落可安全归类的一类」语义，本次不扩大到一次点击落多类；不升 `0.5.0`（尚未发布，发布前合并）。`PendingRiskRules` 仅增加可选 `cwd` 字段，兼容旧条目，版本仍为 1。检查与执行之间存在符号链接 TOCTOU（cwd 内可写，检查后被替换仍可能逃逸）；本计划只保证检查时真实路径不逃逸，并在 SPEC 记录该残余风险。

理由：解析、匹配、路由、卡片需同一提交才能形成可用闭环；拆开会出现「能选范围但保存不了」的中间态。

## 改动位置

1. `lib/risk.js`：新增并导出 `isValidHost`（接受 `localhost`、IPv4、方括号 `[IPv6]` 原样、常规 DNS 标签、下划线内网名、`xn--` 与单个尾点；拒绝空白、斜杠、冒号、括号、引号、`$`、空标签）；`hostOf` 小写、去单个尾点，非法返回 `''`；`extractUrls` 只去尾部未配对的 `)` 及 `,.;`，**不因非法 host 丢弃 URL**（保留 `unknown-link`/`insecure-http`）。`registry.npmjs.org)` 归一为 `registry.npmjs.org`；`http://$(tailscale ...)` 的 `hostOf` 为空，仍产生 `unknown-link`，且不生成 host 规则。
2. `lib/risk-allow.js`
   - `validRule` 增加 `temp-rm`（要求非空 `key` 与绝对路径 `cwd`；匹配时对当前 cwd 取 realpath 后比较）；`allowedHosts` 用 `isValidHost` 过滤；不改非法 host 的加载条件，历史坏规则留在文件中但不参与匹配。
   - 抽出 `parsePathTarget` 与 `parseRmTargets`，保留 glob/尾部斜杠标记；`parseArtifactRm` 行为不变。
   - 新增 `parseTempRm(command, cwd)`：先 `realpathSync(cwd)`；每一非空 shell 段都必须以 `rm` 开头（`rm a && rm b` 可用；含 `cd`、管道、重定向、其他命令一律不命中）；cwd 必须非空；拒绝 `..`、glob、`$`/反引号、`sudo`/`xargs`、`~`、尾部 `/`、裸 `/tmp`、含 `.git` 段。
   - 每个目标 `path.resolve(realCwd, target)`，用 `lstatSync`/`realpathSync`（不存在时取最近存在父目录）校验：真实路径必须在 realCwd 下且仍含 `.tmp*` 段；符号链接逃逸、`.tmp*` 链到普通目录均不命中；`/tmp` 不在此规则范围。
   - temp 规则 key 含 realCwd；`matchesTempRm(command, cwd)` 要求 `rule.cwd === realpathSync(cwd)`；`filterRiskByRules` 增加 cwd 参数，命中只移除 `destructive-rm`，保留 `repo-delete`；`publicRule` 为 `temp-rm` 返回 `scope:'temp-rm'`。
   - `ruleSpecsFor(command, risk, now, { scope, cwd })` 支持 `scope:'command'` 强制只生成整条命令规则；artifact 优先于 temp（`*.tmp*/node_modules` 仍落 artifact）；无 cwd 不生成 temp；host 规则只接受 `isValidHost` 的主机。
3. `index.js`：pre-execute 与保存路由重分析（`index.js` 638 行附近）都从 `exec.arguments?.cwd || exec.arguments?.workdir || exec.cwd` 取 cwd，传给 `filterRiskByRules`/`ruleSpecsFor`/`pendingRiskRules.add`；`scope` 缺省为 `auto`，仅接受 `auto|command`（其他 400），保存用 `entry.cwd`；无 cwd 时 temp 不生成（fail-closed），但 host/command/artifact 规则照常。
4. `client.js`：原因弹窗增加「仅记住这条完整命令」复选框，提交 `{reason, scope}`；说明改为链接只放行主机、`/tmp` 已免询问、`.tmp*` 简单 rm 放行临时清理、构建产物按项目前缀、其他只记整条命令；保存成功后用 `showNotice` 展示规则类型。

## 实施步骤

1. 先改 `lib/risk.js` 并补测试，确保坏 URL 不再产生 host 规则、动态 fetch 保持询问。
2. 再改 `lib/risk-allow.js` 的路径解析、`temp-rm` 与 `scope:'command'`，补规则匹配测试。
3. 接线 `index.js` 与 `client.js`，更新文案。
4. `cd /home/zh/www/dsh-context-guard && npm test`；用 `test.mjs` 断言以下用例（cwd `/home/zh/www`）：
   | 输入 | 预期 |
   | --- | --- |
   | `curl https://registry.npmjs.org)` | host=`registry.npmjs.org`，`ruleSpecsFor` 产 host spec |
   | `curl http://$(tailscale ip -4):8791/x` | `hostOf` 空，codes 有 `unknown-link`，不产 host spec |
   | `xdg-open http://$(tailscale ip -4):8791/x` | ask，codes 有 `unknown-link`（不因过滤丢失） |
   | `rm -rf /tmp/cg-probe` | `risk=false`，不产规则（现有 tempRoots） |
   | `rm -rf .tmp-probe` | temp spec；store.add 后 `filterRiskByRules` 为 false |
   | `rm -rf /tmp/cg-probe && bash -c 'rm -rf /home/zh/www/src'` | 不命中 temp，risk 仍 true |
   | `/tmp/link -> /home/zh/www` 的子路径 | 不命中 temp，risk 仍 true |
   | `rm -rf .tmp-x/.git/.tmp-y` | 不命中 temp，`repo-delete` 保留 |
   | `rm -rf .tmpbuild/node_modules` | 落 artifact spec，不落 temp |
5. 更新 README/README.en 风险段、STATUS、SPEC；在 `/home/zh/www` 执行 `./scripts/check.sh --repo dsh-context-guard`。
6. 重启窗口由用户确认；重启后验证卡片文案、勾选「仅此命令」、保存通知。未重启前只完成单测与 Node 回放。

## 验收

- `npm test` 全绿；新增用例覆盖尾标点归一、括号平衡保留、`$(...)` 不生成 host 但保留 `unknown-link`、`xdg-open` 动态主机不被静默、历史坏 host 规则不生效、`[::1]`/`foo_bar`/`example.com.` 校验、`/tmp` 仍免询问且不产规则、cwd 下 `.tmp*` 命中、相对路径按 cwd 解析、混合/复合命令不命中、裸 `/tmp`/glob/`..`/尾部 `/`/`~`/重定向/`.git` 段不命中、符号链接逃逸不命中、`.tmp*/node_modules` 落 artifact、`scope:'command'` 不写 host、`temp-rm` 重启 reload 后仍存在。
- Node 回放按上表逐条断言；`temp-rm` 的保存链路用 `ruleSpecsFor`→`store.add`→`filterRiskByRules`，不依赖 UI。
- 实机（待重启验证）：保存通知写明规则类型；勾选「仅此命令」后只新增 command 规则；host 规则仍只按主机匹配，不出现 URL 前缀规则。

## 回滚

`git revert <提交号>`；旧版不识别 `temp-rm`，会忽略并可能在下一次写入规则文件时清理；cwd 用 realpath 存储，符号链接路径也能匹配；已保存 host/command/artifact 规则不受影响。

## 改动记录

- 2026-11-22 23:06 建立计划：用户确认 A（受控范围）、curl 只按主机、rm 允许 `/tmp` 与 `.tmp*`；本计划不引入自由正则。
- 2026-11-22 23:10 自检修订：补「所有 shell 段必须为 rm」防复合命令夹带、cwd 约束（含 `workdir` 回退）、realpath/lstat 防符号链接逃逸、TOCTOU 残余风险，以及混合原因不落多类规则。
- 2026-11-22 23:13 核验修订：修正 `/tmp` 已由 tempRoots 免询问的前提；非法 host 不再从 `extractUrls` 丢弃，避免非 curl 命令失去 `unknown-link`；temp 只移 `destructive-rm` 且拒绝 `.git` 段；artifact 优先于 temp；补 `temp-rm` reload、`scope` 缺省、realpath cwd、回放断言与 check.sh 路径。
- 2026-11-22 23:45 实施完成：`lib/risk.js`、`lib/risk-allow.js`、`index.js`、`client.js` 全部落地，`test.mjs` 新增对应断言并通过 `npm test`；README/README.en、STATUS、SPEC 已同步。实施偏差：回放表 `/tmp/link -> /home/zh/www` 一行按字面 `/tmp/...` 仍被 analyze 的 `tempRoots` 直接免询问（不会产生规则），因此该行测试改为「mock risk 为 true 时 temp 规则不匹配、risk 仍 true」，与计划「不命中 temp」一致；`scope:'command'` 路由非法值在消费 token 前返回 400。实机卡片/通知验证仍待重启窗口（步骤 6）。
