# 记分页界面精简 实施计划（更多菜单 / 原生分享 / 明细独立页 / 我标识）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把记分页的管理按钮收进右上角底部弹出菜单、邀请改为原生分享优先（局域网降级为房号+链接+二维码面板）、每局明细独立成页、比分行标出「我」。

**Architecture:** 新增一个挂在 `document.body` 的底部弹出面板组件（菜单与分享面板共用），`topbar()` 增加右侧操作区参数。明细页复用并泛化现有 `VIEWS.rounds`（数据源在「进行中的场」与 `db.sessions` 间二选一，权限决定是否显示改/删，`view.from` 决定返回目标）。二维码由服务器新增只读 `GET /qr` 生成，避免把 56KB 的 qrcode 库打进单文件 dist。

**Tech Stack:** 原生 JS（无框架），`node --test`（logic/sync/server 有测试；`app.js` 为浏览器代码无单测，靠 `node --check` + 浏览器 e2e 验证），浏览器多标签 e2e。

## Global Constraints

- **权限模型不变**：菜单只是收纳，各项仍沿用现有 `isOwner()` / `RunfastSync.canEdit(online.room, online.uid)` 判断；服务器 `canWrite/canPatch` 一律不动，只新增只读的 `GET /qr`。
- **不打包 qrcode 到 dist**：`src/vendor/qrcode.js` 有 56KB，只能在 `server.js` 里用；`build.js` 的文件清单不变。
- **本地与联机结构一致**：两种模式都用同一套 topbar 操作区、底部菜单、明细页组件。
- **本地单机流程不变**：`goRecord/saveRound/editRound/deleteRound/commitSession` 的本地分支行为保持等价，只调整「录入完回哪个页面」。
- **协作草稿交互不动**：赢家先定 → 各自填 → 确认 → 全部确认后房主端自动记局，一律不改。
- **构建**：改完 `node build.js` 重建 `dist/index.html`；测试 `node --test`。
- **e2e 双设备做法**：`http://localhost:PORT` 与 `http://127.0.0.1:PORT` 是两个源，`localStorage` 不共享，因此能模拟两台设备（同源开两个标签会共用同一个 deviceId，模拟不出来）。

---

### Task 1: 服务器 `/qr` 二维码端点

**Files:**
- Modify: `server.js`（在 `/status` 路由之后、`/rooms/...` 匹配之前插入）
- Test: `test/server.test.js`（文件末尾追加一个 test）

**Interfaces:**
- Produces（供 Task 6）：`GET /qr?text=<url>` → 200 + `Content-Type: image/svg+xml; charset=utf-8` + 内联 SVG 字符串；`text` 为空或长度 > 512 → 400。

- [ ] **Step 1: 写失败的测试**

在 `test/server.test.js` **文件末尾**追加：

```js
test('/qr：正常返回内联 SVG；缺 text 或超长返回 400', async () => {
  const df = tmpData();
  const server = createRunfastServer({ dataFile: df });
  const port = await listen(server);
  try {
    let r = await req(port, 'GET', '/qr?text=' + encodeURIComponent('http://192.168.1.7:8787/?room=123456'));
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'] || '', /image\/svg\+xml/);
    assert.ok(r.body.includes('<svg'));

    r = await req(port, 'GET', '/qr');                       // 缺 text
    assert.equal(r.status, 400);

    r = await req(port, 'GET', '/qr?text=' + 'a'.repeat(600)); // 超长
    assert.equal(r.status, 400);
  } finally { server.close(); try { fs.unlinkSync(df); } catch (e) {} }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/server.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 1`（`/qr` 未实现，走到 404，断言 status 200 失败）

- [ ] **Step 3: 实现路由**

`server.js` 里找到 `/status` 那段：

```js
    // 在线人数
    if (req.method === 'GET' && p === '/status') {
      json(res, 200, { clients: clientCount(), rooms: Object.keys(rooms).length });
      return;
    }
```

在它**之后**插入：

