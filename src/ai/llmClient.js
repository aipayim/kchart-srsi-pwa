/**
 * LLM 多供应商客户端 (OpenAI Chat Completions 兼容系)
 *
 * 支持: DeepSeek / OpenAI / OpenRouter / 自定义端点(任意兼容 /chat/completions 的服务, 如本地 Ollama)
 * API Key 经 src/auth/apiKeyStore.js AES-GCM 加密存 IndexedDB (exchange='LLM')
 *
 * 设计约束:
 *  - 只读行情快照 → 提示词, 无任何交易权限 (信号源, 非执行者)
 *  - 30s 超时 + 1 次重试 + 错误分类
 *  - 预算统计 (按次/按 token) 由本模块提供, legacy.js 消费
 */

const LLM_PROVIDERS = {
  deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com', path: '/chat/completions', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', path: '/chat/completions', model: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', path: '/chat/completions', model: 'openrouter/auto' },
  custom: { label: '自定义', base: '', path: '/chat/completions', model: '' }
};

const DEFAULT_TIMEOUT = 30000;

export function providerConfig(cfg) {
  const prov = LLM_PROVIDERS[cfg && cfg.provider] || LLM_PROVIDERS.deepseek;
  let base = ((cfg && cfg.baseUrl) || prov.base || '').trim().replace(/\/+$/, '');
  // 自动代理: 自定义端点指向本机其它端口(localhost/127.0.0.1)时, 浏览器会因 CORS 拦截。
  // 开发模式下自动改走 Vite 内置代理 /llm-proxy → target(默认 127.0.0.1:3457, 可在 vite.config.js 修改)
  if (base && cfg && cfg.provider === 'custom' && typeof location !== 'undefined') {
    const m = base.match(/^https?:\/\/(localhost|127\.0\.0\.1):(\d+)/i);
    if (m && String(m[2]) !== String(location.port)) {
      base = location.origin + '/llm-proxy';
    }
  }
  let url;
  if (base) {
    // 兼容用户填完整 /chat/completions 端点: 不重复拼接
    url = /\/chat\/completions$/i.test(base) ? base : base + (prov.path || '/chat/completions');
  } else {
    url = (prov.base || '') + (prov.path || '/chat/completions');
  }
  return {
    url,
    model: ((cfg && cfg.model) || prov.model || 'deepseek-chat').trim(),
    apiKey: ((cfg && cfg.apiKey) || '').trim(),
    label: prov.label
  };
}

