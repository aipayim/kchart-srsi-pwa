// 本机 TSEV 自学习 loop 单元测试：注册 / 优雅降级 / 按币种分训 / 样本导入导出
import * as localLoop from '../src/pwa/localLoop.js';

// localStorage stub（Node 默认无此 API）：P5 权重版本化需要
if (typeof globalThis.localStorage === 'undefined') {
  const _m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (_m.has(k) ? _m.get(k) : null),
    setItem: (k, v) => { _m.set(k, String(v)); },
    removeItem: (k) => { _m.delete(k); },
    clear: () => _m.clear(),
    key: (i) => Array.from(_m.keys())[i] ?? null,
    get length() { return _m.size; }
  };
}

let passed = 0, failed = 0;
function ok(name, cond) { if (cond) { passed++; console.log('ok:', name); } else { failed++; console.log('FAIL:', name); } }

const T = globalThis.__localTsev || null;
localLoop.register();
const api = globalThis.__localTsev;
ok('register 暴露 globalThis.__localTsev', typeof api === 'object');
ok('暴露 forwardAccuracy/importSamples/exportSamples', typeof api.forwardAccuracy === 'function' && typeof api.importSamples === 'function' && typeof api.exportSamples === 'function');

await localLoop.init(); // 无 IDB 环境应优雅降级，不抛错
ok('init 不抛错', true);

// 空状态：无 IDB 时 exportSamples 返回 null，权重为空
ok('exportSamples 空→null', (await localLoop.exportSamples()) === null);
ok('getWeights 空→null', localLoop.getWeights() === null);

// 导入紧凑聚合统计（{v:2,stats,sampleCount,perSym}）后，应能在内存中按币种训练出权重
const imp = JSON.stringify({
  v: 2,
  stats: { 'BTC|consensus|bull|1': { n: 600, h: 520 }, 'BTC|consensus|bear|-1': { n: 600, h: 90 } },
  sampleCount: 1200,
  perSym: { BTC: { total: 1200, done: 1200, backfilled: true } }
});
const okImp = await localLoop.importSamples(imp);
ok('importSamples 返回 true', okImp === true);
const w = localLoop.getWeights();
ok('importSamples 后 getWeights 非空', w && w.perSym && w.perSym.BTC);
ok('按币种 BTC 学出 bull 权重(>0)', w && w.perSym.BTC && (w.perSym.BTC['consensus|bull|1'] > 0));
ok('按币种 BTC 学出 bear 权重(<0)', w && w.perSym.BTC && (w.perSym.BTC['consensus|bear|-1'] < 0));
ok('getStats.factorCount=2', api.getStats().factorCount === 2);

// forwardAccuracy 在导入样本（仅聚合统计、无内存 _rows）上返回 null 属正常（需实时/回补采样填充验证缓冲）
ok('forwardAccuracy(BTC) 无验证缓冲→null(不崩)', localLoop.forwardAccuracy('BTC') === null);

// ⭐ v1.6.71：超短档（scalp）样本必须被接受 —— 旧正则写死 short|mid|long 会**静默拒绝**，
//    表现为面板「超短档已判定 N 笔」但「本机 TSEV 独立样本 0/50」永远不增长。
{
  const SYM = 'SCALPTEST';
  ok('recordJevSample 接受 scalp（修复回归）', localLoop.recordJevSample(SYM, Date.now(), 'scalp', -1, 1) === true);
  ok('recordJevSample 接受 short/mid/long', ['short', 'mid', 'long'].every(h => localLoop.recordJevSample(SYM, Date.now(), h, 1, 1) === true));
  ok('recordJevSample 拒绝非法档（白名单仍生效）', localLoop.recordJevSample(SYM, Date.now(), 'bogus', 1, 1) === false);
  ok('recordJevSample 拒绝非法 side', localLoop.recordJevSample(SYM, Date.now(), 'scalp', 0, 1) === false);
  const dbg = localLoop.debugTsev(SYM);
  const sc = dbg.find(x => x.key === 'jev|scalp|-1');
  ok('debugTsev 出现 jev|scalp|-1（n≥1，未达门槛也列出）', !!sc && sc.n >= 1);
  const sk = dbg.filter(x => x.key.indexOf('jev|') === 0).map(x => x.key);
  ok('debugTsev 四档 jev 因子齐（scalp/short/mid/long）', ['jev|scalp|-1', 'jev|short|1', 'jev|mid|1', 'jev|long|1'].every(k => sk.indexOf(k) >= 0));
}