```js
    // 二维码（邀请面板用）：局域网 HTTP 是非安全上下文，没有系统分享面板，扫码进房更实用。
    // 只读、无状态；text 长度设上限避免被拿来生成超大图。
    if (req.method === 'GET' && p === '/qr') {
      const text = u.searchParams.get('text') || '';
      if (!text || text.length > 512) { res.writeHead(400); res.end('bad text'); return; }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(qrSvg(text));
      return;
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `ℹ fail 0`，总数比之前多 1。

- [ ] **Step 5: 提交**

```bash
git add server.js test/server.test.js
git commit -m "feat(界面精简): 服务器新增只读 /qr 端点，供邀请面板生成二维码"
```

---

### Task 2: 底部弹出面板组件 + topbar 操作区 + CSS

**Files:**
- Modify: `src/style.css`（文件末尾追加）
- Modify: `src/app.js`（`topbar` 定义处、其后插入 sheet 函数、`go()`）

**Interfaces:**
- Produces（供 Task 4/5/6/7）：
  - `topbar(title, backJs, actionsHtml)` — 第三参数渲染到右侧 `.actions`
  - `openSheet(items, headerHtml)` — `items = [{label, onclick, danger?}]`，`headerHtml` 可选自定义顶部内容
  - `closeSheet()` — 幂等移除面板
  - CSS 类：`.topbar .actions`、`.icon-btn`、`.sheet-mask`、`.sheet`、`.sheet-item`（`.danger` / `.cancel` 变体）、`.me-tag`

本任务不改变任何现有行为（暂时没有调用方），只提供组件。

- [ ] **Step 1: 追加 CSS**

在 `src/style.css` **文件末尾**追加：

```css
.topbar .actions { margin-left: auto; display: flex; gap: 8px; flex-shrink: 0; }
/* 只对带操作区的顶栏截断，避免改变现有页面标题的换行行为 */
.topbar.has-actions .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icon-btn { background: rgba(0,0,0,.28); color: var(--gold-soft); border: 1px solid rgba(212,175,55,.4);
  border-radius: 10px; padding: 7px 12px; font-size: 15px; cursor: pointer; }
.sheet-mask { position: fixed; inset: 0; background: rgba(4,24,13,.62); z-index: 60; display: flex; align-items: flex-end; }
.sheet { width: 100%; max-width: 520px; margin: 0 auto; background: var(--cream); color: var(--ink);
  border-radius: 18px 18px 0 0; padding: 6px 12px calc(10px + env(safe-area-inset-bottom)); }
