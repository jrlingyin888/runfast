# 跑得快记分 联机方案改造：局域网自建服务器 设计文档

日期：2026-07-23
状态：已与用户确认
前置：v1.1 联机设计见 `2026-07-22-runfast-v11-online-design.md`（本方案替换其中的 Firebase 同步后端，其余不变）

## 1. 背景与根因

v1.1 用 Firebase 实时数据库做联机同步。实测在中国大陆网络下：
- **连不上**：Firebase 走 Google 域名（googleapis.com / firebasedatabase.app），国内被墙；
- **时连时断**：即便偶尔连上，实时同步依赖的 SSE 长连接会被持续干扰而反复中断；
- 微信内置浏览器进一步加剧（对 Google 域名与长连接更不友好）。

结论：Firebase 选型在国内不可用。用户打牌场景是**面对面、同一个 WiFi**，回归用户最初设想——
**局域网自建服务器**：房主电脑（Mac，长期可开）跑一个零依赖 Node 服务，既发页面又当同步中心，
手机同 WiFi 扫码进入。数据不出公网、不过墙，稳定且免费、无需备案/实名。

## 2. 目标

1. 联机同步改为局域网：房主电脑跑 `server.js`，手机连 `http://电脑IP:端口` 实时同步。
2. **傻瓜启动**：房主双击 `跑得快联机.command`，自动开服务 + 弹出带二维码的"主机页"。
3. 手机**扫码即入**，无需手输地址/房号。
4. **最小改动复用** v1.1 同步层：`sync.js` 对外接口不变，仅换内部连接实现；`app.js`/`logic.js`/结算/皮肤/分享/历史/本地单机 全部不变。
5. 彻底移除 Firebase 及"中国大陆无法联机"限制。

## 3. 架构总览

```
房主 Mac
├── 跑得快联机.command        双击启动：node server.js + open 主机页
├── server.js                 Node 零依赖 http 服务（新增）
│   ├── GET  /                → 发送 dist/index.html（注入 __RUNFAST_HOST__ 标志）
│   ├── GET  /host            → 主机页：局域网地址 + 二维码 + 状态（新增）
│   ├── GET  /rooms/:code/events  → SSE 实时推送（模拟 Firebase put 事件格式）
│   ├── GET  /rooms/:code     → 读房间 JSON
│   ├── PUT  /rooms/:code     → 写房间（X-Device-Id 头，服务器强制权限）
│   ├── DELETE /rooms/:code   → 删房（仅房主）
│   └── 内存房间 Map + 落地 server-data.json
│
手机（同 WiFi）
└── 扫码 → http://电脑IP:端口/ → 记分页（sync.js 用相对路径连回本机）
```

组件职责：
- **server.js**：唯一新增的后端。发页面 + 房间同步 + 权限校验 + 数据落地。零第三方依赖（Node 内置 http/fs/os/crypto）。
- **主机页 /host**：房主电脑屏幕展示——大二维码 + `http://IP:端口` 文本 + 在线牌友数。二维码在页面内用内联的 MIT 纯 JS 二维码库生成（不依赖外网）。
- **sync.js**：改内部连接实现，对外 15 个接口签名不变。
- **app.js**：仅改 `configured()` 判据与联机入口文案；移除"中国大陆限制"提示。

## 4. 使用流程

**房主**：双击 `跑得快联机.command` → 电脑自动打开 `/host` 主机页（大二维码 + 地址）。
在手机上扫自己电脑屏幕的码进入 → 创建联机场（选人、单价）→ 得到房间，招呼牌友扫码。

**牌友**：用**手机相机/系统浏览器**扫主机页二维码（比微信内置浏览器稳）→ 打开记分页 →
首页「加入联机场」输房号进入（房号在主机页/邀请里可见）。

**结束**：房主结束本场 → 各手机自动存本地历史 → 房主可关房。电脑上主机页可一直开着复用。

