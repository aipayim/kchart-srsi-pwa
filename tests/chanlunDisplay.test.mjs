// 缠论显示层单元测试（Node 原生，无框架）
// 覆盖：chanlunWindowItems（窗口过滤/方向/开关/上限） / chanlunReadout（行数/字段/延迟/结论）
//       / chanDelayInfo / chanSignalDelayText / chanBspMeta / CHAN_LAYERS / CHAN_DISCLAIMER
//       / chanlunReadoutHtml / renderChanlunInto（签名守卫）。
import { buildChanlun, normalizeBars } from '../src/engine/chanlun.js';
import {
  chanlunWindowItems, chanlunReadout, chanDelayInfo, chanSignalDelayText, chanBspMeta,
  CHAN_LAYERS, chanCfgKey, CHAN_LAYER_CFG_KEYS, CHAN_DISCLAIMER, CHAN_MULTI_NOTE,
} from '../src/engine/chanlunDisplay.js';
import { chanlunReadoutHtml, renderChanlunInto } from '../src/tech2/chanlunPanel.js';

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

// 合成行情：趋势 + 盘整 + 趋势（与 chanlun.test.mjs 同源，确保能产出笔/中枢/信号）
function synthCloses(n = 900) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const seg = Math.floor(i / 300);
    const drift = seg === 0 ? 0.35 : seg === 1 ? 0.02 : -0.30;
    p = Math.max(5, p + drift + Math.sin(i / 6) * 0.9 + Math.sin(i / 23) * 0.4);
    out.push(+p.toFixed(4));
  }
  return out;
}
function ohlcFromCloses(closes) {
  return {
    opens: closes.map((v, i) => (i ? closes[i - 1] : v)),
    highs: closes.map((v) => v + 0.5),
    lows: closes.map((v) => v - 0.5),
    closes,
    vols: closes.map(() => 100),
    times: closes.map((_, i) => i * 3600_000),
  };
}
const closes = synthCloses(900);
const bars = normalizeBars(ohlcFromCloses(closes));
const chan = buildChanlun(bars, { on: true });

// ---------- 0. 常量与元数据 ----------
{
  ok('免责声明: 含「仅结构描述」「无统计优势」',
    CHAN_DISCLAIMER.indexOf('仅结构描述') >= 0 && CHAN_DISCLAIMER.indexOf('无统计优势') >= 0);
  ok('免责声明: 含实时口径回测为负', CHAN_DISCLAIMER.indexOf('6.7 年回测为负') >= 0);
  ok('多解层说明: 非空且含「多解层」', typeof CHAN_MULTI_NOTE === 'string' && CHAN_MULTI_NOTE.indexOf('多解层') >= 0);
  ok('CHAN_LAYERS: 6 个显示层', Array.isArray(CHAN_LAYERS) && CHAN_LAYERS.length === 6);
  ok('CHAN_LAYERS: 每层有 key/label/title',
    CHAN_LAYERS.every((L) => typeof L.key === 'string' && L.label && L.title));
  ok('CHAN_LAYERS: 笔为确定层、其余标注多解层',
    CHAN_LAYERS[0].key === 'showBi' && CHAN_LAYERS[0].title.indexOf('确定性层') >= 0 &&
    CHAN_LAYERS.slice(1).every((L) => L.title.indexOf('多解层') >= 0));
  ok('chanBspMeta: 1b=一买/看多', chanBspMeta('1b').name === '一买' && chanBspMeta('1b').side === 'long');
  ok('chanBspMeta: 3s=三卖/看空', chanBspMeta('3s').name === '三卖' && chanBspMeta('3s').side === 'short');
  ok('chanBspMeta: 未知 kind 回退不抛', chanBspMeta('xx').name === 'xx' && chanBspMeta(undefined).icon === '◇');
}