.sheet-item { display: block; width: 100%; border: 0; background: none; padding: 16px; font-size: 17px;
  color: var(--ink); text-align: center; cursor: pointer; border-bottom: 1px solid #eee; }
.sheet-item:last-child { border-bottom: 0; }
.sheet-item.danger { color: #b91c1c; }
.sheet-item.cancel { margin-top: 6px; font-weight: 700; }
.sheet .muted { color: #6b7280; }  /* 面板是米色底，.muted 默认的近白色在这里看不见 */
.me-tag { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  background: var(--felt-light); color: var(--gold-soft); font-size: 12px; font-weight: 700; }
```

- [ ] **Step 2: topbar 加操作区参数 + 新增 sheet 组件**

`src/app.js` 里把这两行：

```js
  const topbar = (title, backJs) =>
    `<div class="topbar">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div></div>`;
```

整体替换为：

```js
  const topbar = (title, backJs, actionsHtml) =>
    `<div class="topbar${actionsHtml ? ' has-actions' : ''}">${backJs ? `<button class="back" onclick="${backJs}">‹ 返回</button>` : ''}<div class="title">${title}</div>${actionsHtml ? `<span class="actions">${actionsHtml}</span>` : ''}</div>`;

  // 底部弹出面板：「更多」菜单与分享面板共用。挂在 body 上而不是 #app 里，
  // 这样联机端 onRoom 频繁 render() 重绘 #app 时面板不会被抖掉。
  function closeSheet() { const el = document.getElementById('sheet'); if (el) el.remove(); }
  function openSheet(items, headerHtml) {
    closeSheet();
    const el = document.createElement('div');
    el.id = 'sheet';
    el.className = 'sheet-mask';
    el.innerHTML = `<div class="sheet">
      ${headerHtml || ''}
      ${items.map((it) => `<button class="sheet-item${it.danger ? ' danger' : ''}" onclick="${it.onclick}">${it.label}</button>`).join('')}
      <button class="sheet-item cancel">取消</button>
    </div>`;
    // 按钮的内联 onclick 先在目标上执行，这个委托监听随后关闭面板
    el.addEventListener('click', (ev) => {
      if (ev.target === el || ev.target.classList.contains('sheet-item')) closeSheet();
    });
    document.body.appendChild(el);
  }
```

- [ ] **Step 3: 切页时关闭面板**

把：

```js
  function go(v) { view = v; render(); window.scrollTo(0, 0); }
```

替换为：

```js
  function go(v) { closeSheet(); view = v; render(); window.scrollTo(0, 0); }
```

- [ ] **Step 4: 构建自检**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`（本步无行为改动）。

- [ ] **Step 5: 提交**

```bash
git add src/style.css src/app.js dist/index.html
git commit -m "feat(界面精简): 底部弹出面板组件 + topbar 右侧操作区 + 相关样式"
```

---

### Task 3: 修复 `routeByPhase` 误把子视图踢回记分页

**Files:**
- Modify: `src/app.js`（`routeByPhase` 函数）

**Interfaces:**
- Consumes: 无
- Produces（供 Task 4）：停留在 `players` / `rounds` / `record` 视图时，房间更新只重绘、不跳转。

**为什么必须先修**：现状是 playing 阶段只要 `view.name !== 'session'` 就强制跳回记分页，所以联机下任何房间更新都会把正在「玩家管理」的人弹走；Task 4 的明细页同样会被弹走、等于不可用。

- [ ] **Step 1: 替换 routeByPhase**

把：

```js
  // 按房间阶段决定当前应在哪个视图（大厅/记分/结算），并在原地更新
  function routeByPhase() {
    const phase = online.room.phase;
    if (phase === 'lobby') {
      if (view.name !== 'lobby') go({ name: 'lobby' }); else render();
    } else if (phase === 'playing') {
      if (view.name !== 'session') go({ name: 'session' }); else render();
    }
  }
```

整体替换为：

```js
  // playing 阶段的合法子视图：停在这些页面时房间更新只重绘，不要把人踢回记分页
  const PLAYING_VIEWS = ['session', 'record', 'players', 'rounds'];

  // 按房间阶段决定当前应在哪个视图（大厅/记分/结算），并在原地更新
  function routeByPhase() {
    const phase = online.room.phase;
    if (phase === 'lobby') {
      if (view.name !== 'lobby') go({ name: 'lobby' }); else render();
    } else if (phase === 'playing') {
      if (!PLAYING_VIEWS.includes(view.name)) go({ name: 'session' }); else render();
    }
  }
```

- [ ] **Step 2: 构建**

Run: `node build.js && node --check src/app.js`
Expected: 构建成功、语法通过。

- [ ] **Step 3: 手动 e2e（不再被踢）**

启动本机服务，用两个源（`localhost` / `127.0.0.1`）当两台设备：房主建 2 人局、两端各入座、开局。房主进「玩家管理」停在那里，让另一端在草稿里填一格触发房间更新——**房主应仍停在玩家管理页**（修复前会被弹回记分页）。

- [ ] **Step 4: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "fix(联机): 房间更新不再把玩家管理/明细等子视图踢回记分页"
```

---

### Task 4: 每局明细独立页

**Files:**
- Modify: `src/app.js`（`roundRow`、`VIEWS.session`、`VIEWS.rounds`、新增 `afterRecord`、`App.editRound/saveRound/cancelRecord`）

**Interfaces:**
- Consumes: Task 3 的 `PLAYING_VIEWS`（明细页停留时不被踢）
- Produces（供 Task 5）：`VIEWS.session` 内已有局部变量 `detailEntry`（明细入口行），Task 5 会把它放进新的返回结构。

- [ ] **Step 1: `roundRow` 增加来源参数**

把：

```js
  function roundRow(s, r, i, readonly) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢${r.at ? ` <span class="muted">${fmtTime(r.at)}</span>` : ''}
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
      ${readonly ? '' : `<div style="flex-shrink:0">
        <button class="btn btn-sm" onclick="App.editRound('${r.id}')">改</button>
        <button class="btn btn-sm" onclick="App.deleteRound('${r.id}')">删</button></div>`}
    </div>`;
  }
```

整体替换为：

```js
  // from：这一行是在哪个页面渲染的（'rounds' = 明细页），决定改完之后回哪
  function roundRow(s, r, i, readonly, from) {
    const detail = L.roundTransfers(r, s.pricePerCardFen)
      .map((t) => `${esc(t.from)} ${t.cards}张`).join('，');
    return `<div class="row">
      <div><b>第${i + 1}局</b> ${esc(r.winner)} 赢${r.at ? ` <span class="muted">${fmtTime(r.at)}</span>` : ''}
        <div class="muted">${detail || '其他人也都出完了'}</div></div>
      ${readonly ? '' : `<div style="flex-shrink:0">
        <button class="btn btn-sm" onclick="App.editRound('${r.id}','${from || 'session'}')">改</button>
        <button class="btn btn-sm" onclick="App.deleteRound('${r.id}')">删</button></div>`}
    </div>`;
  }
```

- [ ] **Step 2: 记分页把整段局列表换成一行入口**

`VIEWS.session` 里把这段：

```js
    const roundsCard = `<div class="card" style="margin-top:12px">
      ${s.rounds.map((r, i) => roundRow(s, r, i, !online.active ? false : !RunfastSync.canEdit(online.room, online.uid))).join('')
        || '<div class="muted">还没有记录' + (online.active ? '，在上面记这一局' : '，点上面「记一局」开始') + '</div>'}</div>`;
```

整体替换为：

```js
    const detailEntry = s.rounds.length
      ? `<button class="btn" style="margin-top:12px" onclick="App.goRounds('${s.id}','session')">查看每局明细（${s.rounds.length} 局） ›</button>`
      : `<div class="card" style="margin-top:12px"><div class="muted">还没有记录${online.active ? '，在上面记这一局' : '，点上面「记一局」开始'}</div></div>`;
```

然后把 `VIEWS.session` 里**两处** `${roundsCard}` 都改成 `${detailEntry}`（联机分支一处、本地分支一处）。

- [ ] **Step 3: 泛化 `VIEWS.rounds`**

把：

```js
  VIEWS.rounds = () => {
    const s = db.sessions.find((x) => x.id === view.sid);
    return `
      ${topbar('每局明细', `App.goSettle('${view.sid}','${view.from}')`)}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i, true)).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };
