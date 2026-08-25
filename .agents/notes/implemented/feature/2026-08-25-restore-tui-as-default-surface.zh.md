# Agent Note：恢复 TUI 作为 dsh 默认界面

Status: implemented

[English](2026-08-25-restore-tui-as-default-surface.md) | 中文

## 问题

2026-08-04 的移除让 Web 成为唯一随附的交互界面；裸 `dsh` 必须指定 `--profile`，产品默认是浏览器界面。用户要求默认改为终端界面，逆转这次移除。

## 决策

从移除提交的父提交（`10bb9cbf4a^`）恢复 `packages/ui/tui`，重新对齐当前核心并让 TUI 成为 `dsh` 启动器的默认界面。重集成覆盖四层，每层都沿用既有模式：

- **包**：恢复 `packages/ui/tui` 并注册进构建（tsconfig paths/references、knip、workspace-constraints extras、`patches/` 中的 `pi-tui@0.80.7` 补丁与 `patchedDependencies`）。源码导入与服务名对齐当前核心（`@deepseek-ai/cordis`、`dsh-user-questions`、`dsh-compaction`、`ModelSelection`/`installModelSelection`、payload 式 agent 事件、`agent/pre-step`、`SessionReferenceResolver`/`SessionQueryEngine`/`SkillRegistry`、当前会话事件词汇）。
- **界面组合包**：新增 `@deepseek-ai/dsh-tui-app`（镜像 `dsh-web-app`）：`cordis.patch.yml` 表面层 + `startup` provider（解析 `--resume`、铸造会话身份、提供 launcher 拥有的启动槽）。
- **Profile 与启动器**：`tui` 加入 `PROFILE_TEMPLATES`；裸 `dsh` 默认启动 `tui` profile；`dsh tui` 是硬编码别名；`dsh -h` 仍打印启动器帮助。
- **文档**：README、用户指南（index.md 改为 TUI 指南，Web 指南移至 web.md）、apps/cli README 与 CLI 行为参考、站点映射均以 TUI 为先；Web 是显式 `dsh web` 入口。

本笔记取代 2026-08-04 移除笔记的「无终端 UI」结论。已归档的 TUI 实现笔记保持冻结，不作为当前权威。

## 验证

- `tsc -b`（tui/tui-app/cli/app-boot）退出码 0。
- `apps/cli/tests/args.spec.ts` 6/6 通过（默认 profile 路由、`tui` 别名、透传边界）。
- `packages/ui/tui` 单测 179/186 通过。剩余 7 个失败均为针对移除前核心编写的行为夹具（goal 渲染、一个 steering 徽章提示过渡、两个 compaction 重放标记、一个 transcript 渲染、一个引用卡片渲染、一个错误/销毁通知），属于夹具预期而非编译或启动器回归。
- 未在本变更内运行的门：完整 `tsconfig.host.json` 类型检查（测试夹具仍带旧形状成员）、新组合包行的 doc-sync 目录再生成、组装后 `tui` profile 的无密钥 PTY 启动冒烟。

## 备选方案

**新建 TUI 而非恢复**。未采纳：移除前的前端在三个星期前仍是产品级质量，恢复加重集成今天即可交付可用默认；重写可在此基础上迭代。

**保留 `dsh` 必须指定 `--profile`**。未采纳：用户要求的正是面向用户的默认值；Web 仍是同等显式入口之一。

## 后果

裸 `dsh` 现在启动终端界面：`tui` profile（`base + tui-app`）成为默认，`dsh tui` 是其显式别名，Web 通过显式 `dsh web` 入口到达，因此没有浏览器的安装也能获得一流的交互界面。新的 `@deepseek-ai/dsh-tui-app` 界面组合包随 `apps/cli` 一起发布，默认模板可从安装中解析。文档、用户指南（index.md 现为 TUI 指南，Web 指南位于 web.md）与站点映射均以 TUI 为先。本笔记取代 2026-08-04 移除笔记的「无终端 UI」结论；已归档的 TUI 实现笔记保持冻结，不作为当前权威。待办的门仍如「验证」一节所记录：完整 `tsconfig.host.json` 类型检查（测试夹具仍带旧形状成员）、新组合包行的 doc-sync 目录再生成、以及组装后 `tui` profile 的无密钥 PTY 启动冒烟。