// ---------- 0b. chanCfgKey / CHAN_LAYER_CFG_KEYS（回归：药丸按钮必须点亮） ----------
{
  ok('chanCfgKey: showBi → chanShowBi', chanCfgKey('showBi') === 'chanShowBi');
  ok('chanCfgKey: showSeg/showZs/showDiv/showBsp/showTrend',
    chanCfgKey('showSeg') === 'chanShowSeg' && chanCfgKey('showZs') === 'chanShowZs' &&
    chanCfgKey('showDiv') === 'chanShowDiv' && chanCfgKey('showBsp') === 'chanShowBsp' &&
    chanCfgKey('showTrend') === 'chanShowTrend');
  ok('chanCfgKey: 非法输入不抛', chanCfgKey('') === 'chan' && chanCfgKey(null) === 'chan');
  ok('CHAN_LAYER_CFG_KEYS: 6 项且与层一一对应',
    CHAN_LAYER_CFG_KEYS.length === 6 && CHAN_LAYERS.every((L, i) => CHAN_LAYER_CFG_KEYS[i] === chanCfgKey(L.key)));
  // 模拟 kchart 默认 cfg：用正确字段名读 → 按钮点亮；用引擎字段名直读（旧 bug）→ undefined（永远熄灭）
  const cfgLike = { chanShowBi: true, chanShowSeg: false, chanShowZs: true, chanShowDiv: true, chanShowBsp: true, chanShowTrend: true };
  ok('按钮点亮判定: 用 chanCfgKey 读取正确',
    CHAN_LAYER_CFG_KEYS.every((k) => typeof cfgLike[k] === 'boolean') &&
    !!cfgLike[chanCfgKey('showBi')] === true && !!cfgLike[chanCfgKey('showSeg')] === false);
  ok('按钮点亮判定: 旧写法 cfg[L.key] 恒为 undefined（复现 bug）',
    CHAN_LAYERS.every((L) => cfgLike[L.key] === undefined));
}

// ---------- 1. chanlunWindowItems ----------
{
  const empty = chanlunWindowItems(null, {});
  ok('窗口项: null → 空结果', empty.bis.length === 0 && empty.segs.length === 0 && empty.centers.length === 0 && empty.divs.length === 0 && empty.bsps.length === 0);

  const full = chanlunWindowItems(chan, { start: 0, end: bars.n });
  ok('窗口项: 全窗口含笔', full.bis.length === chan.bis.length && full.bis.length > 0);
  ok('窗口项: 笔 y0/y1 方向正确（向上笔 y0<y1）',
    full.bis.every((b) => (b.dir === 'up' ? b.y0 < b.y1 : b.y0 > b.y1)));
  ok('窗口项: 中枢含 zg/zd 且 zg>zd', full.centers.length === chan.centers.length && full.centers.every((z) => z.zg > z.zd));
  ok('窗口项: 线段与引擎数量一致', full.segs.length === chan.segs.length);
  ok('窗口项: 背驰 idx 在窗口内', full.divs.every((d) => d.idx >= 0 && d.idx < bars.n));
  ok('窗口项: 买卖点带 name/side', full.bsps.every((s) => s.name && (s.side === 'long' || s.side === 'short')));

  const none = chanlunWindowItems(chan, { start: bars.n + 10, end: bars.n + 100 });
  ok('窗口项: 窗口外 → 全空', none.bis.length === 0 && none.centers.length === 0);

  const noBi = chanlunWindowItems(chan, { start: 0, end: bars.n, showBi: false, showSeg: false, showZs: false, showDiv: false, showBsp: false });
  ok('窗口项: 全部开关关 → 全空', noBi.bis.length === 0 && noBi.segs.length === 0 && noBi.centers.length === 0 && noBi.divs.length === 0 && noBi.bsps.length === 0);

  const cap = chanlunWindowItems(chan, { start: 0, end: bars.n, maxBis: 3, maxSegs: 2, maxCenters: 2 });
  ok('窗口项: maxBis/maxSegs/maxCenters 上限生效', cap.bis.length <= 3 && cap.segs.length <= 2 && cap.centers.length <= 2);

  // 半窗口：只保留与 [0, half) 相交的对象
  const half = Math.floor(bars.n / 2);
  const halfItems = chanlunWindowItems(chan, { start: 0, end: half });
  ok('窗口项: 半窗口笔均与窗口相交', halfItems.bis.every((b) => b.i1 >= 0 && b.i0 < half));
  ok('窗口项: 半窗口 ≤ 全窗口', halfItems.bis.length <= full.bis.length);
}