```

整体替换为：

```js
  VIEWS.rounds = () => {
    // 进行中的场（联机的不在 db.sessions 里）优先用 sessionCtx()，否则查本地历史
    const live = sessionCtx();
    const s = (live && live.id === view.sid) ? live : db.sessions.find((x) => x.id === view.sid);
    if (!s) return VIEWS.home();
    const fromSession = view.from === 'session';
    const editable = fromSession && (!online.active || RunfastSync.canEdit(online.room, online.uid));
    const back = fromSession ? 'App.goSession()' : `App.goSettle('${view.sid}','${view.from}')`;
    return `
      ${topbar('每局明细', back)}
      <div class="card">${s.rounds.map((r, i) => roundRow(s, r, i, !editable, 'rounds')).join('')
        || '<div class="muted">本场没有记录任何一局</div>'}</div>`;
  };
```

- [ ] **Step 4: 录入页结束后回到来源页**

在 `VIEWS.rounds` 之后（或任意 helper 区）新增：

```js
  // 录入/改局结束后回哪：从明细页进来的回明细页，否则回记分页
  function afterRecord(returnTo) {
    if (returnTo === 'rounds') {
      const s = sessionCtx();
      if (s) { App.goRounds(s.id, 'session'); return; }
    }
    App.goSession();
  }
```

把 `App.cancelRecord`：

```js
    cancelRecord() { App.goSession(); },
```

替换为：

```js
    cancelRecord() { afterRecord(view.returnTo); },
```

把 `App.editRound` 整体替换为（新增 `from` 参数并写入 `returnTo`）：

```js
    editRound(rid, from) {
      if (online.active && !RunfastSync.canEdit(online.room, online.uid)) { alert('房主未开启「允许他人修改」，只有房主可以改这一局'); return; }
      const s = sessionCtx();
      const i = s.rounds.findIndex((x) => x.id === rid);
      const r = s.rounds[i];
      const cards = Object.create(null), shutoutOff = Object.create(null);
      r.losers.forEach((l) => {
        cards[l.name] = l.cardsLeft;
        if (l.cardsLeft === 10 && !l.shutout) shutoutOff[l.name] = true;
      });
      go({
        name: 'record',
        participants: [r.winner, ...r.losers.map((l) => l.name)],
        winner: r.winner, cards, shutoutOff,
        editId: rid, editIndex: i + 1,
        returnTo: from === 'rounds' ? 'rounds' : 'session',
      });
    },
