# Changelog

本项目的版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；每次 `v*` tag 由 GitHub Actions 构建出可直接安装的 `.tgz`。

## 0.2.1 — 2026-10-29

- 修复（Windows）：Session 目录的删除/移动对 Windows 上常见的短暂占用（`EPERM` / `EBUSY` / `ENOTEMPTY`，来自 Explorer、杀毒或索引服务）做最多 5 次退避重试，不再第一次就失败。
- 修复（Windows）：回收站与投影缓存改为从 Harness home（`dshHomePath()` → `$DSH_HOME` → `~/.dsh`）派生，而不是从 `sessionPersistence.root` 的父目录派生 —— `sessionPersistence.root` 在另一个盘时（Windows 常见）不会再算错位置。
- 修复（Windows）：跨盘移动的 `EXDEV` 降级为「复制 → 删除」，并同样带重试；`:` 等非法字符在回收站目录名里已被扁平化（原本就有，补了说明）。
- 修复（Windows）：`scripts/check.mjs` 用 `pathToFileURL` 动态导入，`C:/…/index.js` 不再是非法 URL。
- 新增：`tests/offline.mjs` 离线验证脚本（假 Cordis 上下文 + 临时 home），覆盖删除、回收站、永久删除、运行中会话的 `force` 关闭、错误码与工具参数；`npm test`。
- CI 增加 `windows-latest` / `macos-latest` 矩阵，`npm test` 在三平台都跑。

## 0.2.0 — 2026-10-29

- 新增：会话仍在本进程里打开时，删除不再只是一条报错 —— 对话框切换到「正在运行」警告，按钮变成「关闭并删除」，确认后依次：取消进行中的回合（`cancel({kind:'user'})`）→ 关闭会话（`SessionStore.remove` 触发 `session/disposed`，持久化层关掉写句柄）→ 移入回收站。
- 新增：`SESSION_LIVE_UNCLOSED`（409）—— 会话没能在超时内关掉时拒绝删除，目录保持原样。
- 新增：HTTP `POST /delete` 的 `force` 字段、Agent 工具 `session_cleaner_delete` 的 `force` 参数、`/health` 返回 `version`。
- 修复：菜单项与确认对话框改为照抄 dsh 原生 primitives 的几何与语义色（14px 描边垃圾桶图标、34px 行高、`padding: 6px 8px`、380px 对话框），不再用 emoji 与手写间距。

## 0.1.0 — 2026-10-29

- 首个版本：侧栏会话菜单「删除会话」+ 确认对话框；默认移入 `~/.dsh/session-trash/`，可选永久删除；同步清理 projcache、置顶/归档记账与 Workspace 的 `sessionIds`；`session_cleaner_list` / `session_cleaner_delete` 两个 Agent 工具；`/dsh-session-cleaner/{health,sessions,delete}` HTTP 路由。
