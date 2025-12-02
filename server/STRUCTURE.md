# 服务器模块结构说明

## 目录结构

```
server/
├── index.js              # 入口文件，整合所有模块
├── config.js             # 配置管理（环境变量、常量）
├── stores.js             # 数据存储（连接、系统信息、token黑名单）
├── server.js              # 服务器初始化（HTTP/HTTPS、WebSocket）
├── supabase.js           # Supabase数据库操作
├── auth/                 # 认证相关模块
│   ├── token.js          # JWT token管理（生成、验证、撤销）
│   └── handlers.js       # 认证消息处理（auth、refresh_token、token验证）
├── realtime/             # Supabase Realtime 订阅模块
│   └── tasks.js          # 监听 tasks 表变更并向客户端派发任务
└── websocket/            # WebSocket相关模块
    ├── connection.js     # WebSocket连接生命周期管理
    └── handlers.js       # WebSocket消息处理（system_info、heartbeat、data等）
```

## 模块说明

### 核心模块

- **index.js**: 应用程序入口，初始化服务器并设置连接处理
- **config.js**: 集中管理所有配置常量（端口、JWT密钥、token过期时间等）
- **stores.js**: 管理运行时内存数据（已认证连接、客户端系统信息、token黑名单）
- **server.js**: 创建HTTP/HTTPS服务器和WebSocket服务器，处理服务器生命周期

### Realtime 模块 (realtime/)

- **tasks.js**:
  - 订阅 Supabase Realtime `public.tasks` 表的 `INSERT` 事件
  - 根据 `tasks.machine_id` 找到对应的在线 WebSocket 连接
  - 下发 `task_assigned` 消息到目标机器

### 认证模块 (auth/)

- **token.js**: 
  - `generateAccessToken()` - 生成短期access token
  - `generateRefreshToken()` - 生成长期refresh token
  - `verifyToken()` - 验证token有效性
  - `revokeToken()` - 撤销token（加入黑名单）
  - `isTokenExpiringSoon()` - 检查token是否即将过期

- **handlers.js**:
  - `handleAuth()` - 处理API Key认证请求
  - `handleRefreshToken()` - 处理refresh token请求
  - `handleTokenAuth()` - 处理token认证
  - `checkAndRefreshToken()` - 自动检查并刷新即将过期的token

### WebSocket模块 (websocket/)

- **connection.js**:
  - `setupHeartbeat()` - 设置心跳机制
  - `handleMessage()` - 处理所有WebSocket消息
  - `handleClose()` - 处理连接关闭
  - `handleError()` - 处理连接错误
  - `setupConnection()` - 初始化WebSocket连接

- **handlers.js**:
  - `handleSystemInfo()` - 处理系统信息消息（首次心跳包）
  - `handleHeartbeat()` - 处理定期心跳消息
  - `handleData()` - 处理数据消息
  - `handlePong()` - 处理心跳响应

### 数据库模块

- **supabase.js**: Supabase数据库操作
  - `verifyApiKey()` - 验证API Key
  - `saveOrUpdateMachine()` - 保存或更新机器信息
  - `updateMachineHeartbeat()` - 更新机器心跳时间

## 数据流

1. **连接建立**: `index.js` → `server.js` → `websocket/connection.js`
2. **消息处理**: `websocket/connection.js` → `auth/handlers.js` 或 `websocket/handlers.js`
3. **认证流程**: `auth/handlers.js` → `auth/token.js` → `supabase.js`
4. **数据存储**: `websocket/handlers.js` → `supabase.js`

## 优势

- **模块化**: 每个模块职责单一，易于维护和测试
- **可扩展**: 新功能可以轻松添加到相应模块
- **可测试**: 每个模块可以独立测试
- **清晰的结构**: 代码组织清晰，易于理解和导航