```

把 `App.saveRound` 整体替换为（导航前先捕获 `returnTo`，因为 `go()` 会替换 `view`）：

```js
    saveRound() {
      const losers = currentLosers();
      if (!view.winner || losers.some((l) => typeof l.cardsLeft !== 'number')) return;
      const winner = view.winner;
      const editId = view.editId;
      const returnTo = view.returnTo;
      const newRound = editId ? null : { id: 'r' + Date.now(), at: new Date().toISOString(), winner, losers };
      commitSession((s) => {
        if (editId) {
          const r = s.rounds.find((x) => x.id === editId);
          if (!r) return;
          r.winner = winner;
          r.losers = losers;
        } else {
          s.rounds.push(newRound);
        }
      });
      afterRecord(returnTo);
    },
```

- [ ] **Step 5: 构建 + 回归**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`。

- [ ] **Step 6: 手动 e2e（明细页）**

本地单机：开一场 → 记两局 → 记分页底部只剩「查看每局明细（2 局）›」→ 点进明细页看到两局带改/删 → 点「改」改一局保存 → **回到明细页**（不是记分页）→ 顶部「‹ 返回」回记分页。
联机：房主进明细页改一局；非房主进明细页应**无**改/删按钮；房主在菜单里打开「允许他人修改」后，非房主明细页实时出现改/删。

- [ ] **Step 7: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(界面精简): 每局明细独立成页，记分页只留入口；改局后回到来源页"
```

---

### Task 5: 顶栏收纳（更多菜单 + onlineBar 瘦身 + 大厅操作区）

**Files:**
- Modify: `src/app.js`（`onlineBar`、新增 `topActions`、`VIEWS.session` 两个分支、`VIEWS.lobby`、新增 `App.openMore`）

**Interfaces:**
- Consumes: Task 2 的 `topbar(title, backJs, actionsHtml)` / `openSheet(items)`；Task 4 的 `detailEntry`
- Produces: `topActions(withShare)` 生成顶栏右上角按钮组；`App.openMore()` 弹出按身份定制的菜单。

**注意**：`App.share()` 在 Task 6 才实现。本任务的分享按钮先接上 `App.share()`，Task 5 结束到 Task 6 之间点分享会报 `App.share is not a function`——这是已知的中间态，Task 6 立刻补上。

- [ ] **Step 1: onlineBar 去掉邀请/退出按钮**

把：

```js
  function onlineBar() {
    if (!online.active) return '';
    const playing = RunfastSync.playingCount(seatsOf());
    const watching = RunfastSync.observerCount(online.presence, seatsOf());
    const dot = online.status === 'connected' ? '' : 'off';
    return `<div class="sync-bar">
      <span><span class="sync-dot ${dot}"></span>房号 ${esc(online.code)} · ${playing} 人在玩 · ${watching} 人观战</span>
      <span>
        <button class="btn btn-sm" onclick="App.invite()">邀请</button>
        <button class="btn btn-sm" onclick="App.leaveRoom()">退出</button>
      </span>
    </div>`;
  }
```

整体替换为（只剩状态；邀请/退出移到顶栏与菜单）：

```js
  function onlineBar() {
    if (!online.active) return '';
    const playing = RunfastSync.playingCount(seatsOf());
    const watching = RunfastSync.observerCount(online.presence, seatsOf());
    const dot = online.status === 'connected' ? '' : 'off';
    return `<div class="sync-bar">
      <span><span class="sync-dot ${dot}"></span>房号 ${esc(online.code)} · ${playing} 人在玩 · ${watching} 人观战</span>
    </div>`;
  }

  // 顶栏右上角操作区：联机（含大厅）有分享，本地只有「更多」
  const topActions = (withShare) =>
    `${withShare ? '<button class="icon-btn" onclick="App.share()">分享</button>' : ''}<button class="icon-btn" onclick="App.openMore()">⋯</button>`;
```

- [ ] **Step 2: 记分页两个分支改用顶栏操作区，并删掉正文管理按钮**

`VIEWS.session` 里把联机分支：

```js
    if (online.active) {
      return `
        ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', '')}
        ${onlineBar()}
        ${scoreCard}
        ${emptySeatClaimCard()}
        ${draftCard()}
        ${isOwner() ? `<div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap">
          <button class="btn" onclick="App.goPlayers()">玩家管理</button>
          <button class="btn" onclick="App.voidSession()">作废本场</button>
          <button class="btn" onclick="App.toggleAllowEdit()">${online.room.allowEdit ? '✅ 牌友可改已存局' : '🔒 改局仅房主'}</button>
        </div>
        <div style="margin-top:10px"><button class="btn btn-danger" onclick="App.finishSession()">结束本场</button></div>` : ''}
        ${detailEntry}`;
    }
