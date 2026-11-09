# dsh-workbuddy

> A **WorkBuddy** workbench for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).
> Adds a right-sidebar panel **and** agent tools that hand real work to the WorkBuddy desktop app running on the same machine.
>
> 把本机正在运行的 **WorkBuddy 桌面版**（腾讯 CodeBuddy）接进 DSH：右栏面板 + 三个模型工具，把活真的派出去。

派出去的是真活：默认角色 `general-purpose` 在**这台机器上**有自己的 Read / Write / Edit / Bash / PowerShell / Glob / Grep / WebFetch / WebSearch / Skill 和独立 shell。你在 DSH 里看到的不是"另一个聊天框"，而是一个真的会动文件、跑命令的工位。

```
DSH 对话 / 右栏面板  ──派活──▶  WorkBuddy 网关  ──▶  codebuddy agent（本机，有工具）
                     ◀──交回──                  ◀──
```

---

## 安装 / Install

要求：**Windows**（插件依赖 `discover.ps1` 读进程环境）、DSH `>=0.2.0-rc.2`、本机装了 WorkBuddy 桌面版并已登录。

### 方式 A：`plugin_manager`（推荐）

```
plugin_manager  action: install_bundle  target: <仓库目录的绝对路径>
```

安装后重启一次 `dsh web`（`cordis.patch.yml` 只在 startup 读取）。

### 方式 B：手动挂进 profile

1. 把仓库放到任意目录，例如 `C:\Users\<you>\.dsh\plugins\dsh-workbuddy`；
2. 在 `~/.dsh/profiles/<profile>/package.json` 的 `dependencies` 里加一行
   `"dsh-workbuddy": "link:<上面的目录>"`；
3. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: workbuddy
      name: 'dsh-workbuddy'
