# 桌面壳与系统平台支持清单 (Platform Support Matrix)

本文档定义 Agent 任务调度器桌面客户端的三平台支持范围、系统版本基线、CPU 架构支持清单、Linux 依赖要求、macOS 签名公证策略以及人工 GUI 验收规范。

---

## 1. 平台与架构支持矩阵 (Platform & Architecture Matrix)

> 遵循 **E-259**：发布清单必须逐项声明 OS、版本基线、CPU 架构与对应发布资产。对于未覆盖的 CPU 架构（如 Windows arm64、Linux arm64），明确标为「未覆盖」，且下载入口严格禁止提供其他架构的安装包。

| 操作系统 | 版本基线 | CPU 架构 | 支持状态 | 资产文件名 / 命名模式 | 说明 |
|---|---|---|---|---|---|
| **Windows** | Windows 10 (1809+) / Windows 11 | **x64** | **支持** | `agsched-desktop_x64-setup.exe` / `.msi` | 依赖 Edge WebView2 Runtime (Evergreen) (E-148) |
| **Windows** | Windows 11 | **arm64** | **未覆盖** | *(无资产)* | 未进入当前构建矩阵。**禁止向 arm64 提供 x64 模拟包** (E-259) |
| **macOS** | macOS 11.0+ (Big Sur 及更高) | **arm64** (Apple Silicon) | **支持** | `agsched-desktop_aarch64.dmg` | 原生 Apple Silicon 架构产物 |
| **macOS** | macOS 11.0+ (Big Sur 及更高) | **x64** (Intel) | **未覆盖** | *(无资产)* | CI 唯一的 macOS runner 是 Apple Silicon，Intel 产物未进入构建矩阵。**禁止向 Intel 机器提供 arm64 包** (E-259) |
| **Linux** | Ubuntu 22.04 LTS 及更高 | **x64** (x86_64) | **支持** | `agsched-desktop_amd64.deb` / `.AppImage` | 官方 CI 验证基线；依赖 WebKitGTK 4.1/4.0 与 GTK3 (E-258, E-268) |
| **Linux** | Linux (全发行版) | **arm64** (aarch64) | **未覆盖** | *(无资产)* | 未进入当前构建矩阵。**禁止向 arm64 提供 x64 安装包** (E-259) |

---

## 2. Linux 发行版分级与桌面依赖 (Linux Distribution Tiers & Dependencies)

> 遵循 **E-258** 与 **E-268**：CI 运行环境采用 Ubuntu runner。官方仅将 Ubuntu 作为已验证基线；其他 Linux 发行版标为「尽力兼容」，不作同等支持保证。

### 2.1 支持层级

- **已验证基线 (Verified Baseline)**：
  - **Ubuntu 22.04 LTS / 24.04 LTS** (glibc 2.35+)
  - 纳入 GitHub Actions Ubuntu runner 自动化矩阵，进行安装载荷展开、依赖探测与随包 daemon 的真实启动 smoke。
- **尽力兼容 (Best-Effort Compatibility)**：
  - Debian 12+、Fedora 39+、Arch Linux、openSUSE Tumbleweed / Leap 15.5+、RHEL/CentOS 9+
  - 依赖用户系统具备兼容的 GTK3 与 WebKitGTK 运行库。

### 2.2 原生运行时依赖与安装指引

桌面壳初始化前，启动器 (`linux-launcher.sh` / `linux-launcher.ts`) 会在创建 GUI 窗口前检测动态链接库。若缺失以下核心系统库，进程直接在终端输出对应发行版的安装命令并终止退出，绝不静默白屏或崩溃 (E-258)：
- `libwebkit2gtk-4.1.so.0` (或 `libwebkit2gtk-4.0.so.37`)
- `libgtk-3.so.0`

**各发行版安装命令速查**：

| 发行版 | 包管理器命令 |
|---|---|
| **Ubuntu / Debian / Mint / Pop!_OS** | `sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-0 libgtk-3-0` |
| **Fedora / RHEL / Rocky / AlmaLinux** | `sudo dnf install -y webkit2gtk4.1 gtk3` |
| **Arch Linux / Manjaro** | `sudo pacman -S --needed webkit2gtk-4.1 gtk3` |
| **openSUSE / SLES** | `sudo zypper install -y libwebkit2gtk-4_1-0 libgtk-3-0` |

---

## 3. macOS 产物签名与公证门禁 (macOS Signing & Notarization Policy)

