# WebSocket 客户端

基于Golang的WebSocket客户端，连接到服务器并进行认证。

## 功能特性

- WebSocket客户端连接
- 连接状态检查
- ASCII艺术字显示
- API Key认证
- Session Token管理
- 心跳机制
- 实时数据接收

## 安装依赖

```bash
go mod download
```

## 配置

在 `main.go` 中修改服务器地址：

```go
const serverURL = "ws://localhost:5000"
// 或使用WSS
// const serverURL = "wss://localhost:5000"
```

## 运行

```bash
go run main.go
```

或编译后运行：

```bash
go build -o client main.go
./client
```

## 使用说明

1. 启动客户端后，会显示ASCII艺术字和连接状态
2. 输入您的API Key
3. 如果认证成功，将显示Session Token
4. 客户端将保持连接并接收实时数据更新

## 通信协议

客户端支持以下消息类型：
- `auth` - 发送API Key进行认证
- `auth_success` - 接收认证成功的响应
- `auth_failed` - 接收认证失败的响应
- `ping`/`pong` - 心跳消息
- `data` - 实时数据更新

