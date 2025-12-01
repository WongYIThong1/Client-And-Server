# WebSocket 客户端-服务器系统

一个基于WebSocket的实时通信系统，使用Node.js作为服务器端，Golang作为客户端。

## 项目结构

```
.
├── server/          # Node.js服务器端
│   ├── index.js     # 主服务器文件
│   ├── supabase.js  # Supabase连接模块
│   ├── package.json # Node.js依赖配置
│   └── README.md    # 服务器端文档
├── client/          # Golang客户端
│   ├── main.go      # 主客户端程序
│   ├── go.mod       # Go模块配置
│   └── README.md    # 客户端文档
└── README.md        # 项目总览
```

## 功能特性

### 服务器端
- ✅ WebSocket服务器（支持WS和WSS）
- ✅ Supabase API Key验证
- ✅ JWT Session Token管理
- ✅ 心跳机制（保持连接活跃）
- ✅ 实时数据推送
- ✅ **Machine删除检测**：自动检测并通知客户端
- ✅ **速率限制**：防止认证和消息滥用

### 客户端
- ✅ 连接状态检查
- ✅ ASCII艺术字显示
- ✅ API Key认证
- ✅ Session Token管理
- ✅ 心跳机制响应
- ✅ 实时数据接收
- ✅ **Machine删除处理**：自动清除API Key并退出

## 快速开始

### 1. 服务器端设置

```bash
cd server
npm install
```

创建 `.env` 文件（参考 `config.example.txt`）：

```
SUPABASE_URL=https://kicjyrmadhkozwganhbi.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
JWT_SECRET=your-secret-key-change-this-in-production
PORT=5000
```

启动服务器：

```bash
npm start
```

### 2. 客户端设置

```bash
cd client
go mod download
```

运行客户端：

```bash
go run main.go
```

## 使用流程

1. 启动服务器（`server/`目录）
2. 启动客户端（`client/`目录）
3. 客户端会显示ASCII艺术字和连接状态
4. 输入您的API Key
5. 如果认证成功，将建立WebSocket连接并开始接收实时数据

## 安全特性

- 🔒 使用WSS（WebSocket Secure）进行TLS加密
- 🔒 API Key通过Supabase数据库验证
- 🔒 Session Token使用JWT签名
- 🔒 所有敏感信息存储在环境变量中

## 通信协议

所有消息使用JSON格式：

### 认证流程

**客户端 → 服务器：**
```json
{
  "type": "auth",
  "apiKey": "your-api-key"
}
```

**服务器 → 客户端（成功）：**
```json
{
  "type": "auth_success",
  "sessionToken": "jwt-token",
  "message": "Authentication successful"
}
```

**服务器 → 客户端（失败）：**
```json
{
  "type": "auth_failed",
  "message": "Invalid API Key"
}
```

### 心跳机制

服务器每30秒发送ping，客户端自动响应pong：

**服务器 → 客户端：**
```json
{
  "type": "ping"
}
```

**客户端 → 服务器：**
```json
{
  "type": "pong"
}
```

### Machine删除通知

**服务器 → 客户端：**
```json
{
  "type": "machine_deleted",
  "message": "Your machine has been deleted. Please re-authenticate."
}
```

当服务器检测到machine被删除时，会发送此消息。客户端收到后会：
1. 清除本地保存的API Key
2. 退出程序
3. 提示用户重新启动并输入新的API Key

## 数据库要求

确保Supabase数据库中有一个 `user` 表，包含以下字段：
- `id` - 用户ID（主键）
- `apikey` - API Key字段（用于验证）

## 部署说明

### 服务器部署

1. 将服务器代码部署到Ubuntu服务器
2. 使用Nginx配置反向代理
3. 配置Cloudflare DNS和加速
4. Nginx和Cloudflare会自动处理HTTPS/WSS

### TLS证书

- 开发环境：可以使用自签名证书（`cert.pem`和`key.pem`）
- 生产环境：使用Nginx和Cloudflare自动配置的证书

## 开发注意事项

- 开发环境默认使用WS（非加密），生产环境应使用WSS
- 客户端在开发环境会跳过TLS证书验证（`InsecureSkipVerify: true`）
- 生产环境应启用完整的TLS验证

## 许可证

ISC



