# ncm-am-worker

Cloudflare Worker: 网易云音乐每日推荐 → Apple Music 自动同步

## 功能

- 每天北京时间 06:10 自动触发同步
- 获取网易云音乐每日推荐歌曲 → Apple Music 搜索匹配
- 创建 "NCM Daily YYYY-MM-DD" 歌单，自动清理 3 天前旧歌单
- **NCM cookie 自动刷新** — session 过期时通过 `login/token/refresh` 续期
- **QR 扫码重新登录** — `/login` 生成二维码，`/login/check` 轮询状态

## Endpoints

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息 |
| GET | `/status` | NCM 登录状态 + 最近同步结果 |
| POST | `/sync` | 手动触发同步 |
| GET | `/login` | 获取 QR 扫码登录 URL |
| GET | `/login/check?key=xxx` | 轮询扫码状态 |

## 部署

### 1. 安装依赖

```bash
cd ncm-am-worker && npm install
```

### 2. 创建 KV

```bash
wrangler kv namespace create CONFIG
wrangler kv namespace create STATE
# 把输出的 ID 填入 wrangler.toml
```

### 3. 设置 Secrets

```bash
wrangler secret put NCM_COOKIE          # MUSIC_U=xxx; __csrf=yyy
wrangler secret put AM_DEVELOPER_TOKEN  # Apple Music JWT
wrangler secret put AM_USER_TOKEN       # media-user-token
```

### 4. 部署

```bash
wrangler deploy
```

### 5. 测试

```bash
# 检查登录状态
curl https://ncm-am-worker.<子域>.workers.dev/status

# 手动同步
curl -X POST https://ncm-am-worker.<子域>.workers.dev/sync
```

## QR 重新登录流程

当 `/status` 显示 NCM 登录过期时：

```
1. GET /login
   → 返回 { key, qrUrl, instructions }

2. 用网易云 App 扫描 qrUrl 中的二维码，确认登录

3. GET /login/check?key=xxx
   → 801 = 等待扫码
   → 802 = 已扫码等待确认
   → 803 = 成功 ✅ cookie 自动保存到 KV
```

## 文件结构

```
src/
├── index.ts         # 入口 (HTTP + cron)
├── types.ts         # 类型定义
├── crypto.ts        # NCM weapi 加密
├── ncm.ts           # 网易云 API + 登录 + 刷新
├── apple-music.ts   # Apple Music API
└── sync.ts          # 同步逻辑
```

## 环境变量 (可选)

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PLAYLIST_PREFIX` | `NCM Daily ` | 歌单名前缀 |
| `KEEP_DAYS` | `3` | 保留最近几天 |
| `STOREFRONT` | `cn` | Apple Music 地区 |