// ⭐ P4 剩余子项：SRSI 对齐因子族 `jev_srsi|<td>|<side>`（样本来自 P1 配对「命中即喂」）
{
  const SYM = 'SRSITEST';
  ok('recordJevSrsiSample 接受 15m', localLoop.recordJevSrsiSample(SYM, Date.now(), '15m', 1, true) === true);
  ok('recordJevSrsiSample 拒绝非法 side', localLoop.recordJevSrsiSample(SYM, Date.now(), '15m', 0, true) === false);
  ok('recordJevSrsiSample 缺 sym → false', localLoop.recordJevSrsiSample('', Date.now(), '15m', 1, true) === false);
  ok('debugTsev 出现 jev_srsi|15m|1（n≥1）', (() => { const d = localLoop.debugTsev(SYM).find(x => x.key === 'jev_srsi|15m|1'); return !!d && d.n >= 1; })());
  ok('非法 td 回退 15m（不拒绝）', localLoop.recordJevSrsiSample(SYM, Date.now(), 'bogus!', -1, false) === true);
  ok('非法 td 回退后键为 jev_srsi|15m|-1', !!localLoop.debugTsev(SYM).find(x => x.key === 'jev_srsi|15m|-1'));
  ok('register 暴露 recordJevSrsiSample', typeof api.recordJevSrsiSample === 'function');
}

// ⭐ P5：权重版本化（每日快照 + 一键回滚）与学习曲线
{
  ok('register 暴露 listWeightVersions/rollbackWeights/learningCurve',
    ['listWeightVersions', 'rollbackWeights', 'learningCurve'].every(k => typeof api[k] === 'function'));
  const vs = localLoop.listWeightVersions();
  ok('listWeightVersions 数组且非空（训练后已建版）', Array.isArray(vs) && vs.length >= 1);
  ok('版本项含 day/factors/sampleCount/syms', !!vs.length && typeof vs[0].day === 'string' && typeof vs[0].factors === 'number' && typeof vs[0].syms === 'number');
  ok('版本元数据不外泄权重本体', vs.length > 0 && vs[0].weights === undefined);
  const before = localLoop.getWeights();
  ok('rollbackWeights(0) 成功', localLoop.rollbackWeights(0) === true);
  const after = localLoop.getWeights();
  ok('回滚后权重仍非空', !!after && !!after.perSym && Object.keys(after.perSym).length > 0);
  ok('rollbackWeights 非法索引 → false', localLoop.rollbackWeights(999) === false);
  ok('rollbackWeights(空列表 ref 缺省) 不抛', typeof localLoop.rollbackWeights(undefined) === 'boolean');
  const lc = localLoop.learningCurve('BTC');
  ok('learningCurve 含 windows[3]', !!lc && Array.isArray(lc.windows) && lc.windows.length === 3);
  ok('learningCurve 含 rows/versions/guard', !!lc && typeof lc.rows === 'number' && typeof lc.versions === 'number' && Array.isArray(lc.guard));
  ok('learningCurve 无验证缓冲时 acc 为 null（不崩）', lc.windows.every(w => w.acc === null || typeof w.acc === 'number'));
  ok('status 含 verCount/guardN', typeof api.status().verCount === 'number' && typeof api.status().guardN === 'number');
}

// ⭐ 样本卫生修复：importSamples 兼容 v5(buckets) 与旧 {n,h} 两种形状（之前旧形状会崩 addRow / v5 形状会静默丢样本）
{
  const A = 'IMPLEGACY', B = 'IMPV5';
  ok('导入旧 {n,h} 形状', (await localLoop.importSamples(JSON.stringify({ v: 2, stats: { [A + '|consensus|bull|1']: { n: 400, h: 330 } }, sampleCount: 400 }))) === true);
  ok('旧形状导入后权重可用（n 折算到当前周桶）', (() => { const w = localLoop.getWeights(); return !!(w && w.perSym && w.perSym[A] && w.perSym[A]['consensus|bull|1'] > 0); })());
  let threw = false;
  try { localLoop.recordJevSample(A, Date.now(), 'scalp', 1, true); } catch (e) { threw = true; }
  ok('旧形状条目上再喂样本不抛错（addRow/_recordBucket 防御）', threw === false);
  const bk = {}; bk[Math.floor(Date.now() / (7 * 86400000))] = { n: 500, h: 400 };
  ok('导入 v5 buckets 形状', (await localLoop.importSamples(JSON.stringify({ v: 5, stats: { [B + '|consensus|bull|1']: { buckets: bk } }, sampleCount: 500 }))) === true);
  ok('v5 buckets 导入后权重可用（不得静默丢弃）', (() => { const w = localLoop.getWeights(); return !!(w && w.perSym && w.perSym[B] && w.perSym[B]['consensus|bull|1'] > 0); })());
  ok('非法 JSON → false', (await localLoop.importSamples('{bad')) === false);
  // 脏键（缺 sym 前缀）必须被跳过，否则会产生无法被任何币种消费的孤儿条目
  await localLoop.importSamples(JSON.stringify({ v: 5, stats: { 'consensus|bull|1': { n: 999, h: 999 } }, sampleCount: 999 }));
  ok('脏键（无 sym 前缀）被跳过', localLoop.debugTsev('consensus').length === 0 && localLoop.getWeights() === null);
  ok('无 stats → false', (await localLoop.importSamples(JSON.stringify({ v: 5 }))) === false);
}

console.log(`\n=== localLoop.test: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