```

整体替换为：

```js
    if (online.active) {
      return `
        ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', '', topActions(true))}
        ${onlineBar()}
        ${scoreCard}
        ${emptySeatClaimCard()}
        ${draftCard()}
        ${detailEntry}`;
    }
```

再把本地分支：

```js
    // 本地单机（原逻辑）
    return `
      ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', 'App.goHome()')}
      ${scoreCard}
      <button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>
      <div style="display:flex;gap:10px;margin-top:10px">
        <button class="btn" onclick="App.goPlayers()">玩家管理</button>
        <button class="btn" onclick="App.voidSession()">作废本场</button>
      </div>
      <div style="margin-top:10px"><button class="btn btn-danger" onclick="App.finishSession()">结束本场</button></div>
      ${detailEntry}`;
```

整体替换为：

```js
    // 本地单机
    return `
      ${topbar('已记 ' + s.rounds.length + ' 局 · ' + yuan(s.pricePerCardFen) + '元/张', 'App.goHome()', topActions(false))}
      ${scoreCard}
      <button class="btn btn-primary" style="font-size:20px;padding:18px" onclick="App.goRecord()">📝 记一局</button>
      ${detailEntry}`;
```

- [ ] **Step 3: 大厅顶栏也给分享 / 更多**

`VIEWS.lobby` 里把：

```js
      ${topbar('等待入座 · ' + yuan(s.pricePerCardFen) + '元/张', '')}
```

替换为：

```js
      ${topbar('等待入座 · ' + yuan(s.pricePerCardFen) + '元/张', '', topActions(true))}
```

（大厅原本靠 `onlineBar` 里的邀请/退出，摘掉后必须由顶栏补上，否则大厅没有邀请与退出入口。）

- [ ] **Step 4: 新增 `App.openMore()`**

在 `App` 对象里（`App.leaveRoom` 之后）加：

```js
    openMore() {
      const items = [];
      if (!online.active) {                       // 本地单机
        items.push({ label: '玩家管理', onclick: 'App.goPlayers()' });
        items.push({ label: '作废本场', onclick: 'App.voidSession()', danger: true });
        items.push({ label: '结束本场', onclick: 'App.finishSession()', danger: true });
      } else if (view.name === 'lobby') {         // 大厅：与原能力等价，只有退出
        items.push({ label: '退出房间', onclick: 'App.leaveRoom()' });
      } else if (isOwner()) {                     // 联机房主
        items.push({ label: '玩家管理', onclick: 'App.goPlayers()' });
        items.push({ label: online.room.allowEdit ? '✅ 牌友可改已存局' : '🔒 改局仅房主', onclick: 'App.toggleAllowEdit()' });
        items.push({ label: '作废本场', onclick: 'App.voidSession()', danger: true });
        items.push({ label: '结束本场', onclick: 'App.finishSession()', danger: true });
        items.push({ label: '退出房间', onclick: 'App.leaveRoom()' });
      } else {                                    // 联机牌友/观战
        items.push({ label: '退出房间', onclick: 'App.leaveRoom()' });
      }
      openSheet(items);
    },
```

- [ ] **Step 5: 构建 + 回归**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`。

- [ ] **Step 6: 手动 e2e（菜单）**

本地：记分页右上只有 `⋯`，点开是 玩家管理 / 作废本场 / 结束本场 + 取消；点遮罩与点任一项都能关闭；正文不再有那排按钮。
联机：房主 `⋯` 五项齐全，切换「改局仅房主 / 牌友可改已存局」后再打开菜单标签已更新；非房主 `⋯` 只有「退出房间」；大厅 `⋯` 只有「退出房间」。

- [ ] **Step 7: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(界面精简): 管理项收进右上角底部菜单，onlineBar 只留状态，大厅顶栏补分享/更多"
```

---

### Task 6: 分享（原生优先 + 自建面板降级 + 二维码）

**Files:**
- Modify: `src/app.js`（删除 `App.invite`，新增 `App.share/shareFallback/copyInvite`）

**Interfaces:**
- Consumes: Task 1 的 `GET /qr?text=`；Task 2 的 `openSheet(items, headerHtml)`；Task 5 顶栏的「分享」按钮
- Produces: `App.share()` 供顶栏调用。

- [ ] **Step 1: 用 share 系列替换 invite**

把 `App.invite` 整体：

```js
    async invite() {
      const link = location.origin + location.pathname + '?room=' + online.code;
      const ok = await copyToClipboard('来跑得快记分房间围观/记分：' + link + '（房号 ' + online.code + '）');
      alert(ok ? '邀请链接已复制，发到群里吧' : '复制失败，请手动把房号告诉牌友：' + online.code);
    },
