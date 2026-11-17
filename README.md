# dsh-session-rewind

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的「撤回」插件：把一轮已经跑完的提问收回去——对话切到本轮之前，工作区文件还原到本轮开始前的快照。

> **English summary.** A DeepSeek Harness plugin that rewinds a completed turn: it forks the session before that turn (DSH's log is append-only, so a fork is the supported equivalent of truncation) and restores the workspace from a private git snapshot taken when the turn started. Snapshots write only to a per-session object store; the repository's index, refs, and object store are never modified. Requires git for file restore; conversation-only rewind works without it.

## 它解决什么

DSH 的会话日志是只追加的事件流，没有「删掉最后几条消息」的接口；而一轮对话往往伴随着一串文件改动。想把某次提问连同它的副作用一起收回，需要两件事同时发生：

1. **对话**回到那一轮之前；
2. **文件**回到那一刻的样子。

这个插件把两件事合成一个动作，并且**不销毁任何东西**：原会话完整保留在侧边栏。

## 用法

每条已完成回复的下方、复制/分支图标那一行的上方，会出现一个细小的回转箭头。点它：

1. 弹出确认框，先显示「将还原 N 个文件 / 删除 M 个本轮新增的文件」；
2. 勾选「同时还原工作区文件」后确认 → 先还原文件，再从本轮之前新建会话分支并打开它；
3. 取消勾选 → 只撤回对话，工作区保持现状。

新会话里没有本轮的提问和回答，也没有之后的所有轮次；你可以重新组织问题再发一次。

## 安装

需要 DSH 0.2.x（在 `0.2.2-rc.3` 上验证）。

```bash
git clone https://github.com/MrMark019/dsh-session-rewind.git
```

然后在 DSH 里二选一：

- **设置 → 插件 → 添加插件**，选择克隆出来的目录；
- 或者让 agent 调用 `plugin_manager` 的 `install_bundle`，`target` 传该目录的绝对路径。

安装后**刷新一次页面**（浏览器端模块要重新加载）。

卸载：设置 → 插件里禁用或移除；仓库目录不会被动。

## 工作原理

**对话**：调用 Harness 自带的 `session.fork`（与「分支」按钮同一机制），切点取在本轮 `turn/start` 事件的前一个 seq，因此整轮被切掉。切完由客户端打开子会话。

**文件**：每轮 `turn/start` 时把工作区写成一个 git tree：

- 复制仓库 index 到私有索引 → `git add --all --ignore-errors` → `git write-tree`；
- 对象写进本会话私有的对象库（系统临时目录下的 `dsh-session-rewind/<会话 id>`），仓库对象库只作为只读 `GIT_ALTERNATE_OBJECT_DIRECTORIES`；
- `tools/pre-execute` 会等待快照落定，保证任何工具动手前基线已经存在；
- 还原时用 `git read-tree` + `git checkout-index` 写回文件（二进制、符号链接、配置过的 `smudge`/LFS 过滤器与正常 checkout 一致），删除本轮新增的路径，并只刷新「内容已与暂存区一致」那些文件的索引 stat 缓存。

快照索引（`index.json`）与对象一起留在私有目录，**Host 重启后仍可还原**。

## 安全边界

- 不写你的仓库：`.git/index` 内容、refs、对象库都不动（实测对象库文件数与 index 字节均不变）。
- 不越过仓库根：所有还原路径先规范化再写盘，含 `..`、绝对路径、`.git/` 的条目一律拒绝。
- 被忽略的未跟踪文件（`node_modules`、构建产物等）**既不还原也不删除**。
- 还原前先 `dryRun` 预览要动多少文件；单次上限 `maxFiles`。

## 限制

- **文件回档需要 Git**：工作目录不在 Git 仓库里时只能撤回对话。
- **插件加载之前的轮次没有快照**：可以撤回对话（用会话日志补出轮次边界），但不会还原文件。
- 被 `.gitignore` 覆盖的文件不在快照里。
- 首次快照需要把工作区里未被忽略的文件写进私有对象库，仓库越大越慢；之后的快照只处理变化部分。
- 会话仍在运行时不能撤回，需要等这一轮结束。
- 私有快照目录超过 7 天未使用会在下次启动时清理。
- 单次还原最多处理 `maxFiles` 个路径。

## 配置

在 profile 的 patch 里覆盖插件行的 `config`：

```yaml
- id: session-rewind
  name: '@mrmark019/dsh-session-rewind'
  config:
    restoreFiles: true     # 关掉后对话框不再提供文件还原
    maxFiles: 500          # 单次还原允许的最大路径数
    timeoutMs: 30000       # 单条 git 命令的超时
    maxScanEvents: 20000   # 补历史轮次时允许扫描的事件上限
```

## 自测

三个脚本都不依赖 Cordis，跑完自动清理：

```bash
node scripts/selftest.mjs    # 快照/还原算法：tree 一致、status 干净、二进制逐字节、忽略文件未动、仓库未变
node scripts/hosttest.mjs    # 用桩 Context 加载 Host 入口：记录、路由、忙闲拒绝、atSeq、重启后还原
node scripts/clienttest.mjs  # 用桩加载器 + React 垫片加载浏览器入口：槽位注册、渲染、dryRun 请求
```

## 目录结构

```
index.js             Host 半：快照记录器 + 两条 /api 路由
client.js            浏览器半：轮次动作、确认框、fork 与跳转
rewind/git.js        git 管道：定位仓库、快照、tree diff、checkout、索引刷新
rewind/restore.js    还原计划与应用（路径安全、上限、逐路径容错）
rewind/store.js      每会话 checkpoint 与私有快照目录（含持久化索引）
locale/{zh,en}.json  插件面板元数据
docs/DETAIL.md       插件详情页
scripts/             三个自测脚本
```

## License

MIT © 2026 MrMark019