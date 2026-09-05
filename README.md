# 声笺 · Personal Voice Reader

一个移动端优先的个人声音阅读器：粘贴文字或上传 TXT，选择一个声音，第一段生成后立即播放，后续段落并行预生成并连续接播。

## 已实现

- Next.js 16 + TypeScript 单仓库应用
- Fish Audio 服务端 TTS（API key 不进入浏览器）
- TXT 上传与中英文段落切分
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
# 编辑 .env.local，填入 FISH_API_KEY
npm install
npm run dev
```

打开 <http://localhost:3000>。首次运行会在 `.data/` 创建本地 JSON 数据和 MP3 缓存；该目录已加入 `.gitignore`。

如果已有 Fish voice model，可填写 `FISH_DEFAULT_VOICE_ID`，也可以在界面右上角添加。没有 reference ID 时，默认项会使用 Fish 当前模型的默认声音。

## API

| Endpoint | 用途 |
| --- | --- |
| `GET /api/voices` | 列出通用 Voice 对象 |
| `POST /api/voices` | 连接已有 Voice ID，或用 multipart 音频克隆声音 |
| `POST /api/documents` | 保存文本并生成 segments |
| `POST /api/tts` | 为单个 segment 生成或命中缓存音频 |
| `GET /api/audio/:segment` | 播放音频，支持 Range 请求 |

Fish 实现被隔离在 `src/lib/providers/fish.ts`。上层只使用 `Voice` 和 `VoiceProviderAdapter`，以后增加 MiniMax、ElevenLabs 或本地模型时不必修改 Reader 业务模型。

## 数据与部署

V0 的存储适合单机、自用和快速验证。部署时请使用带持久磁盘的 Node 容器，并通过 `VOICE_READER_DATA_DIR` 指向该磁盘。

面向多用户的 V1 应把 `src/lib/store.ts` 替换成 Postgres/Supabase repository，并把 `persistAudio` 替换为 R2 或 Supabase Storage；provider adapter 和前端 API 合约可以保持不变。V1 还应增加认证、配额、计费、审计和更完整的声音授权流程。

## 验证

```bash
npm test
npm run lint
npm run build
```

## Fish Audio 文档

- [Text to Speech](https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech)
- [Create Model](https://docs.fish.audio/api-reference/endpoint/model/create-model)
- [JavaScript SDK / streaming](https://docs.fish.audio/api-reference/sdk/javascript/api-reference)
