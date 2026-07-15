# Local Model Relay

[English](README.md)

[![Node.js CI](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml/badge.svg)](https://github.com/zhigong0506/local-model-relay/actions/workflows/node.js.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Local Model Relay 是一个零构建、面向个人使用的本地模型中转控制台。它把多个
OpenAI-compatible 上游线路收拢到一个本地 `/v1` 端口，并在浏览器中统一管理线路、
模型路由、故障转移、测试、请求记录和 Token 用量。

它不是多用户网关、计费系统或账号共享平台。

## 主要能力

- 线路优先级、Key 分组、支持模型、超时、冷却时间和备注管理
- 全局与单线路直连、系统代理、自定义代理设置
- 模型路由自动跟随线路优先级，并自动加入支持相同模型的线路
- Chat Completions 与 Responses 协议转换
- 对可重试 HTTP 状态码、网络错误和流式异常进行逐级故障转移
- 对停用 Key、跳过线路、常见上游错误和 HTTP 200 错误包给出可操作的诊断与修正建议
- Codex Responses 文本流、函数调用、工具结果回传和重连熔断兼容
- 当当前线路明确拒绝 `max` 时，仅在线路内部重试一次 `xhigh`；后续支持
  `max` 的线路仍收到原始请求，不会被其他线路连带降级
- 快速连通测试、可选模型的真实测试、临时端口速度测试
- 大模型列表可搜索选择，覆盖测速和真实测试模型名筛选
- 请求记录分页、日期筛选、Token 趋势与模型/线路占比图，支持跟随系统或手动切换日/夜主题
- 缓存 Token 上报状态诊断和无 usage 时的本地估算
- 默认脱敏的配置导入导出
- 无运行时 npm 依赖、无构建步骤、无外部数据库

## 环境要求

- Node.js 20 或更高版本
- 通过 `git clone` 安装时需要 Git

项目没有运行时 npm 依赖，因此克隆后不需要执行 `npm install`。

## 安装

```powershell
git clone https://github.com/zhigong0506/local-model-relay.git
cd local-model-relay
npm start
```

打开 `http://127.0.0.1:25818/admin`，本地 API 地址为：

```text
http://127.0.0.1:25818/v1
```

Windows 用户可以创建桌面快捷方式：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create-shortcut.ps1
```

脚本会自动识别当前克隆目录，不包含作者电脑路径。也可以直接双击
`open-control-panel.vbs` 启动并打开管理界面。

## 第一次使用

1. 在线路页新增 Base URL 和 API Key。
2. 选择上游协议：Chat Completions、Responses 或自动跟随。
3. 运行快速测试，并按需保存发现的模型。
4. 从该线路已保存的模型中选择一个进行真实测试。
5. 检查自动同步生成的模型路由和线路顺序。
6. 把客户端指向本地接口。

默认客户端参数：

```text
base_url = http://127.0.0.1:25818/v1
api_key  = local-relay
```

如果电脑可能被其他人使用，建议先在设置页修改本地 API Key。

## Codex 接入

在 `~/.codex/config.toml` 中添加自定义 provider。Windows 路径通常是
`%USERPROFILE%\.codex\config.toml`：

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

启动 Codex 前设置对应环境变量：

```powershell
$env:LOCAL_RELAY_API_KEY = "local-relay"
```

`env_key` 指向本地接口 Key 所在的环境变量；自定义兼容端口建议保持
`requires_openai_auth = false`，避免把 Codex 账号登录凭据替代成本地接口 Key。
字段定义可参考 [Codex 官方配置 Schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json)。

### Codex 无感故障转移

- 在真正输出内容前遇到 HTTP 错误、`response.failed`、`error`、不完整起始流或
  上游长时间无输出时，本地会在同一个请求内尝试下一条线路。
- 这类切换不需要重新输入“继续”，也不需要 Codex 创建新回合。
- 已经向 Codex 输出有效正文后，本地不会把另一条线路的回答拼接进原流，以免破坏
  工具调用。故障线路会进入冷却，Codex 下一次自动重连会跳过它。
- 连续未完成重连达到阈值后会触发更长冷却，避免反复撞上已限额或持续异常的线路。

## 路由与线路测试

模型路由把一个客户端模型名映射到多条线路。线路按优先级从小到大尝试，可选择：

- 自动推进：最近成功线路成为后续请求起点。
- 锁定起点：每次都从指定线路开始，再按顺序故障转移。

测试分为三类：

- 快速测试：请求 `/v1/models`，默认最多等待 30 秒。
- 真实测试：选择线路已有模型发起一次真实请求，默认最多等待 90 秒。
- 速度测试：临时输入 URL、Key 和模型，多轮测量首字延迟、总耗时和输出速度。

测试时限与线路日常转发超时相互独立，避免线路误填 1 秒后出现“上游成功、本地失败”。

## 数据与隐私

运行后会在本地创建：

```text
data/config.json   线路配置和 API Key
data/state.json    线路状态、请求记录和用量
logs/              后台启动日志
work/              兼容性测试临时数据
```

这些目录均已加入 `.gitignore`。API Key 为了简单可靠会以明文 JSON 保存在本机。
导出配置默认脱敏，只有用户主动选择时才会包含完整密钥。

请保持监听地址为 `127.0.0.1`。管理 API 还会校验访问方是否为本机回环地址，但本项目
仍不适合作为公网服务直接部署。

## 更新与停止

更新代码：

```powershell
git pull --ff-only
npm start
```

前台运行时按 `Ctrl+C` 停止。Windows 用户也可以使用 `stop.bat` 或停止快捷方式。

## 全量测试

```powershell
npm run test:all
```

测试覆盖状态码与 HTTP 200 错误包故障转移、长任务额度耗尽切线、流内失败和空闲流切线、
Codex 文本/工具协议、重连熔断、路由起点、出站代理、TLS socket 错误保护、停用 Key 跳过、
上游诊断、缓存字段、usage 估算、主题与占比图，以及真实测试模型选择。

端到端测试会使用随机本地端口和临时数据目录，不会修改用户正在使用的线路、路由、
请求记录或 Token 统计。

## 已知边界

- 上游兼容性仍取决于中转站对 Chat Completions 或 Responses 格式的实现程度。
- 缓存 Token 只能读取上游返回的 usage 字段，本地无法凭空得知真实缓存命中量。
- 项目不提供多用户权限、计费、支付、Key 加密或账号共享功能。

## 安全说明

详见 [SECURITY.md](SECURITY.md)。公开问题、截图和日志中不要包含真实 API Key、代理密码、
私有线路地址或完整配置导出文件。

## 开源许可

[MIT License](LICENSE)