> 遵循 **E-267**：macOS 客户端受 Apple Gatekeeper 安全机制约束。

- **构建验证件 (Build Verification Artifact)**：
  - 当 CI 缺少 Apple Developer 证书凭据（未配置 `APPLE_CERTIFICATE` / `APPLE_ID`）时，构建出的产物仅标记为 `构建验证件`（资产名如 `agsched-desktop_macos-build-verification.zip`）。
  - 该产物仅用于内部开发联调与流水线验证，不作为对外分发的正式安装包。
- **正式发布门禁 (Formal Release Gate)**：
  - 正式发布版本必须且只能由通过 Apple Developer ID 签名并完成 Apple 公证（Notarization Ticket 注入）的产物放行。
  - 任何未签名或未公证产物尝试作为正式发布时，发布门禁自动阻断失败 (E-267)。

---

## 4. 上游版本锁步与平台下限策略 (Upstream Version Lockstep Policy)

> 遵循 **E-260**：当 Node.js 或 Tauri 升级并提高最低系统版本、libc 或 WebKit 要求时，必须同步更新：
> 1. CI 构建矩阵 (`.github/workflows/desktop-ci.yml`)
> 2. 本支持清单与环境矩阵 (`docs/platform-support.md`)
> 3. 发布说明 (Release Notes)
> 三者缺一项更新，发布检查即失败。

- **Node.js 运行时基线**：**Node.js 22 LTS** (`>=22.0.0`)
  - 对应 `package.json` 的 `engines.node`
  - CI 所有 runner 均固定使用 Node.js 22
  - **随包运行时**：安装包自带 daemon 运行所需的 Node，版本钉在 `packages/shell-desktop/daemon-runtime.json`（当前 **22.17.0**）；`verify-baselines` 断言该文件是 22.x 且本文档写有同一版本号，升级运行时而不改本文档即失败 (E-260)
- **桌面壳框架基线**：**Tauri v2** (`src-tauri/Cargo.toml`)
  - 采用 Rust stable 工具链
  - 前端静态资源由 `packages/web/dist` 单一产物直供 (M10-T4)
- **最低操作系统要求**：
  - Windows: Windows 10 (1809+) 64-bit
  - macOS: macOS 11.0+ (Big Sur) 64-bit / Apple Silicon
  - Linux: Ubuntu 22.04 LTS (glibc 2.35+, GTK 3.24+, WebKitGTK 4.1)

---

## 5. 安装布局与 daemon 启动契约 (Installed Layout & Daemon Launch Contract)

> 遵循 **E-209**：桌面壳每次启动只根据本次实际的 `current_exe` / `resource_dir` 解析 `DaemonLaunchSpec`，安装包不预写任何绝对路径。

daemon 是 Node 应用（入口 `bootstrap.mjs`，需要 Node >= 22），安装包把它连同运行时一起放在资源目录下：

```
<resource_dir>/
  daemon-runtime/            # pnpm deploy --prod 产出的 daemon 及其运行依赖（scripts/build-daemon-distribution.mjs）
    bootstrap.mjs            # 唯一入口
    runtime/node[.exe]       # 随包 Node 运行时（版本见 daemon-runtime.json）
    src/、migrations/、node_modules/
  web/dist/                  # M10-T4 的单次 Web 构建，daemon 的静态插件从 daemon-runtime/../web/dist 解析
```

启动契约固定为 `{ file: <resource_dir>/daemon-runtime/runtime/node[.exe], args: [<resource_dir>/daemon-runtime/bootstrap.mjs], cwd: <resource_dir> }`，由 `packages/shell-desktop/src/launch-spec.ts` 的 `resolveShippedDaemonLayout` 与 `src-tauri/src/lib.rs` 各自按同一布局推导；桌面按钮与原生自启共用同一个冻结对象，恒不经 shell。`tauri.conf.json` 的 `bundle.resources` 把这两个目录声明为随包资源，`cargo build` 即把它们复制到可执行文件旁。

daemon 的机器级单实例锁位于系统目录（Linux `/var/lib/agent-scheduler`、macOS `/Library/Application Support/agent-scheduler`、Windows `%ProgramData%\agent-scheduler`，均要求 root / Administrators 权限，见 08 节），因此 CI 的 smoke 在 POSIX runner 上以 `sudo` 执行；这不改变 `file/args/cwd`。

---

## 6. 三平台 CI 矩阵与自动化边界 (Three-Platform CI Matrix)

