# WebSocket 服务器

基于Node.js的WebSocket服务器，支持Supabase认证和实时通信。

## 功能特性

- WebSocket服务器（支持WS和WSS）
- Supabase API Key验证
- JWT Session Token管理
- 心跳机制（保持连接活跃）
- 实时数据更新

## 安装

```bash
npm install
```

## 配置

创建 `.env` 文件（参考 `.env.example`）：

```
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
JWT_SECRET=your_jwt_secret
PORT=5000
```

## 运行

```bash
npm start
```

或开发模式（自动重启）：

```bash
npm run dev
```

## TLS/WSS配置

要启用WSS（WebSocket Secure），需要在服务器目录下放置：
- `cert.pem` - TLS证书
- `key.pem` - TLS私钥

如果没有这些文件，服务器将使用普通的WS连接（仅用于开发）。

## 数据库要求

确保Supabase数据库中有一个 `user` 表，包含以下字段：
- `id` - 用户ID
- `apikey` - API Key字段

## API

### 消息格式

所有消息使用JSON格式：

**认证请求：**
```json
{
  "type": "auth",
  "apiKey": "your-api-key"
}
```

**认证成功响应：**
```json
{
  "type": "auth_success",
  "sessionToken": "jwt-token",
  "message": "Authentication successful"
}
```

**心跳消息：**
```json
{
  "type": "ping"
}
```

**心跳响应：**
```json
{
  "type": "pong"
}
```