```

替换为：

```js
    // 系统分享面板只在安全上下文（HTTPS / localhost）可用；
    // 局域网明文 HTTP 下 navigator.share 根本不存在，直接走自建面板（房号 + 链接 + 二维码）。
    async share() {
      const link = inviteLink();
      if (navigator.share) {
        try {
          await navigator.share({ title: '跑得快记分', text: '一起来记分（房号 ' + online.code + '）', url: link });
          return;
        } catch (e) { if (e.name === 'AbortError') return; } // 用户取消就算了，其它错误落到降级
      }
      App.shareFallback();
    },

    shareFallback() {
      const link = inviteLink();
      const header = `<div style="text-align:center;padding:10px 0 4px">
        <div class="muted">房号</div>
        <div style="font-size:34px;font-weight:800;letter-spacing:4px">${esc(online.code)}</div>
        <img src="/qr?text=${encodeURIComponent(link)}" alt="扫码进房"
             style="width:180px;height:180px;margin:10px auto 6px;display:block">
        <div class="muted">让牌友扫码，或复制链接发群里</div>
        <div class="muted" style="word-break:break-all;margin-top:4px">${esc(link)}</div>
      </div>`;
      openSheet([{ label: '复制链接', onclick: 'App.copyInvite()' }], header);
    },

    async copyInvite() {
      const ok = await copyToClipboard('来跑得快记分房间围观/记分：' + inviteLink() + '（房号 ' + online.code + '）');
      alert(ok ? '邀请链接已复制，发到群里吧' : '复制失败，请手动把房号告诉牌友：' + online.code);
    },
```

- [ ] **Step 2: 新增 `inviteLink()` helper**

在 `App` 之前的 helper 区（`cleanEntries` 附近）加：

```js
  const inviteLink = () => location.origin + location.pathname + '?room=' + online.code;
```

- [ ] **Step 3: 确认没有遗留的 invite 调用**

Run: `grep -n "App.invite\|invite()" src/app.js`
Expected: 只出现 `copyInvite` 与 `inviteLink` 相关行，**不得**再有 `App.invite()`。

- [ ] **Step 4: 构建 + 回归**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`。

- [ ] **Step 5: 手动 e2e（分享）**

用 `http://127.0.0.1:PORT`（非 localhost，模拟局域网非安全上下文时 `navigator.share` 缺席的降级路径）打开：大厅或记分页点「分享」→ 弹出面板显示大字房号、二维码图片（应真的渲染出黑白码，不是碎图）、完整链接、「复制链接」按钮可用；点遮罩/取消可关闭。
另在 `http://localhost:PORT` 打开——localhost 属安全上下文，若浏览器支持则会弹系统分享面板（弹不出来也应安静降级到自建面板，不报错）。

- [ ] **Step 6: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(界面精简): 邀请改为原生分享优先，局域网降级为房号+链接+二维码面板"
```

---

### Task 7: 排行榜「我」标识

**Files:**
- Modify: `src/app.js`（新增 `myNames()`，`VIEWS.session` 的 `scoreCard`）

**Interfaces:**
- Consumes: Task 2 的 `.me-tag` 样式；现有 `mySeatIdx()` / `seatsOf()`
- Produces: 无（终点特性）

- [ ] **Step 1: 新增 `myNames()`**

在派生 helper 区（`allClaimed` 那一行之后）加：

```js
  // 我坐着的那些座位对应的名字（一台设备可代占多座，故是集合）
  const myNames = () => new Set(mySeatIdx().map((i) => seatsOf()[i].name));
```

- [ ] **Step 2: 比分卡加「我」标签**

`VIEWS.session` 里把：

```js
    const scoreCard = `<div class="card">
      ${net.map((p) => `<div class="row">
        <span>${esc(p.name)}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
        <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
      </div>`).join('')}</div>`;
```

整体替换为：

```js
    const mine = online.active ? myNames() : new Set();   // 本地单机无联机身份，不标「我」
    const scoreCard = `<div class="card">
      ${net.map((p) => `<div class="row">
        <span>${esc(p.name)}${mine.has(p.name) ? ' <span class="me-tag">我</span>' : ''}${s.activePlayers.includes(p.name) ? '' : ' <span class="muted">（已离场）</span>'}</span>
        <span class="${cls(p.fen)}">${p.cards > 0 ? '+' : ''}${p.cards} 张 · ${signYuan(p.fen)} 元</span>
      </div>`).join('')}</div>`;
