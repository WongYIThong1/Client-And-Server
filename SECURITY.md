# 安全说明文档

## 当前安全模型

### 改进后的Token机制

#### 1. **双Token系统**
- **Access Token（访问令牌）**
  - 有效期：**15分钟**
  - 用途：用于日常API调用
  - 特点：短期有效，即使泄露影响也有限

- **Refresh Token（刷新令牌）**
  - 有效期：**7天**
  - 用途：用于刷新Access Token
  - 特点：长期有效，但仅用于刷新，不能直接访问API

#### 2. **Token黑名单机制**
- 服务器维护一个token黑名单
- 可以主动撤销token（例如：用户登出、检测到异常行为）
- 被撤销的token无法继续使用

#### 3. **自动Token刷新**
- 当Access Token过期时，服务器会自动使用Refresh Token刷新
- 客户端无需手动处理token过期

## 客户端被破解的风险分析

### 如果客户端被破解，攻击者可以：

#### ✅ **可以做到的事情：**
1. **提取API Key**
   - 可以用于首次认证
   - **风险等级：高** ⚠️

2. **提取Access Token**
   - 可以在15分钟内使用
   - **风险等级：中** ⚠️

3. **提取Refresh Token**
   - 可以在7天内刷新新的Access Token
   - **风险等级：高** ⚠️

#### ❌ **无法做到的事情：**
1. **无法伪造新Token**
   - JWT_SECRET只存储在服务器端
   - 客户端无法生成有效的token签名

2. **无法修改现有Token**
   - 任何修改都会导致签名验证失败
   - 服务器会拒绝无效token

3. **无法绕过认证**
   - 所有请求都需要有效的token
   - 没有token无法访问受保护的资源

## 安全改进建议

### 1. **API Key保护**（最重要）
```javascript
// 建议：不要在客户端硬编码API Key
// 方案A：使用设备绑定
// 方案B：使用一次性API Key（使用后失效）
// 方案C：定期轮换API Key
```

### 2. **Token存储安全**
- 客户端应该安全存储token（加密存储）
- 避免在日志中输出完整token
- 使用操作系统提供的安全存储机制

### 3. **监控和检测**
- 监控异常登录行为
- 检测同一token在多个位置使用
- 实现速率限制（Rate Limiting）

### 4. **Token撤销机制**
```javascript
// 当检测到异常时，可以撤销token
revokeToken(refreshToken);
```

### 5. **IP绑定（可选）**
```javascript
// 在token中包含IP地址
const token = jwt.sign({
  userId,
  ip: req.socket.remoteAddress
}, JWT_SECRET);
```

### 6. **设备指纹（可选）**
```javascript
// 在token中包含设备信息
const token = jwt.sign({
  userId,
  deviceId: generateDeviceId()
}, JWT_SECRET);
```

## 最佳实践

### 服务器端
1. ✅ JWT_SECRET使用强随机密钥（至少32字符）
2. ✅ 定期轮换JWT_SECRET（需要所有用户重新登录）
3. ✅ 实现token黑名单
4. ✅ 监控异常访问模式
5. ✅ 使用HTTPS/WSS加密传输

### 客户端
1. ✅ 安全存储token（不要明文存储）
2. ✅ 不要在日志中输出完整token
3. ✅ 实现自动token刷新
4. ✅ 处理token过期错误
5. ✅ 使用加密通信（WSS）

## 如果发现Token泄露

### 立即采取的措施：
1. **撤销泄露的Token**
   ```javascript
   revokeToken(leakedRefreshToken);
   ```

2. **通知用户更改API Key**
   - 在Supabase中更新用户的API Key
   - 旧的API Key将失效

3. **监控异常活动**
   - 检查是否有异常访问
   - 记录所有使用泄露token的请求

4. **强制重新认证**
   - 要求所有用户重新登录
   - 生成新的token对

## 安全等级对比

| 方案 | Access Token有效期 | 可撤销性 | 安全性 |
|------|-------------------|---------|--------|
| **旧方案** | 24小时 | ❌ 无法撤销 | ⭐⭐ |
| **新方案** | 15分钟 | ✅ 可撤销 | ⭐⭐⭐⭐ |

## 总结

### 当前实现的优势：
- ✅ Access Token短期有效（15分钟）
- ✅ Refresh Token可撤销
- ✅ 自动token刷新
- ✅ JWT_SECRET仅服务器端存储

### 仍需注意的风险：
- ⚠️ API Key泄露风险（最重要）
- ⚠️ Refresh Token泄露风险（7天有效）
- ⚠️ 需要实现监控和异常检测

### 建议的下一步：
1. 实现API Key轮换机制
2. 添加异常行为检测
3. 实现IP/设备绑定（可选）
4. 添加详细的访问日志