> 遵循 **E-265** 与 **E-209**、**E-257**：
> - Windows (`windows-latest`)、macOS (`macos-latest`)、Ubuntu (`ubuntu-latest`) 三个 runner 均执行：
>   1. `pnpm -w check`（静态检查、类型检查、单元测试）
>   2. 平台集成测试（`packages/daemon/test/platform/`，本机原生适配器）
>   3. 随包 daemon 分发构建 + Tauri 桌面壳构建（`cargo build --release`，tauri-build 同时落下随包资源）
>   4. 安装载荷展开到含空格与 Unicode 的临时根目录 → 产品层检查 → 构建机路径残留检查 → 按上一节契约解析启动清单 → **真正启动随包 daemon** 并探活 `/api/v1/health`
> - 发布门禁从 GitHub API 读回每个平台 job 的各步骤结论，逐平台逐步骤喂给 `assertReleaseVerification`：任一平台任一步骤失败，直接阻断整个版本发布并点名失败的平台与步骤，不得降级为可忽略项 (E-265)。
> - 展开后的安装载荷不得包含构建机绝对路径 (E-209)；daemon（含随包运行时与 `web/dist`）、路径适配器、桌面壳二进制任一产品层缺失均阻断发布并列出缺失项 (E-257)。
> - CI 只做 `cargo build`，不跑 `tauri bundle`：上传的产物是**构建验证件**，不是可分发安装包；macOS 正式发布另由签名/公证门禁放行 (E-267)。
> - 壳能否真的创建窗口、通知与自启是否生效，CI 不作声明，见第 7 节人工验收 (E-266)。

---

## 7. 人工 GUI 验收记录模板 (Manual GUI Acceptance Template)

> 遵循 **E-266**：CI 环境由于缺少稳定桌面图形会话与通知系统交互，**绝不声称自动完成端到端 GUI 交互测试**。
> 每个平台在正式发布前必须由人工执行并记录以下验收项：

### 验收表单模板

```markdown
### 平台 GUI 验收记录

- **验收平台**：[ ] Windows 10/11 x64  |  [ ] macOS (Apple Silicon / Intel)  |  [ ] Linux (Ubuntu 22.04/24.04)
- **系统版本**：________________________ （例如：Windows 11 23H2 / macOS 14.5 / Ubuntu 24.04 LTS）
- **屏幕缩放**：________________________ （例如：100% / 125% / 150% / 200% Retina）
- **验收日期**：YYYY-MM-DD
- **验收人员**：________________________

| 序号 | 验收项目 | 验收操作与期望结果 | 结果 (Pass/Fail) | 备注 / 截图记录 |
|---|---|---|---|---|
| 1 | **空格与 Unicode 路径启动** (E-209) | 将安装目录置于含中文和空格的路径（如 `D:\测试 目录\调度器\app.exe`）启动，窗口正常渲染且无白屏 | [ ] Pass  [ ] Fail | |
| 2 | **单实例与托盘唤醒** (AC 1) | 在应用已运行时重复启动客户端，已有窗口被唤起至最前、解除最小化并获取焦点 | [ ] Pass  [ ] Fail | |
| 3 | **Daemon 进程拉起与自启项** (E-209) | 桌面客户端能够启动内置 daemon；系统开机自启项正确写入当前绝对路径，升级路径后自动重写旧自启项 | [ ] Pass  [ ] Fail | |
| 4 | **系统原生通知与点击回跳** (E-266) | 触发任务完成或审批等待时，操作系统弹出原生通知横幅；点击通知可唤起并聚焦对应会话 | [ ] Pass  [ ] Fail | |
| 5 | **服务未启动时的引导** (E-146) | 退出 daemon 后打开桌面客户端，展示「电脑上的调度服务未启动」连接失败页及「启动调度服务」按钮 | [ ] Pass  [ ] Fail | |
| 6 | **令牌安全存储** (M10-T1) | 客户端配对成功后，令牌存入系统凭据管理器 (Windows Credential / macOS Keychain / Secret Service)，重启后保留 | [ ] Pass  [ ] Fail | |
| 7 | **Linux 依赖缺失拦截** (E-258) | 在缺少 WebKitGTK 的环境启动 launcher，控制台输出发行版安装命令并返回退出码 1，无 GUI 崩溃弹窗 | [ ] Pass  [ ] Fail | |

**验收结论**：
[ ] 满足发布标准 (Pass)
[ ] 存在阻断缺陷 (Blocked) - 缺陷单编号: _________
```
