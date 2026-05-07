export const SW_JS = `self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  const options = {
    body: data.body || '',
    icon: '🎵',
    badge: '🎵',
    tag: data.tag || 'ncm-am-sync',
    data: data.url || '/',
  };
  event.waitUntil(self.registration.showNotification(data.title || 'NCM → AM 同步', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data || '/'));
});`;

export function subscribeHtml(vapidPublicKey: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NCM → AM 推送通知</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#0b1020;color:#e6edf7;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center}
    .card{width:min(420px,92vw);background:#121a2b;border:1px solid #253149;border-radius:18px;padding:28px;box-shadow:0 18px 40px rgba(0,0,0,.35)}
    h1{margin:0 0 8px;font-size:22px}.desc{color:#98a2b3;margin:0 0 18px}.btn{width:100%;border:0;border-radius:10px;padding:12px 16px;font-weight:600;cursor:pointer}
    .primary{background:#4f46e5;color:#fff}.secondary{margin-top:10px;background:transparent;color:#fda4af;border:1px solid #7f1d1d}.status{margin-top:14px;padding:10px 12px;border-radius:10px;background:#111827;color:#cbd5e1}
  </style>
</head>
<body>
  <div class="card">
    <h1>🔔 浏览器推送通知</h1>
    <p class="desc">同步完成或失败后，在当前浏览器接收通知。</p>
    <button id="sub" class="btn primary">开启通知</button>
    <button id="unsub" class="btn secondary" style="display:none">取消通知</button>
    <div id="status" class="status">等待操作</div>
  </div>
  <script>
    const PUBLIC_KEY = ${JSON.stringify(vapidPublicKey)};
    const statusEl = document.getElementById('status');
    function msg(text){statusEl.textContent=text;}
    function b64(input){const pad='='.repeat((4-input.length%4)%4);const base=(input+pad).replace(/-/g,'+').replace(/_/g,'/');return Uint8Array.from(atob(base),c=>c.charCodeAt(0));}
    async function refresh(){
      const ready = await navigator.serviceWorker.ready;
      const sub = await ready.pushManager.getSubscription();
      document.getElementById('sub').style.display = sub ? 'none' : 'block';
      document.getElementById('unsub').style.display = sub ? 'block' : 'none';
      msg(sub ? '✅ 已订阅通知' : '未订阅通知');
    }
    document.getElementById('sub').onclick = async () => {
      try{
        if (Notification.permission !== 'granted') {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') throw new Error('通知权限被拒绝');
        }
        const ready = await navigator.serviceWorker.ready;
        const sub = await ready.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:b64(PUBLIC_KEY)});
        const resp = await fetch('/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub.toJSON())});
        if(!resp.ok) throw new Error('订阅请求失败');
        await refresh();
      }catch(error){msg('❌ '+error.message);}
    };
    document.getElementById('unsub').onclick = async () => {
      const ready = await navigator.serviceWorker.ready;
      const sub = await ready.pushManager.getSubscription();
      if (sub) {
        await fetch('/subscribe',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})});
        await sub.unsubscribe();
      }
      await refresh();
    };
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then(refresh);
  </script>
