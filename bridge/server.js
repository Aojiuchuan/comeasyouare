#!/usr/bin/env node
/**
 * DeepSeek <=> PowerShell 本地桥
 * 只监听 127.0.0.1，供浏览器扩展调用执行 PowerShell 命令。
 *
 * 用法: node server.js [--port 8787] [--cwd D:\work] [--timeout 120]
 *                      [--allow-dangerous]
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const VERSION = '1.1.0';
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const AUDIT_FILE = path.join(ROOT, 'exec-history.log');
const MAX_BODY = 4 * 1024 * 1024;

const DEFAULT_DENY = [
  '\\bformat(\\.com)?\\s+[a-zA-Z]:(\\\\|/|\\s|$)',
  '\\bdiskpart\\b',
  '\\bbcdedit\\b',
  '\\bvssadmin\\s+delete\\b',
  '\\bcipher\\s+/w',
  '\\b(shutdown|Restart-Computer|Stop-Computer)\\b',
  '\\b(Initialize-Disk|Clear-Disk|Format-Volume|Remove-Partition)\\b',
  '\\breg\\s+delete\\s+HKLM',
  '\\bRemove-Item\\b[^\\r\\n]*?["\']?[a-zA-Z]:\\\\?(?:["\']|\\s|$)',
  '\\brd\\s+/s\\s+/q\\s+[a-zA-Z]:\\\\?(?:\\s|$)',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
    const val = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
    out[key] = val;
  }
  return out;
}

function loadConfig() {
  const cfg = {
    port: 8787,
    cwd: os.homedir(),
    timeoutMs: 120000,
    maxOutputBytes: 200000,
    host: '0.0.0.0',
    allowDangerous: false,
    remoteToken: '',
    denyPatterns: DEFAULT_DENY,
  };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      Object.assign(cfg, user);
    }
  } catch (e) {
    console.error('[warn] config.json 解析失败，使用默认配置:', e.message);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.port) cfg.port = Number(args.port);
  if (args.cwd) cfg.cwd = path.resolve(String(args.cwd));
  if (args.timeout) cfg.timeoutMs = Math.max(1000, Number(args.timeout) * 1000);
  if (args.host) cfg.host = String(args.host);
  if (args['allow-dangerous'] || args.allowDangerous) cfg.allowDangerous = true;
  cfg.port = Math.max(1, Math.min(65535, Number(cfg.port) || 8787));
  cfg.timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(cfg.timeoutMs) || 120000));
  cfg.maxOutputBytes = Math.max(4096, Math.min(4 * 1024 * 1024, Number(cfg.maxOutputBytes) || 200000));
  cfg.denyPatterns = (cfg.denyPatterns || []).map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
  if (!fs.existsSync(cfg.cwd)) cfg.cwd = os.homedir();
  if (!cfg.remoteToken) {
    cfg.remoteToken = crypto.randomBytes(9).toString('base64url');
    try {
      const cur = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
      cur.remoteToken = cfg.remoteToken;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(cur, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
  }
  return cfg;
}

const CONFIG = loadConfig();
const REMOTE = { queue: [], seq: 0, lastSeenAt: 0, status: null, log: [], replies: [], execs: [] };
function pushRemoteLog(text, kind) {
  REMOTE.log.push({ t: Date.now(), text: String(text).slice(0, 300), kind: kind || '' });
  if (REMOTE.log.length > 100) REMOTE.log.splice(0, REMOTE.log.length - 100);
}
function remoteAuthed(req, url) {
  const token = req.headers['x-remote-token'] || url.searchParams.get('token') || '';
  return !!token && token === CONFIG.remoteToken;
}
const STARTED_AT = Date.now();

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
}

function audit(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fsp.appendFile(AUDIT_FILE, line, 'utf8').catch(() => {});
  // 简单轮转，避免无限增长
  fsp.stat(AUDIT_FILE).then((st) => {
    if (st.size > 2 * 1024 * 1024) return fsp.rename(AUDIT_FILE, AUDIT_FILE + '.1').catch(() => {});
  }).catch(() => {});
}

function originAllowed(origin) {
  if (!origin) return true; // 非浏览器客户端（curl / node / 扩展后台可能不带 Origin）
  try {
    const u = new URL(origin);
    if (u.protocol === 'chrome-extension:' || u.protocol === 'moz-extension:' || u.protocol === 'safari-web-extension:') return true;
    if (u.hostname === 'chat.deepseek.com' || u.hostname === 'chat.deepseek.com.cn') return true;
  } catch { /* ignore */ }
  return false;
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (!origin) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ds-bridge, x-remote-token');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveRemote(req, res, url) {
  if (!remoteAuthed(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset=utf-8><body style="font-family:sans-serif;padding:24px">令牌无效或缺失，请使用带 token 的链接。</body>');
    return;
  }
  const file = path.join(ROOT, 'remote.html');
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('remote.html 缺失: ' + err.message);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/pair' && req.method === 'GET') {
    const ra = req.socket.remoteAddress || '';
    const isLocal = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
    if (!isLocal) { sendJson(res, 403, { ok: false, error: '仅限本机配对' }); return; }
    log('[api] pair 本机配对成功');
    sendJson(res, 200, { ok: true, token: CONFIG.remoteToken, port: CONFIG.port });
    return;
  }

  if (!remoteAuthed(req, url)) {
    const got = String(req.headers['x-remote-token'] || url.searchParams.get('token') || '');
    log('[api] 401 ' + req.method + ' ' + url.pathname + ' tokenGot=' + (got ? got.slice(0, 4) + '***' : '(空)'));
    sendJson(res, 401, { ok: false, error: '令牌无效' });
    return;
  }
  if (url.pathname !== '/api/poll') log('[api] ' + req.method + ' ' + url.pathname);

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const ext = REMOTE.status || {};
    sendJson(res, 200, {
      ok: true, bridgeOk: true, version: VERSION, cwd: CONFIG.cwd,
      extensionOnline: Date.now() - REMOTE.lastSeenAt < 8000,
      extensionAgeSec: Math.round((Date.now() - REMOTE.lastSeenAt) / 1000),
      enabled: ext.enabled !== false, runs: ext.runs, maxRuns: ext.maxRuns, log: REMOTE.log,
      replies: REMOTE.replies.slice(-10),
      execs: REMOTE.execs.slice(-12).map(function (e) { return { at: e.at, command: e.command, exitCode: e.exitCode, timedOut: e.timedOut, durationMs: e.durationMs, stdout: String(e.stdout || '').slice(0, 2000), stderr: String(e.stderr || '').slice(0, 1000) }; }),
    });
    return;
  }

  if (url.pathname === '/api/poll' && req.method === 'GET') {
    REMOTE.lastSeenAt = Date.now();
    const q = url.searchParams.get('enabled');
    const runs = url.searchParams.get('runs');
    const maxRuns = url.searchParams.get('maxRuns');
    if (q !== null || runs !== null) {
      REMOTE.status = { enabled: q !== '0', runs: Number(runs) || 0, maxRuns: Number(maxRuns) || 0 };
    }
    const items = REMOTE.queue.splice(0, REMOTE.queue.length);
    sendJson(res, 200, { ok: true, items });
    return;
  }

  if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '需要 POST' }); return; }
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || '{}'); }
  catch (e) { sendJson(res, 400, { ok: false, error: 'JSON 无效: ' + e.message }); return; }

  if (url.pathname === '/api/report') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) { sendJson(res, 400, { ok: false, error: '内容为空' }); return; }
    REMOTE.replies.push({ at: Date.now(), text: text.slice(0, 20000) });
    if (REMOTE.replies.length > 30) REMOTE.replies.splice(0, REMOTE.replies.length - 30);
    pushRemoteLog('已同步 DeepSeek 回复（' + text.length + ' 字）', 'ok');
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname === '/api/send') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) { sendJson(res, 400, { ok: false, error: '内容为空' }); return; }
    REMOTE.queue.push({ id: ++REMOTE.seq, type: 'send', text });
    pushRemoteLog('手机发送消息：' + text.split('\n')[0].slice(0, 80), 'act');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/rules') {
    REMOTE.queue.push({ id: ++REMOTE.seq, type: 'rules' });
    pushRemoteLog('手机请求发送规则', 'act');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/enabled') {
    REMOTE.queue.push({ id: ++REMOTE.seq, type: 'enabled', enabled: !!payload.enabled });
    pushRemoteLog('手机切换自动执行：' + (payload.enabled ? '开' : '关'), 'act');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/check' || url.pathname === '/api/reset') {
    REMOTE.queue.push({ id: ++REMOTE.seq, type: url.pathname === '/api/check' ? 'check' : 'reset' });
    pushRemoteLog('手机请求：' + (url.pathname === '/api/check' ? '立即检查' : '重置计数'), 'act');
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/exec') {
    const command = typeof payload.command === 'string' ? payload.command.trim() : '';
    if (!command) { sendJson(res, 400, { ok: false, error: 'command 不能为空' }); return; }
    if (command.length > 100000) { sendJson(res, 400, { ok: false, error: '命令过长' }); return; }
    if (!CONFIG.allowDangerous) {
      const hit = checkDangerous(command);
      if (hit) {
        audit({ event: 'blocked-remote', rule: hit, command: command.slice(0, 2000) });
        sendJson(res, 403, { ok: false, blocked: true, error: '命令被本地安全策略拦截', rule: hit });
        return;
      }
    }
    pushRemoteLog('手机直接执行：' + command.split('\n')[0].slice(0, 80), 'act');
    const result = await execute(command, CONFIG.timeoutMs);
    audit({ event: 'exec-remote', command: command.slice(0, 2000), exitCode: result.exitCode });
    pushRemoteLog('执行完成 exit=' + result.exitCode, result.exitCode === 0 ? 'ok' : 'err');
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: '未知 API' });
}

