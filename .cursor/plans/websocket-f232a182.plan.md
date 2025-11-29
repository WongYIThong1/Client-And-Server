<!-- f232a182-b9cb-445b-b1a8-699317ab449c 67c719a1-937f-4700-a469-98fc9bd6e8d7 -->
# WebSocket客户端-服务器系统开发计划

## 项目结构

- `server/` - Node.js服务器端代码
- `client/` - Golang客户端代码

## 服务器端 (Node.js)

### 1. 项目初始化

- 创建 `server/package.json`，包含依赖：
- `ws` - WebSocket服务器库
- `@supabase/supabase-js` - Supabase客户端
- `dotenv` - 环境变量管理
- `jsonwebtoken` - JWT token生成（用于session token）
- `crypto` - 加密工具（Node.js内置）

### 2. 核心文件

- `server/index.js` - 主服务器文件
- 创建WSS服务器（监听5000端口）
- 处理WebSocket连接
- API Key验证逻辑
- Session token生成和管理
- 心跳机制（ping/pong）
- 接收和处理客户端心跳包（system_info和heartbeat）
- 管理后台WebSocket连接管理
- 将机器信息推送到管理后台

- `server/supabase.js` - Supabase连接模块
- 初始化Supabase客户端
- API Key验证函数（查询users表）

- `server/.env` - 环境变量文件
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- JWT_SECRET（用于生成session token）

### 3. 功能实现

- WebSocket连接处理
- API Key验证（查询Supabase users表）
- Session token生成（JWT格式）
- 心跳机制（每30秒发送ping）
- 接收客户端system_info消息（IP、RAM、CPU核心数）
- 接收客户端heartbeat消息
- 在内存中存储客户端系统信息（与连接关联）
- 管理后台连接认证（使用token）
- 根据userId将机器信息推送到对应的管理后台连接
- 错误处理和日志记录

## 客户端 (Golang)

### 1. 项目初始化

- 创建 `client/go.mod`
- 依赖包：
- `github.com/gorilla/websocket` - WebSocket客户端
- `golang.org/x/crypto` - 加密相关（如果需要）
- `runtime` - 获取系统信息（CPU核心数）
- `net` - 获取IP地址

### 2. 核心文件

- `client/main.go` - 主程序
- 连接检查逻辑（连接到wss://localhost:5000）
- ASCII艺术字显示
- API Key输入处理
- WebSocket通信
- Session token管理
- 获取系统信息（IP、RAM、CPU核心数）
- 启动时立即发送system_info心跳包
- 每10分钟发送一次heartbeat心跳包

### 3. 功能实现

- 启动时连接检查
- 连接成功后显示ASCII艺术字和"Connected To Server"
- API Key输入提示
- 发送API Key到服务器
- 接收并存储session token
- 认证成功后立即发送system_info消息（包含IP、RAM、CPU）
- 每10分钟发送heartbeat消息
- 心跳机制响应（响应服务器的ping）
- 实时数据更新接收

## 安全措施

- 使用WSS（WebSocket Secure）进行TLS加密
- API Key验证通过Supabase数据库
- Session token使用JWT签名
- 所有敏感信息存储在环境变量中

## 通信协议

- 消息格式：JSON
- 消息类型：
- `auth` - API Key验证请求
- `auth_success` - 验证成功，包含session token
- `auth_failed` - 验证失败
- `ping`/`pong` - 服务器心跳消息
- `system_info` - 客户端首次心跳包（包含IP、RAM、CPU核心数）
- `heartbeat` - 客户端定期心跳包（每10分钟）
- `data` - 实时数据更新
- `admin_connect` - 管理后台连接请求（使用token）
- `machine_update` - 机器信息更新（推送到管理后台）
- `machine_list` - 获取所有在线机器列表

## 新增功能：机器信息推送到管理后台

### 需求

- 客户端发送心跳包时，服务器将机器信息推送到管理后台
- 管理后台通过WebSocket连接到服务器
- 根据用户token识别，将对应客户端的机器信息推送到对应的管理后台连接
- 不需要Supabase，直接通过WebSocket推送
- 不需要持久化存储，只显示当前状态

### 实现方案

1. **服务器端**：

- 维护管理后台WebSocket连接池（按userId分组）
- 管理后台连接时使用token认证
- 客户端发送心跳包时，根据userId找到对应的管理后台连接
- 将机器信息推送到管理后台

2. **管理后台连接**：

- 连接到WebSocket服务器
- 使用token进行认证
- 接收机器信息更新消息

3. **数据结构**：

- `adminConnections` - Map<userId, Set<WebSocket>> 存储管理后台连接
- 当客户端发送心跳包时，查找该userId的所有管理后台连接并推送

## 待实现细节

- TLS证书配置（用于WSS，开发环境可使用自签名证书）
- 错误处理和重连机制
- 日志记录系统