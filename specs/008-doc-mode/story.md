# Story: 文档模式（左 Tree 导航 + 右分层文档的第二视图）

## 用户原始需求

> 将树状结构渲染成类似于 Markdown 的有层级的文档形式。
> (a) 左侧保留一个 Tree 结构，与 Mind Map 等价、更紧凑，支持拖拽重排（与 Map 交互一致）；
> (b) 添加 Map 模式 / Markdown 模式切换按钮；
> 渲染规则：清晰的 Block 块区分层级（防搞错区域）；node 的 title 是 Head（标题），备注是 Text（正文）。

## 需求说明

- 痛点：节点 note 是 markdown 长文，画布模式下只能逐个点开备注面板看，缺乏整体文档感——长内容导图的**阅读**体验缺一种视图
- 用户拍板的三个决策（AskUserQuestion）：
  1. 文档区**可就地编辑**（双击改文字，自动保存走现有接口；不支持文档模式内增删节点）
  2. 层级映射：**根 = 文档大标题，子级 depth 1..6 → H1..H6，≥7 级缩进退化普通块**（后收敛为 3 档 heading，见 Overview）
  3. Tree **仅在文档模式显示**（Map 模式保持全屏画布现状）
- 后续演进（用户反馈驱动，详见交互细节节）：09-24 统一视图头部/块视觉收敛；
  09-26 Notion 本尊路线；**09-26 Tree 拖拽整体移除**（docs 内拖拽体验差，
  重排回画布做——推翻原始需求中"Tree 支持拖拽重排"一条）
- 计划：`~/.claude/plans/linked-mapping-dahl.md`（linked-mapping-globe，已批准）

## Overview Design

### 视图与数据

| 维度 | 决策 |
|------|------|
| 模式状态 | `docMode` localStorage 持久化（layoutMode 同款惯例）；会话态（focusId 等）不动，切回画布恢复 |
| 数据源 | 复用 `detail` 单一数据源 + WS 全量重拉——DocMode 不自持树状态，Agent 改动实时刷文档 |
| 折叠 | 复用 `node.collapsed`（WS 全端同步免费）：Map 折叠 → 文档模式收起，反向亦然 |
| **后端零改动** | get_map 全树含 note、update_node/move_node/set_node_collapsed 全现成；无 migration、无 SDK 重生成 |

### 层级映射（docTree.headingLevel 单点实现）

```
depth 0        → .doc-title（文档大标题，28px/700）
depth 1..3     → .doc-h1..h3（26/20/17px 三档——Notion 同款：更多档位人眼分不出）
depth ≥4       → .doc-h-deep（15px/600 小节段落，不再假装 heading）
缩进           → depth 0/1 顶格（章节线笔直），depth≥2 内收 24px/级（6 级封顶）
正文           → 16px/1.6（Notion 阅读档）
留白节拍       → H1 前 32px / H2 前 20px / 深层 6px（对比 >5:1）
gutter         → hover/选中显形：⋮⋮ 把手 + #N 锚点（平时标题纯文本）
```

block 视觉三连改（2026-09-24 → 09-26 用户反馈驱动）：①首版 = 20px/级缩进
+ 左边框 + accent 选中 → ②反馈"去缩进去边框、选中用浅灰底"（纯字号路线，
深层 H4-H6 字号挤在 13-15px 信号稀释，结构难辨）→ ③**Notion 本尊路线**
（终态，见上方映射表）：结构感 = 轻缩进 + 3 档字号 + 留白节拍三者叠加，
heading 收敛 3 档、depth≥4 转小节段落、正文 16px、hover 左缘 gutter
（⋮⋮ 把手 + #N，平时隐形的干净标题）。选中底始终 = --bg-hover 浅灰
（无蓝色系）。字号规则限定 `.doc-head` 前缀（headClass 同时挂块上驱动
间距/缩进，防字号泄漏）。

**收拢只由左侧 Tree 提供**（用户拍板）：文档块无折叠钮（FoldBtn 组件从
DocView 移除、Props 删 onToggleFold），DocMode 的 Space 折叠快捷键一并
收掉——收/放的唯一入口是 Tree 行的折叠钮（WS 全端同步照旧，文档块随
折叠裁剪）。

