# 个人 GKD 聚合订阅

把多个规则库整合为一个固定订阅地址，并按计划自动获取更新。

本项目已发布：[Reev3sX/gkd-personal-subscription](https://github.com/Reev3sX/gkd-personal-subscription)。在 GKD 的订阅页面添加：

```text
https://raw.githubusercontent.com/Reev3sX/gkd-personal-subscription/main/dist/gkd.json5
```

[更新任务与运行记录](https://github.com/Reev3sX/gkd-personal-subscription/actions/workflows/update.yml)。

## 已选规则库

| 来源 | 角色 | 分支 | 本次核实版本 |
| --- | --- | --- | --- |
| [Lin-arm](https://github.com/Lin-arm/GKD_subscription) | 主库，保留原有默认开关与全局规则 | main | 614 |
| [奥怪](https://github.com/aoguai/subscription/tree/custom) | 补充库，注意使用 custom 分支 | custom | 89 |
| [言木七](https://github.com/yanmuq/muqi_gkd) | 附加订阅，无全局规则 | main | 51 |

规则来自各上游作者；本项目只负责个人使用的整理和自动构建。上游来源与原编号记录在 `dist/report.json`，原有快照链接保留。

## 合并后的行为

- 保留主库所有规则，默认开关跟随主库；只保留主库的 3 个全局组。
- 补充规则名称带 `补充·奥怪｜` 或 `补充·言木七｜`，全部默认关闭，包括补充库独有应用的规则。进入 GKD 的对应应用规则页，按需要开启具体规则组。
- 不建议批量打开全部补充规则；先选择主库不能处理的操作，再检查是否需要关闭同用途主库组。
- 不拆散规则组，不改选择器文本、组内规则编号或多步骤操作的依赖。跨组引用随新的规则组编号一起转换。
- 只有完整规则组、继承条件和默认开关等价时才自动去重；涉及跨组依赖的组保留。不能自动证明两条不同写法的规则会不会点同一个按钮。
- 主库分类保持原样；补充分类单独显示，避免补充组被主库分类自动开启，或让主库全局规则误以为该应用已有适配。
- `state.json` 永久保留已经分配的编号，删除的编号不复用。请不要删除或手动重建这个文件。
- 上游删除规则时，下次成功构建也会删除对应组；编号档案保留，之后恢复时仍使用原编号。

## 自动更新与失败保护

GitHub Actions 计划每 6 小时执行一次（北京时间 02:17、08:17、14:17、20:17），也可手动运行。

所有来源均须下载、解析和检查成功才会生成新订阅。任一来源失败，或者来源编号改变、版本倒退、应用/规则组数量比上次减少一半以上，本次更新就停止；仓库中的上一版继续可用。

规则内容不变时不增加聚合订阅版本。内容变化时版本递增。`checkUpdateUrl` 指向同一目录内的 `gkd.version.json5`，未保留上游更新地址，手机会继续从自己的地址更新。

手机仍须在 GKD 开启订阅自动更新；云端检查、文件发布和手机刷新是三个步骤，并非上游一更新就立即生效。

GitHub 的定时任务可能延迟；公开仓库连续 60 天无活动时，定时任务可能被自动停用，需要在 Actions 重新启用。[GitHub 官方说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 发布为自己的地址

本地构建和首次 GitHub Actions 运行均已通过检查，在线订阅已回读验证。以下步骤用于日后迁移到其他仓库，后续云端运行状态以 Actions 记录为准。

1. 在自己的 GitHub 账号下创建仓库，默认分支使用 `main`。下面的匿名订阅地址方案需要公开仓库。
2. 上传本目录中的文件，包括 `.github/workflows/update.yml`、`package-lock.json`、`state.json` 和 `dist/`；不要上传 `node_modules/`。普通网页拖拽可能漏掉隐藏目录，建议使用 Git 或 GitHub Desktop 提交完整目录。
3. 在仓库的 Actions 中启用并运行 **Update subscription**，确认运行成功。
4. 手机 GKD → 订阅 → 添加，填入自己的原始文件地址：

```text
https://raw.githubusercontent.com/你的用户名/你的仓库名/main/dist/gkd.json5
```

如果原有订阅页面仍单独启用了这三个上游订阅，切换完成后关闭重复来源，以免并行触发。添加新聚合订阅不会自动迁移旧订阅的手动开关，需要设置一次；以后聚合内编号保持稳定。

本地目录不是在线订阅地址。私有 GitHub 仓库的 Raw 地址需要认证，不能直接当作手机可匿名更新的地址；若要求完全私有，应另行选择有访问控制的托管服务。

## 本地构建

需要 Node.js 22 或更新版本。无需 Android 开发环境。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run build
```

只有一个依赖：JSON5 格式解析器。构建时只下载数据文件，不执行上游仓库代码。

## 本次验证

使用三份实际远程订阅构建，得到 **990 个应用、2,755 个应用规则组、3 个全局组**。补充组保留 **301** 个，等价组删除 **94** 个。

15 项自动检查通过，覆盖默认开关、整组去重、引用保留、编号稳定、版本递增、更新失败与异常截断时保留旧文件。尚未在 Android GKD 中做真实点击与长期定时运行验证。

源版本与最终数量会随上游更新变化，以生成的 `dist/report.json` 为准。
