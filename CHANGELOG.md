# Changelog

本项目的版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)；每次 `v*` tag 由 GitHub Actions 构建出可直接安装的 `.tgz`。

## 0.2.0 — 2026-10-29

- 新增：会话仍在本进程里打开时，删除不再只是一条报错 —— 对话框切换到「正在运行」警告，按钮变成「关闭并删除」，确认后依次：取消进行中的回合（`cancel({kind:'user'})`）→ 关闭会话（`SessionStore.remove` 触发 `session/disposed`，持久化层关掉写句柄）→ 移入回收站。
- 新增：`SESSION_LIVE_UNCLOSED`（409）—— 会话没能在超时内关掉时拒绝删除，目录保持原样。
- 新增：HTTP `POST /delete` 的 `force` 字段、Agent 工具 `session_cleaner_delete` 的 `force` 参数、`/health` 返回 `version`。
- 修复：菜单项与确认对话框改为照抄 dsh 原生 primitives 的几何与语义色（14px 描边垃圾桶图标、34px 行高、`padding: 6px 8px`、380px 对话框），不再用 emoji 与手写间距。

## 0.1.0 — 2026-10-29

- 首个版本：侧栏会话菜单「删除会话」+ 确认对话框；默认移入 `~/.dsh/session-trash/`，可选永久删除；同步清理 projcache、置顶/归档记账与 Workspace 的 `sessionIds`；`session_cleaner_list` / `session_cleaner_delete` 两个 Agent 工具；`/dsh-session-cleaner/{health,sessions,delete}` HTTP 路由。
