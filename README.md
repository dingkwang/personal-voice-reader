# 声笺 · Personal Voice Reader

## Cloud implementation (current)

The app now targets **Vercel + Neon Postgres + private Vercel Blob + Vercel
Workflow + Auth0**. ChatGPT uses scoped OAuth at `/api/mcp`, queues a reading,
and receives a private `/sessions/[id]` playback link. Browser generation
continues after disconnect and exposes reconnectable progress.

Read [the cloud runbook](docs/CLOUD_RUNBOOK.md) for resource isolation, exact
Auth0 web/MCP registration, deployment gates, migration and rollback.
Read [HANDOFF.md](HANDOFF.md) for actual verification and cloud blockers.

```sh
npm ci
npm test
npm run lint
npm run build
npm run test:browser
npm run deploy:check
```

Tests use synthetic data and mocked provider calls. Browser tests own port 3108,
not the existing PoC server on 3000. Cloud runtime never falls back to JSON.
Missing auth/configuration fails closed. The original `.data` is preserved and
backed up, but no cloud deployment or personal-data migration is verified yet.

## Previous local multi-session PoC

The notes below preserve the previous PoC behavior and setup history. Its local
JSON/LAN instructions are **not the current cloud startup or deployment path**.

一个移动端优先的个人声音阅读器：粘贴文字或上传 TXT，选择一个声音，第一段生成后立即播放，后续段落并行预生成并连续接播。

## 已实现

- Next.js 16 + TypeScript 单仓库应用
- Fish Audio 服务端 TTS（API key 不进入浏览器）
- TXT 上传与中英文段落切分
- 历史会话列表、原文恢复、独立保存与音频复用
- 连续播放、暂停、跳段、段内拖动、语速
- 后两段预生成与失败段独立重试
- `provider + voice + model + speed + text` 内容寻址缓存
- 手机录音 / 音频上传并创建私密 Fish voice model
- 连接已有 Fish Voice ID
- Media Session 锁屏控制和 PWA 安装能力
- HTTP Range 音频响应，适合移动端 seek
- 声音克隆前强制确认所有权或授权

## 本地启动

需要 Node.js 20.9 或更新版本。

```bash
cp .env.example .env.local
# 编辑 .env.local，填入 FISH_API_KEY（也兼容 FISH_AUDIO_API_KEY）
npm install
npm run dev
```

打开 <http://localhost:3000>。首次运行会在 `.data/` 创建本地 JSON 数据和 MP3 缓存；该目录已加入 `.gitignore`。

## 多会话 PoC

- 历史列表按创建时间从新到旧显示。点选会话会恢复标题、原文、原来的段落和音频，不会自动播放。有已生成段落时，优先恢复该段的声音与语速。
- **新建会话**清空编辑器。**保存会话**只保存文字，不调用 TTS、不产生语音费用；**开始朗读**会先自动保存，再生成或复用音频。
- 未修改已保存的标题和文字时，保存/朗读复用原会话，不重复创建。修改标题或文字后再保存/朗读，会另存一个新快照，旧会话保留。改动声音或语速不新建会话。
- 离开未保存的新稿或修改稿前会提示确认；保存过程中暂时锁定编辑与会话切换，避免重复提交。未保存的草稿不持久化，移动浏览器强制关闭时可能无法弹出离开提示。
- 切换会话、新建会话、修改声音/语速会立即停止播放，并忽略旧请求的结果。已经发到服务端的生成可能仍会完成并写入原会话的缓存，无法撤销已产生的 provider 费用。
- 刷新后会话仍在列表中，点选即可继续听。不保存上次播放的时间戳。相同段落与设置优先使用现成音频；其他相同文字与设置由服务端内容缓存复用。
- 历史列表与详情使用 `no-store`，不会被旧的浏览器缓存覆盖。带版本号的音频 URL 始终读取对应缓存文件，即使后续生成更新了该段落的声音；无版本号的请求需重新验证。

这是**共享、单用户、本机存储**的 PoC，不是账户隔离的多用户产品。文字、声音信息保存在 `.data/store.json`，音频在 `.data/audio/`；使用同一个服务地址的浏览器与设备共享这些会话和声音，数据不只在当前浏览器里。不会自动删除旧会话，需自行备份整个数据目录。JSON 全量读写只适合小规模单进程自用。