function checkDangerous(command) {
  for (const re of CONFIG.denyPatterns) {
    if (re.test(command)) return re.source;
  }
  return null;
}

function buildScript(command) {
  // 用 UTF-8 BOM 临时脚本执行：中文命令不会因控制台代码页而乱码。
  return '\ufeff' +
    '$ProgressPreference = "SilentlyContinue"\n' +
    '$ErrorActionPreference = "Continue"\n' +
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch {}\n' +
    '$OutputEncoding = [Console]::OutputEncoding\n' +
    '# ===== DeepSeek command begin =====\n' +
    command + '\n' +
    '# ===== DeepSeek command end =====\n' +
    '$__ec = $LASTEXITCODE\n' +
    'if ($null -eq $__ec) { $__ec = 0 }\n' +
    'exit [int]$__ec\n';
}

function killTree(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore */ }
}

function execute(command, timeoutMs) {
  return new Promise(async (resolve) => {
    const file = path.join(os.tmpdir(), `ds-pwsh-${crypto.randomUUID()}.ps1`);
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      fsp.unlink(file).catch(() => {});
      resolve(result);
    };

    try {
      await fsp.writeFile(file, buildScript(command), 'utf8');
    } catch (e) {
      finish({ ok: false, error: '写入临时脚本失败: ' + e.message });
      return;
    }

    try {
      child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', file,
      ], {
        cwd: CONFIG.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      finish({ ok: false, error: '启动 powershell 失败: ' + e.message });
      return;
    }

    const collect = (chunk, which) => {
      if (outBytes >= CONFIG.maxOutputBytes) { truncated = true; return; }
      const text = chunk.toString('utf8');
      outBytes += Buffer.byteLength(text, 'utf8');
      if (which === 'out') stdout += text; else stderr += text;
      if (outBytes >= CONFIG.maxOutputBytes) truncated = true;
    };

    child.stdout.on('data', (c) => collect(c, 'out'));
    child.stderr.on('data', (c) => collect(c, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      log(`[timeout] pid=${child.pid} 超过 ${timeoutMs}ms，终止进程树`);
      killTree(child.pid);
      // 兜底：即使 close 没来也要回包
      setTimeout(() => {
        finish({
          ok: true, exitCode: null, stdout, stderr, timedOut: true, truncated,
          durationMs: Date.now() - startedAt, error: `命令超时（>${Math.round(timeoutMs / 1000)}s）已被强制终止`,
        });
      }, 3000);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: 'powershell 进程错误: ' + e.message });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (truncated) {
        const note = `\n\n[输出超过 ${Math.round(CONFIG.maxOutputBytes / 1024)} KB，已截断]`;
        if (stdout.length >= stderr.length) stdout += note; else stderr += note;
      }
      finish({
        ok: true,
        exitCode: code,
        stdout,
        stderr,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  cors(req, res);

  if (req.method === 'OPTIONS') {
    if (!originAllowed(req.headers.origin)) { res.writeHead(403); res.end(); return; }
    res.writeHead(204); res.end(); return;
  }

  if (new URL(req.url, 'http://127.0.0.1').pathname === '/remote') { serveRemote(req, res, new URL(req.url, 'http://127.0.0.1')); return; }
  if (new URL(req.url, 'http://127.0.0.1').pathname.startsWith('/api/')) { await handleApi(req, res, new URL(req.url, 'http://127.0.0.1')); return; }
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const origin = req.headers.origin;

  if (!originAllowed(origin)) {
    log(`[deny] 非法 Origin: ${origin}`);
    sendJson(res, 403, { ok: false, error: 'Origin 不被允许: ' + origin });
    return;
  }

  if (url.pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      name: 'deepseek-pwsh-bridge',
      version: VERSION,
      pid: process.pid,
      cwd: CONFIG.cwd,
      port: CONFIG.port,
      timeoutMs: CONFIG.timeoutMs,
      allowDangerous: CONFIG.allowDangerous,
      remote: true,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    });
    return;
  }

  if (url.pathname === '/exec') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '只接受 POST' }); return; }
    if (req.headers['x-ds-bridge'] !== '1') {
      sendJson(res, 403, { ok: false, error: '缺少 X-DS-Bridge 请求头' });
      return;
    }
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      sendJson(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch (e) {
      sendJson(res, e.statusCode || 400, { ok: false, error: '请求体不是合法 JSON: ' + e.message });
      return;
    }

    const command = typeof payload?.command === 'string' ? payload.command.trim() : '';
    if (!command) { sendJson(res, 400, { ok: false, error: 'command 不能为空' }); return; }
    if (command.length > 100000) { sendJson(res, 400, { ok: false, error: '命令过长（>100KB）' }); return; }

    if (!CONFIG.allowDangerous) {
      const hit = checkDangerous(command);
      if (hit) {
        log(`[blocked] 命中危险命令规则: ${hit}`);
        audit({ event: 'blocked', rule: hit, command: command.slice(0, 2000) });
        sendJson(res, 403, {
          ok: false,
          blocked: true,
          error: '命令被本地安全策略拦截（疑似破坏性操作）。如确需执行，请在 bridge/config.json 中设置 allowDangerous: true 或启动时加 --allow-dangerous。',
          rule: hit,
        });
        return;
      }
    }

    const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, Number(payload.timeoutMs) || CONFIG.timeoutMs));
    log(`[exec] ${command.split(/\r?\n/)[0].slice(0, 160)}${command.includes('\n') ? ' …' : ''}`);
    const result = await execute(command, timeoutMs);
    log(`[done] exit=${result.exitCode} ${result.durationMs}ms${result.timedOut ? ' (timeout)' : ''}${result.error ? ' ' + result.error : ''}`);
    audit({
      event: 'exec',
      command: command.slice(0, 2000),
      exitCode: result.exitCode,
      timedOut: !!result.timedOut,
      durationMs: result.durationMs,
    });
    try {
      REMOTE.execs.push({ at: Date.now() - (result.durationMs || 0), command: command.slice(0, 8000), exitCode: result.exitCode, timedOut: !!result.timedOut, durationMs: result.durationMs, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') });
      if (REMOTE.execs.length > 40) REMOTE.execs.splice(0, REMOTE.execs.length - 40);
    } catch (e) { /* ignore */ }
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { ok: false, error: '未知接口，可用: GET /health, POST /exec' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${CONFIG.port} 已被占用。可能桥已经在运行；如需换端口，改 config.json 的 port。`);
  } else {
    console.error('[fatal]', e);
  }
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`DeepSeek ⇄ PowerShell 桥已启动: http://127.0.0.1:${CONFIG.port}`);
  log(`工作目录: ${CONFIG.cwd}`);
  log(`超时: ${Math.round(CONFIG.timeoutMs / 1000)}s | 危险命令拦截: ${CONFIG.allowDangerous ? '关闭' : '开启'}`);
  log('保持此窗口开启；关闭窗口后网页将无法执行命令。');
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  if (ips.length) {
    log('手机遥控（同一局域网打开）:');
    for (const ip of ips) log('  http://' + ip + ':' + CONFIG.port + '/remote?token=' + CONFIG.remoteToken);
  } else {
    log('未检测到局域网 IPv4 地址');
  }
});

process.on('SIGINT', () => { log('收到 Ctrl+C，退出'); process.exit(0); });
process.on('SIGTERM', () => { log('收到终止信号，退出'); process.exit(0); });
