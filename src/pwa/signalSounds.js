// 分信号自定义提示音（PWA 盯盘）——纯逻辑模块，无 DOM 依赖，可 Node 单测。
//
// 背景（2026-09-19 用户需求）：设置里「信号提示音」开启后，用户希望**罗列所有信号种类**、
// 每种单独指定提示音、提供多个内置音效并可逐个「试听」。
// 硬约束（用户裁定）：**只用 WebAudio 现场合成的内置音效**（零资源文件、离线可用、无上传/URL）。
//
// 设计约束：
//  - 无 DOM / 无 AudioContext 创建：`playSound` 接收调用方（已解锁）的 AudioContext，便于复用与测试。
//  - 信号种类**唯一权威**来自 `signalAlerts.js` 的 `SIGNAL_KINDS` / `LIVE_ONLY_SIGNAL_KINDS`，此处不另写清单。
//  - 全部导出对 null/undefined/非法输入防御，不抛异常。

import { SIGNAL_KINDS, LIVE_ONLY_SIGNAL_KINDS } from '../tech2/signalAlerts.js';

export const SOUND_MAP_KEY = 'pwa_signal_sounds';

// ---- 音效目录（合成 spec：gain=总增益；notes=音符列表，t=相对起点秒、d=时长秒、a=起音秒、
//      f0→f1=频率（f1≠f0 时做指数滑音）、g=该音符相对增益倍率） ----
export const SOUND_PRESETS = [
  { id: 'beep', name: '哔', desc: '单声短哔（默认）', spec: { gain: 0.08, notes: [{ type: 'sine', f0: 880, d: 0.16, a: 0.01 }] } },
  { id: 'ding', name: '叮', desc: '高音清脆短叮', spec: { gain: 0.09, notes: [{ type: 'sine', f0: 1568, d: 0.34, a: 0.006, g: 0.9 }, { type: 'sine', f0: 3136, d: 0.20, a: 0.004, g: 0.18 }] } },
  { id: 'bell', name: '铃', desc: '铃铛余韵（基频 + 泛音）', spec: { gain: 0.10, notes: [{ type: 'triangle', f0: 1046, d: 0.90, a: 0.008, g: 0.8 }, { type: 'sine', f0: 2093, d: 0.60, a: 0.006, g: 0.25 }, { type: 'sine', f0: 3140, d: 0.35, a: 0.004, g: 0.10 }] } },
  { id: 'drop', name: '落', desc: '下滑音（音高下行）', spec: { gain: 0.09, notes: [{ type: 'sine', f0: 1200, f1: 300, d: 0.30, a: 0.008 }] } },
  { id: 'alert', name: '警报', desc: '方波双音交替（急促）', spec: { gain: 0.07, notes: [{ type: 'square', f0: 784, d: 0.12, a: 0.006 }, { type: 'square', f0: 587, d: 0.12, t: 0.14, a: 0.006 }, { type: 'square', f0: 784, d: 0.12, t: 0.28, a: 0.006 }] } },
  { id: 'pulse', name: '脉冲', desc: '三连短脉冲', spec: { gain: 0.09, notes: [{ type: 'triangle', f0: 660, d: 0.06, a: 0.004 }, { type: 'triangle', f0: 660, d: 0.06, t: 0.10, a: 0.004 }, { type: 'triangle', f0: 880, d: 0.08, t: 0.20, a: 0.004 }] } },
  { id: 'chime2', name: '双音', desc: '两音上行（叮—咚）', spec: { gain: 0.09, notes: [{ type: 'sine', f0: 880, d: 0.18, a: 0.008 }, { type: 'sine', f0: 1320, d: 0.26, t: 0.16, a: 0.008 }] } },
  { id: 'echo', name: '回声', desc: '单音 + 两次渐弱回声', spec: { gain: 0.09, notes: [{ type: 'sine', f0: 990, d: 0.16, a: 0.006 }, { type: 'sine', f0: 990, d: 0.16, t: 0.18, a: 0.006, g: 0.45 }, { type: 'sine', f0: 990, d: 0.16, t: 0.36, a: 0.006, g: 0.2 }] } },
  { id: 'silent', name: '静音', desc: '不发声（可显式关闭某类信号）', spec: { gain: 0, notes: [] } }
];

