/**
 * 扩展后台：代理内容脚本访问 127.0.0.1 本地桥（绕过页面 CSP）。
 * 额外职责：轮询桥的手机遥控队列，把指令转给聊天页 content script。
 */
'use strict';

const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
const REMOTE_TOKEN_KEY = 'remoteToken';

function normalizeBridge(raw) {
  try {
    const url = new URL(String(raw || DEFAULT_BRIDGE));
    if (url.protocol !== 'http:') throw new Error('只支持 http');
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
      throw new Error('只支持本机地址');
    }
    return url.origin;
  } catch (e) {
    return DEFAULT_BRIDGE;
  }
}

async function readJson(res) {
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data && data.error) || text.slice(0, 500) || ('HTTP ' + res.status), data };
  }
  if (!data) return { ok: false, status: res.status, error: '桥返回了非 JSON 响应' };
  return { ok: true, status: res.status, data };
}

async function bridgeFetch(base, path, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(base + path, Object.assign({ cache: 'no-store', signal: controller.signal }, options));
    return await readJson(res);
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? '请求超时' : (e && e.message) || String(e);
    return { ok: false, error: '无法连接本地桥（' + base + '）：' + msg };
  } finally {
    clearTimeout(timer);
  }
}

function senderIsChat(sender) {
  const url = (sender && sender.tab && sender.tab.url) || (sender && sender.url) || '';
  return /^https?:\/\/chat\.deepseek\.com(\/|$)/.test(url) || /^http:\/\/127\.0\.0\.1(:\d+)?\//.test(url);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;

  if (msg.type === 'getRemoteToken') {
    chrome.storage.local.get([REMOTE_TOKEN_KEY], (v) => sendResponse({ ok: true, token: v[REMOTE_TOKEN_KEY] || '' }));
    return true;
  }
  if (msg.type === 'setRemoteToken') {
    chrome.storage.local.set({ [REMOTE_TOKEN_KEY]: String(msg.token || '') }, () => sendResponse({ ok: true }));
    return true;
  }

  if (!senderIsChat(sender)) { sendResponse({ ok: false, error: '来源页面不被允许' }); return false; }

  const base = normalizeBridge(msg.bridgeUrl);

  if (msg.type === 'reportReply') {
    (async () => {
      try {
        const stored = await new Promise((r) => chrome.storage.local.get([REMOTE_TOKEN_KEY], (v) => r(v || {})));
        const token = stored[REMOTE_TOKEN_KEY] || '';
        if (!token) { sendResponse({ ok: false, error: '缺少遥控令牌' }); return; }
        const res = await bridgeFetch(base, '/api/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Remote-Token': token },
          body: JSON.stringify({ text: String(msg.text || ''), at: Date.now() }),
        }, 8000);
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  if (msg.type === 'health') {
    bridgeFetch(base, '/health', { method: 'GET' }, 5000).then(sendResponse);
    return true;
  }

  if (msg.type === 'exec') {
    const command = typeof msg.command === 'string' ? msg.command : '';
    if (!command.trim()) { sendResponse({ ok: false, error: '命令为空' }); return false; }
    const timeoutMs = Math.max(0, Math.min(30 * 60 * 1000, Number(msg.timeoutMs) || 0));
    const payload = { command };
    if (timeoutMs > 0) payload.timeoutMs = timeoutMs;
    const waitMs = timeoutMs > 0 ? timeoutMs + 15000 : 10 * 60 * 1000;
    bridgeFetch(base, '/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DS-Bridge': '1' },
      body: JSON.stringify(payload),
    }, waitMs).then(sendResponse);
    return true;
  }

  if (msg.type === 'refresh-all') {
    const tabId = sender.tab && sender.tab.id;
    sendResponse({ ok: true });
    // 先刷新页面，再重载扩展：避免扩展先卸载导致页面刷新发不出去
    setTimeout(() => {
      if (tabId) {
        try { chrome.tabs.reload(tabId).catch(() => {}); } catch (e) { /* ignore */ }
      }
      setTimeout(() => {
        try { chrome.runtime.reload(); } catch (e) { /* ignore */ }
      }, 500);
    }, 30);
    return false;
  }

  if (msg.type === 'rules') { sendResponse({ ok: true }); return false; }

  if (msg.type === 'remoteToken') {
    bridgeFetch(base, '/api/status', { method: 'GET', headers: { 'X-Remote-Token': msg.token || '' } }, 5000).then(sendResponse);
    return true;
  }

  sendResponse({ ok: false, error: '未知消息类型: ' + msg.type });
  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => {});
});

