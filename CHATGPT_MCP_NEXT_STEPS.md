# ChatGPT MCP 后续工作

当前代码已加入两个 MCP 工具：

- `regenerate_segment`：重新生成一个段落。
- `regenerate_reading`：重新生成整篇。

## Auth0 配置入口

Auth0 团队入口：
https://accounts.auth0.com/teams/team-z5etssb/tenants

Preview staging tenant：`icfg-jorzt9ixausuonnolw8s5hvd-staging`

应用列表：
https://manage.auth0.com/dashboard/us/icfg-jorzt9ixausuonnolw8s5hvd-staging/applications

ChatGPT OAuth Client ID：`3EeI3RgkslActTjSWGaUZ9SbGPSIhZ5X`

进入该应用的 `Credentials → Client Secrets` 获取 secret。Secret 只填入
ChatGPT，不要写入仓库。

两个工具都需要 `create:readings` 权限。调用时必须传入
`acknowledge_billing: true`。重试同一个请求时复用 `idempotency_key`。

## 还需要完成

1. 等待本次 Vercel Preview 构建完成。
2. 将新部署绑定到稳定 Preview 域名：
   `personal-voice-reader-preview-dingkangs-projects.vercel.app`。
3. 在 Auth0 的 ChatGPT 客户端中填写 ChatGPT Developer Mode 显示的确切
   callback URL。不要猜 URL。
4. 在 ChatGPT 中创建 Developer Mode MCP 连接：
   `https://personal-voice-reader-preview-dingkangs-projects.vercel.app/api/mcp`
   使用 OAuth。不要使用 Basic Auth 或 No Authentication。
5. 如果 Vercel Deployment Protection 拦截 ChatGPT 的服务器请求，先完成
   网页拥有者登录验证，再决定是否为 Preview 放宽 Vercel 保护。保留应用自身
   Auth0 和 OAuth 校验。
6. 用拥有者账号完成 OAuth 授权，并确认五个工具可见：
   `list_voices`、`create_reading`、`get_reading_status`、
   `regenerate_segment`、`regenerate_reading`。
7. 先用短文本测试 `create_reading`。确认返回私人 session URL。
8. 用同一个 `job_id` 测试状态查询，再测试单段重新生成。确认旧音频在新音频
   成功前仍可播放。
9. 最后再测试整篇重新生成。确认重复请求不会重复排队。

## 当前验证结果

- MCP 路由测试通过。
- ESLint 通过。
- Next.js 生产构建通过。
- 代码提交：`127a49b Expose audio regeneration through ChatGPT MCP`
- 分支：`feat/audio-regeneration`

## 注意

- 不要把 Auth0 client secret、ChatGPT client secret、Vercel token 或 provider
  key 写入 Git、聊天、命令参数或截图。
- Preview 和 Production 使用不同的 Auth0、数据库和 Blob 资源。
- Production 尚未完成验收。不要把当前 Preview 连接误当成 Production。