**正文编辑 = 块内嵌 vditor**（2026-09-26 用户指出块内 textarea 不用
"侧边栏那个 Markdown 编辑器"的效果；**二修**：第一版做成双击弹侧边栏
面板，用户澄清要的是就地编辑但编辑器效果同侧边栏——最终形态 `DocNoteEditor`：
双击正文/空占位 → 块内就地挂 vditor（lazy chunk 复用，工具栏/IR 即时渲染/
粘贴上传含 map 分目录全套），**Ctrl+Enter 提交、点击外部自动保存收起**
（click capture 在目标处理前到达——先保存旧编辑，随后的选中/双击开新编辑
在新状态下自然进行；closest('.doc-note-vditor, .vditor') 放行编辑器自身
含挂到 body 的弹层/全屏层；用 click 而非 pointerdown——拖滚动条不产生
click，阅读长文不误触收起）、Esc 丢弃、卸载 flush、判脏不发请求（DocEditor
同款状态机，未改动点外部不造版本快照）；侧边栏面板不出现在 doc 模式
（d 键照旧全禁）。标题编辑保持块内 textarea（blur 提交）。e2e 排查实录
两则：①vditor 的
input→draft 是异步链，合成输入后立即断言必假等（Playwright CDP 键盘与
contenteditable 的时序坑，HEAD 基线同样如此非回归；正确姿势=输入后等
传播再操作，或经 flush/按钮路径断言）；②完整流程中 wait_for_selector
的 visible 判定会玄学超时而元素实际已挂载且有尺寸——DOM 计数轮询断言
更可靠。

### Map / Tree 拖拽三区对照

| | Map（ReactFlow） | Tree（pointer events 自研） |
|---|---|---|
| before/after 带 | 节点**矩形外**上下扩 16px（覆盖兄弟间隙 32px） | 行**内部**上/下 30%（行紧贴无外部空间） |
| child 区 | 矩形内部 100% | 行中间 40% |
| dwell | 150ms zone 停稳确认（timer 补位） | 同款（结构照抄） |
| 防环 | 拖起收集后代，命中标红；服务端兜底 | 同款 |
| 提交 | `moveNode(dragId, parentId, position+(after?1:0))`，无乐观更新 | 同款换算 |
| 高亮 | 直改 DOM class（拖动帧率优先） | React state（dwell 确认后才 set，TreeRow memo 只重渲染两行） |

不抽公共拖拽模块：Map 版深度耦合 RF DOM 与回调闭包，且两版命中几何不同，平行实现各自更清晰。

### 就地编辑状态机（DocView.DocEditor）

- uncontrolled textarea：detail 全量重拉不打断打字；block 按 display_id memo（字段级比较）
- 提交判脏：值 === 基线不发请求（不造垃圾版本快照），**但 Enter/blur 仍退出编辑态**（"我完成了"）
- 保存成功才前移基线（失败可重试不被判"无变化"吞掉）
- 卸载兜底 flush（切编辑目标/切模式/删节点）：只发请求**不动 editing state**
- **StrictMode 陷阱**（实测踩坑）：不能"卸载置 alive=false"防迟到回调——dev 双挂载会把它永久打成 false，之后所有成功保存都不收起编辑器。改用 onSuccessRef（卸载置 null，send 每次调用重新赋值）
- 同一时刻至多一个编辑态；content 与 note 二选一

### 交互细节

- **Tree 拖拽已移除**（2026-09-26 用户拍板："docs 内拖拽体验差，就算有也不好用"）：DocTree 退化为纯导航（点选定位 + 折叠收放），首版三区拖拽（pointer events + dwell + 防环 + moveNode 提交链）与 gutter 的 ⋮⋮ 把手整体删除；重排回画布做。gutter 只留 #N（hover/选中显形）
- **统一视图头部（2026-09-24 收敛改版）**：两模式共用 `.view-head` 实体行——标题区（#id/标题/v版本/面包屑）恒在最左，模式工具组挂标题右侧（Map = 文档模式钮+布局钮+刻度条三件套，Doc = "画布"返回钮），宽度差吸收进右侧 spacer。Map 的标题/工具从画布悬浮（.map-title/.canvas-tools absolute）收进此行——**切换瞬间头部 4 元素实测零位移**（getBoundingClientRect 逐像素对比 4/4 STABLE），只有工具组内容换。头部固定 44px 行高（工具组高度差不传导）；顺带消除了 .doc-head 与 doc-block 标题行的 class 撞名。首版踩坑两则：返回钮放头部右端被 ChatPanel（默认开启）头部遮挡→移左；工具组放标题左侧会把标题横向推挤→标题恒左
- 联动：两栏点击共用 selectedId；选中变化 60ms 后两栏 scrollIntoView（等展开祖先的新行渲染）
- 快捷键：画布全局键 `if (docMode) return` 全禁（Esc 浮层链除外）；DocMode 自挂 F2（编辑标题）/ Space（折叠）/ ↑↓（可见行序列移动）
- Esc 不切模式（持久偏好防误触，头部按钮切换）
- 不做虚拟化：collapsed 裁剪天然限长；>500 可见块再评估

