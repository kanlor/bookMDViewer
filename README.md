# KanlorOne MarkDownViewer

**简体中文** | [English](README.en.md)

一款**轻量、完全本机**的 Markdown 查看器与编辑器，支持 Windows、macOS 与 Linux。
以 **Tauri v2** 打造，使用操作系统内建的 WebView（Windows 用 WebView2、macOS 用
WKWebView、Linux 用 WebKitGTK），而非内嵌整个 Chromium —— 因此 Windows 可执行文件仅
**约 4 MB**，闲置内存约 **30–60 MB**。

双击任何 `.md` 文件即可瞬间开启、漂亮渲染 —— 内建可导航的章节大纲、代码语法高亮、
Mermaid 图表、可即时预览的编辑器，以及一键导出成自包含的 HTML 文件。没有安装包臃肿、
没有云端、没有遥测，全部离线运作。

## 屏幕截图

### 阅读模式 —— 大纲 + 渲染后的 Markdown

左侧的**章节大纲(TOC)**会根据文件标题自动产生；点击任一项即可跳转，并会高亮你目前
正在阅读的章节。

![阅读模式与大纲侧栏](docs/screenshots/viewer.png)

### 编辑模式 —— 即时编辑与预览

按 **Edit**（或 `Ctrl+E`）打开分割编辑器。预览会随输入即时更新，左右两栏**同步滚动**，
按 `Ctrl+S` 即可存回磁盘。

![编辑模式与即时预览](docs/screenshots/editor.png)

## 功能特色