</body>
</html>`;
}

export function frontendHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NCM → Apple Music</title>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#090f1f;color:#e5edf7;font:14px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    a{color:#93c5fd;text-decoration:none}a:hover{text-decoration:underline}
    .page{max-width:1180px;margin:0 auto;padding:24px}
    .card{background:#121a2b;border:1px solid #22304a;border-radius:18px;box-shadow:0 16px 34px rgba(0,0,0,.22)}
    .auth-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .auth-card{width:min(460px,100%);padding:28px}
    .title{font-size:28px;font-weight:700;margin:0 0 8px}
    .subtitle{color:#98a2b3;margin:0 0 18px}
    .field{margin-top:14px}
    .field label{display:block;font-size:13px;color:#a9b5c9;margin-bottom:8px}
    .field input[type=password],.field input[type=text]{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #30415f;background:#0b1325;color:#fff;outline:none}
    .field input:focus{border-color:#6366f1}
    .checkbox{display:flex;gap:10px;align-items:flex-start;color:#c4cede;margin:16px 0}
    .actions{display:flex;gap:10px;flex-wrap:wrap}
    .btn{border:0;border-radius:12px;padding:11px 16px;font-weight:600;cursor:pointer;transition:.15s ease;background:#1f2a44;color:#e5edf7}
    .btn:hover{transform:translateY(-1px)}
    .btn:disabled{opacity:.6;cursor:not-allowed;transform:none}
    .btn-primary{background:#4f46e5;color:#fff}
    .btn-danger{background:#3f1d1d;color:#fecaca}
    .btn-secondary{background:#17233a}
    .hidden{display:none!important}
    .shell{display:grid;gap:16px}
    .header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:24px}
    .header h1{margin:0;font-size:24px}
    .muted{color:#98a2b3}
    .badge{display:inline-flex;align-items:center;gap:6px;background:#1d2841;border:1px solid #30415f;padding:6px 10px;border-radius:999px;color:#dbe6f5;font-size:12px}
    .badge.success{background:#10281f;border-color:#1b5e3a;color:#86efac}
    .badge.error{background:#351a1f;border-color:#7f1d1d;color:#fda4af}
    .badge.warn{background:#35270f;border-color:#854d0e;color:#fcd34d}
    .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:0 24px 24px}
    .stat{padding:16px;border-radius:14px;background:#0f1728;border:1px solid #22304a}
    .stat-label{display:block;color:#98a2b3;font-size:12px;margin-bottom:6px}
    .stat-value{display:block;font-size:20px;font-weight:700}
    .section{padding:0 24px 24px}
    .section h2{margin:0 0 12px;font-size:18px}
    .steps{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
    .step{padding:12px;border-radius:12px;background:#0f1728;border:1px solid #22304a;min-height:84px}
    .step-title{font-size:13px;font-weight:700;margin-bottom:6px}
    .step.pending{opacity:.65}.step.running{border-color:#6366f1;box-shadow:inset 0 0 0 1px #6366f1}.step.done{border-color:#1f7a4d}.step.error{border-color:#b91c1c}
    .notice-list{display:grid;gap:10px}
    .notice{padding:12px 14px;border-radius:12px;background:#0f1728;border:1px solid #22304a}
    .notice.error{border-color:#7f1d1d;color:#fecaca}.notice.warning{border-color:#854d0e;color:#fde68a}
    .phase-panel{padding:18px;border-radius:14px;background:#0f1728;border:1px solid #22304a}
    .spinner{width:18px;height:18px;border-radius:999px;border:3px solid #30415f;border-top-color:#818cf8;display:inline-block;vertical-align:middle;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .song-grid,.match-grid{display:grid;gap:12px}
    .song-item,.match-card{padding:14px;border-radius:14px;background:#0f1728;border:1px solid #22304a}
    .song-item{display:grid;grid-template-columns:64px 1fr auto;gap:14px;align-items:center}
    .cover{width:64px;height:64px;border-radius:12px;background:#111827;object-fit:cover}
    .song-name{font-weight:700;font-size:15px}
    .song-meta{color:#98a2b3;font-size:13px}
    .song-actions{display:flex;gap:8px;flex-wrap:wrap}
    .match-card.review{border-color:#854d0e}.match-card.matched{border-color:#1f7a4d}.match-card.skipped{border-color:#334155}.match-card.error{border-color:#b91c1c}
    .match-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:12px}
    .match-status{font-size:12px;padding:4px 8px;border-radius:999px;background:#1d2841}
    .match-status.matched{background:#10281f;color:#86efac}.match-status.review{background:#35270f;color:#fcd34d}.match-status.skipped{background:#1f2937;color:#cbd5e1}.match-status.error{background:#351a1f;color:#fda4af}
    .query-row{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 12px}
    .query-row input{flex:1;min-width:220px;padding:10px 12px;border-radius:10px;border:1px solid #30415f;background:#0b1325;color:#fff}
    .candidate-list{display:grid;gap:10px}
    .candidate{display:grid;grid-template-columns:52px 1fr auto;gap:12px;align-items:center;padding:12px;border-radius:12px;border:1px solid #2e3c59;background:#10182a;cursor:pointer}
    .candidate.selected{border-color:#4f46e5;background:#131d35}
    .candidate img{width:52px;height:52px;border-radius:10px;background:#111827;object-fit:cover}
    .candidate-title{font-weight:600}
    .candidate-meta{font-size:12px;color:#98a2b3}
    .candidate-side{text-align:right;font-size:12px;color:#cbd5e1}
    .empty{padding:14px;border-radius:12px;background:#0b1325;color:#98a2b3;border:1px dashed #30415f}
    .inline-list{display:flex;gap:8px;flex-wrap:wrap}
    .topbar{display:flex;justify-content:flex-end;gap:10px;padding:0 24px 24px}
    .push{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px 24px}
    .push-status{color:#98a2b3}
    .log{display:grid;gap:8px;max-height:220px;overflow:auto}
    .log-item{padding:10px 12px;border-radius:10px;background:#0f1728;border:1px solid #22304a;font-size:13px}
    .log-item.info{color:#bfdbfe}.log-item.success{color:#86efac}.log-item.error{color:#fca5a5}
    @media (max-width:860px){.song-item{grid-template-columns:56px 1fr}.song-actions{grid-column:1/-1}.steps{grid-template-columns:1fr}.header{flex-direction:column}.push{flex-direction:column;align-items:flex-start}}
  </style>
</head>
<body>
  <div id="auth-screen" class="auth-wrap">
    <div class="card auth-card">
      <h1 class="title">🎵 NCM → Apple Music</h1>
      <p class="subtitle">先收集网易云日推，再在 Apple Music 中确认歌曲并创建歌单。</p>
      <div class="field">
        <label for="token-input">Sync Token</label>
        <input id="token-input" type="password" placeholder="输入 token">
      </div>
      <label class="checkbox">
        <input id="auto-check" type="checkbox">
        <span>Automatic Skip Missing Songs。启用后，phase 2 未确认的歌曲会直接跳过并进入下一步。</span>
      </label>
      <div class="actions">
        <button id="start-btn" class="btn btn-primary">开始同步</button>
        <button id="resume-btn" class="btn btn-secondary hidden">恢复会话</button>
      </div>
      <div id="auth-error" class="notice error hidden" style="margin-top:14px"></div>
    </div>
  </div>

  <div id="app" class="page hidden">
    <div class="shell">
      <div class="card">
        <div class="header">
          <div>
            <h1 id="page-title">同步控制台</h1>
            <div id="page-subtitle" class="muted">等待会话</div>
          </div>
          <div id="page-badges" class="inline-list"></div>
        </div>
        <div class="topbar">
          <button class="btn btn-secondary" id="refresh-btn">刷新状态</button>
          <button class="btn btn-danger" id="restart-btn">新建会话</button>
        </div>
        <div class="stats" id="stats"></div>
        <div class="section">
          <h2>阶段进度</h2>
          <div class="steps" id="steps"></div>
        </div>
        <div class="section">
          <h2>问题与提示</h2>
          <div class="notice-list" id="issues"></div>
        </div>
      </div>

      <div class="card">
        <div class="section">
          <h2>当前内容</h2>
          <div id="content"></div>
        </div>
      </div>

      <div class="card">
        <div class="push">
          <div>
            <div style="font-weight:700">🔔 浏览器通知</div>
            <div id="push-status" class="push-status">未检测</div>
          </div>
          <div class="actions">
            <button id="push-sub" class="btn btn-primary">开启通知</button>
            <button id="push-unsub" class="btn btn-secondary hidden">取消通知</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section">
          <h2>操作日志</h2>
          <div id="log" class="log"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const BASE = location.origin;
    const STATE = {
      token: '',
      session: '',
      auto: false,
      payload: null,
      vapidKey: '',
      nextTimer: null,
    };

    function esc(value) {
      const div = document.createElement('div');
      div.textContent = value == null ? '' : String(value);
      return div.innerHTML;
    }

    function escAttr(value) {
      return esc(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function sessionFromUrl() {
      return new URLSearchParams(location.search).get('session') || '';
    }

    function saveLocal() {
      localStorage.setItem('ncm_am_token', STATE.token);
      localStorage.setItem('ncm_am_session', STATE.session);
      localStorage.setItem('ncm_am_auto', STATE.auto ? '1' : '0');
    }

    function loadLocal() {
      STATE.token = localStorage.getItem('ncm_am_token') || '';
      STATE.session = localStorage.getItem('ncm_am_session') || '';
      STATE.auto = localStorage.getItem('ncm_am_auto') === '1';
    }

    function clearSessionOnly() {
      STATE.session = '';
      localStorage.removeItem('ncm_am_session');
    }

    function showAuthError(message) {
      const node = document.getElementById('auth-error');
      node.textContent = message;
      node.classList.remove('hidden');
    }

    function hideAuthError() {
      document.getElementById('auth-error').classList.add('hidden');
    }

    function log(type, message) {
      const node = document.createElement('div');
      node.className = 'log-item ' + type;
      node.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '  ' + message;
      const box = document.getElementById('log');
      box.prepend(node);
    }

    async function api(path) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await fetch(BASE + path + separator + 'token=' + encodeURIComponent(STATE.token));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || response.statusText || 'Request failed');
      }
      return data;
    }

    function setPayload(payload) {
      STATE.payload = payload;
      STATE.session = payload ? payload.sessionId : STATE.session;
      saveLocal();
    }

    function showApp() {
      document.getElementById('auth-screen').classList.add('hidden');
      document.getElementById('app').classList.remove('hidden');
    }

    function showAuth() {
      document.getElementById('auth-screen').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
    }

    function clearNextTimer() {
      if (STATE.nextTimer) {
        clearTimeout(STATE.nextTimer);
        STATE.nextTimer = null;
      }
    }

    function formatStatus(payload) {
      if (!payload) return '';
      if (payload.status === 'done') return '已完成';
      if (payload.status === 'error') return '失败';
      if (payload.status === 'cancelled') return '已取消';
      if (payload.state === 'review_required') return '等待人工确认';
      if (payload.state === 'searching') return '搜索中';
      if (payload.state === 'collecting') return '收集中';
      if (payload.state === 'creating_playlist') return '创建歌单中';
      if (payload.state === 'adding_tracks') return '添加歌曲中';
      if (payload.state === 'cleaning_old_playlists') return '清理旧歌单中';
      return payload.state;
    }

    function statCard(label, value) {
      return '<div class="stat"><span class="stat-label">' + esc(label) + '</span><span class="stat-value">' + esc(value) + '</span></div>';
    }

    function renderStats(payload) {
      const stats = [
        statCard('会话', payload.sessionId.slice(0, 8)),
        statCard('状态', formatStatus(payload)),
        statCard('阶段', 'Phase ' + payload.currentPhase),
        statCard('总歌曲', payload.data.ncmTotal),
        statCard('已确认', payload.progress.matched),
        statCard('待处理', payload.progress.review),
        statCard('已跳过', payload.progress.skipped),
        statCard('错误', payload.progress.errors),
        statCard('区域', payload.data.storefront || '-'),
        statCard('账户', payload.data.accountLabel || '-'),
      ];
      document.getElementById('stats').innerHTML = stats.join('');
    }

    function renderBadges(payload) {
      const badges = [];
      badges.push('<span class="badge">' + esc(payload.source === 'cron' ? 'CRON' : '网页触发') + '</span>');
      badges.push('<span class="badge">' + (payload.auto ? 'Automatic Skip Missing Songs' : '需要人工确认') + '</span>');
      if (payload.active) badges.push('<span class="badge success">Active Session</span>');
      if (payload.status === 'error') badges.push('<span class="badge error">错误</span>');
      if (payload.status === 'done') badges.push('<span class="badge success">已完成</span>');
      if (payload.state === 'review_required') badges.push('<span class="badge warn">需要选择歌曲</span>');
      document.getElementById('page-badges').innerHTML = badges.join('');
    }

    function renderSteps(payload) {
      document.getElementById('steps').innerHTML = payload.phaseSummary.map(function(step) {
        return '<div class="step ' + step.status + '"><div class="step-title">Phase ' + step.phase + ' · ' + esc(step.title) + '</div><div class="muted">' + esc(step.detail) + '</div></div>';
      }).join('');
    }

    function renderIssues(payload) {
      const issues = payload.issues || [];
      if (!issues.length) {
        document.getElementById('issues').innerHTML = '<div class="notice">当前没有需要处理的问题。</div>';
        return;
      }
      document.getElementById('issues').innerHTML = issues.map(function(issue) {
        const tone = issue.severity === 'error' ? 'error' : 'warning';
        const extra = issue.ncmId ? ' · Song #' + issue.ncmId : '';
        return '<div class="notice ' + tone + '"><strong>P' + issue.phase + '</strong> · ' + esc(issue.code) + extra + '<div>' + esc(issue.message) + (issue.retryable ? '（可重试）' : '') + '</div></div>';
      }).join('');
    }

    function songList(items) {
      return '<div class="song-grid">' + items.map(function(song) {
        const image = song.cover ? '<img class="cover" src="' + escAttr(song.cover) + '" alt="">' : '<div class="cover"></div>';
        return '<div class="song-item">' +
          image +
          '<div><div class="song-name">' + esc(song.name) + '</div><div class="song-meta">' + esc(song.artist) + ' · ' + esc(song.album) + '</div></div>' +
          '<div class="song-actions"><a class="btn btn-secondary" target="_blank" href="' + escAttr(song.ncmUrl) + '">网易云</a></div>' +
        '</div>';
      }).join('') + '</div>';
    }

    function candidateButton(song, candidate) {
      const selected = song.selectedCandidate && song.selectedCandidate.id === candidate.id && song.status === 'matched';
      const artwork = candidate.artworkUrl
        ? '<img src="' + escAttr(candidate.artworkUrl) + '" alt="">'
        : '<div class="cover" style="width:52px;height:52px"></div>';
      const openLink = candidate.url
        ? '<div><a target="_blank" href="' + escAttr(candidate.url) + '">打开 Apple Music</a></div>'
        : '';
      return '<button class="candidate ' + (selected ? 'selected' : '') + '" onclick="selectCandidate(' + song.ncmId + ', ' + JSON.stringify(candidate.id) + ')">' +
        artwork +
        '<div><div class="candidate-title">' + esc(candidate.name) + '</div><div class="candidate-meta">' + esc(candidate.artist) + ' · ' + esc(candidate.album || '-') + ' · ' + esc(candidate.source) + openLink + '</div></div>' +
        '<div class="candidate-side"><div>分数 ' + esc(candidate.score) + '</div><div>' + (selected ? '已选择' : '选择此曲') + '</div></div>' +
      '</button>';
    }

    function songStatusLabel(song) {
      if (song.status === 'matched') return '已确认';
      if (song.status === 'needs_review') return '待确认';
      if (song.status === 'skipped') return '已跳过';
      if (song.status === 'error') return '搜索报错';
      return '待处理';
    }

    function renderMatchCard(song) {
      const issues = song.issues && song.issues.length
        ? '<div class="notice-list" style="margin-top:10px">' + song.issues.map(function(issue) {
            return '<div class="notice error">' + esc(issue.message) + (issue.retryable ? '（可重试）' : '') + '</div>';
          }).join('') + '</div>'
        : '';
      const selected = song.selectedCandidate
        ? '<div class="notice" style="margin-bottom:10px">当前选择：' + esc(song.selectedCandidate.name) + ' · ' + esc(song.selectedCandidate.artist) + '</div>'
        : '';
      const empty = '<div class="empty">暂无候选，请修改搜索词后重试，或直接跳过这首。</div>';
      return '<div class="match-card ' + song.status + '">' +
        '<div class="match-head">' +
          '<div><div class="song-name">' + esc(song.ncmName) + '</div><div class="song-meta">' + esc(song.ncmArtist) + ' · ' + esc(song.ncmAlbum) + ' · <a target="_blank" href="' + escAttr(song.ncmUrl) + '">网易云</a></div></div>' +
          '<div class="match-status ' + (song.status === 'needs_review' ? 'review' : song.status) + '">' + esc(songStatusLabel(song)) + '</div>' +
        '</div>' +
        selected +
        '<div class="query-row">' +
          '<input id="query-' + song.ncmId + '" type="text" value="' + escAttr(song.query || (song.ncmName + ' ' + song.ncmArtist)) + '" placeholder="重新搜索 Apple Music">' +
          '<button class="btn btn-secondary" onclick="searchSong(' + song.ncmId + ')">重新搜索</button>' +
          '<button class="btn btn-secondary" onclick="skipSong(' + song.ncmId + ')">跳过此首</button>' +
        '</div>' +
        '<div class="candidate-list">' + (song.candidates && song.candidates.length ? song.candidates.map(function(candidate) {
          return candidateButton(song, candidate);
        }).join('') : empty) + '</div>' +
        issues +
      '</div>';
    }

    function searchingView(payload) {
      return '<div class="phase-panel"><div><span class="spinner"></span> 正在搜索 Apple Music：' + esc(payload.progress.processed + '/' + payload.progress.total) + '</div><p class="muted">Phase 1 已完成，下面是本次收集到的网易云日推歌曲。</p></div>' +
        '<div style="height:12px"></div>' + songList(payload.data.ncmSongs);
    }

    function reviewView(payload) {
      const matches = payload.data.songMatches || [];
      const unresolved = matches.filter(function(song) { return song.status === 'needs_review' || song.status === 'error'; });
      const selected = matches.filter(function(song) { return song.status === 'matched'; });
      const skipped = matches.filter(function(song) { return song.status === 'skipped'; });
      let html = '<div class="phase-panel"><div style="font-weight:700;margin-bottom:8px">Phase 2 结果</div><div class="muted">默认已经展示候选项。你可以直接点选歌曲，也可以改搜或跳过。</div><div class="actions" style="margin-top:14px"><button class="btn btn-primary" onclick="continueReview()">继续下一步</button></div></div>';
      html += '<div style="height:16px"></div>';
      html += '<div class="section" style="padding:0"><h2>待处理歌曲</h2>' + (unresolved.length ? '<div class="match-grid">' + unresolved.map(renderMatchCard).join('') + '</div>' : '<div class="empty">没有待处理歌曲。</div>') + '</div>';
      html += '<div style="height:16px"></div>';
      html += '<div class="section" style="padding:0"><h2>已确认歌曲</h2>' + (selected.length ? '<div class="match-grid">' + selected.map(renderMatchCard).join('') + '</div>' : '<div class="empty">尚未确认任何歌曲。</div>') + '</div>';
      if (skipped.length) {
        html += '<div style="height:16px"></div><div class="section" style="padding:0"><h2>已跳过歌曲</h2><div class="match-grid">' + skipped.map(renderMatchCard).join('') + '</div></div>';
      }
      return html;
    }

    function phaseWaitView(payload, text) {
      const summary = '<div class="notice">歌单：' + esc(payload.data.playlistName || '-') + ' · 已确认 ' + esc(payload.progress.matched) + ' 首 · 已跳过 ' + esc(payload.progress.skipped) + ' 首</div>';
      return '<div class="phase-panel"><div><span class="spinner"></span> ' + esc(text) + '</div><div style="height:12px"></div>' + summary + '</div>';
    }

    function doneView(payload) {
      const deleted = payload.data.deletedPlaylists && payload.data.deletedPlaylists.length
        ? payload.data.deletedPlaylists.map(function(name) { return '<li>' + esc(name) + '</li>'; }).join('')
        : '<li>没有删除旧歌单</li>';
      return '<div class="phase-panel">' +
        '<div style="font-size:18px;font-weight:700;margin-bottom:8px">🎉 同步完成</div>' +
        '<div class="notice">日期：' + esc(payload.data.date) + ' · 歌单：' + esc(payload.data.playlistName || '-') + '</div>' +
        '<div style="height:12px"></div>' +
        '<div class="inline-list">' +
          '<span class="badge success">已添加 ' + esc(payload.data.addedCount) + ' 首</span>' +
          '<span class="badge">已确认 ' + esc(payload.progress.matched) + ' 首</span>' +
          '<span class="badge">已跳过 ' + esc(payload.progress.skipped) + ' 首</span>' +
        '</div>' +
        '<div style="height:16px"></div>' +
        '<h3>清理的旧歌单</h3><ul>' + deleted + '</ul>' +
      '</div>';
    }

    function errorView(payload) {
      const issues = payload.issues && payload.issues.length
        ? payload.issues.map(function(issue) { return '<li>' + esc(issue.message) + '</li>'; }).join('')
        : '<li>未知错误</li>';
      return '<div class="phase-panel"><div style="font-size:18px;font-weight:700;margin-bottom:8px">❌ 流程中断</div><ul>' + issues + '</ul></div>';
    }

    function cancelledView(payload) {
      return '<div class="phase-panel"><div style="font-size:18px;font-weight:700;margin-bottom:8px">此会话已被替换</div><div class="muted">新的会话 ID：' + esc(payload.data.replacedBy || '-') + '</div></div>';
    }

    function renderContent(payload) {
      if (payload.status === 'cancelled') {
        document.getElementById('content').innerHTML = cancelledView(payload);
        return;
      }
      if (payload.status === 'error') {
        document.getElementById('content').innerHTML = errorView(payload);
        return;
      }
      if (payload.status === 'done') {
        document.getElementById('content').innerHTML = doneView(payload);
        return;
      }
      if (payload.currentPhase === 2 && payload.state === 'searching') {
        document.getElementById('content').innerHTML = searchingView(payload);
        return;
      }
      if (payload.currentPhase === 2 && payload.state === 'review_required') {
        document.getElementById('content').innerHTML = reviewView(payload);
        return;
      }
      if (payload.currentPhase === 3) {
        document.getElementById('content').innerHTML = phaseWaitView(payload, '正在创建播放列表');
        return;
      }
      if (payload.currentPhase === 4) {
        document.getElementById('content').innerHTML = phaseWaitView(payload, '正在向歌单添加歌曲');
        return;
      }
      if (payload.currentPhase === 5) {
        document.getElementById('content').innerHTML = phaseWaitView(payload, '正在清理旧歌单');
        return;
      }
      document.getElementById('content').innerHTML = '<div class="phase-panel"><span class="spinner"></span> 正在处理。</div>';
    }

    function render(payload) {
      if (!payload) return;
      showApp();
      document.getElementById('page-title').textContent = '会话 ' + payload.sessionId.slice(0, 8);
      document.getElementById('page-subtitle').textContent = '当前状态：' + formatStatus(payload) + ' · Apple Music 区域：' + (payload.data.storefront || '-');
      renderBadges(payload);
      renderStats(payload);
      renderSteps(payload);
      renderIssues(payload);
      renderContent(payload);
    }

    function scheduleNext(payload) {
      clearNextTimer();
      if (!payload || payload.status !== 'running') return;
      if (payload.currentPhase === 2 && payload.state === 'searching') {
        STATE.nextTimer = setTimeout(function() { runPhase('2'); }, 400);
      } else if (payload.currentPhase === 3 && payload.state === 'creating_playlist') {
        STATE.nextTimer = setTimeout(function() { runPhase('3'); }, 400);
      } else if (payload.currentPhase === 4 && payload.state === 'adding_tracks') {
        STATE.nextTimer = setTimeout(function() { runPhase('4'); }, 400);
      } else if (payload.currentPhase === 5 && payload.state === 'cleaning_old_playlists') {
        STATE.nextTimer = setTimeout(function() { runPhase('5'); }, 400);
      }
    }

    async function startSync() {
      hideAuthError();
      clearNextTimer();
      STATE.token = document.getElementById('token-input').value.trim();
      STATE.auto = document.getElementById('auto-check').checked;
      if (!STATE.token) {
        showAuthError('请输入 token');
        return;
      }
      document.getElementById('start-btn').disabled = true;
      try {
        log('info', '开始新会话');
        const payload = await api('/sync?auto=' + (STATE.auto ? '1' : '0'));
        setPayload(payload);
        render(payload);
        log('success', 'Phase 1 完成，已收集 ' + payload.data.ncmTotal + ' 首歌曲');
        scheduleNext(payload);
      } catch (error) {
        showAuthError(error.message);
        log('error', error.message);
      } finally {
        document.getElementById('start-btn').disabled = false;
      }
    }

    async function restoreSessionById(sessionId) {
      if (!STATE.token) {
        showAuthError('请输入 token 后再恢复会话');
        return;
      }
      try {
        const payload = await api('/session?session=' + encodeURIComponent(sessionId));
        setPayload(payload);
        render(payload);
        log('info', '已恢复会话 ' + sessionId.slice(0, 8));
        scheduleNext(payload);
      } catch (error) {
        clearSessionOnly();
        showAuth();
        showAuthError(error.message);
        log('error', error.message);
      }
    }

    async function restoreActiveSession() {
      if (!STATE.token) return;
      try {
        const payload = await api('/session');
        setPayload(payload);
        render(payload);
        log('info', '已恢复当前 active session');
        scheduleNext(payload);
      } catch (_error) {
        document.getElementById('resume-btn').classList.toggle('hidden', !STATE.session);
      }
    }

    async function refreshSession() {
      if (!STATE.token) return;
      const target = STATE.session || sessionFromUrl();
      if (!target) {
        await restoreActiveSession();
        return;
      }
      await restoreSessionById(target);
    }

    async function runPhase(phase) {
      if (!STATE.session) return;
      try {
        const payload = await api('/sync?phase=' + encodeURIComponent(phase) + '&session=' + encodeURIComponent(STATE.session));
        setPayload(payload);
        render(payload);
        if (phase === '2') log('info', 'Phase 2 搜索进度：' + payload.progress.processed + '/' + payload.progress.total);
        if (payload.status === 'done') log('success', '同步完成');
        scheduleNext(payload);
      } catch (error) {
        log('error', error.message);
        showAuthError(error.message);
      }
    }

    async function searchSong(ncmId) {
      const input = document.getElementById('query-' + ncmId);
      const query = input.value.trim();
      if (!query) return;
      try {
        const payload = await api('/sync?phase=2-search&session=' + encodeURIComponent(STATE.session) + '&ncmId=' + ncmId + '&query=' + encodeURIComponent(query));
        setPayload(payload);
        render(payload);
        log('info', '已更新 Song #' + ncmId + ' 的候选列表');
      } catch (error) {
        log('error', error.message);
      }
    }

    async function selectCandidate(ncmId, candidateId) {
      try {
        const payload = await api('/sync?phase=2-select&session=' + encodeURIComponent(STATE.session) + '&ncmId=' + ncmId + '&candidateId=' + encodeURIComponent(candidateId));
        setPayload(payload);
        render(payload);
        log('success', '已确认 Song #' + ncmId);
      } catch (error) {
        log('error', error.message);
      }
    }

    async function skipSong(ncmId) {
      try {
        const payload = await api('/sync?phase=2-skip-song&session=' + encodeURIComponent(STATE.session) + '&ncmId=' + ncmId);
        setPayload(payload);
        render(payload);
        log('info', '已跳过 Song #' + ncmId);
      } catch (error) {
        log('error', error.message);
      }
    }

    async function continueReview() {
      try {
        const payload = await api('/sync?phase=2-continue&session=' + encodeURIComponent(STATE.session));
        setPayload(payload);
        render(payload);
        log('info', 'Phase 2 已确认完成，进入下一步');
        scheduleNext(payload);
      } catch (error) {
        log('error', error.message);
      }
    }

    function urlBase64ToUint8Array(input) {
      const pad = '='.repeat((4 - input.length % 4) % 4);
      const base = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
      return Uint8Array.from(atob(base), function(char) { return char.charCodeAt(0); });
    }

    async function refreshPushState() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        document.getElementById('push-status').textContent = '当前浏览器不支持通知';
        document.getElementById('push-sub').disabled = true;
        return;
      }
      try {
        const ready = await navigator.serviceWorker.ready;
        const subscription = await ready.pushManager.getSubscription();
        document.getElementById('push-sub').classList.toggle('hidden', !!subscription);
        document.getElementById('push-unsub').classList.toggle('hidden', !subscription);
        document.getElementById('push-status').textContent = subscription ? '✅ 已订阅通知' : '未订阅通知';
      } catch (error) {
        document.getElementById('push-status').textContent = '通知状态检测失败：' + error.message;
      }
    }

    async function subscribePush() {
      try {
        if (!STATE.vapidKey) {
          const result = await api('/vapid-key');
          STATE.vapidKey = result.publicKey;
        }
        if (Notification.permission !== 'granted') {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') throw new Error('通知权限被拒绝');
        }
        const ready = await navigator.serviceWorker.ready;
        const subscription = await ready.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(STATE.vapidKey),
        });
        const response = await fetch(BASE + '/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        });
        if (!response.ok) throw new Error('订阅请求失败');
        await refreshPushState();
      } catch (error) {
        log('error', error.message);
      }
    }

    async function unsubscribePush() {
      try {
        const ready = await navigator.serviceWorker.ready;
        const subscription = await ready.pushManager.getSubscription();
        if (subscription) {
          await fetch(BASE + '/subscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
          await subscription.unsubscribe();
        }
        await refreshPushState();
      } catch (error) {
        log('error', error.message);
      }
    }

    function initForm() {
      loadLocal();
      document.getElementById('token-input').value = STATE.token;
      document.getElementById('auto-check').checked = STATE.auto;
      const knownSession = sessionFromUrl() || STATE.session;
      document.getElementById('resume-btn').classList.toggle('hidden', !knownSession);
      document.getElementById('start-btn').onclick = startSync;
      document.getElementById('resume-btn').onclick = function() {
        const target = sessionFromUrl() || STATE.session;
        if (target) restoreSessionById(target);
      };
      document.getElementById('refresh-btn').onclick = refreshSession;
      document.getElementById('restart-btn').onclick = startSync;
      document.getElementById('push-sub').onclick = subscribePush;
      document.getElementById('push-unsub').onclick = unsubscribePush;
    }

    async function init() {
      initForm();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(refreshPushState);
      }
      if (!STATE.token) {
        const querySession = sessionFromUrl();
        if (querySession) showAuthError('请输入 token 后恢复该会话');
        return;
      }
      const preferred = sessionFromUrl() || STATE.session;
      if (preferred) {
        await restoreSessionById(preferred);
        return;
      }
      await restoreActiveSession();
    }

    window.searchSong = searchSong;
    window.selectCandidate = selectCandidate;
    window.skipSong = skipSong;
    window.continueReview = continueReview;
    init();
  </script>
</body>
</html>`;
}
