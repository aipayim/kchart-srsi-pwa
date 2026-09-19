// 分信号自定义提示音单元测试（Node 原生，无框架）
// 覆盖：音效目录完整性（≥8 种 + silent）/ 默认映射覆盖全部信号种类 / SOUND_KIND_GROUPS 覆盖一致性 /
//       resolveSound 三级优先级与非法输入回退 / readSoundMap·writeSoundMap 往返 + 损坏 JSON + 未知 id 回退 + 写入失败不抛 /
//       playSound stub AudioContext 冒烟 + silent 不建振荡器 + null ctx 不抛 + 滑音 / soundCatalog 顺序稳定
import {
  SOUND_PRESETS, SOUND_MAP_KEY, ALL_SIGNAL_KINDS, SOUND_KIND_GROUPS,
  soundCatalog, isPresetId, presetById,
  defaultSoundFor, resolveSound, readSoundMap, writeSoundMap, playSound
} from '../src/pwa/signalSounds.js';
import { SIGNAL_KINDS, LIVE_ONLY_SIGNAL_KINDS } from '../src/tech2/signalAlerts.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// ---- localStorage 桩（模块级共享；可临时替换以测写入失败） ----
const _ls = {};
const _realLS = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; }
};
globalThis.localStorage = _realLS;

// ---- AudioContext 桩 ----
function makeCtx() {
  const rec = { osc: 0, gain: 0, rampFreq: 0, starts: 0, stops: 0, connect: 0 };
  const ctx = {
    currentTime: 1.0,
    destination: {},
    createOscillator() {
      rec.osc++;
      return {
        type: '', frequency: {
          setValueAtTime() {},
          exponentialRampToValueAtTime() { rec.rampFreq++; }
        },
        connect() { rec.connect++; },
        start() { rec.starts++; },
        stop() { rec.stops++; }
      };
    },
    createGain() {
      rec.gain++;
      return { gain: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { rec.connect++; } };
    }
  };
  return { ctx, rec };
}

console.log('\n[signalSounds: 目录]');
{
  const sounding = SOUND_PRESETS.filter(p => p.id !== 'silent');
  ok('合成音效 ≥ 8 种', sounding.length >= 8);
  ok('含 silent 静音项', SOUND_PRESETS.some(p => p.id === 'silent'));
  ok('id 唯一', new Set(SOUND_PRESETS.map(p => p.id)).size === SOUND_PRESETS.length);
  ok('每项有 id/name/desc/spec', SOUND_PRESETS.every(p => typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name && typeof p.desc === 'string' && p.spec && typeof p.spec === 'object'));
  ok('每项 spec.notes 为数组', SOUND_PRESETS.every(p => Array.isArray(p.spec.notes)));
  ok('合成音效都有音符', sounding.every(p => p.spec.notes.length >= 1));
  ok('静音项无音符', presetById('silent').spec.notes.length === 0);
  ok('isPresetId 正确', isPresetId('beep') === true && isPresetId('nope') === false && isPresetId(null) === false);
  ok('presetById 正确', !!presetById('bell') && presetById('nope') === null);

  const cat = soundCatalog();
  ok('soundCatalog 顺序与目录一致', cat.map(x => x.id).join(',') === SOUND_PRESETS.map(x => x.id).join(','));
  ok('soundCatalog 每项含 silent 标记', cat.every(x => typeof x.silent === 'boolean') && cat.find(x => x.id === 'silent').silent === true && cat.find(x => x.id === 'beep').silent === false);
  ok('soundCatalog 返回新数组（可安全改写）', (() => { const a = soundCatalog(); a.push({ id: 'x' }); return soundCatalog().length === SOUND_PRESETS.length; })());
  ok('soundCatalog 稳定两次相等', JSON.stringify(soundCatalog()) === JSON.stringify(soundCatalog()));
}

