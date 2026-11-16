/**
 * 纯函数核心：语言识别 / 结果格式化 / 哈希。
 * 同时可用于浏览器 content script 和 Node 单元测试。
 */
(function (root) {
  'use strict';

  var LANGS = new Set([
    'powershell', 'pwsh', 'ps1', 'ps', 'posh', 'powershell-core',
    'windows-powershell', 'microsoft-powershell',
  ]);

  function normLang(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .trim()
      .replace(/^```/, '')
      .replace(/^language-/, '')
      .replace(/^lang-/, '')
      .replace(/^\./, '');
  }

  function isPowerShellLang(value) {
    var v = normLang(value);
    if (!v) return false;
    if (LANGS.has(v)) return true;
    return /(^|[\s,-])(powershell|pwsh|ps1)([\s,;]|$)/.test(v);
  }

  /**
   * 从 class 列表与附近文本里推断代码块语言。
   * @param {string[]} classNames
   * @param {string} [labelText]
   * @returns {string} 语言名（可能为空）
   */
  function detectLanguage(classNames, labelText) {
    var list = Array.isArray(classNames) ? classNames : [classNames];
    var i, j, tokens, m;
    for (i = 0; i < list.length; i++) {
      if (!list[i]) continue;
      tokens = String(list[i]).split(/\s+/);
      for (j = 0; j < tokens.length; j++) {
        m = /^(?:language|lang)-([\w+#.-]+)$/i.exec(tokens[j]);
        if (m) return normLang(m[1]);
        if (isPowerShellLang(tokens[j])) return normLang(tokens[j]);
      }
    }
    if (labelText) {
      var label = String(labelText).trim().split(/[\r\n]/)[0].trim();
      label = label.replace(/^```/, '').replace(/[:：]$/, '').trim();
      if (isPowerShellLang(label)) return normLang(label);
      m = /(?:language|lang)[-:：\s]+([\w+#.-]+)/i.exec(label);
      if (m && isPowerShellLang(m[1])) return normLang(m[1]);
    }
    return '';
  }

  function clip(text, limit) {
    var s = String(text == null ? '' : text);
    if (s.length <= limit) return s;
    return s.slice(0, limit) + '\n…[内容过长已截断，原始 ' + s.length + ' 字符]';
  }

  function oneLine(text) {
    return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  }

  /**
   * 把桥返回的执行结果整理成发回给 DeepSeek 的消息。
   * @param {string} command
   * @param {{exitCode:number|null,stdout?:string,stderr?:string,error?:string,timedOut?:boolean,durationMs?:number,truncated?:boolean}} result
   */
  function formatExecMessage(command, result) {
    result = result || {};
    var ms = Number(result.durationMs) || 0;
    var seconds = (ms / 1000).toFixed(ms < 10000 ? 2 : 1);
    var exit = result.exitCode === null || result.exitCode === undefined ? '未知' : result.exitCode;
    var head = '[PowerShell 执行结果] 退出码 ' + exit + '｜耗时 ' + seconds + 's';
    if (result.timedOut) head += '｜已超时强制终止';
    if (result.truncated) head += '｜输出已截断';

    var parts = [head];
    var out = String(result.stdout || '').replace(/\s+$/, '');
    var err = String(result.stderr || '').replace(/\s+$/, '');
    if (out) {
      parts.push('```text\n' + clip(out, 14000) + '\n```');
    } else {
      parts.push('（标准输出为空）');
    }
    if (err) {
      parts.push('stderr:\n```text\n' + clip(err, 6000) + '\n```');
    }
    if (result.error) {
      parts.push('桥错误: ' + clip(oneLine(result.error), 500));
    }
    parts.push('请根据以上输出继续。需要再执行命令时，继续用一个 ```powershell 代码块给出完整可执行脚本；任务已完成时用一句话总结即可。');
    return parts.join('\n\n');
  }

  function hashText(text) {
    var s = String(text == null ? '' : text);
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8) + ':' + s.length;
  }

  var api = {
    LANGS: LANGS,
    normLang: normLang,
    isPowerShellLang: isPowerShellLang,
    detectLanguage: detectLanguage,
    formatExecMessage: formatExecMessage,
    hashText: hashText,
    oneLine: oneLine,
    clip: clip,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.__DSPwshCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
