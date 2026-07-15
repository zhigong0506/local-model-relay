# Local Model Relay

[![Node.js CI](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml/badge.svg)](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Local Model Relay 是一个面向个人使用的本地大模型 API 中转控制台。它把多个 OpenAI-compatible 第三方线路、不同 Key 和不同模型统一收拢到一个本地 `/v1` 端口，并在请求失败、额度耗尽或流式连接异常时，按照你设置的优先级自动尝试下一条可用线路。

项目重点不是替你修改各个 AI 客户端的配置，而是提供一个长期稳定的本地 API 入口：Codex、OpenAI SDK、聊天客户端或其他兼容工具只需要连接本机端口，线路选择、协议转换、故障转移、测试、诊断和用量统计都由 Local Model Relay 处理。

> 这是个人桌面工具，不是多用户网关、公开中转站、计费系统或账号共享平台。请保持服务监听在 `127.0.0.1`。

## 核心能力

### 多线路与模型路由

- 保存多个上游的 Base URL、多个 Key、支持模型、优先级、超时、冷却时间和备注。
- 使用分组整理 OpenAI、DeepSeek 或自行创建的其他线路类别；分组不改变真实故障转移顺序。
- 将一个客户端模型名映射到多条真实线路和真实模型，例如：

```text
gpt-5.6-luna
  -> 线路 A / gpt-5.6-luna
  -> 线路 B / gpt-5.6-luna
  -> 线路 C / gpt-5.4-mini
```

- 新增线路或调整线路优先级时，模型路由会同步补充和排序对应目标。
- 支持自动推进、锁定起点和单线锁定三种起点模式。

### 请求级故障转移

- 对 `401`、`402`、`403`、`408`、`409`、`425`、`429`、`5xx`、Cloudflare `520-524` 和常见网络错误自动尝试后续线路。
- 识别“HTTP 200 但正文其实是错误包”的伪成功响应，避免把上游错误当成正常回答。
- 已停用、无可用 Key、正在冷却或不支持目标模型的线路会被跳过，并在日志中说明原因。
- 长任务遇到额度耗尽后会冷却故障线路，后续请求可直接从健康线路继续。
- 支持会话亲和：同一会话优先继续使用此前成功线路，线路不可用时再回到普通路由。

### Codex 与流式协议

- 同时支持 `/v1/chat/completions` 和 `/v1/responses`，可在线路级选择 Chat、Responses 或自动协议。
- 支持 Responses 文本事件、函数调用、工具参数流和工具结果回传。
- 在尚未输出不可逆内容时，可对 `response.failed`、错误事件、不完整起始流和空闲流执行安全切线。
- 一旦有效正文已经发送给客户端，不会把另一条线路的回答拼接进原流，以免破坏上下文和工具调用。
- 连续未完成重连达到阈值后触发较长冷却，使 Codex 下一次自动重连避开持续故障线路。
- 当某条线路明确不支持 `max` 思考强度时，仅在该线路内部尝试一次 `xhigh`；后续支持 `max` 的线路仍收到原始请求。
- 可选 Codex OAuth 账号线路支持浏览器登录、账号导入、Token 自动刷新和同线路多账号切换。

### 测试与诊断

- 快速测试：读取 `/v1/models` 并选择是否保存模型列表。
- 真实测试：从线路已保存模型中选择一个，发起真实 Chat 或 Responses 请求。
- 模型路由测试：展示实际命中的线路、模型、协议、每次尝试状态和延迟。
- 独立测速：临时粘贴 URL、Key 和模型，多轮统计首字延迟、总耗时和输出速度，不写入正式线路。
- Codex 请求头验证只属于手动测试，不会限制其他客户端，也不会改变正常转发顺序。
- 日志提供简短错误摘要；展开后可查看、复制完整原因，或交给用户自行配置的诊断模型分析。

### 用量与管理界面

- 请求记录支持分页、状态/模型/线路筛选、日期范围和 CSV 导出。
- 统计输入、输出、缓存写入、缓存命中和总 Token，并按模型、线路和时间维度展示。
- 上游未返回 usage 时可进行本地估算；真实缓存 Token 仍只能以上游返回字段为准。
- 饼图、趋势图和图例采用紧凑布局，支持日间、夜间和跟随系统主题。
- 支持服务级和线路级直连、系统代理、自定义代理；HTTPS 经 HTTP 代理使用 CONNECT 隧道。
- 配置导出默认脱敏，完整密钥导出仅适合本机备份。

## 与 CC Switch 的区别

[CC Switch](https://github.com/farion1231/cc-switch) 是成熟的跨平台 AI 工具配置管理器。根据其官方项目说明，它面向 Claude Code、Claude Desktop、Codex、Gemini CLI、OpenCode、OpenClaw、Hermes 等多个工具，提供 Provider 预设、配置切换、MCP/Skills 管理、云同步、系统托盘、会话管理，并且也包含本地代理、故障转移和用量统计。

两者存在交集，但主目标不同：

| 维度 | Local Model Relay | CC Switch |
| --- | --- | --- |
| 核心定位 | 单一稳定本地 API 入口和请求级路由器 | 多种 AI 工具的一体化配置与资源管理器 |
| 使用方式 | 客户端长期连接 `127.0.0.1:25818/v1` | 通过桌面应用管理并切换各工具配置，也可启用本地代理 |
| 主要关注点 | 模型级路由、逐线路尝试链、协议转换、流式故障边界、诊断 | Provider 预设、跨工具配置、MCP、Skills、Prompt、会话、云同步 |
| 技术形态 | Node.js、Vanilla Web UI、JSON、零构建、无运行时 npm 依赖 | Tauri 2 原生桌面应用、Rust/TypeScript、SQLite |
| 支持范围 | OpenAI-compatible Chat/Responses 客户端 | 多种编码 Agent 和桌面客户端生态 |
| 故障转移视角 | 围绕每个模型请求保存候选顺序、尝试状态、流式阶段和线路冷却 | 围绕多工具 Provider 管理，并提供代理热切换、健康检查和熔断 |
| 配置侵入性 | 不需要反复改写各客户端配置，只需固定本地 Base URL | 核心能力之一是统一管理和同步各客户端配置 |
| 适合用户 | 已购买多家 API 中转，希望精细控制每个模型如何逐级切线 | 同时使用多种 AI 工具，希望集中管理 Provider、MCP、Skills 和配置 |

简单来说：**CC Switch 更像 AI 编程工具的综合控制中心；Local Model Relay 更像专注 OpenAI-compatible 请求链路的本地路由与故障转移层。** 如果主要需求是跨工具配置、MCP 和 Skills 管理，CC Switch 更完整；如果主要需求是让一个模型请求按自定义线路顺序逐级转发，并观察每次失败、协议转换和 Token 结果，Local Model Relay 更直接。

本项目不以替代 CC Switch 为目标，也不会引入其完整的客户端配置接管、MCP/Skills 管理和云同步体系。

## 安装

### 环境要求

- Windows、macOS 或 Linux
- Node.js 20 或更高版本
- 使用 `git clone` 时需要 Git

项目没有运行时 npm 依赖，因此克隆后不需要执行 `npm install`。

### 下载并运行

```powershell
git clone https://github.com/zhigong0506/local-model-relay.git
cd local-model-relay
npm start
```

打开：

```text
管理界面: http://127.0.0.1:25818/admin
本地 API: http://127.0.0.1:25818/v1
默认 Key: local-relay
```

Windows 用户可以创建桌面快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

脚本会自动识别当前克隆目录。也可以直接双击 `open-control-panel.vbs`。

## 第一次使用

1. 在线路页新增一个 Base URL 和 API Key。
2. 选择上游协议：Chat Completions、Responses 或自动。
3. 执行快速测试并保存发现到的模型。
4. 选择一个已保存模型执行真实测试。
5. 检查自动创建的模型路由和线路顺序。
6. 将客户端 Base URL 指向本地接口。

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
```

如果电脑可能被其他人使用，请先在设置页修改默认本地 Key。

## Codex 接入

在 `%USERPROFILE%\.codex\config.toml` 中添加：

```toml
model_provider = "local_model_relay"
model = "你的虚拟模型名"

[model_providers.local_model_relay]
name = "Local Model Relay"
base_url = "http://127.0.0.1:25818/v1"
wire_api = "responses"
env_key = "LOCAL_RELAY_API_KEY"
requires_openai_auth = false
```

启动 Codex 前设置本地 Key：

```powershell
$env:LOCAL_RELAY_API_KEY = "local-relay"
```

`requires_openai_auth = false` 可以避免 Codex 账号凭据替代本地接口 Key。

## 数据与隐私

运行后会在本机创建：

```text
data/config.json   线路、路由、设置和 API Key
data/state.json    线路状态、请求记录和用量统计
logs/              后台启动日志
work/              测试过程中产生的临时文件
```

这些运行目录已被 Git 忽略。API Key 和 OAuth Token 为了保持本地实现简单，会以明文 JSON 保存；公开配置接口和默认导出会进行脱敏。不要上传 `data/`、日志、完整配置导出或包含真实线路信息的截图。

管理 API 只允许本机回环访问，但项目没有按公网服务的安全标准设计，禁止直接暴露到互联网。

## 外部雷达说明

“雷达”页面按需嵌入 [Codex Reset Radar](https://codex-reset-radar.pages.dev/)。外部内容、数据和品牌归原站点所有。本项目不抓取、不修改、不重新分发其数据，仅提供非营利本地快捷查看，也不代表双方存在官方合作。

推荐访问站主的另一个项目：[登舱](https://deng.codexradar.com/)。如站点所有者希望移除入口，请通过本仓库 [GitHub Issues](https://github.com/zhigong0506/local-model-relay/issues) 联系。

## 更新、停止与测试

更新：

```powershell
git pull --ff-only
npm start
```

前台运行时按 `Ctrl+C` 停止。Windows 用户也可以使用 `stop.bat`。

完整回归：

```powershell
npm run test:all
```

测试覆盖配置迁移、OAuth 脱敏与多账号切换、状态码故障转移、额度耗尽、HTTP 200 错误包、流式异常、Codex 文本与工具协议、重连熔断、模型路由、会话亲和、出站代理、TLS socket 错误、诊断、用量估算、缓存字段、主题图表和模型选择器。

隔离 E2E 使用随机本地端口和临时数据目录，不会修改用户正在使用的线路、路由、日志或 Token 统计。

## 已知边界

- 上游兼容性取决于中转站对 Chat Completions、Responses 和 SSE 事件格式的实现程度。
- 缓存 Token 只有在上游返回对应 usage 字段时才能准确记录。
- 已经向客户端输出有效内容的流无法无损切换到另一条线路。
- 当前不提供多用户权限、计费、支付、密钥加密、账号共享或公网部署能力。
- Codex OAuth 能力依赖上游账号权限和官方接口行为，使用者应自行确认相关服务条款。

## 安全与许可

安全说明见 [SECURITY.md](SECURITY.md)。公开 Issue、截图和日志中不要包含真实 API Key、OAuth Token、代理密码、私有 Base URL 或完整配置。

[MIT License](LICENSE)