/* ---------------- 手机遥控轮询 ---------------- */

const REMOTE_POLL_MS = 2500;
let remotePollTimer = null;

async function getAllChatTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://chat.deepseek.com/*', 'http://chat.deepseek.com/*'] });
  return (tabs || []).filter((t) => t.id);
}

async function getRemoteStates(tabs) {
  const out = [];
  for (const tab of tabs) {
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'getRemoteState' });
      if (st && st.ok) out.push({ tab, state: st });
    } catch (e) { /* tab 未就绪 */ }
  }
  return out;
}

async function pairToken(base) {
  try {
    const res = await fetch(base + '/api/pair', { cache: 'no-store' });
    if (!res.ok) return '';
    const data = await res.json();
    const tk = data && data.token ? String(data.token) : '';
    if (tk) chrome.storage.local.set({ [REMOTE_TOKEN_KEY]: tk });
    return tk;
  } catch (e) {
    return '';
  }
}

async function pollRemoteOnce() {
  const tabs = await getAllChatTabs();
  if (!tabs.length) return;
  const stored = await new Promise((r) => chrome.storage.local.get([REMOTE_TOKEN_KEY, 'bridgeUrl'], (v) => r(v || {})));
  const base = normalizeBridge(stored.bridgeUrl || DEFAULT_BRIDGE);
  let token = stored[REMOTE_TOKEN_KEY] || '';
  if (!token) {
    token = await pairToken(base);
    if (!token) return;
  }

  const states = await getRemoteStates(tabs);
  // 优先租约持有者；否则第一个可用标签
  let target = states.find((x) => x.state.isLeaseOwner) || states[0] || null;

  let enabled = '';
  let runs = '';
  let maxRuns = '';
  if (target) {
    enabled = target.state.enabled ? '1' : '0';
    runs = String(target.state.runs == null ? '' : target.state.runs);
    maxRuns = String(target.state.maxRuns == null ? '' : target.state.maxRuns);
  }

  const qs = new URLSearchParams();
  if (enabled !== '') qs.set('enabled', enabled);
  if (runs !== '') qs.set('runs', runs);
  if (maxRuns !== '') qs.set('maxRuns', maxRuns);
  const q = qs.toString();

  const res = await bridgeFetch(base, '/api/poll' + (q ? ('?' + q) : ''), {
    method: 'GET',
    headers: { 'X-Remote-Token': token },
  }, 5000);
  if (!res.ok || !res.data || !Array.isArray(res.data.items)) return;

  for (const item of res.data.items) {
    let tab = target ? target.tab : null;
    if (!tab) {
      // 没有可用标签：退回广播到任意聊天页，至少让指令不丢
      tab = tabs[0];
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'remoteCommand', item });
    } catch (e) { /* ignore */ }
  }
}

function startRemotePolling() {
  try {
    chrome.alarms.create('remote-poll', { periodInMinutes: 0.05 });
  } catch (e) { /* ignore */ }
  pollRemoteOnce().catch(() => {});
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'remote-poll') pollRemoteOnce().catch(() => {});
  });
} catch (e) { /* ignore */ }

function injectIntoOpenChatTabs() {
  chrome.tabs.query({ url: ['https://chat.deepseek.com/*', 'http://chat.deepseek.com/*'] }, (tabs) => {
    (tabs || []).forEach((tab) => {
      if (!tab.id) return;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['core.js', 'content.js'] }, () => { void chrome.runtime.lastError; });
    });
  });
}

chrome.runtime.onInstalled.addListener(() => { injectIntoOpenChatTabs(); startRemotePolling(); });
chrome.runtime.onStartup.addListener(() => { injectIntoOpenChatTabs(); startRemotePolling(); });
startRemotePolling();