```

4. 重启 `dsh web`。

### 检查是否装好

对话里问一句"WorkBuddy 通道状态"，或用工具：

```
workbuddy_probe {}
```

`gateway: true` 表示通道通了（会返回端口与 pid）。

---

## 面板（右栏 tab「WorkBuddy 工作台」）

打开方式：右栏 → 引导页（或 tab 条的「+」）→ **WorkBuddy 工作台**。

界面按 WorkBuddy 自己的设计语言做：白/深底、不画边框、靠浅一档的底分区、线性图标、胶囊标签、大圆角、**列表 + 详情**两级。

| 区域 | 干什么 |
|---|---|
| 顶部 | 通道状态（已连接 · 端口 / 预热中 / 未运行）+ 刷新 |
| 新建任务 / 正在运行 | 聚焦输入框 / 只看在跑的 |
| `+` 菜单 | 添加文件（插入本地绝对路径）/ 专家 / 技能 / 模式 / 连接器 |
| 权限 | 默认权限 / 完全访问 / 只读（对应 `bypassPermissions`） |
| 模型 | 下拉换模型，倍率与徽章跟随 WorkBuddy 的产品配置 |
| 任务书 + 派出 | 一段自包含任务书，`Ctrl+Enter` 派出 |
| 交接记录 | 状态胶囊、模型、角色、来源（面板派出 / 模型派出）、耗时；点开看任务书全文与它交回的内容，可停止 / 复制 / 填回 |
| 分段筛选 | 全部 / 运行 / 完成 / 失败 |
| 底栏 | 账本条数 + 清空（落盘文件保留） |

面板里画的所有模型/品牌图标都来自 WorkBuddy 自己的 `app.asar`，所以和桌面端一致（GLM = `Z`、混元 = 太极球、MiniMax 与 DeepSeek 走默认圆）。

---

## 工具 / Agent tools

| 工具 | 作用 |
|---|---|
| `workbuddy` | 把一段任务书派给 WorkBuddy，等它交回文本 |
| `workbuddy_jobs` | 查交接账本（可按状态过滤 / 取单条详情） |
| `workbuddy_probe` | 探通道状态（是否在跑、网关端口、预热进程） |

`workbuddy` 的参数：

```jsonc
{
  "prompt": "必填，自包含的任务书：路径、目标、输出格式都写上",
  "agent": "general-purpose | pulse | Explore | Plan",   // 不给就是 general-purpose
  "model": "glm-5.3 / kimi-k3 / deepseek-v4.1-flash …",  // 不给就用 WorkBuddy 默认
  "skill": "workbuddy-pdf / wechat-article-search …",    // 不给就让它自己挑（通常更好）
  "system": "可选的系统提示",
  "maxTurns": 20,
  "fullAccess": false,        // true = bypassPermissions
  "timeoutSec": 900
}
```

**关于技能**：`skill` 会在任务书前加一句 `【使用技能】优先用「x」完成任务`。WorkBuddy 的 agent 会真的去读那个技能的 `SKILL.md` 并遵守它的约束（实测：让它用 `workbuddy-pdf` 生成 PDF，它发现该技能只能读不能写，于是改用 Word COM 导出，并说明原因）。

---

## 它是怎么工作的 / How it works

### 1. 找到网关

WorkBuddy 桌面端会拉起 `codebuddy` 进程，两种：

- `codebuddy --prewarm`：待命池，**通常不监听端口**；
- `codebuddy --serve --session-id …`：真正跑任务的会话进程，**端口在它身上**。

`lib/discover.ps1` 用 P/Invoke（`NtQueryInformationProcess` + `ReadProcessMemory`）读这两种进程的**环境块**，取出 `CODEBUDDY_GATEWAY_PASSWORD`，再配上该进程的监听端口，得到 `{ port, password }`。然后 `GET /api/v1/stats` 探活（200 = 通，401 = 密码不对，404 = 不是它）。

### 2. 派活的两条通道

| 通道 | 接口 | 会不会在 WorkBuddy 里留任务 |
|---|---|---|
| 一次性 | `POST /api/v1/llm/completions` | **不会**。底层 `runOneTimeWithOverrides`，不建会话 |
| 会话（实验） | `POST /api/v1/acp`（JSON-RPC over HTTP + SSE） | **会**。建真会话，能在 WorkBuddy 任务列表里看到并接着聊 |

ACP 流程（已实测跑通，代码见 `test/probe-acp2.mjs`）：

```
POST /api/v1/acp/connect          → { connectionId, sessionToken }
POST /api/v1/acp  initialize      → 协议版本 / 能力
POST /api/v1/acp  session/new     → SSE: session/update（含 sessionId）
POST /api/v1/acp  session/prompt  → SSE: session_update / usage_update / result
```

后续每个请求都要带 `acp-connection-id` 与 `acp-session-token`。

### 3. 账本

所有派出的活（不管来自面板还是模型工具）都记在 `~/.dsh/workbuddy/jobs.jsonl`，上限 300 条，面板与 `workbuddy_jobs` 读同一份。

### 4. 前端

`panel/panel.html` 是一个**自包含单文件**（图标数据也内联在里面），由 `client.js` 用 iframe 挂进右栏 tab。改面板只需要刷新页面；改 `lib/*.js` 或 `client.js` 需要重启 `dsh web`。

---

## 兼容性 / Compatibility

| 项 | 值 |
|---|---|
| DSH | `>=0.2.0-rc.2 <0.3.0`，实测 `0.2.1-rc.2` |
| 平台 | Windows（`os: ["win32"]`） |
| WorkBuddy | 实测 `5.9.3` |

---

## 已知限制 / Limitations

- **只在 Windows 上工作**：进程环境读取与端口枚举都是 Win32 调用。
- **一次性通道不会在 WorkBuddy 里留任务**：想留就用 ACP 通道（已跑通，面板尚未默认切过去）。
- **预热进程会被回收**：WorkBuddy 闲置一段时间会杀掉 `--prewarm`。插件会重探一次并给出可照做的提示，但仍需你在 WorkBuddy 里发一句话把它唤醒。
- **模式和连接器不可用**：这两项需要 App 的登录态与内部接口，面板里置灰，不做假功能。
- **`credits` 为空的模型不显示**：那是内部别名（如 `default-1.1` = Claude-3.7-Sonnet）、编辑器补全、图像/视频生成模型，原版下拉也不给选。

---

## 第三方资源 / Third-party assets

- `panel/brand-icons.js`、`panel/panel.html` 里的模型/品牌图标 SVG **提取自 WorkBuddy 桌面端的 `app.asar`**，版权归腾讯及相关品牌方所有。此处仅用于在本机复现 WorkBuddy 自身的界面外观，**不随本仓库的 MIT 许可授权**；再分发或商用前请自行确认授权。
- `icon.svg` 为本项目原创（MIT）。
- 插件本身不包含 WorkBuddy 的任何二进制、不绕过其登录，只是消费本机已登录实例提供的本地 HTTP 网关。

---

## 开发 / Development

```bash
node --check lib/index.js lib/gateway.js lib/server.js lib/runtime.js

node lib/cli.mjs probe          # 探通道
node lib/cli.mjs ask "..."      # 命令行派一个活

node test/panel-smoke.mjs 5130  # 单独起面板预览（不需要 dsh）
node test/probe-acp2.mjs        # 走一遍 ACP 建会话 + 派活
```

```
lib/index.js     插件入口：注册 3 个工具 + 挂 HTTP 路由
lib/gateway.js   端点发现、探活、completions 调用（含通道自愈重试）
lib/discover.ps1 读 codebuddy 进程环境拿网关密码与端口
lib/runtime.js   任务账本、模型/技能目录、并发调度
lib/server.js    面板用的 HTTP 路由
client.js        右栏 tab 注册（iframe 外壳）
panel/           面板本体（单文件 HTML）
```

---

## License

MIT（`icon.svg` 与全部源码）。`panel/` 内的品牌图标见上面的第三方资源说明。
