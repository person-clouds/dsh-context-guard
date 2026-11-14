# 发布到 DSH 插件市场

> 状态：**发布材料已就绪，尚未创建公开仓库 / 发布 npm**。
> 目标仓库：`person-clouds/dsh-context-guard`
> npm 包名：`dsh-context-guard`

## 当前结构

```text
task/dsh-context-guard/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 插入 context-guard 插件行
├── index.js              # Host-only 插件
├── test.mjs              # 无外部依赖的单元测试
├── README.md
├── PUBLISHING.md
├── LICENSE
└── market/person-clouds__dsh-context-guard.yml
```

## 一、创建独立公开仓库

```bash
cd /home/zh/www/personalCloud/task/dsh-context-guard
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
cd /home/zh/www/personalCloud/task/dsh-context-guard
npm test
npm pack --pack-destination release
# 产物：release/dsh-context-guard-0.2.0.tgz
```

## 三、发布 npm（需要先登录）

```bash
npm login --registry=https://registry.npmjs.org
npm publish --registry=https://registry.npmjs.org --access public
```

## 四、创建 GitHub Release

- tag：`v0.2.0`
- 上传 `release/dsh-context-guard-0.2.0.tgz`
- Release 资源名建议保持无版本号：`dsh-context-guard.tgz`

## 五、提交 DSH 插件市场

市场收录要求与交付台一致：

1. 公开 GitHub 仓库，`package.json` 声明 `dsh.bundle`；
2. 仓库创建满 1 天；
3. 添加 GitHub topic `dsh-plugin`；
4. 向 `awesome-dsh-plugin` 提交 `data/plugins/person-clouds__dsh-context-guard.yml`；
5. 推荐同时发布 npm 包或 Release tarball。

本地条目草稿：`market/person-clouds__dsh-context-guard.yml`。