## 实现描述

| 文件 | 改动 |
|------|------|
| `fe/src/docTree.ts`（新） | buildDocRows（DFS 可见行，两栏共用）/ collectDescendants（防环）/ headingLevel（6 级封顶单点） |
| `fe/src/DocTree.tsx`（新） | 左树：行渲染（--depth 缩进）+ pointer 拖拽（6px 阈值启动 + 行内三区 + dwell + 防环 + 边缘自动滚动 + touch-action:pan-y）+ 拖拽尾巴 click 吞除 |
| `fe/src/DocView.tsx`（新） | 文档块：标题阶梯 + note markdown（react-markdown + mdComponents 同 ChatPanel 管线，mermaid 免费）+ DocEditor 就地编辑状态机 |
| `fe/src/DocMode.tsx`（新） | 主体：Tree+View 组装/联动 effect/快捷键/编辑失联守卫（渲染期派生 editingLive，不 setState）。头部在编辑器级统一渲染，本组件不含 chrome |
| `fe/src/MindMapEditor.tsx`（改） | docMode state + toggleDocMode（清画布输入态）；updateNode 收口（saveNote 改薄封装消重）+ moveNodeTo + toggleDocFold；**统一视图头部 .view-head（工具组按模式切换 + 原画布标题区收进）**；editor-main 条件渲染（rf-wrap 原样包进 ternary）；快捷键 `if (docMode) return` |
| `fe/src/App.css`（改） | .view-head/.view-tools 统一头部段（Map 悬浮标题/工具样式收敛为实体行）+ .doc-* 段（chrome token、block 左边框、标题阶梯、编辑器像素级对齐、三区高亮系）；.detail-panel top 让位随悬浮区撤销而调整 |
| `fe/src/i18n.tsx`（改） | doc.* 8 key + help.doc* 8 key 双语 |
| `fe/src/HelpPanel.tsx`（改） | "文档模式"小节（切换/拖拽/就地编辑/快捷键） |

**API 调用全部收在 MindMapEditor（回调下发），DocMode 一族是纯交互层。**

## 验证结果

- `npx tsc -b` / `npx oxlint`（新文件 0 warning，总量 18 = 存量不涨）/ `npm run build` 全过
- Playwright 端到端（dev server + 真 uvicorn，23/23 通过）：
  - 模式：切入/切回画布、刷新后保持（localStorage）
  - 渲染：根=大标题、depth1→H1、depth6→H6、**depth7→缩进退化**；note 的粗体/表格渲染；空正文占位；块/树行数与节点一致
  - 联动：点 Tree 行 → 文档块选中
  - 就地编辑：标题 Enter 提交 + WS 回流更新；正文 Ctrl+Enter 提交 + markdown 重渲染
  - 拖拽：child 区蓝高亮 + 挂子生效（缩进变化）；before 区插入线高亮；**拖自身子树红拒**；dwell 停稳确认
- 视觉：浅色/深色主题截图各过一遍（token var() 自动翻转）；修掉 #N 角标与标题间距问题
- **收敛改版复验（2026-09-24）**：头部 4 元素（view-head/#id/标题/v版本）切换前后 getBoundingClientRect 全等（4/4 STABLE，含 x 与 y）；e2e 23/23 复跑通过（选择器 .canvas-tools → .view-tools）；两模式截图对比确认头部同构
- 开发中修掉的两个真实 bug：StrictMode 双挂载导致保存后编辑器不收起（见上）；ChatPanel 遮挡右端按钮（按钮移左，后随统一头部改版一并解决）
- 后端 `uv run pytest` 未跑（零改动，未触后端代码）