const PRESET_BY_ID = (() => {
  const m = {};
  for (const p of SOUND_PRESETS) m[p.id] = p;
  return m;
})();

export function isPresetId(id) { return typeof id === 'string' && !!PRESET_BY_ID[id]; }
export function presetById(id) { return (typeof id === 'string' && PRESET_BY_ID[id]) || null; }

// 全部信号种类（SIGNAL_KINDS 键 ∪ LIVE_ONLY）——顺序稳定：先 SIGNAL_KINDS 定义序，再补 LIVE_ONLY 未含者
export const ALL_SIGNAL_KINDS = (() => {
  const out = [];
  const seen = {};
  for (const k of Object.keys(SIGNAL_KINDS)) { if (!seen[k]) { seen[k] = 1; out.push(k); } }
  for (const k of (LIVE_ONLY_SIGNAL_KINDS || [])) { if (!seen[k]) { seen[k] = 1; out.push(k); } }
  return out;
})();

// 设置页分组（真实成交 / 机会点与钩 / 提醒预演 / 基石调仓）——与 ALL_SIGNAL_KINDS 必须一一覆盖（单测保证）
export const SOUND_KIND_GROUPS = [
  { id: 'trade', name: '真实成交', kinds: ['srsi-open', 'srsi-close', 'alpha-open', 'alpha-close'] },
  { id: 'opportunity', name: '机会点与钩', kinds: ['srsi-cross-buy', 'srsi-cross-sell', 'srsi-hook-gold', 'srsi-hook-death'] },
  { id: 'watch', name: '提醒预演', kinds: ['srsi-edge-upper', 'srsi-edge-lower', 'srsi-confirm', 'srsi-preview'] },
  { id: 'alpha', name: '基石调仓', kinds: ['alpha-rebal'] }
];

// 每种信号的默认音效：成交类更醒目、机会点类柔和、预演类默认静音（保留旧行为）
const DEFAULT_BY_KIND = {
  'srsi-open': 'chime2',
  'srsi-close': 'drop',
  'alpha-open': 'chime2',
  'alpha-close': 'drop',
  'alpha-rebal': 'bell',
  'srsi-edge-upper': 'pulse',
  'srsi-edge-lower': 'pulse',
  'srsi-confirm': 'beep',
  'srsi-preview': 'silent',
  'srsi-cross-buy': 'ding',
  'srsi-cross-sell': 'ding',
  'srsi-hook-gold': 'chime2',
  'srsi-hook-death': 'bell'
};

// 默认映射：显式表 → 按 severity 兜底 → 'beep'（永不返回未知 id）
export function defaultSoundFor(kind, severity) {
  try {
    if (typeof kind === 'string' && DEFAULT_BY_KIND[kind]) return DEFAULT_BY_KIND[kind];
    let sev = severity;
    if (!sev && typeof kind === 'string' && SIGNAL_KINDS[kind]) sev = SIGNAL_KINDS[kind].severity;
    if (sev === 'trade') return 'chime2';
    if (sev === 'preview') return 'silent';
    if (sev === 'signal') return 'ding';
  } catch (e) { /* ignore */ }
  return 'beep';
}

// 用户映射：只保留「键为字符串 + 值为已知 presetId」的项（未知/损坏值被丢弃 → 回退默认）
export function readSoundMap() {
  const out = {};
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(SOUND_MAP_KEY);
    if (!raw) return out;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
    for (const k of Object.keys(obj)) {
      if (typeof k !== 'string' || !k) continue;
      const v = obj[k];
      if (typeof v === 'string' && PRESET_BY_ID[v]) out[k] = v;
    }
  } catch (e) { return {}; }
  return out;
}

// 写入用户映射；失败（含 localStorage 不可用/配额）返回 false，**不抛**
export function writeSoundMap(map) {
  try {
    if (typeof localStorage === 'undefined') return false;
    const clean = {};
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const k of Object.keys(map)) {
        if (typeof k !== 'string' || !k) continue;
        const v = map[k];
        if (typeof v === 'string' && PRESET_BY_ID[v]) clean[k] = v;
      }
    }
    localStorage.setItem(SOUND_MAP_KEY, JSON.stringify(clean));
    return true;
  } catch (e) { return false; }
}

