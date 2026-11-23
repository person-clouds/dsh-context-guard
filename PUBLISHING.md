# 发布到 DSH 插件市场

> 状态：**`0.6.0` 待发布（`npm publish` 需用户 2FA）；`0.5.0` 只有 npm、无 tag/Release；上一版 `0.4.4` 已发布，tag 与 GitHub Release `v0.4.4` 已推送（资产 `dsh-context-guard.tgz` 58586 字节，`latest/download` 返回 200）。**
> 目标仓库：`person-clouds/dsh-context-guard`
> npm 包名：`@fenghoer/dsh-context-guard`（npm 上 `dsh-context-guard` 已被其他项目占用）

## 当前结构

```text
dsh-context-guard/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入 context-guard 插件行
├── index.js              # Host-only 插件
├── test.mjs              # 无外部依赖的单元测试
├── README.md
├── README.en.md
├── PUBLISHING.md
├── LICENSE
└── market/person-clouds__dsh-context-guard.yml
```

## 一、创建独立公开仓库

```bash
cd /home/zh/www/dsh-context-guard
git init
git add .
git commit -m "feat: DSH 压缩归档插件"
git branch -M main
git remote add origin git@github.com:person-clouds/dsh-context-guard.git
git push -u origin main
```

GitHub 仓库添加 topic：`dsh-plugin`。

## 二、本地打包验证

```bash
cd /home/zh/www/dsh-context-guard
npm test
npm pack --pack-destination release
# 产物：release/fenghoer-dsh-context-guard-0.5.0.tgz
```

## 三、发布 npm（需要先登录）

```bash
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

> 本机默认 registry 是华为云镜像（`https://repo.huaweicloud.com/repository/npm/`），发布必须显式 `--registry=https://registry.npmjs.org`；token 在 `~/.npmrc`；`npm view` 有 3–5 分钟传播延迟。完整流程与约束见 [doc/specs/npm-publishing.md](/home/zh/www/doc/specs/npm-publishing.md)，`package.json` 已设 `publishConfig.registry` 兜底。

## 四、创建 GitHub Release

- tag：`v0.5.0`（发布 0.5.0 时创建；历史 tag 见 STATUS）
- 上传 `dsh-context-guard.tgz`（源码 tarball，无版本号文件名）
- Release 资源名建议保持无版本号：`dsh-context-guard.tgz`

## 五、提交 DSH 插件市场

市场收录要求与交付台一致：

1. 公开 GitHub 仓库，`package.json` 声明 `dsh.bundle`；
2. 仓库创建满 1 天；
3. 添加 GitHub topic `dsh-plugin`；
4. 向 `awesome-dsh-plugin` 提交 `data/plugins/person-clouds__dsh-context-guard.yml`；
5. 推荐同时发布 npm 包或 Release tarball。

本地条目草稿：`market/person-clouds__dsh-context-guard.yml`。

已合并 PR：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/15266

发布后的市场索引由 awesome-dsh-plugin 目录生成；DSH 的 Discover 索引源示例：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`。