- **GFM 渲染** —— 表格、任务清单、删除线（`markdown-it`）
- **代码语法高亮**（`highlight.js`）
- **Mermaid 图表** —— 延迟加载，只有文件实际含有 ` ```mermaid ` 区块时才加载，
  纯文本文档完全不需要付出这份成本
- **大纲 / TOC 侧栏** —— 根据标题自动建立、滚动时高亮当前章节、可用 `Ctrl+\` 折叠
- **即时编辑与预览** —— 分割编辑器、左右同步滚动（`Ctrl+E`）、`Ctrl+S` 保存，
  关闭时若有未保存更改会跳出确认
- **导出 HTML** —— 在原文件旁产生单一自包含的 `.html`，内含大纲侧栏、语法高亮的
  代码，以及内嵌的 Mermaid SVG 图
- **即时重载** —— 监视打开中的文件，保存后自动重新渲染
- **文件关联** —— 双击任何 `.md` / `.markdown` 文件即可打开
- **拖放** —— 把 Markdown 文件拖进窗口即可打开
- **文档内搜索**（`Ctrl+F`）、**打开文件对话框**（`Ctrl+O`）与**最近打开列表**
- **YAML front matter** —— 开头的 `---...---` 会渲染成漂亮的 metadata 卡片（标题、description、日期、标签、Draft 徽章），而非乱掉的分隔线
- **本机相对路径图片** —— 文件中 `![](images/x.png)` 会正确显示
- **多编码兼容** —— 自动识别 UTF-8 / GBK / Big5 / Shift_JIS / EUC-KR 等编码，
  Windows 记事本默认保存的 ANSI 文件可直接打开
- **底部状态栏** —— 实时显示文件路径、章节数量（H1/H2）、内容统计（中文数/总字/图表/代码块）、文件属性（大小/修改日期）
- **安全** —— 渲染后的 HTML 会经过 DOMPurify 清理并套用严格 CSP，打开不信任的文件也不会执行恶意脚本
- 深色 / 浅色主题跟随系统设定
- 外部链接以你的默认浏览器打开

## 下载

到 [**Releases**](https://github.com/craig7351/bookMDViewer/releases/latest) 页面获取最新版本：

| 平台 | 文件 |
| --- | --- |
| Windows（安装版，**推荐**） | `KanlorOne MarkDownViewer_*_x64-setup.exe` 或 `*_x64_en-US.msi` |
| Windows（免安装便携版） | `KanlorOne MarkDownViewer_*_x64_portable.exe` |
| macOS（Apple Silicon / Intel） | `*_aarch64.dmg` / `*_x64.dmg` |
| Linux | `*_amd64.AppImage`、`*_amd64.deb`、`*.x86_64.rpm` |

> 安装版会注册 `.md` 文件关联（双击即可打开）；便携版免安装即可运行，但不会更改
> 文件关联。所有版本都需要系统内建的 WebView（Windows 11 已预载 WebView2）。

### 杀毒软件误报（Windows）

本软件为开源、且 exe **尚未经代码签名（code signing）**，Windows Defender 或
SmartScreen 偶尔会把它误判为 `Program:Win32/Wacapew.A!ml` 之类的「潜在不需要的
程序（PUA）」。这是**误报**而非真的恶意程序 —— 名称中的 `!ml` 代表这是机器学习的
*推测性*判断，而非病毒特征码比对。

- **建议优先下载「安装版」**，误报几率通常比免安装便携版低。
- 所有安装文件都由 GitHub Actions 直接从公开源代码自动构建，你可自行把 exe 丢到
  [VirusTotal](https://www.virustotal.com) 验证（典型误报的特征是：数十家引擎中
  仅少数报、且都是 `!ml` / `PUA` / `Generic` 这类启发式名称）。
- 若被拦下，可在通知中按「允许 / 还原」，或到 **Windows 安全中心 → 病毒与威胁防护
  → 保护历史记录** 将它还原。

### macOS 首次打开（重要）

目前 macOS 版尚未经过 Apple 公证（notarization），加上近期 macOS 的安全限制越来越严格，
第一次打开时可能会被系统拦下（出现「无法打开，因为无法验证开发者」之类的消息）。
请任选一种方式解除：

- **右键打开**（Ventura 以前）：在 `KanlorOne MarkDownViewer.app` 上按右键 →「打开」→ 再按一次「打开」。
- **系统设置**（Sonoma / Sequoia）：先双击一次被挡下后，到 **系统设置 → 隐私与安全性**，
  找到被阻止的提示，按 **「仍要打开 / Open Anyway」**。
- **或用终端执行一次**（清除隔离属性）：

  ```bash
  xattr -cr "/Applications/KanlorOne MarkDownViewer.app"
  ```

之后就能正常打开，不需要每次都做。

### Linux 疑难排解

若遇到白画面、或 `libGLESv2.so.2: undefined symbol`（常见于不同 GPU/驱动/虚拟机环境），
App 已默认停用 WebKitGTK 的 DMABUF 渲染来绕过。若仍有问题，可在启动前再加一个环境变量：

```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./KanlorOne.MarkDownViewer_*_amd64.AppImage
```

（也可反过来用 `WEBKIT_DISABLE_DMABUF_RENDERER=0` 还原默认行为。）

## 键盘快捷键

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+O` | 打开文件 |
| `Ctrl+F` | 文档内搜索 |
| `Ctrl+E` | 切换编辑 / 预览 |
| `Ctrl+S` | 保存 |
| `Ctrl+\` | 切换大纲侧栏 |
| `Ctrl++` / `Ctrl+-` | 字体放大 / 缩小（也可用右上角 `A+` / `A−` 按钮） |

## 启动参数

```bash
KanlorOne-MarkDownViewer.exe file.md            # 打开并渲染
KanlorOne-MarkDownViewer.exe file.md --edit     # 直接进入编辑模式
KanlorOne-MarkDownViewer.exe file.md --zoom=1.5 # 整体 UI 放大（高 DPI / 无障碍）
```

## 开发

```bash
npm install
npm run tauri dev
```

## 在本地构建可执行文件

```bash
npm run tauri build
```

产出（Windows）：`src-tauri/target/release/KanlorOne-MarkDownViewer.exe`，以及位于
`src-tauri/target/release/bundle/` 的 NSIS / MSI 安装文件。

## 跨平台发布

推送版本 tag，GitHub Actions 会构建 Windows / macOS（Intel + Apple Silicon）/
Linux 安装文件 —— 外加一个 Windows 便携版 exe —— 并发布到 release：

```bash
git tag v1.0.0
git push origin v1.0.0
```

详见 [.github/workflows/release.yml](.github/workflows/release.yml)。
