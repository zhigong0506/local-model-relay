# Local Model Relay

Local Model Relay 是一个零构建的本地模型中转控制台。它把多个 OpenAI-compatible 上游服务收拢到一个本地 `/v1` 接口后面，让你可以在浏览器里管理线路优先级、模型路由、故障转移、请求记录和 Token 用量。

这个项目面向个人本地使用，不包含多用户、计费、支付或账号共享功能。

## 主要功能

- 本地管理界面：`http://127.0.0.1:25818/admin`
- 本地 OpenAI-compatible API：`http://127.0.0.1:25818/v1`
- 多上游线路管理：优先级、超时、冷却、模型列表、凭据分组
- 模型路由：虚拟模型名映射到多条真实线路目标
- 自动故障转移：遇到 `401`、`403`、`429`、`500`、`502`、`503`、`504` 等错误时自动尝试下一条线路
- 路由起点：可手动指定从某条线路开始故障转移，支持自动推进或锁定不变
- 出站代理：支持全局直连、系统代理、自定义代理，也支持单条线路覆盖
- Chat Completions 和 Responses 协议转换
- 仪表盘：请求量、Token 趋势、模型分布、最近用量
- 请求记录：筛选、排序、CSV 导出、清空记录
- Token 用量统计：支持上游 usage，也支持无 usage 时的本地估算
- 端到端测试脚本：故障转移测试和 usage 估算测试
- 无构建、无 npm 依赖、无外部数据库

## 快速开始

确保本机已经安装 Node.js 20 或更高版本。

```powershell
npm start
```

然后打开：

```text
http://127.0.0.1:25818/admin
```

默认本地接口配置：

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
```

## 客户端接入

任何支持 OpenAI-compatible 接口的客户端都可以接入本地端口。

示例：

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
model    = 你在模型路由中配置的虚拟模型名
```

测试模型列表：

```powershell
curl http://127.0.0.1:25818/v1/models -H "Authorization: Bearer local-relay"
```

## 配置文件

运行时配置位于：

```text
data/config.json
```

运行状态和请求记录位于：

```text
data/state.json
```

这两个文件默认不会提交到 git，因为它们可能包含 API Key、上游地址、请求记录或本地使用数据。

仓库里只提供安全模板：

```text
data/config.example.json
```

首次使用时，可以参考这个模板从管理界面添加自己的线路配置。

## 模型路由与故障转移

模型路由用于把客户端请求的虚拟模型名映射到多条真实上游线路。

例如：

```text
my-gpt-model
  -> Provider A / gpt-example
  -> Provider B / gpt-example
  -> Provider C / gpt-example
```

当 Provider A 返回可重试错误或网络失败时，本地代理会自动尝试 Provider B，然后再尝试 Provider C。

模型路由会自动跟随线路优先级排序。如果某条线路声明支持某个模型，保存线路后会自动加入对应模型路由。

线路页可以把某条线路设为“路由起点”。`auto` 模式下，最近一次成功线路会成为下一次请求的起点；`locked` 模式下，起点不会被成功请求自动改写。

## 出站代理

设置页可以选择全局出站模式：

- `direct`：直连
- `system`：使用系统代理
- `custom`：使用自定义 HTTP/HTTPS 代理

线路编辑页也可以单独指定代理模式。这样可以让某些线路直连，另一些线路走国外代理，而本地 `/admin` 和 `/v1` 入站访问始终保持本机访问。

## 协议转换

每条线路可以配置为：

- `chat`：Chat Completions
- `responses`：Responses
- `auto`：跟随客户端请求协议

当客户端和上游协议不一致时，Local Model Relay 会尽量进行基础转换。例如客户端使用 Chat Completions，而某条上游只适合 Responses，代理会转换请求和响应。

## Token 用量

项目会优先读取上游响应里的 `usage` 字段。

如果上游没有返回 usage，或者客户端在流式响应结束前断开，项目会生成一个本地估算值，并在前端标记为“估算”。估算值只用于本地观察，不应视为上游精确计费结果。

## 测试

语法检查：

```powershell
npm run check
```

故障转移端到端测试：

```powershell
npm run test:failover
```

usage 估算端到端测试：

```powershell
npm run test:usage-estimate
```

出站代理测试：

```powershell
npm run test:outbound-proxy
```

路由起点测试：

```powershell
npm run test:sticky-routing
```

这些测试会临时启动本地 mock 上游，调用真实的本地 `/v1` 接口，并在结束后清理临时线路和模型路由。

## 安全说明

- 不要提交 `data/config.json`
- 不要提交 `data/state.json`
- 不要把包含明文 API Key 的导出配置发布到公开仓库
- 默认实现为了简单可靠，会把 API Key 保存在本机 JSON 文件里
- 如果需要多人环境或更强安全性，建议接入系统密钥库或本机加密机制

## 桌面启动

Windows 下可以使用：

```text
open-control-panel.vbs
start-hidden.vbs
stop.bat
```

也可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

来创建桌面快捷方式。

## 项目定位

Local Model Relay 是一个个人本地工具，目标是让多个模型服务入口变得更稳定、更容易观察、更容易切换。

它不提供公开服务端能力，不负责多用户隔离、余额管理、支付、分销或账号共享。