console.log('\n[signalSounds: 默认映射]');
{
  ok('ALL_SIGNAL_KINDS = SIGNAL_KINDS ∪ LIVE_ONLY', (() => {
    const u = new Set([...Object.keys(SIGNAL_KINDS), ...LIVE_ONLY_SIGNAL_KINDS]);
    return ALL_SIGNAL_KINDS.length === u.size && ALL_SIGNAL_KINDS.every(k => u.has(k));
  })());
  ok('ALL_SIGNAL_KINDS 无重复', new Set(ALL_SIGNAL_KINDS).size === ALL_SIGNAL_KINDS.length);
  ok('默认映射覆盖全部信号种类', ALL_SIGNAL_KINDS.every(k => isPresetId(defaultSoundFor(k))));
  ok('默认映射显式表覆盖全部种类（非 severity 兜底）', ALL_SIGNAL_KINDS.every(k => isPresetId(defaultSoundFor(k, 'signal'))));
  ok('预演默认静音', defaultSoundFor('srsi-preview') === 'silent');
  ok('成交类默认更醒目（非 beep/silent）', ['srsi-open', 'srsi-close', 'alpha-open', 'alpha-close', 'alpha-rebal'].every(k => ['beep', 'silent'].indexOf(defaultSoundFor(k)) < 0));
  // 未知 kind 的 severity 兜底
  ok('未知 kind + trade → chime2', defaultSoundFor('zzz', 'trade') === 'chime2');
  ok('未知 kind + preview → silent', defaultSoundFor('zzz', 'preview') === 'silent');
  ok('未知 kind + signal → ding', defaultSoundFor('zzz', 'signal') === 'ding');
  ok('全空 → beep', defaultSoundFor(null, null) === 'beep');
  ok('非法输入不抛', typeof defaultSoundFor(undefined, {}) === 'string');
  // 分组覆盖
  const groupKinds = SOUND_KIND_GROUPS.reduce((a, g) => a.concat(g.kinds), []);
  ok('SOUND_KIND_GROUPS 覆盖全部信号种类（无遗漏）', ALL_SIGNAL_KINDS.every(k => groupKinds.indexOf(k) >= 0));
  ok('SOUND_KIND_GROUPS 无多余/重复种类', groupKinds.length === new Set(groupKinds).size && groupKinds.every(k => ALL_SIGNAL_KINDS.indexOf(k) >= 0));
  ok('SOUND_KIND_GROUPS 有名称与 id', SOUND_KIND_GROUPS.every(g => g.id && g.name && Array.isArray(g.kinds)));
}

console.log('\n[signalSounds: resolveSound]');
{
  ok('用户映射优先', resolveSound('srsi-open', 'trade', { 'srsi-open': 'bell' }) === 'bell');
  ok('未知 presetId → 回退默认', resolveSound('srsi-open', 'trade', { 'srsi-open': 'nope' }) === defaultSoundFor('srsi-open'));
  ok('映射为空 → 默认', resolveSound('srsi-hook-death', 'signal', {}) === defaultSoundFor('srsi-hook-death'));
  ok('映射 null → 默认', resolveSound('srsi-preview', 'preview', null) === 'silent');
  ok('映射为数组 → 视为无', resolveSound('srsi-open', 'trade', ['bell']) === defaultSoundFor('srsi-open'));
  ok('未知 kind → beep', resolveSound('zzz', null, {}) === 'beep');
  ok('kind null → beep', resolveSound(null, null, null) === 'beep');
  ok('kind 非字符串 → beep', resolveSound(123, undefined, undefined) === 'beep');
  ok('非法 map 值类型不抛', typeof resolveSound('srsi-open', 'trade', { 'srsi-open': 42 }) === 'string');
  ok('resolveSound 永不返回未知 id', ALL_SIGNAL_KINDS.every(k => isPresetId(resolveSound(k, undefined, null))));
}

