/**
 * DeepSeek 网页 ⇄ 本地 PowerShell 桥（Edge/Chrome 扩展 content script）
 *
 * 工作方式：
 *   1. 观察最后一条助手消息，等它生成完毕且文本稳定；
 *   2. 找到 ```powershell 代码块 → 发给本地桥执行；
 *   3. 把 stdout/stderr/退出码整理成一条消息，自动填入输入框并回车发送；
 *   4. DeepSeek 继续回复 → 回到第 1 步。
 */
(function () {
  'use strict';

  // 通知可能残留的旧实例（扩展重载前注入的）退出，避免两份逻辑同时跑
  try { window.dispatchEvent(new CustomEvent('ds-pwsh-bridge-replaced')); } catch (e) { /* ignore */ }

  var core = globalThis.__DSPwshCore;
  if (!core) {
    console.error('[DS-Pwsh] core.js 未加载，扩展损坏');
    return;
  }

  var DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
  var MAX_RUNS_DEFAULT = 40;
  var STABLE_MS = 700;

  var RULES_MESSAGE = [
    '现在开始，你可以通过 PowerShell 操作我这台 Windows 电脑（本地桥会真实执行并回传输出）。',
    '',
    '一、执行规则',
    '1. 需要执行命令时，只输出**一个** ```powershell 代码块，里面是可直接执行的完整脚本；不要输出多个代码块，也不要在代码块里放占位符。',
    '2. 一次只做一步，等我把输出发回来再决定下一步。',
    '3. 不要重复执行已经成功过的命令；先检查当前状态，再动手。',
    '4. 不要请求我手动确认，直接给下一条命令；但如果任务完成，或需要我提供信息，就直接说，不要给代码块。',
    '5. 输出尽量简洁，避免一次打印海量内容；单条命令超过 120 秒不要跑。',
    '',
    '二、如果要修改/扩展这个插件本身',
    '项目根目录：C:\\Users\\aojun\\Documents\\deepseek-harness\\default-workspace\\deepseek-pwsh-bridge',
    '- extension\\content.js：网页面板与自动执行循环',
    '- extension\\background.js：代内容脚本访问本地桥',
    '- extension\\core.js：语言识别/结果格式化',
    '- extension\\manifest.json：扩展清单',
    '- bridge\\server.js：本地 HTTP 桥（127.0.0.1:8787）',
    '- bridge\\supervise.vbs：守护进程，node 被杀后约 2 秒自动拉起',
    '',
    '必须遵守：',
    '6. 改动前先备份（例如 Copy-Item server.js server.js.bak-时间戳），改完做语法检查。',
    '7. 改 bridge\\server.js 后，必须先 `node --check server.js` 通过，再重启桥；只杀这个进程：',
    "   Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*deepseek-pwsh-bridge*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    '   绝对不要 `Stop-Process -Name node`（会杀掉 DSH 和其他 node 服务），也不要杀 wscript.exe / supervise.vbs。',
    "8. 重启桥会让连接中断、本条命令结果可能回不来：把重启放在脚本最后一步；下一条命令先等 2~5 秒再检查健康：Invoke-RestMethod http://127.0.0.1:8787/health -Headers @{'X-DS-Bridge'='1'}。",
    '9. 改扩展文件（content.js/background.js/core.js/manifest.json）后：先 node --check（manifest 用 JSON.parse 校验）；浏览器不会热更新，必须提醒我去 edge://extensions 点「刷新」再刷新聊天页；改扩展要放在任务最后，不要和重启桥放在同一条命令里。',
    '10. 不要改桥的端口/监听地址（保持 127.0.0.1:8787），不要放宽 Origin 校验或危险命令拦截，除非我明确要求。',
    '11. 禁止关机/重启电脑、格式化磁盘、删除项目目录、杀 explorer/Edge/DSH 进程、改系统安全策略。',
    '12. 保持现有行为：只执行带 powershell 标签的代码块；历史消息不自动执行；输入框有草稿不覆盖；最多连续 40 条；同一条命令连续 3 次自动停机。',
    '13. 每次改完汇报：改了哪些文件、做了什么校验、是否需要我刷新扩展/页面、还有什么风险没验证。',
    '14. extension\\ 目录里严禁放以 `_` 或 `.` 开头的文件（例如 _patch.js、_fixmanifest.js），否则 Edge 会报「无法加载扩展」，整个面板直接消失。补丁、备份、临时脚本一律放项目根目录的 tools\\，不要写进 extension\\。',
  ].join('\n');

  var S = {
    ready: false,
    enabled: true,
    bridgeUrl: DEFAULT_BRIDGE,
    maxRuns: MAX_RUNS_DEFAULT,
    runs: 0,
    busy: false,
    pending: null,
    bridgeOk: false,
    bridgeInfo: null,
    contextDead: false,
    logs: [],
    handled: new Set(),
    executedPre: new WeakSet(),
    lastCommandHash: '',
    lastCommandAt: 0,
    repeatCount: 0,
    lastSnap: { text: '', at: 0 },
    lastActionAt: 0,
    lastSendAt: 0,
    sendFailures: 0,
    execFailures: 0,
    bootKey: '',
    bootDone: false,
    lastHref: '',
    armed: false,
    armedBaseline: '',
    paused: false,
    draftWarned: false,
    checkNote: '',
    host: null,
    shadow: null,
    ui: {},
    theme: 'dark',
    panelPos: null,
    timers: [],
    observer: null,
    leaseOwner: false,
    leaseTimer: null,
    tabId: ''
  };

  /* ------------------------------------------------------------------ */
  /* 小工具                                                              */
  /* ------------------------------------------------------------------ */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  function fmtTime() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
  }

  // 去掉零宽字符和末尾的光标符号，避免流式光标闪烁被误判成“内容一直在变”
  function stableText(text) {
    return String(text || '')
      .replace(/[\u200b-\u200f\ufeff]/g, '')
      .replace(/[▍▌▋▊▉█]+$/g, '')
      .trim();
  }

  /* ------------------------------------------------------------------ */
  /* 设置持久化                                                          */
  /* ------------------------------------------------------------------ */

  function storageGet(keys) {
    return new Promise(function (resolve) {
      try {
        if (!chrome || !chrome.storage || !chrome.storage.local) return resolve({});
        chrome.storage.local.get(keys, function (v) { resolve(v || {}); });
      } catch (e) { resolve({}); }
    });
  }

  function storageSet(obj) {
    try {
      if (chrome && chrome.storage && chrome.storage.local) chrome.storage.local.set(obj);
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* 面板 UI                                                             */
  /* ------------------------------------------------------------------ */

  var PANEL_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.card{width:308px;background:rgba(24,26,32,.96);color:#e8eaed;border:1px solid rgba(255,255,255,.12);border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.35);overflow:hidden;backdrop-filter:blur(10px)}',
    '.hd{display:flex;align-items:center;gap:8px;padding:9px 10px;background:rgba(255,255,255,.05);cursor:move;user-select:none;touch-action:none}',
    '.hd .ttl{font-size:12px;font-weight:600;letter-spacing:.2px;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#8a8f98;flex:none;box-shadow:0 0 0 3px rgba(138,143,152,.15)}',
    '.dot.ok{background:#38c172;box-shadow:0 0 0 3px rgba(56,193,114,.18)}',
    '.dot.bad{background:#e5534b;box-shadow:0 0 0 3px rgba(229,83,75,.18)}',
    '.dot.busy{background:#e0a800;box-shadow:0 0 0 3px rgba(224,168,0,.2);animation:pulse 1s infinite}',
    '@keyframes pulse{50%{opacity:.35}}',
    '.iconbtn{all:unset;cursor:pointer;color:#aab0ba;font-size:14px;line-height:1;padding:2px 4px;border-radius:4px}',
    '.iconbtn:hover{background:rgba(255,255,255,.1);color:#fff}',
    '.bd{padding:8px 10px 10px}',
    '.row{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:11px;color:#b7bdc7}',
    '.row.grow{justify-content:space-between}',
    '.st{color:#c9ced8}',
    '.note{color:#8f96a3;font-size:10.5px;line-height:1.4;margin:-2px 0 6px;display:none}',
    '.note.on{display:block}',
    '.cnt{font-variant-numeric:tabular-nums;color:#8f96a3}',
    '.sw{display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;font-size:11px;color:#d5d9e0}',
    '.sw input{accent-color:#4d6bfe;width:13px;height:13px;margin:0;cursor:pointer}',
    '.btns{display:flex;gap:5px;flex-wrap:wrap}',
    '.btns button{all:unset;cursor:pointer;font-size:11px;padding:4px 7px;border-radius:6px;background:rgba(255,255,255,.08);color:#dfe3ea;border:1px solid rgba(255,255,255,.06)}',
    '.btns button:hover{background:rgba(255,255,255,.16)}',
    '.btns button:active{transform:translateY(1px)}',
    '.log{margin-top:7px;max-height:118px;overflow:auto;font-size:10.5px;line-height:1.45;font-family:Consolas,"Cascadia Mono",monospace;background:rgba(0,0,0,.25);border-radius:6px;padding:5px 6px;color:#aeb6c2;white-space:pre-wrap;word-break:break-all}',
    '.log:empty{display:none}',
    '.log .t{color:#6e7683}',
    '.log .ok{color:#7ee2a8}',
    '.log .err{color:#ff9d97}',
    '.log .act{color:#8fb4ff}',
    '.foot{margin-top:6px;font-size:9.5px;color:#6d7480;display:flex;justify-content:space-between;gap:6px}',
    '.setrow{display:none;margin-bottom:7px}',
    '.setrow.on{display:flex}',
    '.setrow input{all:unset;flex:1;font-size:10.5px;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:5px;padding:3px 6px;color:#cfd5de;font-family:Consolas,monospace}',
    '.collapsed .bd{display:none}',
    '/* light theme */',
    '.card.light{background:rgba(255,255,255,.97);color:#1f2328;border-color:rgba(0,0,0,.12);box-shadow:0 8px 30px rgba(0,0,0,.18)}',
    '.card.light .hd{background:rgba(0,0,0,.04)}',
    '.card.light .iconbtn{color:#5b626c}',
    '.card.light .iconbtn:hover{background:rgba(0,0,0,.08);color:#000}',
    '.card.light .row{color:#4b5563}',
    '.card.light .st{color:#24292f}',
    '.card.light .cnt{color:#6b7280}',
    '.card.light .note{color:#6b7280}',
    '.card.light .sw{color:#24292f}',
    '.card.light .btns button{background:rgba(0,0,0,.06);color:#24292f;border-color:rgba(0,0,0,.08)}',
    '.card.light .btns button:hover{background:rgba(0,0,0,.12)}',
    '.card.light .setrow input{background:#fff;border-color:rgba(0,0,0,.15);color:#24292f}',
    '.card.light .log{background:rgba(0,0,0,.05);color:#374151}',
    '.card.light .log .t{color:#9ca3af}',
    '.card.light .log .ok{color:#15803d}',
    '.card.light .log .err{color:#b91c1c}',
    '.card.light .log .act{color:#1d4ed8}',
    '.card.light .foot{color:#9ca3af}',
  ].join('\n');

  function buildPanel() {
    // 扩展重载后旧面板可能残留，先清掉
    var stale = document.getElementById('ds-pwsh-bridge-panel');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    var host = document.createElement('div');
    host.id = 'ds-pwsh-bridge-panel';
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483000;display:none;';
    S.host = host;

    var shadow = host.attachShadow({ mode: 'open' });
    S.shadow = shadow;

    var style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    var wrap = document.createElement('div');
    wrap.className = 'card';
    wrap.innerHTML = [
      '<div class="hd">',
      '  <span class="dot" data-el="dot"></span>',
      '  <span class="ttl">DeepSeek ⇄ PowerShell</span>',
      '  <button class="iconbtn" data-act="theme" title="切换浅色/深色">◐</button>',
      '  <button class="iconbtn" data-act="gear" title="桥地址设置">⚙</button>',
      '  <button class="iconbtn" data-act="collapse" title="收起/展开">—</button>',
      '</div>',
      '<div class="bd">',
      '  <div class="row grow"><span>桥：<span class="st" data-el="status">检测中…</span></span><span class="cnt" data-el="count">0 / 40</span></div>',
      '  <div class="note" data-el="note"></div>',
      '  <div class="row"><label class="sw"><input type="checkbox" data-el="enabled" checked><span>自动执行</span></label></div>',
      '  <div class="btns">',
      '    <button data-act="rules">发送规则</button>',
      '    <button data-act="check">立即检查</button>',
      '    <button data-act="reset">重置计数</button>',
      '    <button data-act="refresh" title="重新加载扩展和当前聊天页">刷新</button>',
      '  </div>',
      '  <div class="setrow" data-el="setrow"><input type="text" data-el="bridgeUrl" spellcheck="false"></div>',
      '  <div class="setrow" data-el="setrow2"><input type="text" data-el="remoteToken" spellcheck="false" placeholder="手机遥控令牌"></div>',
      '  <div class="log" data-el="log"></div>',
      '  <div class="foot"><span data-el="cwd">仅本机 127.0.0.1</span><span>v1.0</span></div>',
      '</div>',
    ].join('');

    shadow.appendChild(wrap);

    S.ui.dot = shadow.querySelector('[data-el="dot"]');
    S.ui.status = shadow.querySelector('[data-el="status"]');
    S.ui.count = shadow.querySelector('[data-el="count"]');
    S.ui.enabled = shadow.querySelector('[data-el="enabled"]');
    S.ui.log = shadow.querySelector('[data-el="log"]');
    S.ui.cwd = shadow.querySelector('[data-el="cwd"]');
    S.ui.note = shadow.querySelector('[data-el="note"]');
    S.ui.setrow = shadow.querySelector('[data-el="setrow"]');
    S.ui.card = wrap;
    S.ui.hd = shadow.querySelector('.hd');
    S.ui.themeBtn = shadow.querySelector('[data-act="theme"]');
    S.ui.bridgeUrl = shadow.querySelector('[data-el="bridgeUrl"]');
    S.ui.setrow2 = shadow.querySelector('[data-el="setrow2"]');
    S.ui.remoteToken = shadow.querySelector('[data-el="remoteToken"]');

    shadow.addEventListener('click', function (ev) {
      var t = ev.target;
      var act = t && t.getAttribute ? t.getAttribute('data-act') : null;
      if (!act) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (act === 'theme') {
        setTheme(S.theme === 'light' ? 'dark' : 'light');
      } else if (act === 'collapse') {
        wrap.classList.toggle('collapsed');
      } else if (act === 'gear') {
        S.ui.setrow.classList.toggle('on');
        if (S.ui.setrow2) S.ui.setrow2.classList.toggle('on', S.ui.setrow.classList.contains('on'));
        if (S.ui.setrow.classList.contains('on')) {
          S.ui.bridgeUrl.value = S.bridgeUrl;
          if (S.ui.remoteToken) chrome.runtime.sendMessage({ type: 'getRemoteToken' }, function (r) { if (r && r.ok && S.ui.remoteToken) S.ui.remoteToken.value = r.token || ''; });
          S.ui.bridgeUrl.focus();
        }
      } else if (act === 'rules') {
        void sendRules();
      } else if (act === 'check') {
        arm('手动检查：临时启用自动执行');
        // 手动检查处理的是“当前这条回复”，不能等新回复：清掉基线/历史保护
        S.armedBaseline = '';
        S.bootKey = '';
        S.lastSnap = { text: '', at: 0 };
        S.lastActionAt = 0;
        addLog('手动检查…', 'act');
        if (!S.bridgeOk) addLog('本地桥未连接：先启动 bridge，再点一次', 'err');
        void tick(true);
      } else if (act === 'reset') {
        S.runs = 0;
        S.paused = false;
        S.execFailures = 0;
        S.repeatCount = 0;
        S.lastCommandHash = '';
        render();
        addLog('计数已重置', 'act');
        if (!S.enabled) setEnabled(true); else scheduleTick(300);
      } else if (act === 'refresh') {
        void refreshAll();
      }
    });

    S.ui.enabled.addEventListener('change', function () {
      setEnabled(S.ui.enabled.checked);
    });

    S.ui.bridgeUrl.addEventListener('change', function () {
      var url = S.ui.bridgeUrl.value.trim().replace(/\/+$/, '');
      if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
        addLog('桥地址只支持 http://127.0.0.1:端口', 'err');
        S.ui.bridgeUrl.value = S.bridgeUrl;
        return;
      }
      S.bridgeUrl = url;
      storageSet({ bridgeUrl: url });
      S.bridgeOk = false;
      render();
      void checkHealth();
    });

    if (S.ui.remoteToken) {
      S.ui.remoteToken.addEventListener('change', function () {
        var tok = S.ui.remoteToken.value.trim();
        chrome.runtime.sendMessage({ type: 'setRemoteToken', token: tok }, function () {
          addLog('手机遥控令牌已保存' + (tok ? '' : '（已清空）'), 'act');
        });
      });
    }

    bindDrag(host, S.ui.hd);
    if (S.panelPos) applyPos(host, S.panelPos.x, S.panelPos.y);
    host.style.display = '';
    applyTheme(S.theme);
    document.body.appendChild(host);
    render();
  }

  function applyTheme(theme) {
    S.theme = theme === 'light' ? 'light' : 'dark';
    if (S.ui.card) S.ui.card.classList.toggle('light', S.theme === 'light');
  }

  function setTheme(theme) {
    applyTheme(theme);
    storageSet({ theme: S.theme });
    addLog('主题：' + (S.theme === 'light' ? '浅色' : '深色'), 'act');
  }

  function applyPos(host, x, y) {
    var w = host.offsetWidth || 308;
    var h = host.offsetHeight || 240;
    var maxX = Math.max(0, window.innerWidth - w - 4);
    var maxY = Math.max(0, window.innerHeight - h - 4);
    var cx = Math.min(Math.max(0, Number(x) || 0), maxX);
    var cy = Math.min(Math.max(0, Number(y) || 0), maxY);
    host.style.left = cx + 'px';
    host.style.top = cy + 'px';
    S.panelPos = { x: cx, y: cy };
    return S.panelPos;
  }

  function bindDrag(host, handle) {
    if (!handle) return;
    var start = null;
    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      var r = host.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top, moved: false };
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
    });
    handle.addEventListener('pointermove', function (e) {
      if (!start) return;
      var dx = e.clientX - start.px;
      var dy = e.clientY - start.py;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      start.moved = true;
      applyPos(host, start.x + dx, start.y + dy);
    });
    function end(e) {
      if (!start) return;
      var moved = start.moved;
      start = null;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (moved && S.panelPos) storageSet({ panelPos: S.panelPos });
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  window.addEventListener('resize', function () {
    if (S.host && S.panelPos && S.host.style.display !== 'none') {
      applyPos(S.host, S.panelPos.x, S.panelPos.y);
    }
  });

  function render() {
    if (!S.ui.dot) return;
    var cls = 'dot';
    var text;
    if (S.contextDead) { cls += ' bad'; text = '扩展已重载，请按 F5 刷新页面'; }
    else if (!S.enabled) { cls += ' bad'; text = '自动执行已关闭'; }
    else if (!S.bridgeOk) { cls += ' bad'; text = '未连接（启动 bridge）'; }
    else if (S.busy) { cls += ' busy'; text = '执行中…'; }
    else if (!S.armed) { cls += ' ok'; text = '已连接 · 发消息后自动执行'; }
    else { cls += ' ok'; text = '已连接' + (S.bridgeInfo && S.bridgeInfo.cwd ? ' · ' + shortPath(S.bridgeInfo.cwd) : ''); }
    S.ui.dot.className = cls;
    if (S.enabled && S.bridgeOk && !S.busy && S.leaseOwner === false && S.armed) { text = '待命（另一会话在执行）'; }
    S.ui.status.textContent = text;
    S.ui.count.textContent = S.runs + ' / ' + S.maxRuns;
    S.ui.enabled.checked = S.enabled;
    if (S.bridgeInfo && S.bridgeInfo.cwd) S.ui.cwd.textContent = shortPath(S.bridgeInfo.cwd);
    renderLog();
  }

  function shortPath(p) {
    var s = String(p || '');
    if (s.length > 34) s = '…' + s.slice(-33);
    return s;
  }

  function renderLog() {
    if (!S.ui.log) return;
    var items = S.logs.slice(-8);
    S.ui.log.textContent = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var line = document.createElement('div');
      var t = document.createElement('span');
      t.className = 't';
      t.textContent = it.t + ' ';
      var m = document.createElement('span');
      m.className = it.kind === 'ok' ? 'ok' : it.kind === 'err' ? 'err' : it.kind === 'act' ? 'act' : '';
      m.textContent = it.text;
      line.appendChild(t);
      line.appendChild(m);
      S.ui.log.appendChild(line);
    }
    S.ui.log.scrollTop = S.ui.log.scrollHeight;
  }

  function addLog(text, kind) {
    S.logs.push({ t: fmtTime(), text: String(text || '').slice(0, 400), kind: kind || '' });
    if (S.logs.length > 40) S.logs.shift();
    renderLog();
  }

  function addLogOnce(text, kind, key) {
    if (S['logOnce_' + key]) return;
    S['logOnce_' + key] = true;
    addLog(text, kind);
  }

  function setNote(text) {
    if (!S.ui.note) return;
    if (S.checkNote === text) return;
    S.checkNote = text;
    S.ui.note.textContent = text || '';
    S.ui.note.classList.toggle('on', !!text);
  }

  var LEASE_KEY = 'execLease';
  var LEASE_TTL = 15000;
  S.tabId = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  function readLease() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get([LEASE_KEY], function (v) { resolve((v && v[LEASE_KEY]) || null); });
      } catch (e) { resolve(null); }
    });
  }
  function writeLease(obj) {
    try { chrome.storage.local.set({ execLease: obj }); } catch (e) { /* ignore */ }
  }
  async function ensureLease() {
    var cur = await readLease();
    var now = Date.now();
    if (cur && cur.owner && cur.owner !== S.tabId && now - (cur.at || 0) < LEASE_TTL) return false;
    writeLease({ owner: S.tabId, at: now });
    S.leaseOwner = true;
    startLeaseRenew();
    return true;
  }
  function renewLease() {
    if (!S.leaseOwner) return;
    writeLease({ owner: S.tabId, at: Date.now() });
  }
  function startLeaseRenew() {
    if (S.leaseTimer) return;
    S.leaseTimer = setInterval(renewLease, 5000);
  }
  function releaseLease() {
    S.leaseOwner = false;
    if (S.leaseTimer) { clearInterval(S.leaseTimer); S.leaseTimer = null; }
    readLease().then(function (cur) {
      if (cur && cur.owner === S.tabId) { try { chrome.storage.local.remove(LEASE_KEY); } catch (e) { /* ignore */ } }
    });
  }
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area !== 'local' || !ch[LEASE_KEY]) return;
      var nv = ch[LEASE_KEY].newValue;
      if (!nv || nv.owner !== S.tabId) { S.leaseOwner = false; render(); }
    });
  } catch (e) { /* ignore */ }

  var lastReportedHash = '';
  function maybeReportReply(text) {
    try {
      var t = String(text || '');
      if (!t.trim()) return;
      var h = core.hashText(t);
      if (h === lastReportedHash) return;
      lastReportedHash = h;
      chrome.runtime.sendMessage({ type: 'reportReply', text: t, bridgeUrl: S.bridgeUrl }, function () { void chrome.runtime.lastError; });
    } catch (e) { /* ignore */ }
  }

  function setEnabled(on) {
    S.enabled = !!on;
    if (!on) releaseLease(); else ensureLease().catch(function () {});
    storageSet({ enabled: S.enabled });
    addLog(on ? '自动执行已开启' : '自动执行已暂停', 'act');
    render();
    if (on) scheduleTick(400);
  }

  /**
   * 只有「用户刚发过消息 / 我们刚发过结果」才允许自动执行。
   * 这样翻看历史会话、刷新页面、切换会话都不会误跑旧命令。
   */
  function arm(reason) {
    ensureLease().catch(function () {});
    if (S.armed) return;
    S.armed = true;
    S.lastSendAt = Date.now();
    S.bootKey = '';
    S.lastSnap = { text: '', at: 0 };
    var root = findLastAssistant();
    S.armedBaseline = root ? core.hashText(root.innerText || '') : '';
    if (reason) addLog(reason, 'act');
    render();
    scheduleTick(400);
  }

  function autoOff(reason) {
    releaseLease();
    if (!S.enabled) return;
    S.enabled = false;
    S.paused = true;
    storageSet({ enabled: false });
    addLog('已停止：' + reason, 'err');
    setNote('已自动停止：' + reason);
    render();
  }

  /* ------------------------------------------------------------------ */
  /* 与桥通信                                                            */
  /* ------------------------------------------------------------------ */

  async function checkHealth() {
    if (S.contextDead) return;
    var resp = null;
    try {
      resp = await chrome.runtime.sendMessage({ type: 'health', bridgeUrl: S.bridgeUrl });
    } catch (e) {
      var errMsg = String((e && e.message) || e);
      if (/context invalidated|receiving end does not exist|message port closed|extension context/i.test(errMsg)) {
        S.contextDead = true;
        S.bridgeOk = false;
        setNote('扩展已重载，请按 F5 刷新页面');
        addLog('扩展上下文已失效：请在页面上按 F5 刷新', 'err');
        render();
        return;
      }
      S.bridgeOk = false;
      render();
      return;
    }
    if (resp && resp.ok) {
      S.bridgeOk = true;
      S.bridgeInfo = resp.data || {};
      S['logOnce_bridge-fail'] = false;
      addLogOnce('桥已连接：' + shortPath(S.bridgeInfo.cwd), 'ok', 'bridge-ok');
      scheduleTick(500);
    } else {
      if (S.bridgeOk) addLog('桥连接断开：' + ((resp && resp.error) || '未知错误'), 'err');
      else addLogOnce('桥连接失败：' + ((resp && resp.error) || '未知错误'), 'err', 'bridge-fail');
      S.bridgeOk = false;
    }
    render();
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  async function runCommand(command) {
    var resp = await withTimeout(chrome.runtime.sendMessage({
      type: 'exec',
      bridgeUrl: S.bridgeUrl,
      command: command,
    }), 5 * 60 * 1000, '执行超时（5 分钟没有响应），已停止等待');
    if (!resp) throw new Error('扩展后台无响应');
    if (resp.ok === false) throw new Error(resp.error || '桥返回失败');
    return resp.data || {};
  }

  /* ------------------------------------------------------------------ */
  /* 会话 DOM                                                            */
  /* ------------------------------------------------------------------ */

  function findTextarea() {
    var list = Array.prototype.slice.call(document.querySelectorAll('textarea')).filter(isVisible);
    if (!list.length) return null;
    list.sort(function (a, b) {
      var pa = /deepseek|发送|message/i.test(a.getAttribute('placeholder') || '') ? 1 : 0;
      var pb = /deepseek|发送|message/i.test(b.getAttribute('placeholder') || '') ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight);
    });
    return list[0];
  }

  var UI_TEXT_RE = /^(复制|拷贝|下载|分享|重新生成|编辑|copy|download|share|regenerate|edit)$/i;
  function cleanAssistantText(el) {
    if (!el) return "";
    var clone;
    try { clone = el.cloneNode(true); } catch (e) { return String(el.innerText || ""); }
    var drop = clone.querySelectorAll("button,[role=button],svg,img,textarea,input,[class*=toolbar],[class*=Toolbar]");
    for (var i = 0; i < drop.length; i++) {
      if (drop[i].parentNode) drop[i].parentNode.removeChild(drop[i]);
    }
    var all = clone.querySelectorAll("*");
    for (var j = all.length - 1; j >= 0; j--) {
      var n = all[j];
      if (n.children.length) continue;
      var t = String(n.textContent || "").trim();
      if (t && t.length <= 16 && UI_TEXT_RE.test(t)) {
        if (n.parentNode) n.parentNode.removeChild(n);
      }
    }
    var pres = Array.prototype.slice.call(clone.querySelectorAll("pre"));
    for (var k = pres.length - 1; k >= 0; k--) {
      var pre = pres[k];
      var codeEl2 = pre.querySelector("code") || pre;
      var code2 = String(codeEl2.innerText || codeEl2.textContent || "").replace(/\u200b/g, "").trim();
      var lang2 = "";
      try { lang2 = detectBlockLanguage(pre, codeEl2) || ""; } catch (e) { lang2 = ""; }
      var fence = String.fromCharCode(96, 96, 96);
      var tn = document.createTextNode("\n\n" + fence + lang2 + "\n" + code2 + "\n" + fence + "\n\n");
      if (pre.parentNode) pre.parentNode.replaceChild(tn, pre);
    }
    var out = String(clone.innerText || clone.textContent || "");
    return out.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function findLastAssistant() {
    var nodes = Array.prototype.slice.call(document.querySelectorAll('.ds-markdown'));
    if (!nodes.length) {
      nodes = Array.prototype.slice.call(document.querySelectorAll('.ds-assistant-message-main-content'));
    }
    if (!nodes.length) {
      nodes = Array.prototype.slice.call(document.querySelectorAll('[class*="markdown"]')).filter(function (n) {
        return !n.querySelector('[class*="markdown"]');
      });
    }
    for (var i = nodes.length - 1; i >= 0; i--) {
      var el = nodes[i];
      if (!isVisible(el)) continue;
      if (!(el.innerText || '').trim()) continue;
      return el;
    }
    return null;
  }

  function isGenerating() {
    var re = /(停止生成|停止输出|停止响应|停止思考|stop generating|stop streaming|stop responding)/i;
    var els = document.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!isVisible(el)) continue;
      // 只认底部输入区的“停止”按钮，避免侧栏/菜单里的同名按钮把状态永久卡在“生成中”
      var rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 320) continue;
      var label = [
        el.getAttribute('aria-label') || '',
        el.getAttribute('title') || '',
        el.textContent || '',
      ].join(' ');
      if (re.test(label)) return true;
    }
    return false;
  }

  function detectBlockLanguage(pre, codeEl) {
    var classes = [];
    if (codeEl && codeEl.className) classes.push(codeEl.className);
    if (pre.className) classes.push(pre.className);
    var p1 = pre.parentElement;
    if (p1 && p1.className) classes.push(p1.className);
    var p2 = p1 && p1.parentElement;
    if (p2 && p2.className) classes.push(p2.className);

    var lang = core.detectLanguage(classes, '');
    if (lang) return lang;

    var holder = p1;
    if (holder) {
      var labelEl = holder.querySelector('[class*="lang"],[class*="language"],[data-lang],[data-language]');
      if (labelEl) {
        var labelText = labelEl.textContent || labelEl.getAttribute('data-lang') || labelEl.getAttribute('data-language') || '';
        lang = core.detectLanguage([], labelText);
        if (lang) return lang;
      }
      // 代码块顶部的语言标签：取前几行，去掉「复制 / Copy / 运行」这类按钮文字再识别
      var lines = (holder.innerText || '').split('\n').slice(0, 4);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/复制|拷贝|copy|run|运行/gi, '').trim();
        if (!line || line.length > 24) continue;
        lang = core.detectLanguage([], line);
        if (lang) return lang;
      }
    }

    var dataLang = (codeEl && (codeEl.getAttribute('data-lang') || codeEl.getAttribute('data-language'))) ||
      pre.getAttribute('data-lang') || '';
    return core.detectLanguage([], dataLang);
  }

  function extractPowerShellBlocks(root) {
    var out = [];
    var pres = root.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      var codeEl = pre.querySelector('code') || pre;
      var code = (codeEl.innerText || codeEl.textContent || '').replace(/\u200b/g, '').trim();
      if (!code) continue;
      var lang = detectBlockLanguage(pre, codeEl);
      if (!core.isPowerShellLang(lang)) continue;
      out.push({ index: i, code: code, lang: lang, pre: pre });
    }
    return out;
  }

  function setNativeValue(el, value) {
    if (el.tagName === 'TEXTAREA') {
      var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, value);
    } else if (el.isContentEditable) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, value);
    } else {
      el.value = value;
    }
  }

  function findSendButton() {
    var selectors = [
      'div[role="button"].ds-button--primary.ds-button--circle',
      'div[role="button"].ds-button--primary',
      'button[type="submit"]',
      '.ds-button--primary',
    ];
    for (var s = 0; s < selectors.length; s++) {
      var els = document.querySelectorAll(selectors[s]);
      for (var i = els.length - 1; i >= 0; i--) {
        var el = els[i];
        if (!isVisible(el)) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        var cls = el.className || '';
        if (typeof cls === 'string' && /disabled/i.test(cls)) continue;
        return el;
      }
    }
    return null;
  }

  async function sendToChat(text) {
    if (isGenerating()) throw new Error('DeepSeek 正在生成，暂不发送');
    var ta = findTextarea();
    if (!ta) throw new Error('找不到 DeepSeek 输入框');

    ta.focus({ preventScroll: true });
    // 优先用 execCommand 走真实编辑管线（React 受控组件最容易识别），失败再退回原生 setter
    var inserted = false;
    try {
      ta.select();
      inserted = document.execCommand('insertText', false, text);
    } catch (e) { inserted = false; }
    if (!inserted || ta.value !== text) {
      setNativeValue(ta, text);
    }
    ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);

    if (ta.value !== text) {
      setNativeValue(ta, text);
      ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await sleep(100);
    }

    function keyEvent(type) {
      return new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      });
    }
    ta.dispatchEvent(keyEvent('keydown'));
    ta.dispatchEvent(keyEvent('keypress'));
    ta.dispatchEvent(keyEvent('keyup'));
    await sleep(700);

    var stillThere = ta.value.trim() === text.trim() && ta.value.trim() !== '';
    if (stillThere) {
      var btn = findSendButton();
      if (btn) {
        btn.click();
        await sleep(800);
      }
    }
    var left = ta.value.trim();
    if (left === text.trim() && left !== '') {
      throw new Error('无法自动发送：输入框内容未被清空（可先手动点一次发送）');
    }
    S.lastActionAt = Date.now();
    S.lastSendAt = Date.now();
    S.armed = true;
  }

  /* ------------------------------------------------------------------ */
  /* 主循环                                                              */
  /* ------------------------------------------------------------------ */

  var ticking = false;
  var tickTimer = null;

  function noteNavigation() {
    var href = location.href;
    if (href === S.lastHref) return;
    S.lastHref = href;
    S.lastSnap = { text: '', at: 0 };

    // 发完第一条消息后，DeepSeek 会把地址从 / 变成 /a/chat/s/xxx，这不算“切换会话”
    if (Date.now() - S.lastSendAt < 10000) {
      S.bootKey = '';
      addLog('会话地址已更新，继续自动执行', 'act');
      return;
    }

    S.bootKey = '';
    S.armed = false;
    addLog('会话切换，重建历史保护…', 'act');
    setTimeout(function () {
      var root = findLastAssistant();
      var text = root ? (root.innerText || '') : '';
      if (text.trim()) {
        S.bootKey = core.hashText(text);
        addLog('已跳过该会话的历史命令', 'act');
      }
    }, 1200);
  }

  function scheduleTick(delay) {
    if (tickTimer) return;
    tickTimer = setTimeout(function () {
      tickTimer = null;
      void tick();
    }, typeof delay === 'number' ? delay : 700);
  }

  function markDraftOnce() {
    if (S.draftWarned) return;
    S.draftWarned = true;
    addLog('输入框里有草稿，先不动它；清空后会自动继续', 'err');
  }

  async function flushPending() {
    if (!S.pending) return;
    if (isGenerating()) return;
    var ta = findTextarea();
    if (!ta) return;
    if (ta.value.trim()) { markDraftOnce(); return; }

    S.busy = true;
    render();
    setNote('把结果填回输入框并发送…');
    try {
      await sendToChat(S.pending);
      S.pending = null;
      S.sendFailures = 0;
      S.draftWarned = false;
      addLog('结果已发回 DeepSeek，等待下一步', 'ok');
    } catch (e) {
      var sendErr = String((e && e.message) || e);
      if (/无法连接本地桥|Failed to fetch|NetworkError|请求超时/i.test(sendErr)) {
        addLog('发送结果时桥断开，等待重连后重试', 'err');
      } else {
        S.sendFailures++;
        addLog('发送失败：' + sendErr, 'err');
        if (S.sendFailures >= 3) {
          S.pending = null;
          autoOff('连续 3 次发送失败');
        }
      }
    } finally {
      S.busy = false;
      S.lastActionAt = Date.now();
      render();
      setNote('等待 DeepSeek 的下一步…');
      scheduleTick(600);
    }
  }

  async function executeBlock(block, key) {
    if (S.executedPre.has(block.pre)) return;
    var codeHash = core.hashText(block.code);
    if (codeHash === S.lastCommandHash && Date.now() - S.lastCommandAt < 10000) {
      S.handled.add(key);
      addLog('忽略 10 秒内重复出现的同一条命令（防止同一个代码块被执行两次）', 'act');
      return;
    }

    // 同一条命令连续跑 3 次 → 判定为死循环（常见于模型反复重试同一个失败命令）
    if (codeHash === S.lastCommandHash && Date.now() - S.lastCommandAt < 120000) {
      S.repeatCount++;
    } else {
      S.repeatCount = 0;
    }
    if (S.repeatCount >= 2) {
      S.handled.add(key);
      addLog('同一条命令连续出现 3 次，已停止，避免无限重试', 'err');
      autoOff('同一条命令连续执行 3 次（可能是模型在反复重试）');
      return;
    }
    S.lastCommandHash = codeHash;
    S.lastCommandAt = Date.now();

    S.busy = true;
    render();
    setNote('执行 PowerShell 命令中…');
    addLog('▶ ' + core.oneLine(block.code).slice(0, 90), 'act');
    try {
      var result = await runCommand(block.code);
      if (result.ok === false) throw new Error(result.error || '执行失败');
      S.runs++;
      S.execFailures = 0;
      S.handled.add(key);
      S.executedPre.add(block.pre);
      S.lastCommandHash = codeHash;
      S.lastCommandAt = Date.now();
      S.pending = core.formatExecMessage(block.code, result);
      addLog('✔ 退出码 ' + result.exitCode + ' · ' + ((result.durationMs || 0) / 1000).toFixed(1) + 's', 'ok');
    } catch (e) {
      var errMsg = String((e && e.message) || e);
      S.handled.add(key);
      if (/无法连接本地桥|Failed to fetch|NetworkError|ECONNREFUSED|请求超时|执行超时/i.test(errMsg)) {
        // 桥重启/断线：不算执行失败，等重连后把“结果未知”告诉 DeepSeek，避免循环直接停掉
        S.execFailures = 0;
        S.pending = '[本地桥提示] 刚才那条命令执行时本地桥断开了（可能正在重启），命令结果未知。请先检查当前状态，再决定下一步。';
        addLog('桥在命令执行中断开，已排队通知 DeepSeek', 'err');
      } else if (/安全策略拦截/.test(errMsg)) {
        S.execFailures = 0;
        S.pending = '[本地桥提示] 命令被本地安全策略拦截，未执行。拦截原因：' + errMsg + '。请换一种安全的方式，或建议用户在 bridge/config.json 中开启 allowDangerous。';
        addLog('命令被安全策略拦截，已排队通知 DeepSeek', 'err');
      } else {
        S.execFailures++;
        S.pending = '[本地桥提示] 命令执行失败，错误信息：' + errMsg + '。请检查命令并继续。';
        addLog('✘ 执行失败：' + errMsg, 'err');
        if (S.execFailures >= 2) autoOff('连续执行失败（检查 bridge 窗口）');
      }
    } finally {
      S.busy = false;
      S.lastActionAt = Date.now();
      render();
      setNote('等待 DeepSeek 的下一步…');
      scheduleTick(400);
    }
  }

  async function tick(force) {
    if (!S.ready || ticking) return;
    if (S.contextDead) { setNote('扩展已重载，请按 F5 刷新页面'); return; }
    if (!S.enabled) { setNote('自动执行已关闭'); return; }
    if (!S.armed && !force) { setNote('等待你发一条消息'); return; }
    if (!S.bridgeOk) { setNote('本地桥未连接：先启动 bridge'); return; }
    if (S.busy) { setNote('正在执行/发送…'); return; }
    if (S.pending) { setNote('等待把结果发回 DeepSeek'); ticking = true; try { await flushPending(); } finally { ticking = false; } return; }
    if (S.paused) { setNote('已暂停'); return; }
    if (S.runs >= S.maxRuns) { setNote('已达到执行上限'); autoOff('已达到执行上限 ' + S.maxRuns + ' 次'); return; }
    if (Date.now() - S.lastActionAt < 1000) { setNote('稍等…'); return; }

    var ta = findTextarea();
    if (!ta) { setNote('找不到输入框（页面还没加载完？）'); return; }

    var root = findLastAssistant();
    if (!root) { setNote('还没有 DeepSeek 的回复'); return; }

    var text = cleanAssistantText(root);
    if (!text.trim()) { setNote('回复内容为空'); return; }
    var stable = stableText(text);

    var textKey = core.hashText(text);
    if (!force && S.bootKey && textKey === S.bootKey) { setNote('这是历史回复，不执行旧命令'); return; }
    // 刚发完消息、还停在旧回复上时不要执行旧命令，等新的回复出现
    if (!force && S.armedBaseline && textKey === S.armedBaseline) { setNote('等待 DeepSeek 新的回复'); return; }

    if (S.lastSnap.text !== stable) {
      S.lastSnap = { text: stable, at: Date.now() };
      setNote('回复内容还在变化…');
      return;
    }
    if (Date.now() - S.lastSnap.at < STABLE_MS) { setNote('等待回复稳定（约 ' + (STABLE_MS / 1000).toFixed(1) + ' 秒）…'); return; }
    if (isGenerating()) { setNote('DeepSeek 正在生成，等待结束…'); return; }
    maybeReportReply(text);

    var blocks = extractPowerShellBlocks(root);
    if (!blocks.length) {
      setNote('最后一条回复里没有 powershell 代码块');
      addLogOnce('最后一条回复里没有 powershell 代码块（任务可能已完成；也可点「发送规则」引导）', '', 'no-block');
      return;
    }
    S['logOnce_no-block'] = false;

    var block = blocks[blocks.length - 1];
    var key = core.hashText(text + '\u0000' + block.index + '\u0000' + block.code);
    if (S.handled.has(key)) { setNote('这条命令已经执行过了'); return; }

    if (ta.value.trim()) { setNote('输入框里有草稿，清空后继续'); markDraftOnce(); return; }

    setNote('准备执行…');
    if (!(await ensureLease())) { setNote('另一个会话正在执行，本页待命'); return; }
    ticking = true;
    try {
      await executeBlock(block, key);
    } finally {
      ticking = false;
    }
  }

  async function refreshAll() {
    if (S.busy) { addLog('正在执行命令，稍后再刷新', 'err'); return; }
    if (!window.confirm('刷新会重新加载扩展和当前页面，未发送的草稿会丢失。继续？')) return;
    addLog('正在刷新扩展和页面…', 'act');
    setNote('刷新中…');
    // 兜底：即使后台没有处理，1.8 秒后也至少刷新页面
    setTimeout(function () { try { location.reload(); } catch (e) { /* ignore */ } }, 1800);
    try {
      var resp = await chrome.runtime.sendMessage({ type: 'refresh-all' });
      if (!resp || resp.ok === false) {
        addLog('后台没有接受刷新请求：' + ((resp && resp.error) || '无响应') + '，已尝试刷新页面', 'err');
      }
    } catch (e) {
      addLog('刷新请求失败：' + ((e && e.message) || e), 'err');
    }
  }

  async function sendRules() {
    if (isGenerating()) { addLog('正在生成，稍后再发规则', 'err'); return; }
    var ta = findTextarea();
    if (!ta) { addLog('找不到输入框', 'err'); return; }
    if (ta.value.trim()) { addLog('输入框里有内容，先清空再发规则', 'err'); return; }
    S.busy = true;
    render();
    try {
      await sendToChat(RULES_MESSAGE);
      addLog('已发送执行规则', 'ok');
      S.bootKey = '';
    } catch (e) {
      addLog('发送规则失败：' + e.message, 'err');
    } finally {
      S.busy = false;
      render();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                                */
  /* ------------------------------------------------------------------ */

  async function init() {
    // 被新实例接管时，旧实例立即停手并移除自己的面板
    window.addEventListener('ds-pwsh-bridge-replaced', function () {
      S.enabled = false;
      S.paused = true;
      S.contextDead = true;
      try { (S.timers || []).forEach(clearInterval); } catch (e) { /* ignore */ }
      S.timers = [];
      if (S.observer) { try { S.observer.disconnect(); } catch (e) { /* ignore */ } }
      if (S.host && S.host.parentNode) S.host.parentNode.removeChild(S.host);
    }, { once: true });

    var saved = await storageGet(['enabled', 'bridgeUrl', 'maxRuns', 'theme', 'panelPos']);
    if (typeof saved.enabled === 'boolean') S.enabled = saved.enabled;
    if (saved.bridgeUrl) S.bridgeUrl = saved.bridgeUrl;
    if (saved.maxRuns) S.maxRuns = Math.max(1, Math.min(200, Number(saved.maxRuns) || MAX_RUNS_DEFAULT));
    if (saved.theme === 'light' || saved.theme === 'dark') S.theme = saved.theme;
    if (saved.panelPos && typeof saved.panelPos.x === 'number' && typeof saved.panelPos.y === 'number') {
      S.panelPos = { x: Number(saved.panelPos.x), y: Number(saved.panelPos.y) };
    }
    buildPanel();

    S.ui.bridgeUrl.value = S.bridgeUrl;
    S.lastHref = location.href;
    render();

    // 页面加载时已经存在的最后一条回复视为历史消息，不自动重跑其中的旧命令。
    var bootRoot = findLastAssistant();
    var bootText = bootRoot ? (bootRoot.innerText || '') : '';
    if (bootText.trim()) {
      S.bootKey = core.hashText(bootText);
      addLog('页面已有历史消息，不会自动执行其中的旧命令', 'act');
    }

    // 用户手动发消息（回车或点发送）→ 表示这是一次新的提问，才允许自动执行
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
      var t = ev.target;
      if (!t || t.tagName !== 'TEXTAREA') return;
      if (!(t.value || '').trim()) return;
      arm('检测到你手动发消息，已开启自动执行');
    }, true);

    document.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      if (!t.closest('div[role="button"].ds-button--primary,button[type="submit"],.ds-button--primary')) return;
      var ta = findTextarea();
      if (!ta || !(ta.value || '').trim()) return;
      arm('检测到你手动发消息，已开启自动执行');
    }, true);

    try {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || typeof msg.type !== 'string') return false;
        if (msg.type === 'toggle') { setEnabled(!S.enabled); sendResponse({ ok: true }); return false; }
        if (msg.type === 'getRemoteState') {
          sendResponse({ ok: true, enabled: S.enabled, runs: S.runs, maxRuns: S.maxRuns, busy: S.busy, isLeaseOwner: !!S.leaseOwner, tabId: S.tabId });
          return false;
        }
        if (msg.type === 'remoteCommand') {
          handleRemoteCommand(msg.item).then(function (r) { sendResponse(r); }, function (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); });
          return true;
        }
        return false;
      });
    } catch (e) { /* ignore */ }

    async function handleRemoteCommand(item) {
      if (!item || typeof item.type !== 'string') return { ok: false, error: '指令无效' };
      if (item.type === 'send') {
        var text = typeof item.text === 'string' ? item.text : '';
        if (!text.trim()) return { ok: false, error: '内容为空' };
        await sendToChat(text);
        addLog('手机遥控：已发送消息', 'act');
        return { ok: true };
      }
      if (item.type === 'rules') {
        await sendRules();
        addLog('手机遥控：已发送规则', 'act');
        return { ok: true };
      }
      if (item.type === 'enabled') {
        setEnabled(!!item.enabled);
        addLog('手机遥控：自动执行' + (item.enabled ? '开' : '关'), 'act');
        return { ok: true };
      }
      if (item.type === 'check') {
        S.lastSnap = { text: '', at: 0 };
        addLog('手机遥控：立即检查', 'act');
        await tick(true);
        return { ok: true };
      }
      if (item.type === 'reset') {
        S.runs = 0;
        S.paused = false;
        S.execFailures = 0;
        render();
        addLog('手机遥控：已重置计数', 'act');
        scheduleTick(300);
        return { ok: true };
      }
      return { ok: false, error: '未知遥控指令: ' + item.type };
    }

    S.ready = true;
    await checkHealth();

    S.timers.push(setInterval(function () { void checkHealth(); }, 10000));
    S.timers.push(setInterval(function () { scheduleTick(900); }, 2500));
    S.timers.push(setInterval(noteNavigation, 1000));

    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i].target;
        if (S.host && t && S.host.contains(t)) continue;
        scheduleTick(650);
        return;
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    S.observer = obs;

    addLog('已就绪，等待 DeepSeek 给出 powershell 代码块', 'act');
    scheduleTick(1200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { void init(); }, { once: true });
  } else {
    void init();
  }

  // 调试钩子（隔离世界内可见）
  window.__dsPwshBridge = {
    state: S,
    tick: tick,
    sendRules: sendRules,
    sendToChat: sendToChat,
    findLastAssistant: findLastAssistant,
    extractPowerShellBlocks: extractPowerShellBlocks,
  };
})();