## 5. server.js 详细设计

### 5.1 启动与寻址
- 端口固定 `8787`（可被环境变量 `PORT` 覆盖）。
- 启动时用 `os.networkInterfaces()` 找第一个非内部 IPv4（`192.168.*`/`10.*`/`172.16-31.*`），
  拼成 `http://<IP>:8787/`；终端打印该地址，主机页展示其二维码。
- 找不到局域网 IP 时回退 `localhost` 并在终端提示"未检测到局域网，请确认已连 WiFi"。

### 5.2 房间数据模型（与 v1.1 云端同构，保证 logic.js 直接复用）
```json
rooms/<6位房号>: {
  "creatorUid": "<房主 deviceId>",
  "allowEdit": false,
  "updatedAt": 1690000000000,
  "session": { ...与本地 session 完全同构（players/activePlayers/rounds/...）... }
}
```
- 内存 `Map<code, room>`；每次写入后**防抖落地**到 `server-data.json`（≤1s 合并写），启动时加载。
- `session` 同构 ⇒ 结算/积分/战绩全部复用 `logic.js` 纯函数，零改动。

### 5.3 接口
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 返回 `dist/index.html`，把占位注释 `<!--RUNFAST_HOST-->` 替换为 `<script>window.__RUNFAST_HOST__=true</script>` |
| GET | `/host` | 主机页 HTML（内联二维码库），显示地址+二维码+在线数 |
| GET | `/rooms/:code/events` | **SSE**：`Content-Type: text/event-stream`。连上先补发一帧全量 `event: put\ndata: {"path":"/","data":<room 或 null>}`，之后房间每次变更推送同格式帧。心跳注释帧 `:keep-alive` 每 30s。 |
| GET | `/rooms/:code` | 返回房间 JSON 或 `null` |
| PUT | `/rooms/:code` | 请求头 `X-Device-Id`。整房写入，服务器校验权限（§5.4）后保存并向该房所有 SSE 订阅者广播 put 帧。返回 200/403 |
| DELETE | `/rooms/:code` | 仅房主；删房后向订阅者广播 `data:{"path":"/","data":null}` |

- **并发**：单进程按请求串行处理房间写，天然无竞态（取代 v1.1 的 ETag 乐观锁）。
- **SSE 事件格式刻意对齐 Firebase**：`{path, data}`，`path:"/"` 为整房替换、`data:null` 为删除。
  ⇒ `sync.js` 的 `applyEvent`/`onEvt`/`normalizeRoom` 原样复用。

### 5.4 权限校验（服务器强制，等价 v1.1 的 Firebase 规则）
PUT 时，设 `me = X-Device-Id`、`old = 现有房间`、`neu = 请求体`：
- 建房（`old` 不存在）：要求 `neu.creatorUid === me` → 允许；
- 房主（`old.creatorUid === me`）：允许任意写（含改 allowEdit、结束）；
- 他人：仅当 `old.allowEdit === true` 且 `neu.creatorUid === old.creatorUid` 且
  `neu.allowEdit === old.allowEdit`（不得篡改房主/权限位）→ 允许；否则 403。
DELETE 仅 `old.creatorUid === me`。

## 6. sync.js 改造（对外接口不变）

保留导出的 15 个名字不变，只改内部：
- **删除** Firebase 认证栈：`signIn/refreshIdToken/freshToken/auth/signInPromise/saveAuth` 的 Firebase 实现、`FB` 常量。
- `signIn()` 保留同名，改为"确保本机有 deviceId"：读/生成 `localStorage['runfast.device']`（随机串），返回 `{uid: deviceId}`。`getUid()` 返回该 deviceId。
- `readRoom/writeRoom/mutate/createRoom/deleteRoom`：URL 由 Firebase 绝对地址改为**同源相对路径** `('/rooms/'+code)`；去掉 `?auth=`、`if-match`/ETag；写请求带头 `X-Device-Id: deviceId`；403 → 抛"没有修改权限"。
- `subscribe`：`EventSource('/rooms/'+code+'/events')`（同源，无 token）。其余重连/generation/onEvt 逻辑（v1.1-T4 加固过的）不变。
- `configured()`：改为 `typeof window !== 'undefined' && window.__RUNFAST_HOST__ === true`
  ——即"页面是从主机服务器加载的"才算联机可用。