局域网启动（仅用于可信网络，无登录保护）：

```bash
npm run build
npm run start -- --hostname 0.0.0.0 --port 3000
```

从手机打开 `http://电脑的局域网IP:3000`。不要把此端口公开到互联网。LAN HTTP 不支持麦克风和 PWA 安装等需要安全上下文的能力，TXT/音频文件上传与常规播放仍可使用。

如果已有 Fish voice model，可填写 `FISH_DEFAULT_VOICE_ID`，也可以在界面右上角添加。没有 reference ID 时，默认项会使用 Fish 当前模型的默认声音。

## Clone 我的声音

1. 打开首页，点击右上角 `+` 或声音选择器里的“添加”。
2. 用手机录制 30–60 秒，或上传 2–3 段各 15–20 秒的录音。
3. 勾选声音所有权/授权确认，然后点击“保存声音”。
4. Backend 会以 multipart 请求调用 Fish `POST /model`，使用 `type=tts`、`train_mode=fast` 和 `visibility=private`。
5. Fish 返回的 `_id` 会保存为通用 Voice 的 `providerVoiceId`；此后 TTS 自动把它作为 `reference_id` 使用。

录音至少应有 10 秒。安静房间、单人讲话、稳定音量和自然停顿最重要；不要带背景音乐或其他人的声音。上传多段录音时，服务端会把每段都作为一个 `voices` 字段发送，当前最多接受 20 段。

浏览器麦克风需要安全上下文：电脑上的 `http://localhost:3000` 可以录音；iPhone 通过局域网 IP 访问时请使用 HTTPS 部署或 HTTPS tunnel。也可以先用手机录音 App 录好，再从页面上传音频文件。

## API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/voices` | 列出通用 Voice 对象 |
| `POST /api/voices` | 连接已有 Voice ID，或用 multipart 音频克隆声音 |
| `GET /api/documents` | 获取历史会话摘要（最新在前，不缓存） |
| `GET /api/documents/:id` | 恢复原文、标题和原段落/音频 metadata（不缓存） |
| `POST /api/documents` | 保存文本并生成 segments |
| `POST /api/tts` | 为单个 segment 生成或命中缓存音频 |
| `GET /api/audio/:segment` | 播放音频，支持 Range 请求 |

Fish 实现被隔离在 `src/lib/providers/fish.ts`。上层只使用 `Voice` 和 `VoiceProviderAdapter`，以后增加 MiniMax、ElevenLabs 或本地模型时不必修改 Reader 业务模型。

## 数据与部署

V0 的存储适合单机、自用和快速验证。部署时请使用带持久磁盘的 Node 容器，并通过 `VOICE_READER_DATA_DIR` 指向该磁盘。

当前版本已改用 Neon Postgres、private Vercel Blob、Vercel Workflow 与 Auth0。
不要将旧版无认证 PoC 部署到公网；当前部署步骤见 cloud runbook。

## 验证

```bash
npm test
npm run lint
npm run build
```

后端测试使用临时目录，不读取或更改真实 `.data`。浏览器测试也应以独立端口和 `VOICE_READER_DATA_DIR=/绝对路径/临时目录` 启动服务，并拦截 `/api/tts` 使用模拟响应，避免调用付费服务。不要将真实声音或文章复制到测试夹具。

自动化浏览器验收（需要 Chrome、ffmpeg 和 Playwright；可将 Playwright 安装到临时目录，不改项目依赖）：

```bash
npm run build
PLAYWRIGHT_MODULE=/绝对路径/playwright/index.mjs node scripts/check-sessions.mjs
```

脚本使用 `127.0.0.1:3107`、新建临时存储和合成音频，禁用 Fish key 并拦截 TTS，完成后关闭测试服务。结果与桌面/手机截图保存在终端输出的 `EVIDENCE` 目录。

## Fish Audio 文档

- [Text to Speech](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [Create Model](https://docs.fish.audio/api-reference/endpoint/model/create-model)
- [JavaScript SDK / streaming](https://docs.fish.audio/api-reference/sdk/javascript/api-reference)