// ---------- 2. chanlunReadout ----------
{
  const base = chanlunReadout(null, {});
  ok('解读: null → ok=false + 免责声明', base.ok === false && base.disclaimer === CHAN_DISCLAIMER && base.rows.length === 0);

  const ro = chanlunReadout(chan, { livePrice: 200 });
  ok('解读: ok=true', ro.ok === true);
  ok('解读: 6 层 + 延迟状态 = 7 行', ro.rows.length === 7);
  ok('解读: 每行有 icon/color/label/detail',
    ro.rows.every((r) => typeof r.icon === 'string' && /^#|^rgba/.test(r.color) && r.label && typeof r.detail === 'string'));
  ok('解读: tone ∈ bull/bear/range', ['bull', 'bear', 'range'].indexOf(ro.tone) >= 0);
  ok('解读: 结论含「结构：」与「仅结构描述」', ro.verdict.indexOf('结构：') === 0 && ro.verdict.indexOf('仅结构描述') >= 0);
  ok('解读: 结论为一行（不含换行）', ro.verdict.indexOf('\n') < 0);
  ok('解读: 含「当前笔」行', ro.rows.some((r) => r.label.indexOf('当前笔') === 0));
  ok('解读: 含「线段」行', ro.rows.some((r) => r.label.indexOf('线段') === 0));
  ok('解读: 含「最近中枢」行', ro.rows.some((r) => r.label.indexOf('最近中枢') === 0));
  ok('解读: 含「背驰」行', ro.rows.some((r) => r.label.indexOf('背驰') >= 0));
  ok('解读: 含「买卖点/一买/二买/三买/一卖/二卖/三卖」行',
    ro.rows.some((r) => /买卖点|一买|二买|三买|一卖|二卖|三卖/.test(r.label)));
  ok('解读: 含「走势类型」行', ro.rows.some((r) => r.label.indexOf('走势类型') === 0));
  const delayRow = ro.rows.find((r) => r.label.indexOf('延迟状态') === 0);
  ok('解读: 延迟状态行含「信号已可见」「待定稿」',
    !!delayRow && delayRow.label.indexOf('信号已可见') >= 0 && delayRow.label.indexOf('待定稿') >= 0);
  ok('解读: 延迟状态行说明「迟的」', !!delayRow && delayRow.detail.indexOf('迟的') >= 0);

  // 当前笔「已持续 N 根」
  const biRow = ro.rows.find((r) => r.label.indexOf('当前笔') === 0);
  ok('解读: 当前笔行含「已持续」「根」', !!biRow && biRow.detail.indexOf('已持续') >= 0 && biRow.detail.indexOf('根') >= 0);

  // 中枢「距上沿/距下沿」
  const zsRow = ro.rows.find((r) => r.label.indexOf('最近中枢') === 0);
  if (chan.centers.length) {
    ok('解读: 中枢行含「区间」「距上沿」「距下沿」',
      !!zsRow && zsRow.detail.indexOf('区间') >= 0 && zsRow.detail.indexOf('距上沿') >= 0 && zsRow.detail.indexOf('距下沿') >= 0);
  } else {
    ok('解读: 中枢行（无中枢回退）', !!zsRow && zsRow.detail.indexOf('段重叠') >= 0);
  }

  // 实时价影响「距中枢上/下沿」数值
  const zsRowHi = chanlunReadout(chan, { livePrice: 1e9 }).rows.find((r) => r.label.indexOf('最近中枢') === 0);
  const zsRowLo = chanlunReadout(chan, { livePrice: 1e-9 }).rows.find((r) => r.label.indexOf('最近中枢') === 0);
  if (chan.centers.length && zsRowHi && zsRowLo) {
    ok('解读: livePrice 改变中枢距离读数', zsRowHi.detail !== zsRowLo.detail);
  } else {
    ok('解读: livePrice 路径无中枢时仍稳定', true);
  }

  // 关闭层 → 行数减少
  const ro2 = chanlunReadout(chan, { showSeg: false, showDiv: false });
  ok('解读: 关闭线段/背驰 → 行数减少', ro2.rows.length === 5 && !ro2.rows.some((r) => r.label.indexOf('线段') === 0));
  const ro3 = chanlunReadout(chan, { showBi: false, showSeg: false, showZs: false, showDiv: false, showBsp: false, showTrend: false });
  ok('解读: 仅剩延迟行（1 行）', ro3.rows.length === 1 && ro3.rows[0].label.indexOf('延迟状态') === 0);

  // stats 与引擎一致
  ok('解读: stats 计数与引擎一致',
    ro.stats.nBis === chan.bis.length && ro.stats.nSegs === chan.segs.length &&
    ro.stats.nCenters === chan.centers.length && ro.stats.nSignals === chan.signals.length);
  ok('解读: stats 可见+待定 = 信号总数', ro.stats.visible + ro.stats.pending === ro.stats.nSignals);
}

// ---------- 3. chanDelayInfo / chanSignalDelayText ----------
{
  const d = chanDelayInfo(chan);
  ok('延迟统计: visible+pending=total', d.visible + d.pending === d.total && d.total === chan.signals.length);
  ok('延迟统计: medianLag 为有限数或 null', d.medianLag === null || (Number.isFinite(d.medianLag) && d.medianLag >= 0));
  ok('延迟统计: null 输入安全', chanDelayInfo(null).total === 0 && chanDelayInfo(null).medianLag === null);

  ok('单信号延迟: 待定稿文案', chanSignalDelayText({ naiveAt: 10, detectAt: 12, finalAt: null }).indexOf('待定稿') >= 0);
  const t1 = chanSignalDelayText({ naiveAt: 10, detectAt: 12, finalAt: 20 });
  ok('单信号延迟: 含实时可检测后 8 根 + 标注点后 10 根', t1.indexOf('8 根') >= 0 && t1.indexOf('10 根') >= 0);
  const t2 = chanSignalDelayText({ naiveAt: 10, detectAt: null, finalAt: 20 });
  ok('单信号延迟: 无 detectAt 回退标注延迟', t2.indexOf('10 根后定稿') >= 0);
  ok('单信号延迟: null 安全', chanSignalDelayText(null) === '');
}

// ---------- 4. chanlunReadoutHtml / renderChanlunInto ----------
{
  const ro = chanlunReadout(chan, { livePrice: 200 });
  const html = chanlunReadoutHtml(ro);
  ok('HTML: 含免责声明', html.indexOf(CHAN_DISCLAIMER) >= 0);
  ok('HTML: 含结论（chan-concl）', html.indexOf('chan-concl') >= 0 && html.indexOf(ro.verdict) >= 0);
  ok('HTML: 含多解层说明', html.indexOf(CHAN_MULTI_NOTE) >= 0);
  ok('HTML: 含全部行 label', ro.rows.every((r) => html.indexOf(r.label) >= 0));
  ok('HTML: null → 空串', chanlunReadoutHtml(null) === '');
  const emptyHtml = chanlunReadoutHtml({ ok: false, verdict: '数据不足（需要更多 K 线）' });
  ok('HTML: 数据不足 → 提示 + 免责声明', emptyHtml.indexOf('数据不足') >= 0 && emptyHtml.indexOf(CHAN_DISCLAIMER) >= 0);

  const box = { __chanSig: undefined, innerHTML: '' };
  ok('渲染: 首次写入返回 true', renderChanlunInto(box, ro) === true && box.innerHTML.indexOf(CHAN_DISCLAIMER) >= 0);
  ok('渲染: 相同内容二次写入返回 false（签名守卫）', renderChanlunInto(box, ro) === false);
  ok('渲染: 内容变化返回 true', renderChanlunInto(box, chanlunReadout(chan, { livePrice: 1e6 })) === true);
  ok('渲染: null box 安全', renderChanlunInto(null, ro) === false);
}

console.log(`\n=== chanlunDisplay.test: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