console.log('\n[signalSounds: read/write map]');
{
  ok('初始读取为空对象', Object.keys(readSoundMap()).length === 0);
  ok('写入成功', writeSoundMap({ 'srsi-open': 'bell', 'alpha-rebal': 'drop' }) === true);
  const back = readSoundMap();
  ok('往返一致', back['srsi-open'] === 'bell' && back['alpha-rebal'] === 'drop');
  ok('写入未知 id 被过滤', (() => { writeSoundMap({ 'srsi-open': 'nope', 'alpha-open': 'ding' }); const m = readSoundMap(); return m['srsi-open'] === undefined && m['alpha-open'] === 'ding'; })());
  ok('写入非对象 → 清空', (() => { writeSoundMap(['x']); return Object.keys(readSoundMap()).length === 0; })());
  ok('写入 null → 清空不抛', writeSoundMap(null) === true && Object.keys(readSoundMap()).length === 0);

  // 损坏 JSON
  _ls[SOUND_MAP_KEY] = '{bad json';
  ok('损坏 JSON → {}', Object.keys(readSoundMap()).length === 0);
  _ls[SOUND_MAP_KEY] = '"just a string"';
  ok('非对象 JSON → {}', Object.keys(readSoundMap()).length === 0);
  _ls[SOUND_MAP_KEY] = '[1,2,3]';
  ok('数组 JSON → {}', Object.keys(readSoundMap()).length === 0);
  _ls[SOUND_MAP_KEY] = JSON.stringify({ 'srsi-open': 'bell', 'srsi-close': 'nope', 'x': 5 });
  ok('读取时丢弃未知 id/非字符串值', (() => { const m = readSoundMap(); return m['srsi-open'] === 'bell' && m['srsi-close'] === undefined && m['x'] === undefined; })());

  // 写入失败不抛
  const saved = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: () => {}
  };
  ok('写入抛错 → false 且不抛', writeSoundMap({ 'srsi-open': 'bell' }) === false);
  globalThis.localStorage = saved;
  // localStorage 不可用（undefined）
  const saved2 = globalThis.localStorage;
  try { delete globalThis.localStorage; } catch (e) { globalThis.localStorage = undefined; }
  ok('localStorage 缺失：readSoundMap → {}', Object.keys(readSoundMap()).length === 0);
  ok('localStorage 缺失：writeSoundMap → false', writeSoundMap({ 'srsi-open': 'bell' }) === false);
  globalThis.localStorage = saved2;
  writeSoundMap({});
}

console.log('\n[signalSounds: playSound]');
{
  const { ctx, rec } = makeCtx();
  ok('playSound 正常返回 true', playSound(ctx, 'beep') === true);
  ok('创建了振荡器与增益', rec.osc >= 1 && rec.gain >= 1 && rec.starts >= 1 && rec.stops >= 1);
  ok('多音符预设创建多个振荡器', (() => { const { ctx: c, rec: r } = makeCtx(); playSound(c, 'chime2'); return r.osc === 2; })());
  ok('滑音预设触发频率 ramp', (() => { const { ctx: c, rec: r } = makeCtx(); playSound(c, 'drop'); return r.rampFreq >= 1; })());
  ok('silent 不创建振荡器', (() => { const { ctx: c, rec: r } = makeCtx(); const res = playSound(c, 'silent'); return res === false && r.osc === 0; })());
  ok('未知 preset → 回退 beep 仍发声', (() => { const { ctx: c, rec: r } = makeCtx(); return playSound(c, 'nope') === true && r.osc >= 1; })());
  ok('null ctx → false 不抛', playSound(null, 'beep') === false);
  ok('undefined ctx → false', playSound(undefined, 'beep') === false);
  ok('空对象 ctx → false', playSound({}, 'beep') === false);
  ok('非法 presetId 类型不抛', (() => { const { ctx: c } = makeCtx(); return typeof playSound(c, 42) === 'boolean'; })());
  ok('opts.now/gain 接受且不抛', (() => { const { ctx: c, rec: r } = makeCtx(); const res = playSound(c, 'beep', { now: 5, gain: 0.5 }); return res === true && r.starts >= 1; })());
  ok('opts 非法不抛', (() => { const { ctx: c } = makeCtx(); return playSound(c, 'beep', 'x') === true; })());
  ok('gain=0 仍可调用', (() => { const { ctx: c } = makeCtx(); return playSound(c, 'beep', { gain: 0 }) === true; })());
  // 每个合成预设都能播（不抛且返回 true）
  ok('全部合成音效可播放', SOUND_PRESETS.filter(p => p.id !== 'silent').every(p => { const { ctx: c } = makeCtx(); return playSound(c, p.id) === true; }));
}

console.log(`\n=== signalSounds: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
