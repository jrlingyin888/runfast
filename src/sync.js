// 联机同步：Firebase RTDB REST + SSE，无 SDK。
// 浏览器全局 RunfastSync；Node 下 module.exports 供纯函数测试。
var RunfastSync = (function () {
  'use strict';

  // Task 6 由控制器替换为真实值
  const FB = { apiKey: '__FB_API_KEY__', databaseURL: '__FB_DB_URL__' };
  const configured = () => !FB.apiKey.startsWith('__');

  // ---------- 纯函数 ----------
  function genRoomCode(rand) {
    const r = rand || Math.random;
    let s = '';
    for (let i = 0; i < 6; i++) s += Math.floor(r() * 10);
    return s;
  }
  const validRoomCode = (s) => typeof s === 'string' && /^[0-9]{6}$/.test(s);
  const canEdit = (room, uid) => !!room && !!uid && (room.creatorUid === uid || room.allowEdit === true);
  const canAdmin = (room, uid) => !!room && !!uid && room.creatorUid === uid;

  // SSE put 事件 → 本地房间镜像
  function applyEvent(room, path, data) {
    if (path === '/' || room == null) return data;
    const keys = path.replace(/^\//, '').split('/');
    const next = JSON.parse(JSON.stringify(room));
    let node = next;
    for (let i = 0; i < keys.length - 1; i++) node = node[keys[i]] ||= {};
    const last = keys[keys.length - 1];
    if (data === null) delete node[last];
    else node[last] = data;
    return next;
  }

  // ---------- 匿名认证 ----------
  const AUTH_KEY = 'runfast.sync.v1';
  let auth = null; // {uid, idToken, refreshToken, expiresAt}

  async function signIn() {
    if (auth) return auth;
    try { auth = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { auth = null; }
    if (auth && auth.refreshToken) {
      if (Date.now() > auth.expiresAt - 60000) await refreshIdToken();
      return auth;
    }
    const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + FB.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    if (!res.ok) throw new Error('匿名登录失败');
    const d = await res.json();
    auth = { uid: d.localId, idToken: d.idToken, refreshToken: d.refreshToken, expiresAt: Date.now() + d.expiresIn * 1000 };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }

  async function refreshIdToken() {
    const res = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FB.apiKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(auth.refreshToken),
    });
    if (!res.ok) { // refresh token 失效则重新匿名注册（旧身份房间将失去房主权，可接受）
      localStorage.removeItem(AUTH_KEY);
      auth = null;
      return signIn();
    }
    const d = await res.json();
    auth = { uid: d.user_id, idToken: d.id_token, refreshToken: d.refresh_token, expiresAt: Date.now() + d.expires_in * 1000 };
    localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
    return auth;
  }

  async function freshToken() {
    await signIn();
    if (Date.now() > auth.expiresAt - 60000) await refreshIdToken();
    return auth.idToken;
  }

  const getUid = () => (auth ? auth.uid : null);

  // ---------- REST ----------
  const roomUrl = (code) => FB.databaseURL + '/rooms/' + code + '.json';

  async function readRoom(code) {
    const token = await freshToken();
    const res = await fetch(roomUrl(code) + '?auth=' + token, { headers: { 'X-Firebase-ETag': 'true' } });
    if (!res.ok) throw new Error('读取失败 ' + res.status);
    return { data: await res.json(), etag: res.headers.get('ETag') };
  }

  async function writeRoom(code, data, etag) {
    const token = await freshToken();
    const res = await fetch(roomUrl(code) + '?auth=' + token, {
      method: data === null ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'if-match': etag, 'X-Firebase-ETag': 'true' },
      body: data === null ? undefined : JSON.stringify(data),
    });
    if (res.status === 412) return { conflict: true };
    if (res.status === 401 || res.status === 403) throw new Error('没有修改权限');
    if (!res.ok) throw new Error('写入失败 ' + res.status);
    return { conflict: false };
  }

  // 读-改-条件写；412 重试
  async function mutate(code, opFn) {
    for (let i = 0; i < 4; i++) {
      const { data, etag } = await readRoom(code);
      if (data === null) throw new Error('房间不存在或已关闭');
      const next = opFn(JSON.parse(JSON.stringify(data)));
      const w = await writeRoom(code, next, etag);
      if (!w.conflict) return next;
    }
    throw new Error('操作冲突，请重试');
  }

  async function createRoom(session) {
    await signIn();
    for (let i = 0; i < 5; i++) {
      const code = genRoomCode();
      const { data, etag } = await readRoom(code);
      if (data !== null) continue; // 房号被占用，换一个
      const room = { creatorUid: auth.uid, allowEdit: false, updatedAt: Date.now(), session };
      const w = await writeRoom(code, room, etag);
      if (!w.conflict) return code;
    }
    throw new Error('建房失败，请重试');
  }

  async function deleteRoom(code) {
    for (let i = 0; i < 4; i++) {
      const { data, etag } = await readRoom(code);
      if (data === null) return;
      const w = await writeRoom(code, null, etag);
      if (!w.conflict) return;
    }
    throw new Error('关闭房间失败，请重试');
  }

  // ---------- SSE 订阅 ----------
  let es = null, currentCode = null, cb = null, room = null, resubTimer = null;

  async function subscribe(code, callbacks) {
    close();
    currentCode = code;
    cb = callbacks;
    await openStream();
  }

  async function openStream() {
    if (!currentCode) return;
    const token = await freshToken();
    if (cb.onStatus) cb.onStatus('connecting');
    es = new EventSource(roomUrl(currentCode) + '?auth=' + token);
    es.addEventListener('put', onEvt);
    es.addEventListener('patch', onEvt);
    es.addEventListener('auth_revoked', () => { es.close(); openStream(); });
    es.onopen = () => { if (cb.onStatus) cb.onStatus('connected'); };
    es.onerror = () => { if (cb.onStatus) cb.onStatus('connecting'); };
    clearTimeout(resubTimer);
    resubTimer = setTimeout(() => { if (es) { es.close(); openStream(); } }, 50 * 60 * 1000);
  }

  function onEvt(e) {
    const { path, data } = JSON.parse(e.data);
    room = applyEvent(room, path, data);
    if (room === null) { if (cb.onDeleted) cb.onDeleted(); return; }
    if (cb.onRoom) cb.onRoom(room);
  }

  function close() {
    clearTimeout(resubTimer);
    if (es) es.close();
    es = null; room = null; currentCode = null; cb = null;
  }

  const api = { configured, genRoomCode, validRoomCode, canEdit, canAdmin, applyEvent,
    signIn, getUid, createRoom, readRoom, subscribe, mutate, deleteRoom, close };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