- **复用不变**：`genRoomCode/validRoomCode/canEdit/canAdmin/applyEvent/normalizeRoom`。

## 7. app.js 改造（极小）
- 依赖 `configured()` 的入口（`goOnlineSetup/goJoinRoom`）逻辑不变，但因 `configured()` 语义变了，
  非主机环境下点联机入口提示改为：**"联机需在房主电脑上启动服务后，扫码进入本页面"**。
- 移除首页/交付话术里"中国大陆无法联机"等 Firebase 限制文案。
- 「加入联机场」MVP 保留手输房号 + 邀请复制（房号在主机页/邀请里可见）。房间列表列为可选增强。

## 8. 兜底与离线
- **本地单机**：完全不变，任何环境（含无服务器、无网络）都能用。
- **GitHub Pages / 单 HTML 文件**：仍可用，但 `__RUNFAST_HOST__` 不存在 ⇒ `configured()` 为 false ⇒
  只提供单机记分，联机入口提示需从主机扫码。作为"电脑没开时的兜底"。
- **电脑关机/重启**：当前牌局已落地 `server-data.json`，重启服务后恢复；各手机在结束时也已存本地历史。

## 9. 安全考量
- 攻击面仅限**同一局域网**（家里 WiFi），非公网暴露。
- 房主/权限由服务器强制（§5.4），非房主改接口也改不动，与 v1.1 一致。
- 玩家名 `validName` 校验、`esc()` 渲染、导入名校验：全部不变。
- `X-Device-Id` 为不可猜的随机串，作为房主身份；局域网信任模型下足够（记分场景合适）。
- server 只服务局域网；README 提示不要把端口映射到公网。

## 10. 测试策略
- `logic.js` 13 测、`sync.js` 纯函数测（`genRoomCode/validRoomCode/canEdit/canAdmin/applyEvent/normalizeRoom`）保持通过。
- **server.js 单元/集成测**（`node --test`，用内置 http 起测试实例）：建房权限、他人越权 403、allowEdit 开关后可写、房主删房、SSE 首帧全量、写入广播、数据落地与重启恢复、权限位篡改被拒。
- **双客户端 e2e**（浏览器两标签同源连本机 server）：建房/进房/实时互见/权限开关/越权拒绝/结束快照/关房/作废，全链路（对齐 v1.1-T7 的 12 项，但连本机）。
- **真机扫码**（交付时）：手机同 WiFi 扫主机页码进入、双机实时同步。

## 11. 交付
- 房主拿到：项目文件夹（含 `server.js`、`跑得快联机.command`、`dist/`）。双击 `.command` 即用。
- **首次双击** macOS 可能提示"未验证的开发者"——README 说明：右键→打开，或系统设置→隐私与安全性→仍要打开。
- 扫码建议用**手机相机/系统浏览器**（Safari/Chrome），比微信内置浏览器稳。
- 需已装 Node（用户已有 v26）；README 附检查命令。
- GitHub 仓库（runfast + RunFastPoker）更新；GitHub Pages 版继续作为"离线单机版"。

## 12. 范围外（本次不做）
- 内网穿透/公网访问（异地联机）——用户当前场景不需要；接口未来可扩展。
- 国内云 BaaS 迁移。
- 服务器多桌房间列表页（§7 标记为可选增强，MVP 用手输房号+邀请）。
- 打包成 .app / 安装器；HTTPS（局域网 http 足够，Web Share 等已在 v1 处理降级）。