```

- [ ] **Step 3: 构建 + 回归**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`。

- [ ] **Step 4: 手动 e2e（我标识）**

联机 3 人局：普通牌友端比分卡里**只有自己那行**带「我」；房主代占两座时**那两行都带「我」**；观战端（未入座）**没有任何行**带「我」。本地单机场比分卡不出现「我」。

- [ ] **Step 5: 提交**

```bash
git add src/app.js dist/index.html
git commit -m "feat(界面精简): 比分卡标出「我」（我持有的每个座位都标）"
```

---

### Task 8: 全链路双机回归 e2e

**Files:**
- 无代码改动；若发现问题，就地修复并在本任务内提交。

**Interfaces:**
- Consumes: Task 1–7 全部产物
- Produces: 验收通过的系统

- [ ] **Step 1: 自动化回归**

Run: `node build.js && node --check src/app.js && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: 构建成功、语法通过、`ℹ fail 0`（应比改动前多 1 个测试，即 `/qr`）。

- [ ] **Step 2: 双机全链路 e2e**

起本机服务，用 `localhost` 与 `127.0.0.1` 两个源当两台设备，逐条验证：

1. 大厅：顶栏 `[分享][⋯]`；分享面板二维码可渲染；`⋯` 只有「退出房间」；认领座位、满员开局照常。
2. 记分页房主：`⋯` 五项齐全且权限标签随开关更新；正文只剩比分 / 空座认领 / 草稿 / 明细入口。
3. 协作记分未受影响：赢家先定 → 各自填 → 确认 → 全部确认后自动记局。
4. 明细页：进入、房主改/删、改完回明细页、返回回记分页；非房主无改删；房主开「允许他人修改」后非房主实时出现改删。
5. **子视图不被踢**：一端停在明细页 / 玩家管理，另一端触发房间更新，本端不跳转。
6. 「我」标识：牌友一行、房主代占多座多行、观战端无。
7. 玩家管理加人/离场、结束本场 → 两端存本地历史 → 结算页 → 房主关闭房间，均照常。
8. 本地单机：`⋯` 三项、明细页可改删、无分享入口、无「我」标识；开新一场→记一局→改→删→结束 全程正常。
9. 全程浏览器控制台无红色报错。

- [ ] **Step 3: 提交（若有修复）**

```bash
git add -A src/ dist/ server.js test/
git commit -m "fix(界面精简): 全链路回归发现的问题修复"
```

若无修复则跳过本步。

---

## Self-Review

- **Spec 覆盖**：底部面板+topbar 操作区(§1)→Task 2；顶栏收纳与各身份菜单(§2，含大厅)→Task 5；分享原生优先+降级面板+`/qr`(§3)→Task 1+6；明细独立页与返回定位(§4)→Task 4；「我」标识(§5)→Task 7；`routeByPhase` 修复(§6)→Task 3；验证计划(§8)→各任务 e2e 步 + Task 8。非目标(§7)未被任何任务触碰。
- **占位符扫描**：无 TBD/TODO；每个改动步骤都给出完整替换代码与精确锚点。
- **类型/命名一致**：`topbar(title, backJs, actionsHtml)`、`openSheet(items, headerHtml)`、`closeSheet()`、`topActions(withShare)`、`roundRow(s, r, i, readonly, from)`、`afterRecord(returnTo)`、`inviteLink()`、`myNames()`、`PLAYING_VIEWS` 贯穿各任务一致；`detailEntry` 在 Task 4 定义、Task 5 复用；`App.editRound(rid, from)` 的第二参数与 `roundRow` 传入的 `from` 对应。
- **顺序安全**：Task 3 先于 Task 4（否则明细页会被踢走）；Task 2 先于 Task 5/6（组件依赖）；Task 1 先于 Task 6（二维码端点）。Task 5 与 Task 6 之间存在一个已在 Task 5 显式标注的中间态（分享按钮暂时无实现），Task 6 立即补齐。
- **风险点**：面板挂 `body` 且 `go()` 内 `closeSheet()`，避免与 `render()` 竞态和切页残留；`saveRound` 在导航前捕获 `returnTo`；`/qr` 只读且限长，不扩大服务器攻击面。