// 解析某信号应播的音效：用户映射 → 默认映射 → 'beep'
export function resolveSound(kind, severity, map) {
  try {
    const k = (typeof kind === 'string') ? kind : '';
    const m = (map && typeof map === 'object' && !Array.isArray(map)) ? map : null;
    if (m && typeof m[k] === 'string' && PRESET_BY_ID[m[k]]) return m[k];
    const d = defaultSoundFor(k, severity);
    if (typeof d === 'string' && PRESET_BY_ID[d]) return d;
  } catch (e) { /* ignore */ }
  return 'beep';
}

// UI 目录（顺序稳定；silent 标记便于界面区分）
export function soundCatalog() {
  return SOUND_PRESETS.map(p => ({ id: p.id, name: p.name, desc: p.desc, silent: p.id === 'silent' }));
}

// 用给定 AudioContext 合成播放一个预设。返回是否真的播了（静音/无效 ctx → false），**不抛**。
// v1.6.38：主增益（用户反馈“试听没声音”→ 实测 0.08 在手机外放/低音量下偏轻）。
// 只在此处放大，所有预设统一受益；如需再调，改这一个常量即可。
const MASTER_GAIN = 1.8;

export function playSound(ctx, presetId, opts) {
  try {
    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return false;
    const p = (typeof presetId === 'string' && PRESET_BY_ID[presetId]) || PRESET_BY_ID.beep;
    if (!p || p.id === 'silent') return false;   // 静音：不创建任何振荡器
    const spec = (p.spec && typeof p.spec === 'object') ? p.spec : null;
    if (!spec || !Array.isArray(spec.notes)) return false;
    const o = (opts && typeof opts === 'object') ? opts : {};
    const base = Number.isFinite(+o.now) ? +o.now : (Number.isFinite(ctx.currentTime) ? ctx.currentTime : 0);
    const vol = Number.isFinite(+o.gain) ? Math.max(0, +o.gain) : 1;
    const baseGain = (Number.isFinite(+spec.gain) ? +spec.gain : 0.08) * MASTER_GAIN;
    let played = 0;
    for (const n of spec.notes) {
      if (!n || typeof n !== 'object') continue;
      const t0 = base + (Number.isFinite(+n.t) ? Math.max(0, +n.t) : 0);
      const d = (Number.isFinite(+n.d) && +n.d > 0) ? +n.d : 0.15;
      const atk = (Number.isFinite(+n.a) && +n.a >= 0) ? Math.min(+n.a, d) : Math.min(0.012, d);
      const peak = Math.max(0.0002, baseGain * (Number.isFinite(+n.g) ? Math.max(0, +n.g) : 1) * vol);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      try { if (n.type) osc.type = n.type; } catch (e) { /* ignore */ }
      const f0 = (Number.isFinite(+n.f0) && +n.f0 > 0) ? +n.f0 : 880;
      const f1 = (Number.isFinite(+n.f1) && +n.f1 > 0) ? +n.f1 : f0;
      if (osc.frequency) {
        if (typeof osc.frequency.setValueAtTime === 'function') osc.frequency.setValueAtTime(f0, t0);
        else osc.frequency.value = f0;
        if (f1 !== f0 && typeof osc.frequency.exponentialRampToValueAtTime === 'function') osc.frequency.exponentialRampToValueAtTime(f1, t0 + d);
      }
      if (typeof osc.connect === 'function') osc.connect(g);
      if (g && typeof g.connect === 'function') g.connect(ctx.destination);
      if (g && g.gain) {
        if (typeof g.gain.setValueAtTime === 'function') g.gain.setValueAtTime(0.0001, t0);
        if (typeof g.gain.exponentialRampToValueAtTime === 'function') {
          g.gain.exponentialRampToValueAtTime(peak, t0 + atk);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
        } else { g.gain.value = peak; }
      }
      if (typeof osc.start === 'function') osc.start(t0);
      if (typeof osc.stop === 'function') osc.stop(t0 + d + 0.03);
      played++;
    }
    return played > 0;
  } catch (e) { return false; }
}