/** 粗略 token 估算 (ASCII ~4字符/token, 中文 ~1.5字符/token) */
export function estimateTokens(text) {
  if (!text) return 0;
  const ascii = (String(text).match(/[\x00-\x7F]/g) || []).length;
  const nonAscii = (String(text).match(/[^\x00-\x7F]/g) || []).length;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/** 从 LLM 输出中稳健提取 JSON 对象 (处理代码围栏/前后文字) */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/**
 * 调用 Chat Completions (OpenAI 兼容)
 * @param {string} prompt 用户提示词
 * @param {Object} cfg {provider, baseUrl, model, apiKey, temperature, maxTokens, timeoutMs}
 * @returns {Promise<{text:string, usage?:{prompt_tokens,completion_tokens,total_tokens}}>}
 */
export async function chat(prompt, cfg) {
  const conf = providerConfig(cfg);
  if (!conf.apiKey) throw new Error('缺少 API Key');
  const body = {
    model: conf.model,
    messages: [
      { role: 'system', content: '你是加密货币合约市场的技术分析师。基于给定的市场快照输出结构化 JSON 判断。只输出 JSON, 不要额外文字或解释。' },
      { role: 'user', content: prompt }
    ],
    temperature: cfg && cfg.temperature != null ? cfg.temperature : 0.3,
    max_tokens: (cfg && cfg.maxTokens) || 1200
  };
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), (cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(conf.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + conf.apiKey
        },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(tid);
      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${classifyStatus(resp.status)}: ${errText.slice(0, 200)}`);
      }
      const data = await resp.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      let text = msg ? (msg.content || msg.reasoning_content || '').trim() : '';
      if (!text) {
        const snippet = JSON.stringify(data).slice(0, 200);
        throw new Error('响应无内容: ' + snippet);
      }
      return { text: String(text).trim(), usage: data.usage };
    } catch (e) {
      lastErr = e;
      if (e.name === 'AbortError') break;
      if (e.message && /(401|403|404|429)/.test(e.message)) break;
    }
  }
  const rawMsg = (lastErr && lastErr.message) || '调用失败';
  if (lastErr && lastErr.name === 'AbortError') {
    throw new Error('请求超时 (' + Math.round(((cfg && cfg.timeoutMs) || DEFAULT_TIMEOUT) / 1000) + 's) → ' + conf.url);
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(rawMsg)) {
    const isLocalOtherPort = /^https?:\/\/(localhost|127\.0\.0\.1):(\d+)/i.test(conf.url) &&
      !/^https?:\/\/(localhost|127\.0\.0\.1):5173/i.test(conf.url);
    const proxyHint = isLocalOtherPort
      ? ' 提示: 本地服务默认会被浏览器 CORS 拦截(服务端需返回 allow-origin:*)。开发模式下可把端点填为 http://localhost:5173/llm-proxy 走内置代理(改 vite.config.js 的 target 端口)'
      : ' 若是自定义端点, 需支持 CORS 且可被浏览器直接访问';
    throw new Error('网络错误: 无法连接 ' + conf.url + ' — 请检查端点地址是否正确' + proxyHint);
  }
  throw new Error(rawMsg + ' → ' + conf.url);
}

function classifyStatus(code) {
  if (code === 401) return '认证失败(API Key 错误)';
  if (code === 403) return '无权限';
  if (code === 404) return '端点不存在';
  if (code === 429) return '限流或余额不足';
  if (code >= 500) return '服务端错误';
  return '错误';
}

/** 测试连接: 最小请求验证 Key/端点/模型 */
export async function testConnection(cfg) {
  const t0 = Date.now();
  try {
    const res = await chat('只回复两个字: OK', { ...(cfg || {}), maxTokens: 8, temperature: 0 });
    return { ok: true, ms: Date.now() - t0, reply: res.text };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}

/** 预算是否可用 (mode: 'calls' 按次数 | 'tokens' 按K-token量) */
export function budgetAvailable(stats, mode, limit) {
  if (!stats) return true;
  if (mode === 'tokens') {
    const max = (parseFloat(limit) || 0) * 1000;
    return (stats.tokens || 0) < max;
  }
  return (stats.calls || 0) < (parseFloat(limit) || 0);
}

/** 消耗预算 */
export function consumeBudget(stats, usage, promptText) {
  if (!stats) return;
  stats.calls = (stats.calls || 0) + 1;
  if (usage && usage.total_tokens) {
    stats.tokens = (stats.tokens || 0) + usage.total_tokens;
  } else {
    stats.tokens = (stats.tokens || 0) + estimateTokens(promptText || '');
  }
}

/** 调用频次设置 → 毫秒 */
export function freqToMs(freq) {
  const map = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, 'off': Infinity };
  return map[freq] != null ? map[freq] : 300000;
}

// ---------------------------------------------------------------------------
// Jev `/v1/decisions`（决策端点）—— 与 chat 不同的 schema，见 src/engine/jevState.js 注释
// 实测形状（2026-09-29）：
//   { model, state, questions: { <id>: { type:'choice'|'score'|'noul', instructions, criteria } } }
//   响应 { model, answers: { <id>: { type, choice|score, confidence, probabilities, legend } }, usage:{input_tokens,output_tokens} }
// ---------------------------------------------------------------------------

/** 决策端点 URL：本机自定义端口自动走 Vite 代理 /llm-proxy（目标 = 网关根 + /v1） */
export function decisionEndpoint(cfg) {
  let base = ((cfg && cfg.baseUrl) || '').trim().replace(/\/+$/, '');
  if (base && typeof location !== 'undefined') {
    const m = base.match(/^https?:\/\/(localhost|127\.0\.0\.1):(\d+)/i);
    if (m && String(m[2]) !== String(location.port)) base = location.origin + '/llm-proxy';
  }
  if (!base) base = '/llm-proxy';
  if (/\/decisions$/i.test(base)) return base;
  return base + '/decisions';
}

const DECISION_PROBE_SHAPES = [
  { label: 'score+criteria[5]', questions: (q) => ({ q1: { type: 'score', instructions: q, criteria: ['强空', '偏空', '中性', '偏多', '强多'] } }) },
  { label: 'choice+criteria{}', questions: (q) => ({ q1: { type: 'choice', instructions: q, criteria: { 看多: '偏多', 看空: '偏空', 中性: '震荡' } } }) },
  { label: 'noul', questions: (q) => ({ q1: { type: 'noul', instructions: q } }) },
  { label: '扁平 instructions', questions: (q) => ({ q1: { instructions: q } }) },
  { label: 'questions 字符串', questions: (q) => q }
];

/**
 * 调用决策端点。body 由调用方（jevState.buildJevBody）构造，本函数只负责传输/超时/重试。
 * @returns {Promise<{json:Object, ms:number, usage:Object|null}>}
 */
export async function decisionCall(cfg, body) {
  const url = decisionEndpoint(cfg);
  const apiKey = ((cfg && cfg.apiKey) || '').trim();
  if (!apiKey) throw new Error('缺少 Token（请在设置中填写 Jev Token）');
  const timeoutMs = (cfg && cfg.timeoutMs) || 45000;
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), timeoutMs);
  let lastErr = null;
  const t0 = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(body),
        signal: ac.signal
      });
      clearTimeout(tid);
      const txt = await resp.text();
      let json = null;
      try { json = JSON.parse(txt); } catch (e) { json = null; }
      if (!resp.ok) {
        const msg = (json && json.error && (json.error.message || json.error)) || txt.slice(0, 200) || ('HTTP ' + resp.status);
        const err = new Error('HTTP ' + resp.status + ' ' + classifyStatus(resp.status) + ': ' + String(msg).slice(0, 240));
        err.status = resp.status;
        err.raw = json || txt.slice(0, 400);
        throw err;
      }
      if (!json) throw new Error('响应不是 JSON: ' + txt.slice(0, 160));
      return { json, ms: Date.now() - t0, usage: json.usage || null };
    } catch (e) {
      lastErr = e;
      if (e && e.name === 'AbortError') break;
      if (e && e.status && e.status >= 400 && e.status < 500) break;   // 4xx 重试无意义（含 schema 错误）
    }
  }
  if (lastErr && lastErr.name === 'AbortError') {
    throw new Error('请求超时 (' + Math.round(timeoutMs / 1000) + 's) → ' + url);
  }
  const raw = (lastErr && lastErr.message) || '调用失败';
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    throw new Error('网络错误: 无法连接 ' + url + ' — 请检查 base_url 与 CORS/代理设置');
  }
  throw lastErr || new Error(raw);
}

/**
 * 形状探测：依次尝试候选请求体，返回每个的 HTTP 状态与错误原文（用于「测试连接」诊断）。
 * 不抛异常，永不写控制台。
 */
export async function probeDecisionShapes(cfg, stateText, questionText, opts = {}) {
  const model = ((cfg && cfg.model) || 'jev-latest').trim();
  const state = stateText || '(探测用 state) 价格 100，趋势向上。';
  const q = questionText || '接下来偏多还是偏空？';
  const shapes = opts.shapes || DECISION_PROBE_SHAPES;
  const out = [];
  for (const s of shapes) {
    const body = { model, state, questions: s.questions(q) };
    const t0 = Date.now();
    try {
      const r = await decisionCall(cfg, body);
      out.push({ label: s.label, ok: true, status: 200, ms: Date.now() - t0, answers: r.json && r.json.answers ? Object.keys(r.json.answers) : [] });
    } catch (e) {
      out.push({ label: s.label, ok: false, status: (e && e.status) || 0, ms: Date.now() - t0, error: String((e && e.message) || e).slice(0, 240) });
    }
  }
  const winner = out.find(x => x.ok) || null;
  return { ok: !!winner, winner: winner ? winner.label : null, results: out };
}
