import { ema, rsi, macd, srsi, srsiKD, srsiSignal, atrClose, ais, aisMacd, resonance, detectRegime, detectRegimeState, trendGate, pullbackEntry, signalBacktest, walkForwardWinRate, filterSignalsBySide, gateKeepFactor, normLongRatio, superviseATR, computeTFChanges, techScore, momentumPct, momentumState, takerBuyPct, volumeDivergence, supportResistance, threeLayerResonance, hexToNum, parseScanV2, parseBlockchairStats, onChainTrend, newsSentiment, sanitizeSigScoreTable, downsampleOHLC, sumVol } from './engine/indicators.js';
import { resample, bucketByMinute, combineResonance, TF_LIST, KLINE_TF, KLINE_INTERVAL, KLINE_DOWNSAMPLE, TICK_TF } from './engine/timeframe.js';
import { APP_VERSION, APP_TAG, APP_COMMIT, APP_DESCRIBE, APP_DIRTY, APP_BUILD_TIME } from './version.generated.js';
import { chat, testConnection, providerConfig, budgetAvailable, consumeBudget, estimateTokens, freqToMs } from './ai/llmClient.js';
import { buildMarketPrompt, parseVerdict } from './ai/promptBuilder.js';
import { recordTrade, getWinExamples, getLoseExamples, formatExample } from './ai/tradeLibrary.js';
import { shouldLLMExit, shouldScoreExit } from './ai/exitLogic.js';
import { regimeParams, volFactor, regimeSignalWeight } from './engine/regimeParams.js';
import { ensureFusionBacktestPanel } from './tech2/fusionBacktest.js';
import { THRESH } from './engine/thresholds.js';

let techConfig = {
  symbol: 'BTCUSDT',
  show: { ema20: true, ema120: true, rsi: true, macd: true, srsi: true, aisChannel: true },
  ais: { ema20: true, ema120: true, rsi: true, macd: true, srsi: true },
  timeframes: { '1t': true, '5t': false, '10t': true, '20t': false, '50t': false, '1m': true, '5m': false, '10m': false, '15m': false, '1h': false, '4h': false, '1d': false },
  primaryTF: '1t',
  signalSource: 'all',      // 信号源: 'all' | 'ais' | 'trend' | 'rsi' | 'macd' | 'srsi'
  signalMinVotes: 3,        // 最低票数 3~5 (对单源自动钳制)
  signalConfirm: 0,         // 确认K线 0~3
  srsiEnable: 1,            // SRSI策略开关（人工盯盘反手策略，仅图表显示）
  srsiRsiPeriod: 85,        // RSI 周期
  srsiStochPeriod: 50,      // Stoch 周期
  srsiSmoothK: 10,          // %K 平滑
  srsiSmoothD: 5,           // %D 平滑
  srsiOverbought: 80,       // 超买线上沿触发
  srsiOversold: 20          // 超卖线下沿触发
};

let mode='pro';
const T={
  nav_fusion:{pro:'数据融合',simple:'市场分析'},nav_arb:{pro:'套利',simple:'赚差价'},nav_subs:{pro:'子账户',simple:'分账户'},
  nav_ledger:{pro:'账本',simple:'历史记录'},
  side_coins:{pro:'币种',simple:'币种'},side_subs:{pro:'子账户',simple:'分账户'},side_risk:{pro:'风控',simple:'风险控制'},
  side_pnl:{pro:'今日盈亏',simple:'今日盈亏'},side_active:{pro:'活跃仓位',simple:'正在交易'},
  side_winrate:{pro:'AI胜率',simple:'AI赚钱比例'},side_arb:{pro:'套利次数',simple:'赚差价次数'},total:{pro:'总资产',simple:'总资产'},
  dash_pos:{pro:'当前持仓',simple:'当前持仓'},dash_nopos:{pro:'暂无持仓',simple:'还没有任何交易'},
  card_be:{pro:'已保本',simple:'已回本'},card_spread:{pro:'差',simple:'差'},card_fee:{pro:'费率',simple:'持仓费'},
  card_oi:{pro:'OI',simple:'大家投'},card_fg:{pro:'F&G',simple:'情绪'},
  card_buy:{pro:'买入',simple:'买入'},card_sell:{pro:'卖出',simple:'卖出'},card_ai:{pro:'AI',simple:'AI分析'},
  pos_long:{pro:'多',simple:'涨'},pos_short:{pro:'空',simple:'跌'},
  pos_dolong:{pro:'做多',simple:'买涨'},pos_doshort:{pro:'做空',simple:'买跌'},
  pos_entry:{pro:'入场',simple:'买入价'},pos_tp:{pro:'TP',simple:'已卖'},pos_close:{pro:'平仓',simple:'卖出'},
  pos_section:{pro:'当前持仓',simple:'当前持仓'},fusion_title:{pro:'多维数据融合',simple:'市场分析'},
  fus_rate:{pro:'资金费率',simple:'持仓费'},fus_rate_long:{pro:'多头支付空头',simple:'看涨的人付钱给看跌的人'},
  fus_rate_short:{pro:'空头支付多头',simple:'看跌的人付钱给看涨的人'},fus_oi:{pro:'持仓量 (OI)',simple:'大家投了多少钱'},
  fus_oi_sub:{pro:'市场参与度',simple:'多少人在玩'},fus_fg:{pro:'恐惧贪婪指数',simple:'市场情绪指数'},
  fus_fear5:{pro:'极度恐慌',simple:'大家很害怕'},fus_fear4:{pro:'恐慌',simple:'有点害怕'},
  fus_fear3:{pro:'中性',simple:'一般般'},fus_fear2:{pro:'贪婪',simple:'有点疯狂'},fus_fear1:{pro:'极度贪婪',simple:'大家很疯狂'},
  fus_spread:{pro:'跨所价差',simple:'两边价格差'},fus_whale:{pro:'鲸鱼监控',simple:'大户动向'},
  fus_score:{pro:'综合趋势评分',simple:'综合评分'},fus_score_sub:{pro:'多因子融合',simple:'综合多个数据'},
  fus_nowhale:{pro:'暂无异动',simple:'暂时没有大动作'},
  fus_fresh:{pro:'更新',simple:'更新'},fus_stale:{pro:'数据过期',simple:'数据过期'},fus_never:{pro:'暂无数据',simple:'暂无数据'},
  fus_breadth:{pro:'市场广度',simple:'涨跌比'},fus_breadth_sub:{pro:'上涨/下跌币种',simple:'涨/跌的币'},
  fus_action_buy:{pro:'偏多(可做多)',simple:'偏涨'},fus_action_sell:{pro:'偏空(可做空)',simple:'偏跌'},fus_action_neutral:{pro:'中性(观望)',simple:'先看看'},
  fus_confirm_high:{pro:'高',simple:'高'},fus_confirm_mid:{pro:'中',simple:'中'},fus_confirm_low:{pro:'低',simple:'低'},
  fus_tech:{pro:'技术信号',simple:'技术指标'},fus_tech_sub:{pro:'RSI/MACD/AIS/共振',simple:'指标多空'},
  fus_regime:{pro:'市场情境',simple:'市场状态'},fus_regime_sub:{pro:'趋势/震荡/回调+波动',simple:'趋势+波动'},
  fus_ai:{pro:'AI 多空评分',simple:'AI打分'},fus_ai_sub:{pro:'当前多/空信号强度',simple:'看多/看空得分'},
  fus_llm:{pro:'LLM 判断',simple:'AI分析师'},fus_llm_sub:{pro:'大模型方向观点',simple:'AI观点'},
  fus_pos:{pro:'持仓状态',simple:'我的仓位'},fus_pos_sub:{pro:'当前币持仓盈亏',simple:'这只币的仓位'},
  fus_24h:{pro:'24h 行情',simple:'24小时'},fus_24h_sub:{pro:'涨跌/高低/成交量',simple:'涨跌/量'},
  fus_mtf:{pro:'多周期涨跌',simple:'多周期涨跌'},fus_mtf_long:{pro:'偏多',simple:'偏多'},fus_mtf_short:{pro:'偏空',simple:'偏空'},
  fus_vol:{pro:'波动率',simple:'波动'},fus_vol_sub:{pro:'ATR 波动扩张/收缩',simple:'波动大小'},
  fus_ls:{pro:'多空账户比',simple:'多空比'},fus_ls_sub:{pro:'散户持仓方向占比',simple:'大家看多还是看空'},
  fus_top:{pro:'顶级交易者多空比',simple:'大户多空比'},fus_top_sub:{pro:'大户持仓方向占比',simple:'大户方向'},
  fus_taker:{pro:'Taker 买卖比',simple:'主动买卖比'},fus_taker_sub:{pro:'主动买入/卖出量',simple:'买卖力度'},
  fus_nopos:{pro:'无持仓',simple:'没有仓位'},
  fus_trend_up:{pro:'趋势上涨',simple:'上涨趋势'},fus_trend_down:{pro:'趋势下跌',simple:'下跌趋势'},
  fus_range:{pro:'震荡',simple:'横盘'},fus_pullback_up:{pro:'回调(上)',simple:'回调'},fus_pullback_down:{pro:'回调(下)',simple:'回落'},
  fus_vol_exp:{pro:'波动扩张',simple:'波动变大'},fus_vol_cont:{pro:'波动收缩',simple:'波动变小'},fus_vol_flat:{pro:'波动平稳',simple:'波动正常'},
  fus_ob:{pro:'超买',simple:'过热'},fus_os:{pro:'超卖',simple:'超卖'},fus_macd_bull:{pro:'MACD多头',simple:'MACD涨'},fus_macd_bear:{pro:'MACD空头',simple:'MACD跌'},
  fus_res_buy:{pro:'共振做多',simple:'都看多'},fus_res_sell:{pro:'共振做空',simple:'都看空'},fus_res_none:{pro:'无共振',simple:'没信号'},
  fus_res_strong:{pro:'强',simple:'强'},fus_res_medium:{pro:'中',simple:'中'},fus_res_weak:{pro:'弱',simple:'弱'},
  fus_llm_off:{pro:'LLM 未开启',simple:'AI没开'},fus_llm_na:{pro:'暂无判断',simple:'暂无AI观点'},
  fus_llm_long:{pro:'看多',simple:'看涨'},fus_llm_short:{pro:'看空',simple:'看跌'},fus_llm_neutral:{pro:'中性',simple:'观望'},
  fus_ai_long:{pro:'AI偏多',simple:'AI看多'},fus_ai_short:{pro:'AI偏空',simple:'AI看空'},
  fus_high:{pro:'最高',simple:'最高'},fus_low:{pro:'最低',simple:'最低'},
  fus_frTrend:{pro:'费率趋势',simple:'费率走势'},fus_frTrend_sub:{pro:'历史资金费率方向',simple:'费率一直涨还是跌'},
  fus_oiTrend:{pro:'OI 趋势',simple:'持仓走势'},fus_oiTrend_sub:{pro:'历史持仓量方向',simple:'钱在流入还是流出'},
  fus_priceTrend:{pro:'价格走势',simple:'价格动量'},fus_priceTrend_sub:{pro:'近期价格动量',simple:'最近价格动得怎么样'},
  fus_fgTrend:{pro:'情绪趋势',simple:'情绪走势'},fus_fgTrend_sub:{pro:'恐惧贪婪变化方向',simple:'情绪在变好还是变差'},
  fus_rise:{pro:'上升',simple:'上升'},fus_fall:{pro:'下降',simple:'下降'},fus_flat:{pro:'平稳',simple:'平稳'},
  fus_inflow:{pro:'资金流入',simple:'钱进来了'},fus_outflow:{pro:'资金流出',simple:'钱跑了'},
  fus_heat:{pro:'情绪升温',simple:'更乐观'},fus_cool:{pro:'情绪降温',simple:'更悲观'},
  fus_mom_up:{pro:'急涨',simple:'快速上涨'},fus_mom_down:{pro:'急跌',simple:'快速下跌'},
  fus_sigWR:{pro:'AI 信号胜率',simple:'信号胜率'},fus_sigWR_sub:{pro:'当前信号历史表现',simple:'这些信号靠不靠谱'},
  fus_aiRec:{pro:'AI 战绩',simple:'AI战绩'},fus_aiRec_sub:{pro:'该币 AI 历史交易',simple:'这个币AI做得怎么样'},
  fus_closedRec:{pro:'近期平仓',simple:'最近平仓'},fus_closedRec_sub:{pro:'该币最近平仓记录',simple:'最近卖出记录'},
  fus_aisPos:{pro:'AIS 通道位置',simple:'通道位置'},fus_aisPos_sub:{pro:'价格在通道内位置',simple:'价格在通道哪里'},
  fus_emaT:{pro:'EMA 趋势',simple:'均线趋势'},fus_emaT_sub:{pro:'EMA20/120 关系',simple:'均线多头还是空头'},
  fus_gold:{pro:'金叉',simple:'金叉'},fus_dead:{pro:'死叉',simple:'死叉'},fus_nocross:{pro:'无交叉',simple:'没交叉'},
  fus_bt:{pro:'回测胜率',simple:'回测胜率'},fus_bt_sub:{pro:'买/卖信号历史胜率',simple:'历史胜率'},
  fus_onchain:{pro:'链上活跃度',simple:'链上活跃度'},fus_onchain_eth:{pro:'ETH',simple:'ETH'},
  fus_onchain_bnb:{pro:'BNB销毁',simple:'BNB销毁'},fus_onchain2:{pro:'BNB销毁/ETH供应',simple:'供应/销毁'},
  fus_accum:{pro:'数据积累中...',simple:'攒数据中...'},fus_noRec:{pro:'暂无记录',simple:'暂无记录'},
  fus_news:{pro:'相关新闻',simple:'新闻'},fus_news_sub:{pro:'CoinDesk 相关新闻情绪',simple:'相关新闻'},
  fus_news_pos:{pro:'偏多',simple:'利好'},fus_news_neg:{pro:'偏空',simple:'利空'},
  fus_news_stale:{pro:'新闻暂不可用',simple:'暂无新闻'},
  ai_engine:{pro:'AI 决策引擎',simple:'AI 怎么决定的'},ai_evo:{pro:'AI 进化统计',simple:'AI 做得怎么样'},
  ai_prompt:{pro:'AI 分析提示词',simple:'AI 怎么想的'},ai_exec:{pro:'已执行',simple:'已自动操作'},
  ai_wait:{pro:'待执行',simple:'还没操作'},ai_conf:{pro:'置信度',simple:'把握'},
  ai_total:{pro:'总交易',simple:'总操作次数'},ai_winrate:{pro:'胜率',simple:'赚钱比例'},
  ai_win:{pro:'盈利',simple:'赚了'},ai_lose:{pro:'亏损',simple:'亏了'},
  ai_waitmsg:{pro:'等待AI分析...',simple:'AI正在分析中...'},ai_waitdata:{pro:'等待AI分析数据...',simple:'AI正在分析数据...'},
  ai_full_label:{pro:'全面分析行情',simple:'一键分析全部币种'},ai_full_close:{pro:'收起分析',simple:'收起来'},
  pos_fee:{pro:'手续费',simple:'交易费'},
  arb_title:{pro:'跨交易所套利监控',simple:'两个交易所的差价'},
  arb_wait:{pro:'等待套利机会... (开启套利开关后自动检测)',simple:'等待赚差价机会... (打开开关后自动检测)'},
  subs_title:{pro:'虚拟子账户管理',simple:'分账户管理'},
  sub_idle:{pro:'空闲',simple:'没事做'},sub_active:{pro:'活跃',simple:'在交易'},sub_losed:{pro:'清算',simple:'亏完了'},
  set_trade:{pro:'交易设置',simple:'交易设置'},set_maxlev:{pro:'最大杠杆',simple:'最大借钱倍数'},
  set_maxorder:{pro:'单笔最大',simple:'单笔最多花'},set_maxloss:{pro:'每日最大亏损',simple:'每天最多亏'},
  set_aiset:{pro:'AI 设置',simple:'AI 设置'},set_aiauto:{pro:'AI自动交易',simple:'AI自动交易'},
  set_aiconf:{pro:'最低置信度',simple:'AI最少要多有把握'},set_aimax:{pro:'每日AI上限',simple:'AI每天最多操作几次'},
  set_arbset:{pro:'套利设置',simple:'赚差价设置'},set_arbon:{pro:'套利开关',simple:'赚差价开关'},
  set_minspread:{pro:'最小价差%',simple:'最小价格差%'},set_boths:{pro:'必须双边',simple:'必须两边都有'},
  set_minprofit:{pro:'最小净利润',simple:'最少赚多少'},set_slip:{pro:'滑点保护',simple:'价格偏差保护'},
  set_fusion:{pro:'数据融合',simple:'市场数据'},set_fr:{pro:'资金费率',simple:'持仓费'},
  set_oi:{pro:'持仓量(OI)',simple:'大家投了多少钱'},set_fg:{pro:'恐惧贪婪',simple:'市场情绪'},
  set_whale:{pro:'鲸鱼监控',simple:'大户动向'},
  modal_sub:{pro:'子账户',simple:'分账户'},modal_dir:{pro:'方向',simple:'买涨还是买跌'},
  modal_lev:{pro:'杠杆',simple:'借钱倍数'},  modal_amt:{pro:'投入金额',simple:'花多少钱'},
  modal_fee:{pro:'手续费',simple:'交易费'},modal_slip:{pro:'预估滑点',simple:'价格偏差'},
  modal_conf_buy:{pro:'确认买入',simple:'确认买入'},modal_conf_sell:{pro:'确认做空',simple:'确认买跌'},
  term_arb:{pro:'套利',simple:'赚差价'},term_sub:{pro:'子账户',simple:'分账户'},
};
function t(k){return T[k]?T[k][mode]:k;}
function tl(msg){
  if(mode==='pro')return msg;
  return msg.replace(/保本出!/g,'回本了!').replace(/平仓50%/g,'卖掉一半')
    .replace(/阶梯止盈/g,'分批卖出').replace(/跟踪止损/g,'自动止损')
    .replace(/止损/g,'亏太多停了').replace(/置信/g,'把握')
    .replace(/套利/g,'赚差价').replace(/子账户/g,'分账户')
    .replace(/做多/g,'买涨').replace(/做空/g,'买跌')
    .replace(/平仓/g,'卖出').replace(/鲸鱼/g,'大户')
    .replace(/x杠杆/g,'倍').replace(/杠杆/g,'倍');
}
function tSig(s){
  if(mode==='pro')return s;
  return s.replace(/负费率/g,'负持仓费').replace(/正费率/g,'正持仓费')
    .replace(/极恐/g,'大家害怕').replace(/极贪/g,'大家疯狂')
    .replace(/鲸鱼转入/g,'大户转入').replace(/鲸鱼转出/g,'大户转出');
}
function tPrompt(p){
  if(!p||mode==='pro')return p;
  return p.replace('费率:','持仓费:').replace('F&G:','市场情绪:')
    .replace('决策:','决定:').replace('做多','买涨').replace('做空','买跌')
    .replace('负费率','负持仓费').replace('正费率','正持仓费');
}
function symId(s){
  if(!s)return '?';
  return typeof s==='string'?s:(s.id||s.sym||'?');
}
function toggleMode(){
  mode=mode==='pro'?'simple':'pro';
  document.getElementById('modeToggleBtn').textContent=mode==='pro'?'切换大白话版':'切换专业版';
  updateTexts();render();refreshTerminal();
  saveState(true);
}
function updateTexts(){
  const el=id=>document.getElementById(id);
  el('modeToggleBtn').textContent=mode==='pro'?'切换大白话版':'切换专业版';
  el('nav_fusion').textContent=t('nav_fusion');el('nav_arb').textContent=t('nav_arb');
  el('nav_subs').textContent=t('nav_subs');el('nav_ledger').textContent=t('nav_ledger');el('totalLabel').textContent=t('total');el('side_coins').textContent=t('side_coins');el('side_subs_label').textContent=t('side_subs');
  el('side_risk').textContent=t('side_risk');el('side_pnl').textContent=t('side_pnl');
  el('side_active').textContent=t('side_active');el('side_winrate').textContent=t('side_winrate');
  el('side_arb').textContent=t('side_arb');el('pos_section_label').textContent=t('pos_section');
  el('fusion_title_label').textContent=t('fusion_title');el('ai_engine_label').textContent=t('ai_engine');
  el('ai_evo_label').textContent=t('ai_evo');el('ai_prompt_label').textContent=t('ai_prompt');
  el('arb_title_label').textContent=t('arb_title');el('subs_title_label').textContent=t('subs_title');
  el('set_trade_h').textContent=t('set_trade');el('set_maxlev_l').textContent=t('set_maxlev');
  el('set_maxorder_l').textContent=t('set_maxorder');el('set_maxloss_l').textContent=t('set_maxloss');
  el('set_aiset_h').textContent=t('set_aiset');el('set_aiauto_l').textContent=t('set_aiauto');
  el('set_aiconf_l').textContent=t('set_aiconf');el('set_aimax_l').textContent=t('set_aimax');
  el('set_arbset_h').textContent=t('set_arbset');el('set_arbon_l').textContent=t('set_arbon');
  el('set_minspread_l').textContent=t('set_minspread');el('set_boths_l').textContent=t('set_boths');
  el('set_minprofit_l').textContent=t('set_minprofit');el('set_slip_l').textContent=t('set_slip');
  el('set_fusion_h').textContent=t('set_fusion');el('set_fr_l').textContent=t('set_fr');
  el('set_oi_l').textContent=t('set_oi');el('set_fg_l').textContent=t('set_fg');
  el('set_whale_l').textContent=t('set_whale');el('modal_sub_label').textContent=t('modal_sub');
  el('modal_dir_label').textContent=t('modal_dir');el('modal_lev_label').textContent=t('modal_lev');
  el('modal_amt_label').textContent=t('modal_amt');el('modal_fee_label').textContent=t('modal_fee');el('modal_slip_label').textContent=t('modal_slip');el('modal_opt_long').textContent=t('pos_dolong');
  el('modal_opt_short').textContent=t('pos_doshort');el('term_arb').textContent=t('term_arb');
  el('term_sub').textContent=t('term_sub');
}
function refreshTerminal(){
  const b=document.getElementById('terminalBody');b.innerHTML='';
  S.logs.filter(l=>S.lf==='all'||l.tag===S.lf).forEach(l=>{
    b.innerHTML+='<div class="log-entry"><span class="log-time">'+l.t+'</span><span class="log-tag '+l.tag+'">['+l.tag.toUpperCase()+']</span><span class="log-msg">'+tl(l.msg)+'</span></div>';});
  b.scrollTop=b.scrollHeight;
}
const RP={conservative:{size:50,count:20,maxLev:5,bp:5,tp:12,label:'保守',aiLev:{hi:5,mid:4,lo:3},minConf:75,aiMax:10,maxOrder:50,maxDailyLoss:300},standard:{size:100,count:20,maxLev:20,bp:8,tp:8,label:'标准',aiLev:{hi:15,mid:10,lo:5},minConf:65,aiMax:20,maxOrder:100,maxDailyLoss:500},aggressive:{size:100,count:20,maxLev:50,bp:10,tp:12,label:'激进',aiLev:{hi:30,mid:20,lo:10},minConf:55,aiMax:40,maxOrder:200,maxDailyLoss:1000}};
let rp='conservative',P=RP[rp];
const DEFAULT_SYMS=[
  {id:'BTCUSDT',name:'Bitcoin',icon:'₿',base:78000,vol:.015},
  {id:'ETHUSDT',name:'Ethereum',icon:'Ξ',base:2500,vol:.02},
  {id:'SOLUSDT',name:'Solana',icon:'S',base:95,vol:.03},
  {id:'BNBUSDT',name:'BNB',icon:'B',base:700,vol:.015},
  {id:'XRPUSDT',name:'XRP',icon:'X',base:1.5,vol:.025},
  {id:'DOGEUSDT',name:'Dogecoin',icon:'D',base:.095,vol:.035},
  {id:'ADAUSDT',name:'Cardano',icon:'A',base:.25,vol:.028},
  {id:'AVAXUSDT',name:'Avalanche',icon:'A',base:8,vol:.032}
];
function loadSymbols(){
  try{
    const raw=typeof localStorage!=='undefined'?localStorage.getItem('smartTrader_syms'):null;
    if(raw){
      const arr=JSON.parse(raw);
      if(Array.isArray(arr)&&arr.length&&arr.every(x=>x&&typeof x.id==='string'))
        return arr.map(s=>({id:String(s.id).toUpperCase(),name:s.name||String(s.id).replace('USDT',''),icon:s.icon||String(s.id).charAt(0),base:Number(s.base)>0?Number(s.base):1,vol:Number(s.vol)>0?Number(s.vol):0.03}));
    }
  }catch(e){}
  return DEFAULT_SYMS.map(s=>({...s}));
}
function saveSymbols(){
  try{if(typeof localStorage!=='undefined')localStorage.setItem('smartTrader_syms',JSON.stringify(SYMS.map(s=>({id:s.id,name:s.name,icon:s.icon,base:s.base,vol:s.vol}))));}catch(e){}
}
let SYMS=loadSymbols();
const __btCache={};
let S={prices:{},okx:{},okxT:{},spark:{},sparkVol:{},history:{},hist1m:{},histT:{},indicators:{},klines:{},klinesT:{},klinesO:{},klinesH:{},klinesL:{},klinesV:{},pos:[],subs:[],dPnl:0,total:1000,sel:'BTCUSDT',logs:[],lf:'all',mark:{},markPrice:{},sim:{spotUsdt:5000,perpUsdt:5000,coin:{}},kchartTradeOn:true,kchartTradeLinked:true,kchartTsevOn:true,
  fusion:{fr:{},oi:{},frB:{},frO:{},oiB:{},oiO:{},fg:50,fgLabel:'中性',fgHis:[],frHis:{},oiHis:{},whales:[],whaleMin:150000,lastFR:0,lastOI:0,lastFG:0,lsG:{},lsT:{},tk:{},lastLS:0,qVol:{},multiTF:{},lastTF:0,lastMark:0,onChain:{},lastOnChain:0,news:{},lastNews:0},
  ai:{dec:[],tt:0,w:0,l:0,prompt:'',sigScore:{},sigLog:[],fullAnalysis:null,faOpen:false,lastExecT:0,lastEnter:{},lastSide:null,dirStat:{long:{w:0,l:0},short:{w:0,l:0}},llm:null,llmStats:{dayDate:null,calls:0,tokens:0},llmErr:null,llmRefreshing:false,winTrades:[],loseTrades:[],lastCtx:null,tradeLibTab:'win',llmHistory:[],lastScores:{},mgmtDayDate:null,mgmtCount:0,atrSuper:{},atrHis:{},prior:{}},
  arb:{opp:[],cnt:0,profit:0},realized:0,initCap:1000,closed:[],active:new Set(SYMS.map(s=>s.id))};

let _saveT=0;
function saveState(force){
  // 节流: 渲染循环每800ms调用, 但只每5s真正写盘(force 用于关键变更时立即保存)
  const now=Date.now();
  if(!force&&now-_saveT<5000)return;
  _saveT=now;
  try{localStorage.setItem('smartTrader',JSON.stringify({
    ver:STATE_VER,rp:rp,mode:mode,
    subs:S.subs.map(s=>({id:s.id,bal:Math.round(s.bal*100)/100,st:s.st,pnl:Math.round(s.pnl*100)/100,ex:s.ex,tr:s.tr,w:s.w||0,type:s.type||'',sim:!!s.sim,coins:s.coins?s.coins:{}})),
    pos:S.pos.map(p=>({sym:p.sym,sid:p.sid,side:p.side,lev:p.lev,qty:p.qty,entry:p.entry,be:p.be,tl:p.tl,hi:p.hi||p.entry,lo:p.lo||p.entry,amt:p.amt||0,openTime:p.openTime||0,marginMode:p.marginMode||'usdt',reinvest:!!p.reinvest,pnl:Math.round((p.pnl||0)*10000)/10000,pnlHis:(p.pnlHis&&p.pnlHis.length?p.pnlHis.slice(-200):null)})),
    ai:{tt:S.ai.tt,w:S.ai.w,l:S.ai.l,lastExecT:S.ai.lastExecT||0,lastEnter:S.ai.lastEnter||null,dayDate:S.ai.dayDate||null,dayCount:S.ai.dayCount||0,dayStartEquity:S.ai.dayStartEquity||0,dirStat:S.ai.dirStat||{long:{w:0,l:0},short:{w:0,l:0}},sigScore:S.ai.sigScore,sigLog:S.ai.sigLog,llm:S.ai.llm||null,llmStats:S.ai.llmStats||{dayDate:null,calls:0,tokens:0},winTrades:S.ai.winTrades||[],loseTrades:S.ai.loseTrades||[],llmHistory:S.ai.llmHistory||[],mgmtDayDate:S.ai.mgmtDayDate||null,mgmtCount:S.ai.mgmtCount||0},arb:{cnt:S.arb.cnt,profit:S.arb.profit},logs:S.logs.slice(-500),realized:Math.round(S.realized*100)/100,initCap:S.initCap||1000,closed:S.closed,
    settings:{
      maxLev:document.getElementById('setMaxLev')?.value||'20x',
      maxOrder:document.getElementById('setMaxOrder')?.value||'100',
      maxDailyLoss:document.getElementById('setMaxDailyLoss')?.value||'500',
      aiAuto:document.getElementById('setAiAuto')?.value||'0',
      minConf:document.getElementById('setMinConf')?.value||'70',
      aiMax:document.getElementById('setAiMax')?.value||'20',
      tradeMode:document.getElementById('setTradeMode')?.value||'standard',
      arbOn:document.getElementById('setArbOn')?.value||'0',
      minSpread:document.getElementById('setMinSpread')?.value||'0.05',
      bothSide:document.getElementById('setBothSide')?.value||'1',
      fFR:document.getElementById('setFusionFR')?.value||'1',
      fOI:document.getElementById('setFusionOI')?.value||'1',
      fFG:document.getElementById('setFusionFG')?.value||'1',
      fWhale:document.getElementById('setFusionWhale')?.value||'1',
      fLS:document.getElementById('setFusionLS')?.value||'1',
      llmOn:document.getElementById('setLLMOn')?.value||'0',
      llmRole:document.getElementById('setLLMRole')?.value||'signal',
      llmProvider:document.getElementById('setLLMProvider')?.value||'deepseek',
      llmModel:document.getElementById('setLLMModel')?.value||'deepseek-chat',
      llmUrl:document.getElementById('setLLMUrl')?.value||'',
      llmFreq:document.getElementById('setLLMFreq')?.value||'5m',
      llmBudgetMode:document.getElementById('setLLMBudgetMode')?.value||'calls',
      llmBudget:document.getElementById('setLLMBudget')?.value||'50',
      llmWeight:document.getElementById('setLLMWeight')?.value||'15',
      llmMinConf:document.getElementById('setLLMMinConf')?.value||'60',
      llmHistPrompt:document.getElementById('setLLMHistPrompt')?.value||'8',
      llmHistKeep:document.getElementById('setLLMHistKeep')?.value||'100',
      llmHistDays:document.getElementById('setLLMHistDays')?.value||'7',
      aiMgmtOn:document.getElementById('setAiMgmtOn')?.value||'1',
      aiMgmtConf:document.getElementById('setAiMgmtConf')?.value||'60',
      aiMgmtHoldMin:document.getElementById('setAiMgmtHoldMin')?.value||'10',
      aiMgmtDaily:document.getElementById('setAiMgmtDaily')?.value||'5',
      kchartTradeOn:document.getElementById('setKchartTradeOn')?.value||'1',
      kchartTradeLinked:document.getElementById('setKchartLink')?.value||'1',
      kchartTsevOn:document.getElementById('setKchartTsevOn')?.value||'1',
      sim:S.sim||{spotUsdt:5000,perpUsdt:5000,coin:{}},
      signalSource:techConfig.signalSource,
      signalMinVotes:techConfig.signalMinVotes,
      signalConfirm:techConfig.signalConfirm,
      srsiEnable:techConfig.srsiEnable,
      srsiRsiPeriod:techConfig.srsiRsiPeriod,
      srsiStochPeriod:techConfig.srsiStochPeriod,
      srsiSmoothK:techConfig.srsiSmoothK,
      srsiSmoothD:techConfig.srsiSmoothD,
      srsiOverbought:techConfig.srsiOverbought,
      srsiOversold:techConfig.srsiOversold
    }
  }));}catch(e){}
}
const STATE_VER='v0.11';
function loadState(){
  try{const raw=localStorage.getItem('smartTrader');if(!raw)return false;
    const d=JSON.parse(raw);
    if(d.ver!==STATE_VER){localStorage.removeItem('smartTrader');return false;}
    if(d.rp&&RP[d.rp]){rp=d.rp;Object.assign(P,RP[d.rp]);}
    if(d.mode)mode=d.mode;
    if(d.subs&&d.subs.length)S.subs=d.subs;
    if(d.pos)S.pos=d.pos.map(p=>({...p,pnl:p.pnl||0,pnlPct:p.pnlPct||0,hi:p.hi||p.entry,lo:p.lo||p.entry,amt:p.amt||0,openTime:p.openTime||0,pnlHis:p.pnlHis||[0]}));
    if(d.logs)S.logs=d.logs;
    if(typeof d.realized==='number')S.realized=d.realized;
    if(d.closed)S.closed=d.closed||[];
    // 迁移：旧版本自动开仓未写 src 字段 → 补齐为 'srsiAuto'（仅缺失项；新开仓的显式 src 不受此影响）
    S.pos.forEach(p=>{ if(p&&!p.src)p.src='srsiAuto'; });
    S.closed.forEach(c=>{ if(c&&!c.src)c.src='srsiAuto'; });
    if(d.initCap)S.initCap=d.initCap;
    if(d.ai){S.ai.tt=d.ai.tt||0;S.ai.w=d.ai.w||0;S.ai.l=d.ai.l||0;S.ai.lastExecT=d.ai.lastExecT||0;S.ai.lastEnter=d.ai.lastEnter||null;S.ai.dayDate=d.ai.dayDate||null;S.ai.dayCount=d.ai.dayCount||0;S.ai.dayStartEquity=d.ai.dayStartEquity||0;S.ai.dirStat=d.ai.dirStat||{long:{w:0,l:0},short:{w:0,l:0}};S.ai.sigScore=d.ai.sigScore||{};S.ai.sigLog=d.ai.sigLog||[];S.ai.llm=d.ai.llm||null;S.ai.llmStats=d.ai.llmStats||{dayDate:null,calls:0,tokens:0};S.ai.winTrades=d.ai.winTrades||[];S.ai.loseTrades=d.ai.loseTrades||[];S.ai.llmHistory=d.ai.llmHistory||[];S.ai.mgmtDayDate=d.ai.mgmtDayDate||null;S.ai.mgmtCount=d.ai.mgmtCount||0;}
    if(d.ai&&d.ai.sigScore&&!(S.ai.cleaned==='v1.6'))sanitizeSigScore();
    if(d.arb){S.arb.cnt=d.arb.cnt||0;S.arb.profit=d.arb.profit||0;}
    if(d.settings){
      const s=d.settings;
      if(s.maxLev){const el=document.getElementById('setMaxLev');if(el)el.value=s.maxLev;}
      if(s.maxOrder){const el=document.getElementById('setMaxOrder');if(el)el.value=s.maxOrder;}
      if(s.maxDailyLoss){const el=document.getElementById('setMaxDailyLoss');if(el)el.value=s.maxDailyLoss;}
      if(s.aiAuto){const el=document.getElementById('setAiAuto');if(el)el.value=s.aiAuto;}
      if(s.minConf){const el=document.getElementById('setMinConf');if(el)el.value=s.minConf;}
      if(s.aiMax){const el=document.getElementById('setAiMax');if(el)el.value=s.aiMax;}
      if(s.tradeMode){const el=document.getElementById('setTradeMode');if(el)el.value=s.tradeMode;}
      if(s.arbOn){const el=document.getElementById('setArbOn');if(el)el.value=s.arbOn;}
      if(s.minSpread){const el=document.getElementById('setMinSpread');if(el)el.value=s.minSpread;}
      if(s.bothSide){const el=document.getElementById('setBothSide');if(el)el.value=s.bothSide;}
      if(s.fFR){const el=document.getElementById('setFusionFR');if(el)el.value=s.fFR;}
      if(s.fOI){const el=document.getElementById('setFusionOI');if(el)el.value=s.fOI;}
      if(s.fFG){const el=document.getElementById('setFusionFG');if(el)el.value=s.fFG;}
      if(s.fWhale){const el=document.getElementById('setFusionWhale');if(el)el.value=s.fWhale;}
      if(s.fLS){const el=document.getElementById('setFusionLS');if(el)el.value=s.fLS;}
      if(s.llmOn){const el=document.getElementById('setLLMOn');if(el)el.value=s.llmOn;}
      if(s.llmRole){const el=document.getElementById('setLLMRole');if(el)el.value=s.llmRole;}
      if(s.llmProvider){const el=document.getElementById('setLLMProvider');if(el)el.value=s.llmProvider;}
      if(s.llmModel){const el=document.getElementById('setLLMModel');if(el)el.value=s.llmModel;}
      if(s.llmUrl){const el=document.getElementById('setLLMUrl');if(el)el.value=s.llmUrl;}
      if(s.llmFreq){const el=document.getElementById('setLLMFreq');if(el)el.value=s.llmFreq;}
      if(s.llmBudgetMode){const el=document.getElementById('setLLMBudgetMode');if(el)el.value=s.llmBudgetMode;}
      if(s.llmBudget){const el=document.getElementById('setLLMBudget');if(el)el.value=s.llmBudget;}
      if(s.llmWeight){const el=document.getElementById('setLLMWeight');if(el)el.value=s.llmWeight;}
      if(s.llmMinConf){const el=document.getElementById('setLLMMinConf');if(el)el.value=s.llmMinConf;}
      if(s.llmHistPrompt){const el=document.getElementById('setLLMHistPrompt');if(el)el.value=s.llmHistPrompt;}
      if(s.llmHistKeep){const el=document.getElementById('setLLMHistKeep');if(el)el.value=s.llmHistKeep;}
      if(s.llmHistDays){const el=document.getElementById('setLLMHistDays');if(el)el.value=s.llmHistDays;}
      if(s.aiMgmtOn){const el=document.getElementById('setAiMgmtOn');if(el)el.value=s.aiMgmtOn;}
      if(s.aiMgmtConf){const el=document.getElementById('setAiMgmtConf');if(el)el.value=s.aiMgmtConf;}
      if(s.aiMgmtHoldMin){const el=document.getElementById('setAiMgmtHoldMin');if(el)el.value=s.aiMgmtHoldMin;}
      if(s.aiMgmtDaily){const el=document.getElementById('setAiMgmtDaily');if(el)el.value=s.aiMgmtDaily;}
      if(s.kchartTradeOn!=null){const el=document.getElementById('setKchartTradeOn');if(el)el.value=s.kchartTradeOn;S.kchartTradeOn=s.kchartTradeOn==='1';}
      if(s.kchartTradeLinked!=null){const el=document.getElementById('setKchartLink');if(el)el.value=s.kchartTradeLinked;S.kchartTradeLinked=s.kchartTradeLinked==='1';}
      if(s.kchartTsevOn!=null){const el=document.getElementById('setKchartTsevOn');if(el)el.value=s.kchartTsevOn;S.kchartTsevOn=s.kchartTsevOn==='1';}
      if(s.sim){
        const rawCoin=s.sim.coin||{};const coin={};
        SYMS.forEach(sy=>{const k=sy.id||sy;if(rawCoin[k]!=null)coin[k]=rawCoin[k];});
        S.sim={spotUsdt:s.sim.spotUsdt!=null?s.sim.spotUsdt:5000,perpUsdt:s.sim.perpUsdt!=null?s.sim.perpUsdt:5000,coin};
        const e1=document.getElementById('simSpotUsdt');if(e1)e1.value=S.sim.spotUsdt;
        const e2=document.getElementById('simPerpUsdt');if(e2)e2.value=S.sim.perpUsdt;renderSimCoinList();
      }
      if(s.signalSource)techConfig.signalSource=s.signalSource;
      if(s.signalMinVotes!=null)techConfig.signalMinVotes=Math.max(1,Math.min(5,parseInt(s.signalMinVotes)||3));
      if(s.signalConfirm!=null)techConfig.signalConfirm=Math.max(0,Math.min(3,parseInt(s.signalConfirm)||0));
      if(s.srsiEnable!=null)techConfig.srsiEnable=s.srsiEnable?1:0;
      if(s.srsiRsiPeriod!=null)techConfig.srsiRsiPeriod=Math.max(2,Math.min(200,parseInt(s.srsiRsiPeriod)||85));
      if(s.srsiStochPeriod!=null)techConfig.srsiStochPeriod=Math.max(2,Math.min(100,parseInt(s.srsiStochPeriod)||50));
      if(s.srsiSmoothK!=null)techConfig.srsiSmoothK=Math.max(1,Math.min(30,parseInt(s.srsiSmoothK)||10));
      if(s.srsiSmoothD!=null)techConfig.srsiSmoothD=Math.max(1,Math.min(30,parseInt(s.srsiSmoothD)||5));
      if(s.srsiOverbought!=null)techConfig.srsiOverbought=Math.max(50,Math.min(99,parseInt(s.srsiOverbought)||80));
      if(s.srsiOversold!=null)techConfig.srsiOversold=Math.max(1,Math.min(50,parseInt(s.srsiOversold)||20));
    }
    return true;
  }catch(e){return false;}
}

// ===================== 模拟真实交易 / K线快捷交易 设置 =====================
function renderSimCoinList(){
  const box=document.getElementById('simCoinList');
  if(!box)return;
  box.innerHTML='';
  if(!S.sim)S.sim={spotUsdt:5000,perpUsdt:5000,coin:{}};
  SYMS.forEach(sym=>{
    const id=sym.id||sym;
    const wrap=document.createElement('div');wrap.className='sim-coin-row';
    const lab=document.createElement('label');lab.textContent=id;lab.style.flex='0 0 96px';
    const inp=document.createElement('input');inp.type='number';inp.min='0';inp.step='any';inp.value=(S.sim.coin[id]!=null?S.sim.coin[id]:0);inp.dataset.sym=id;
    inp.addEventListener('input',()=>{S.sim.coin[id]=parseFloat(inp.value)||0;saveState(true);if(window.paperEngine)window.paperEngine.updateSim(S.sim);if(window.__isolatedPE)window.__isolatedPE.updateSim(S.sim);});
    wrap.appendChild(lab);wrap.appendChild(inp);
    box.appendChild(wrap);
  });
}
function onSimChange(){
  if(!S.sim)S.sim={spotUsdt:5000,perpUsdt:5000,coin:{}};
  const e1=document.getElementById('simSpotUsdt');if(e1)S.sim.spotUsdt=parseFloat(e1.value)||0;
  const e2=document.getElementById('simPerpUsdt');if(e2)S.sim.perpUsdt=parseFloat(e2.value)||0;
  saveState(true);
  if(window.paperEngine)window.paperEngine.updateSim(S.sim);
  if(window.__isolatedPE)window.__isolatedPE.updateSim(S.sim);
  if(window.refreshKchartTradeEngine)window.refreshKchartTradeEngine();
}
function onSimReset(){
  S.sim={spotUsdt:5000,perpUsdt:5000,coin:{}};
  if(window.paperEngine)window.paperEngine.resetSim(S.sim);
  if(window.__isolatedPE)window.__isolatedPE.resetSim(S.sim);
  if(window.refreshKchartTradeEngine)window.refreshKchartTradeEngine();
  saveState(true);
  if(window.log)window.log('sys','模拟真实交易账户已重置为默认初始资金');
}
function onKchartTradeOnChange(){
  const v=document.getElementById('setKchartTradeOn')?.value==='1';
  S.kchartTradeOn=v;saveState(true);
  if(window.kchartApi)window.kchartApi.setTradeConfig({on:v});
}
function onKchartLinkChange(){
  const v=document.getElementById('setKchartLink')?.value==='1';
  S.kchartTradeLinked=v;saveState(true);
  if(window.refreshKchartTradeEngine)window.refreshKchartTradeEngine();
}
function onKchartTsevOnChange(){
  const v=document.getElementById('setKchartTsevOn')?.value==='1';
  S.kchartTsevOn=v;saveState(true);
  if(window.setTsevEnabled)window.setTsevEnabled(v);
  if(window.setKLocalLoop)window.setKLocalLoop(v);
  if(v && window.refreshLocalTsev)window.refreshLocalTsev().catch(()=>{});
  if(window.__renderKChart)window.__renderKChart();
}

const _renderCache={};
function memoizeRender(section,sig,fn){
  if(_renderCache[section]===sig)return false;
  _renderCache[section]=sig;fn();return true;
}
function sigOfPrices(){
  // 用 2 位小数 + chg 1 位小数做 memo 键, 避免整数截断(p.last|0)在整美元附近反复触发全网格重建
  let s='';SYMS.forEach(x=>{const p=S.prices[x.id];s+=x.id+(p?(p.last.toFixed(2))+','+(p.chg.toFixed(1)):'' )+';'});return s;
}

let wsBin=null,wsOKX=null,wsBinReconnect=0,wsOKXReconnect=0,dataReady=0;
let okxRestFailCount=0,lastOkxRestLog=0,lastBinRestLog=0,lastAiLog='',lastAiLogT=0;

const CORS_PROXY='';
const BINANCE_API='https://api.binance.com';
const OKX_API='https://www.okx.com';
const FEE=0.0004,SLIP=0.0002;
const FETCH_TIMEOUT=5000;
const COINGECKO_API='https://api.coingecko.com/api/v3';
const CG_MAP={btc:'bitcoin',eth:'ethereum',sol:'solana',bnb:'binancecoin',xrp:'ripple',doge:'dogecoin',ada:'cardano',avax:'avalanche-2'};
function cgId(s){const n=String(s.id||'').replace('USDT','').toLowerCase();return CG_MAP[n]||n;}

async function fetchT(url,opts){
  const ac=new AbortController();const tid=setTimeout(()=>ac.abort(),FETCH_TIMEOUT);
  try{const r=await fetch(url,{...opts,signal:ac.signal});clearTimeout(tid);return r;}
  catch(e){clearTimeout(tid);throw e;}
}

async function fetchBinancePrices(){
  try{
    const resp=await fetch(CORS_PROXY+BINANCE_API+'/api/v3/ticker/24hr');
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const data=await resp.json();
    let count=0;
    // REST 只做兜底: WS 实时流在持续推送时(REST 快照到达时 <8s 前刚更新过), 不覆盖实时价, 防止跳变
    const wsFresh=wsBin&&wsBin.readyState===1;
    data.forEach(t=>{
      if(S.prices[t.symbol]){
        const p=S.prices[t.symbol];
        const isWSFresh=wsFresh&&p.lastT&&(Date.now()-p.lastT)<8000;
        if(!isWSFresh){
          p.last=parseFloat(t.lastPrice);
          p.lastT=Date.now();
          p.chg=parseFloat(t.priceChangePercent);
          p.high=parseFloat(t.highPrice);
          p.low=parseFloat(t.lowPrice);
          p.open=parseFloat(t.openPrice);
          p.vol=parseFloat(t.volume);
          p.qVol=parseFloat(t.quoteVolume||0);
          S.spark[t.symbol].push(p.last);
          if(!S.sparkVol[t.symbol])S.sparkVol[t.symbol]=[];
          S.sparkVol[t.symbol].push(p.vol);
          if(S.sparkVol[t.symbol].length>40)S.sparkVol[t.symbol].shift();
          if(S.spark[t.symbol].length>40)S.spark[t.symbol].shift();
        }else{
          // WS 实时中, 只补齐 vol(REST 才有的字段), 不碰 last 避免跳变
          p.vol=parseFloat(t.volume);
          p.qVol=parseFloat(t.quoteVolume||0);
        }
        count++;
      }
    });
    if(count>0){
      dataReady|=1;
      const nowL=Date.now();
      if(nowL-lastBinRestLog>30000){
        lastBinRestLog=nowL;
        log('sys','Binance REST: 获取'+count+'个币种实时价格'+(wsFresh?'(兜底)':''));
      }
    }
    return true;
  }catch(e){
    log('sys','Binance REST 失败: '+e.message);
    return false;
  }
}

async function fetchOKXPrices(){
  try{
    const resp=await fetch(CORS_PROXY+OKX_API+'/api/v5/market/tickers?instType=SPOT');
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const data=await resp.json();
    const wsFresh=wsOKX&&wsOKX.readyState===1;
    if(data.data){
      data.data.forEach(t=>{
        const instId=t.instId||'';
        // OKX instId 为 BTC-USDT, 需映射回我们的键 BTCUSDT(不能直接去USDT后缀)
        const sym=instId.replace('-USDT','')+'USDT';
        if(S.okx[sym]){
          // WS 实时中且 <8s 前更新过则跳过, 防止 REST 旧快照覆盖实时价
          const isWSFresh=wsFresh&&S.okxT[sym]&&(Date.now()-S.okxT[sym])<8000;
          if(!isWSFresh){
            S.okx[sym]=parseFloat(t.last);
            S.okxT[sym]=Date.now();
          }
        }
      });
      dataReady|=2;
      okxRestFailCount=0;
      const nowL=Date.now();
      if(nowL-lastOkxRestLog>30000){
        lastOkxRestLog=nowL;
        log('sys','OKX REST: 获取'+data.data.length+'个币种价格'+(wsFresh?'(兜底)':''));
      }
    }
    return true;
  }catch(e){
    okxRestFailCount++;
    // 失败日志节流: 连续失败才提示, 避免刷屏
    if(okxRestFailCount===1||okxRestFailCount%5===0)log('sys','OKX REST 失败: '+e.message+' (连续'+okxRestFailCount+'次)');
    return false;
  }
}

// 启动时回填 1m K线历史，让大周期指标立即可用
async function backfillKlines(){
  try{
    const syms=SYMS.filter(s=>S.active.has(s.id));
    const results=await Promise.allSettled(syms.map(async s=>{
      if(S.hist1m[s.id]&&S.hist1m[s.id].length>=120)return;
      const resp=await fetch(CORS_PROXY+BINANCE_API+'/api/v3/klines?symbol='+s.id+'&interval=1m&limit=150');
      if(!resp.ok)throw new Error('HTTP '+resp.status);
      const k=await resp.json();
      if(!Array.isArray(k)||!k.length)return;
      const arr=k.map(c=>({t:c[0],p:parseFloat(c[4])}));
      S.hist1m[s.id]=arr.slice(-150);
    }));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    log('sys','K线回填: '+ok+'个币种 1m 历史'+(S.hist1m['BTCUSDT']&&S.hist1m['BTCUSDT'].length?(' ('+S.hist1m['BTCUSDT'].length+' 根/币)'):''));
  }catch(e){
    log('sys','K线回填失败: '+e.message);
  }
}

// 拉取技术分析用 K线级周期 (5m/15m/1h/4h/1d) 收盘价序列, 存 S.klines[sym][tf]
// 与数据融合页 fetchMultiTF 同源 Binance klines REST; 仅取收盘价供技术指标计算
function parseKlines(arr){
  return {
    o: arr.map(c=>parseFloat(c[1])),
    h: arr.map(c=>parseFloat(c[2])),
    l: arr.map(c=>parseFloat(c[3])),
    c: arr.map(c=>parseFloat(c[4])),
    v: arr.map(c=>parseFloat(c[5])),
    t: arr.map(c=>parseInt(c[0],10)||0)
  };
}

async function refreshTechKlines(){
  try{
    const syms=SYMS.filter(s=>S.active.has(s.id));
    const tfs=KLINE_TF;
    const results=await Promise.allSettled(syms.map(async s=>{
      if(!S.klines[s.id])S.klines[s.id]={};
      const rs=await Promise.allSettled(tfs.map(tf=>{
        const interval=KLINE_INTERVAL[tf]||tf;
        return fetchT(CORS_PROXY+BINANCE_API+'/api/v3/klines?symbol='+s.id+'&interval='+interval+'&limit='+(THRESH.KLINE_LIMIT||150)).then(r=>r.json());
      }));
      rs.forEach((r,i)=>{
        const tf=tfs[i];
        if(r.status==='fulfilled'&&Array.isArray(r.value)&&r.value.length>0){
          let opens=r.value.map(c=>parseFloat(c[1]));
          let highs=r.value.map(c=>parseFloat(c[2]));
          let lows=r.value.map(c=>parseFloat(c[3]));
          let closes=r.value.map(c=>parseFloat(c[4]));
          let vols=r.value.map(c=>parseFloat(c[5]));   // 成交量(BTC 数量)
          let times=r.value.map(c=>parseInt(c[0],10)||0);
          // 非标准周期（如 10m）由源周期（5m）klines 每 step 根聚合 1 根
          const ds=KLINE_DOWNSAMPLE[tf];
          if(ds){
            const step=ds.step;
            const agg=downsampleOHLC(opens,highs,lows,closes,step);
            opens=agg.opens;highs=agg.highs;lows=agg.lows;closes=agg.closes;
            vols=sumVol(vols,step);                      // 成交量按同款右对齐分组求和
            times=times.slice(-closes.length);
          }
          S.klines[s.id][tf]=closes;
          if(!S.klinesO[s.id])S.klinesO[s.id]={};
          if(!S.klinesH[s.id])S.klinesH[s.id]={};
          if(!S.klinesL[s.id])S.klinesL[s.id]={};
          if(!S.klinesV[s.id])S.klinesV[s.id]={};
          S.klinesO[s.id][tf]=opens;
          S.klinesH[s.id][tf]=highs;
          S.klinesL[s.id][tf]=lows;
          S.klinesV[s.id][tf]=vols;
          if(!S.klinesT[s.id])S.klinesT[s.id]={};
          S.klinesT[s.id][tf]=times;
        }
      });
      // 主图原生周/月线（7d→1w, 30d→1M）：根数充足且对齐交易所，避免日线聚合后根数过少（500日线→仅71周/16月）。
      // SRSI 速览/纪律分析仍用原始日线 klines['7d']/['30d']（各自 resample），不受影响。
      try {
        const wk = await fetchT(CORS_PROXY+BINANCE_API+'/api/v3/klines?symbol='+s.id+'&interval=1w&limit='+(THRESH.KLINE_LIMIT||150)).then(r=>r.json());
        if (Array.isArray(wk) && wk.length) { if (!S.klinesWeek) S.klinesWeek = {}; S.klinesWeek[s.id] = parseKlines(wk); }
      } catch (e) {}
      try {
        const mo = await fetchT(CORS_PROXY+BINANCE_API+'/api/v3/klines?symbol='+s.id+'&interval=1M&limit='+(THRESH.KLINE_LIMIT||150)).then(r=>r.json());
        if (Array.isArray(mo) && mo.length) { if (!S.klinesMonth) S.klinesMonth = {}; S.klinesMonth[s.id] = parseKlines(mo); }
      } catch (e) {}
    }));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    if(window.updateIndicators)window.updateIndicators();
    log('sys','技术分析 K线级周期回填: '+ok+'个币种 ('+tfs.join('/')+')');
  }catch(e){
    log('sys','技术分析 K线级周期获取失败: '+e.message);
  }
}

// === 真实API数据源 ===
const FUSION_API_INTERVAL=60000;

async function fetchCoinGeckoPrices(){
  try{
    const ids=SYMS.map(cgId).join(',');
    const resp=await fetchT(COINGECKO_API+'/simple/price?ids='+ids+'&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true');
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const data=await resp.json();
    let count=0;
    SYMS.forEach(s=>{
      const d=data[cgId(s)];
      if(d&&d.usd){
        S.prices[s.id].last=d.usd;
        S.prices[s.id].lastT=Date.now();
        S.prices[s.id].chg=d.usd_24h_change||0;
        S.prices[s.id].vol=d.usd_24h_vol||0;
        S.okx[s.id]=d.usd;
        S.okxT[s.id]=Date.now();
        S.spark[s.id]=Array(40).fill(d.usd);
        S.sparkVol[s.id]=Array(40).fill(0);
        count++;
      }
    });
    if(count>0){
      dataReady|=4;
      log('sys','CoinGecko: 获取'+count+'个币种真实基础价格');
    }
    return true;
  }catch(e){
    log('sys','CoinGecko 失败(可能被墙): '+e.message);
    return false;
  }
}

async function fetchWhaleData(){
  // CoinLobster 无 CORS 头, 纯浏览器前端无法跨域读取 → 改为 Binance REST aggTrades 检测大单
  // 作为 WS aggTrade 流的启动兜底
  try{
    const results=await Promise.allSettled(SYMS.map(s=>
      fetchT(CORS_PROXY+'https://api.binance.com/api/v3/aggTrades?symbol='+s.id+'&limit=100').then(r=>r.json()).then(trades=>{
        if(!Array.isArray(trades))return;
        trades.forEach(t=>{
          const notional=parseFloat(t.p)*parseFloat(t.q);
          if(notional>=S.fusion.whaleMin){
            const sym=s.id;
            if(!S.fusion.whales.some(w=>w.sym===sym&&w.t===t.T)){
              S.fusion.whales.push({sym:sym,amt:Math.round(notional/1000),dir:t.m?'out':'in',price:parseFloat(t.p),exchange:'Binance',t:t.T});
              if(S.fusion.whales.length>10)S.fusion.whales.shift();
            }
          }
        });
      })
    ));
    dataReady|=8;
    return true;
  }catch(e){
    log('sys','鲸鱼数据获取失败: '+e.message);
    return false;
  }
}

async function fetchBinanceFundingRate(){
  try{
    const results=await Promise.allSettled(SYMS.map(s=>
      fetchT(CORS_PROXY+'https://fapi.binance.com/fapi/v1/premiumIndex?symbol='+s.id).then(r=>r.json()).then(d=>{
        if(d.lastFundingRate!==undefined){
          S.fusion.frB[s.id]=parseFloat(d.lastFundingRate);
        }
      })
    ));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    return ok>0;
  }catch(e){
    log('sys','Binance资金费率获取失败: '+e.message);
    return false;
  }
}

async function fetchBinanceOI(){
  try{
    const results=await Promise.allSettled(SYMS.map(s=>
      fetchT(CORS_PROXY+'https://fapi.binance.com/fapi/v1/openInterest?symbol='+s.id).then(r=>r.json()).then(d=>{
        if(d.openInterest!==undefined){
          const price=S.prices[s.id]?.last||1;
          S.fusion.oiB[s.id]=parseFloat(d.openInterest)*price;
        }
      })
    ));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    return ok>0;
  }catch(e){
    log('sys','Binance持仓量获取失败: '+e.message);
    return false;
  }
}

async function fetchOKXFundingRate(){
  try{
    // OKX API 不支持逗号分隔多 instId(返回51000)，需逐币请求
    const results=await Promise.allSettled(SYMS.map(s=>{
      const instId=s.id.replace('USDT','-USDT-SWAP');
      return fetchT(CORS_PROXY+'https://www.okx.com/api/v5/public/funding-rate?instId='+instId)
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
        .then(d=>{
          if(d.code==='0'&&d.data&&d.data[0]){
            const fd=d.data[0];
            const sym=fd.instId.replace('-USDT-SWAP','').replace('-SWAP','')+'USDT';
            if(fd.fundingRate!==undefined){
              S.fusion.frO[sym]=parseFloat(fd.fundingRate);
            }
          }
        });
    }));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    return ok>0;
  }catch(e){
    log('sys','OKX资金费率获取失败: '+e.message);
    return false;
  }
}

async function fetchOKXOI(){
  try{
    // OKX API 不支持逗号分隔多 instId，需逐币请求
    const results=await Promise.allSettled(SYMS.map(s=>{
      const instId=s.id.replace('USDT','-USDT-SWAP');
      return fetchT(CORS_PROXY+'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId='+instId)
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
        .then(d=>{
          if(d.code==='0'&&d.data&&d.data[0]){
            const fd=d.data[0];
            const sym=fd.instId.replace('-USDT-SWAP','').replace('-SWAP','')+'USDT';
            const v=parseFloat(fd.oiUsd||fd.oi||0);
            if(v>0){S.fusion.oiO[sym]=v;}
          }
        });
    }));
    const ok=results.filter(r=>r.status==='fulfilled').length;
    return ok>0;
  }catch(e){
    log('sys','OKX持仓量获取失败: '+e.message);
    return false;
  }
}

// ---- 标记价(mark price): 强平/资金费用标记价代替最新成交价(公开接口) ----
async function fetchMarkPrices(){
  try{
    if(!SYMS.length)return false;
    // Binance fapi premiumIndex: 公开, 无需鉴权
    const binResults=await Promise.allSettled(SYMS.map(s=>
      fetchT(CORS_PROXY+'https://fapi.binance.com/fapi/v1/premiumIndex?symbol='+s.id)
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
        .then(d=>{
          if(d&&d.symbol&&d.markPrice){
            S.mark[s.id]={mark:parseFloat(d.markPrice),index:parseFloat(d.indexPrice)||parseFloat(d.markPrice),from:'binance'};
          }
        })
    ));
    // OKX public mark-price: 公开, 无需鉴权
    const okxResults=await Promise.allSettled(SYMS.map(s=>{
      const instId=s.id.replace('USDT','-USDT-SWAP');
      return fetchT(CORS_PROXY+'https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId='+instId)
        .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();})
        .then(d=>{
          if(d.code==='0'&&d.data&&d.data[0]){
            const sym=d.data[0].instId.replace('-USDT-SWAP','').replace('-SWAP','')+'USDT';
            const m=parseFloat(d.data[0].markPx);
            if(m>0){
              const old=S.mark[sym]||{};
              S.mark[sym]={mark:m,index:old.index||m,okxM:m,both:!!old.mark,from:'okx'};
            }
          }
        });
    }));
    const ok=binResults.filter(r=>r.status==='fulfilled').length+okxResults.filter(r=>r.status==='fulfilled').length;
    if(ok>0){S.fusion.lastMark=Date.now();return true;}
    return false;
  }catch(e){
    log('sys','标记价获取失败: '+e.message);
    return false;
  }
}

// 标记价取数器: 优先 mark/index, 兜底用最新成交价
function getMarkPrice(sym){
  const m=S.mark&&S.mark[sym];
  if(m&&m.mark&&m.mark>0)return m.mark;
  const p=S.prices&&S.prices[sym];
  return p&&p.last||0;
}

// 多空账户比/顶级交易者比/Taker买卖比 (Binance futures/data, 公开接口, 仅拉当前选中币)
async function fetchBinanceLSData(){
  try{
    const sym=S.sel;
    if(!sym||!S.prices[sym])return false;
    const base='https://fapi.binance.com/futures/data/';
    const [g,t,tk]=await Promise.allSettled([
      fetchT(CORS_PROXY+base+'globalLongShortAccountRatio?symbol='+sym+'&period=5m').then(r=>r.json()),
      fetchT(CORS_PROXY+base+'topLongShortAccountRatio?symbol='+sym+'&period=5m').then(r=>r.json()),
      fetchT(CORS_PROXY+base+'takerlongshortRatio?symbol='+sym+'&period=5m').then(r=>r.json())
    ]);
    let ok=0;
    // Binance fapi futures/data 接口按时间升序返回([0]=最旧,[last]=最新), 必须取最后一根
    const lastEl=arr=>arr&&arr.length?arr[arr.length-1]:null;
    if(g.status==='fulfilled'&&Array.isArray(g.value)&&g.value.length){
      const v=lastEl(g.value);S.fusion.lsG[sym]=v;ok++;
    }
    if(t.status==='fulfilled'&&Array.isArray(t.value)&&t.value.length){
      const v=lastEl(t.value);S.fusion.lsT[sym]=v;ok++;
    }
    if(tk.status==='fulfilled'&&Array.isArray(tk.value)&&tk.value.length){
      const v=lastEl(tk.value);S.fusion.tk[sym]=v;ok++;
    }
    if(ok>0)S.fusion.lastLS=Date.now();
    return ok>0;
  }catch(e){
    log('sys','多空比数据获取失败: '+e.message);
    return false;
  }
}

// ---- 多周期涨跌 (数据融合第1卡: 5m~30d) ----
async function fetchMultiTF(){
  try{
    const sym=S.sel;
    if(!sym||!S.prices[sym])return false;
    const tfs=['5m','15m','30m','1h','4h','8h','1d'];
    const results=await Promise.allSettled(tfs.map(tf=>
      fetchT(CORS_PROXY+'https://api.binance.com/api/v3/klines?symbol='+sym+'&interval='+tf+'&limit='+(tf==='1d'?31:5)).then(r=>r.json())
    ));
    const klinesMap={};
    let ok=0;
    results.forEach((r,i)=>{ const tf=tfs[i]; if(r.status==='fulfilled'&&Array.isArray(r.value)&&r.value.length>0){ klinesMap[tf]=r.value; ok++; } });
    if(ok>0){
      const res=computeTFChanges(klinesMap);
      const d1=klinesMap['1d'];
      if(d1&&d1.length>0){
        klinesMap['7d']=d1; klinesMap['30d']=d1;
        const res2=computeTFChanges(klinesMap);
        res.pct['7d']=res2.pct['7d']; res.pct['30d']=res2.pct['30d'];
        res.long=res2.long; res.short=res2.short; res.flat=res2.flat; res.overall=res2.overall;
      }
      // 用实时价覆盖收盘价(更贴近当前)
      if(S.prices[sym]&&S.prices[sym].last>0)res.price=S.prices[sym].last;
      S.fusion.multiTF[sym]=res;
      S.fusion.lastTF=Date.now();
    }
    return ok>0;
  }catch(e){
    log('sys','多周期涨跌获取失败: '+e.message);
    return false;
  }
}

// ---- 链上数据 (阶段二: 链上活跃度 + BNB销毁/ETH供应) ----
// 数据源: 优先用 Etherscan/BscScan V2(需免费 API Key, 与 LLM Key 同 AES-GCM 加密存储),
// 无 Key 时降级到 Blockchair ETH stats(免 Key)。返回数据存 S.fusion.onChain + lastOnChain 新鲜度。
async function fetchOnChain(){
  try{
    let key='';
    try{const k=window.__getOnChainKey?await window.__getOnChainKey():null;if(k&&k.apiKey)key=k.apiKey;}catch(e){}
    const today=new Date().toISOString().slice(0,10);
    const d2=new Date(Date.now()-2*864e5).toISOString().slice(0,10);
    const eth={src:'keyless'},bnb={src:'keyless'};
    // ETH (Ethereum)
    if(key){
      const ebase='https://api.etherscan.io/v2/api?chainid=1&apikey='+encodeURIComponent(key)+'&module=stats&action=';
      const [sup,tx]=await Promise.allSettled([
        fetchT(CORS_PROXY+ebase+'ethsupply').then(r=>r.json()),
        fetchT(CORS_PROXY+ebase+'dailytx&startdate='+d2+'&enddate='+today).then(r=>r.json())
      ]);
      const s=parseScanV2(sup.status==='fulfilled'?sup.value:null,'supply');
      const t=parseScanV2(tx.status==='fulfilled'?tx.value:null,'active');
      if(s.ok){eth.supplyEth=s.eth;eth.src='etherscan';}
      if(t.ok){eth.dailyTx=t.rows;eth.lastTx=parseInt(t.last.transactionCount)||0;eth.src='etherscan';}
    }
    // 无 Key 或部分失败 → Blockchair 免 Key 降级 (ETH 24h 交易数/区块数/流通量)
    if(!eth.lastTx){
      const bc=await fetchT(CORS_PROXY+'https://api.blockchair.com/ethereum/stats').then(r=>r.json()).catch(()=>null);
      const b=parseBlockchairStats(bc);
      if(b.ok){
        if(!eth.tx24h)eth.tx24h=b.tx24h;
        if(!eth.blocks24h)eth.blocks24h=b.blocks24h;
        if(!eth.supplyEth&&b.circulation)eth.supplyEth=b.circulation/1e18;
        if(b.volume24h)eth.vol24h=b.volume24h;
        eth.src='blockchair';
      }
    }
    // BNB (BSC)
    if(key){
      const bbase='https://api.bscscan.com/v2/api?chainid=56&apikey='+encodeURIComponent(key)+'&module=stats&action=';
      const [burn,tx2]=await Promise.allSettled([
        fetchT(CORS_PROXY+bbase+'bnbburn').then(r=>r.json()),
        fetchT(CORS_PROXY+bbase+'dailytx&startdate='+d2+'&enddate='+today).then(r=>r.json())
      ]);
      const b=parseScanV2(burn.status==='fulfilled'?burn.value:null,'bnbburn');
      const t2=parseScanV2(tx2.status==='fulfilled'?tx2.value:null,'active');
      if(b.ok){bnb.burn=b;bnb.src='bscscan';}
      if(t2.ok){bnb.dailyTx=t2.rows;bnb.lastTx=parseInt(t2.last.transactionCount)||0;bnb.src='bscscan';}
    }
    const hasEth=eth.lastTx||eth.tx24h||eth.supplyEth;
    const hasBnb=bnb.lastTx||bnb.burn;
    if(!hasEth&&!hasBnb)return false;
    S.fusion.onChain={eth,bnb};
    S.fusion.lastOnChain=Date.now();
    return true;
  }catch(e){
    log('sys','链上数据获取失败: '+e.message);
    return false;
  }
}

async function fetchFearGreed(){
  try{
    const resp=await fetchT(CORS_PROXY+'https://api.alternative.me/fng/');    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const d=await resp.json();
    if(d.data&&d.data[0]){
      S.fusion.fg=parseInt(d.data[0].value)||50;
      S.fusion.fgLabel=d.data[0].value_classification||'Neutral';
      S.fusion.fgHis.push(S.fusion.fg);
      if(S.fusion.fgHis.length>40)S.fusion.fgHis.shift();
      S.fusion.lastFG=Date.now();
    }
    return true;
  }catch(e){
    log('sys','恐惧贪婪指数获取失败: '+e.message);
    return false;
  }
}

// ---- 消息面(新闻) (三层分析之"消息面"层): CoinDesk RSS 免 Key 拉取, 按币种关键词过滤 ----
// 开发模式走 vite /rss-proxy 代理(Coindesk 无 CORS 头); 生产可换 CORS 代理前缀。
// 数据存 S.fusion.news[sym] = {items:[{title,desc,pubDate,link,category,sentiment}],t}
async function fetchCoinDeskNews(){
  try{
    const url=(typeof location!=='undefined')?location.origin+THRESH.NEWS_PROXY_PATH:THRESH.NEWS_RSS_URL;
    const resp=await fetchT(url);
    if(!resp.ok)throw new Error('HTTP '+resp.status);
    const xml=await resp.text();
    const doc=new DOMParser().parseFromString(xml,'text/xml');
    const items=Array.from(doc.querySelectorAll('item')).slice(0,25).map(function(it){
      return {
        title:it.querySelector('title')?.textContent||'',
        desc:it.querySelector('description')?.textContent||'',
        pubDate:it.querySelector('pubDate')?.textContent||'',
        link:it.querySelector('link')?.textContent||'',
        category:Array.from(it.querySelectorAll('category')).map(function(c){return c.textContent||'';})
      };
    }).filter(function(it){return it.title;});
    if(!items.length)return false;
    // 按币种关键词过滤: 匹配 title/desc/category, 短词(K<4字符)用 \b 词边界防误匹配
    var kwOf=function(sym){
      var base=String(sym).replace('USDT','').toUpperCase();
      var map={'BTC':'Bitcoin','ETH':'Ethereum','SOL':'Solana','BNB':'BNB','XRP':'XRP','DOGE':'Dogecoin','ADA':'Cardano','AVAX':'Avalanche'};
      return [base,map[base]||''].filter(Boolean);
    };
    var matched=0;
    SYMS.forEach(function(s){
      var kws=kwOf(s.id);
      var mine=items.filter(function(it){
        var hay=(it.title+' '+it.desc+' '+(it.category||[]).join(' ')).toLowerCase();
        return kws.some(function(k){
          var kl=k.toLowerCase();
          if(k.length>=4)return hay.indexOf(kl)>=0;
          return new RegExp('\\b'+kl+'\\b','i').test(hay);
        });
      }).slice(0,THRESH.NEWS_MAX_ITEMS);
      if(mine.length){S.fusion.news[s.id]={items:mine,t:Date.now()};matched++;}
    });
    if(matched>0||items.length)S.fusion.lastNews=Date.now();
    return matched>0;
  }catch(e){
    log('sys','新闻获取失败: '+e.message);
    return false;
  }
}

async function fetchAllFusionData(){
  const [fr,oi,okxFR,okxOI,fg,ls,mtf,mark,oc,news]=await Promise.allSettled([
    fetchBinanceFundingRate(),
    fetchBinanceOI(),
    fetchOKXFundingRate(),
    fetchOKXOI(),
    fetchFearGreed(),
    fetchBinanceLSData(),
    fetchMultiTF(),
    fetchMarkPrices(),
    fetchOnChain(),
    fetchCoinDeskNews()
  ]);
  const ok=[fr,oi,okxFR,okxOI,fg,ls,mtf,mark,oc,news].filter(r=>r.status==='fulfilled'&&r.value===true).length;
  mergeFusionData();
  log('fusion','数据融合更新: '+ok+'/10个数据源成功');
}

// 把双所原始值合并为融合值(取可用源平均); 历史采样由 updateFusion 每2s推进
function mergeFusionData(){
  let frReady=0,oiReady=0;
  SYMS.forEach(s=>{
    const b=S.fusion.frB[s.id],o=S.fusion.frO[s.id];
    const hasB=typeof b==='number',hasO=typeof o==='number';
    if(hasB||hasO){
      S.fusion.fr[s.id]=(hasB&&hasO)?(b+o)/2:(hasB?b:o);
      frReady++;
    }
    const b2=S.fusion.oiB[s.id],o2=S.fusion.oiO[s.id];
    const hasB2=typeof b2==='number'&&b2>0,hasO2=typeof o2==='number'&&o2>0;
    if(hasB2||hasO2){
      S.fusion.oi[s.id]=(hasB2&&hasO2)?(b2+o2)/2:(hasB2?b2:o2);
      oiReady++;
    }
  });
  if(frReady>0){S.fusion.lastFR=Date.now();dataReady|=16;}
  if(oiReady>0)S.fusion.lastOI=Date.now();
}

function connectBinanceWS(){
  try{
    const streams=SYMS.map(s=>s.id.toLowerCase()+'@ticker').join('/');
    const aggStreams=SYMS.map(s=>s.id.toLowerCase()+'@aggTrade').join('/');
    const url='wss://stream.binance.com:9443/stream?streams='+streams+'/'+aggStreams;
    wsBin=new WebSocket(url);
    wsBin.onopen=()=>{log('sys','Binance WebSocket 已连接(实时)');wsBinReconnect=0;};
    wsBin.onmessage=(e)=>{
      try{
        const d=JSON.parse(e.data);
        // 用 stream 名区分消息类型(不能只看 data.s: aggTrade 也有 s 字段)
        const stream=String(d.stream||'');
        if(stream.indexOf('@aggTrade')>=0){
          // Binance aggTrade 流: 大单实时检测(鲸鱼信号替代方案, 无需外部API/CORS)
          const a=d.data;
          if(a&&a.s&&S.prices[a.s]){
            const notional=parseFloat(a.p)*parseFloat(a.q);
            if(notional>=S.fusion.whaleMin){
              const taker=a.m?'sell':'buy';
              S.fusion.whales.push({sym:a.s,amt:Math.round(notional/1000),dir:taker==='buy'?'in':'out',price:parseFloat(a.p),exchange:'Binance',t:a.T});
              if(S.fusion.whales.length>10)S.fusion.whales.shift();
            }
          }
        }else if(d.data&&d.data.s){
          const sym=d.data.s;
          if(S.prices[sym]){
            S.prices[sym].last=parseFloat(d.data.c);
            S.prices[sym].lastT=Date.now();
            S.prices[sym].chg=parseFloat(d.data.P);
            S.prices[sym].high=parseFloat(d.data.h);
            S.prices[sym].low=parseFloat(d.data.l);
            S.prices[sym].open=parseFloat(d.data.o);
            S.prices[sym].qVol=parseFloat(d.data.q||0);
            S.spark[sym].push(S.prices[sym].last);
            if(S.spark[sym].length>40)S.spark[sym].shift();
            if(!S.sparkVol[sym])S.sparkVol[sym]=[];
            S.sparkVol[sym].push(S.prices[sym].vol||0);
            if(S.sparkVol[sym].length>40)S.sparkVol[sym].shift();
            S.fusion.oi[sym]=parseFloat(d.data.v||0)*S.prices[sym].last*0.1;
          }
        }
      }catch(ex){}
    };
    wsBin.onerror=()=>{};
    wsBin.onclose=()=>{
      if(wsBinReconnect<20){wsBinReconnect++;setTimeout(connectBinanceWS,5000);}
    };
  }catch(e){}
}

function connectOKXWS(){
  try{
    const url='wss://ws.okx.com:8443/ws/v5/public';
    wsOKX=new WebSocket(url);
    wsOKX.onopen=()=>{
      log('sys','OKX WebSocket 已连接(实时)');
      const args=SYMS.map(s=>({channel:'tickers',instId:s.id.replace('USDT','-USDT')}));
      wsOKX.send(JSON.stringify({op:'subscribe',args:args}));
      wsOKXReconnect=0;
    };
    wsOKX.onmessage=(e)=>{
      try{
        const d=JSON.parse(e.data);
        if(d.data&&d.data[0]){
          const t=d.data[0];
          const instId=t.instId||'';
          // OKX instId 为 BTC-USDT, 映射回我们的键 BTCUSDT
          const sym=instId.replace('-USDT','')+'USDT';
          if(S.okx[sym]){
            S.okx[sym]=parseFloat(t.last);
            S.okxT[sym]=Date.now();
          }
        }
      }catch(ex){}
    };
    wsOKX.onerror=()=>{};
    wsOKX.onclose=()=>{
      // 网络层失败(非101)时退避重连: 30s 起, 指数翻倍至 5min 上限, 最多 8 次(累计约 15min 后放弃, 靠 REST 兜底)
      if(wsOKXReconnect<8){
        wsOKXReconnect++;
        const delay=Math.min(300000,30000*Math.pow(2,wsOKXReconnect-1));
        if(wsOKXReconnect===1)log('sys','OKX WebSocket 断开, '+Math.round(delay/1000)+'s 后重连 ('+wsOKXReconnect+'/8)');
        setTimeout(connectOKXWS,delay);
      }else if(wsOKXReconnect===8){
        wsOKXReconnect++;
        log('sys','OKX WebSocket 重连已达上限, 降级为 REST 轮询(15s)');
      }
    };
  }catch(e){}
}

function initSymData(s){
  S.prices[s.id]={last:s.base,open:s.base,high:s.base,low:s.base,chg:0,vol:0,qVol:0,lastT:Date.now()};
  S.okx[s.id]=s.base;
  S.okxT[s.id]=Date.now();
  S.spark[s.id]=Array(40).fill(s.base);
  S.sparkVol[s.id]=Array(40).fill(0);
  S.history[s.id]=[];S.hist1m[s.id]=[];S.histT[s.id]=[];S.indicators[s.id]={};
  S.fusion.fr[s.id]=0;S.fusion.oi[s.id]=0;
  S.fusion.frB[s.id]=null;S.fusion.frO[s.id]=null;
  S.fusion.oiB[s.id]=null;S.fusion.oiO[s.id]=null;
  S.fusion.frHis[s.id]=Array(40).fill(0);
  S.fusion.oiHis[s.id]=Array(40).fill(0);
  S.fusion.lsG[s.id]=null;S.fusion.lsT[s.id]=null;S.fusion.tk[s.id]=null;
  S.active.add(s.id);
}

function reconnectWS(){
  if(wsBin){wsBin.onclose=null;try{wsBin.close();}catch(e){}wsBin=null;}
  if(wsOKX){wsOKX.onclose=null;try{wsOKX.close();}catch(e){}wsOKX=null;}
  connectBinanceWS();connectOKXWS();
}

function refreshSymbolSelectors(){
  const fs=document.getElementById('fusionSel');
  if(fs){
    fs.innerHTML=SYMS.map(s=>'<option value="'+s.id+'">'+s.id.replace('USDT','')+'</option>').join('');
    fs.value=S.sel;
  }
}

function renderSymList(){
  const el=document.getElementById('symList');if(!el)return;
  el.innerHTML=SYMS.map(s=>'<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:10px;border-bottom:1px solid var(--border)">'
    +'<span style="flex:1">'+s.icon+' '+s.id+' <span style="color:var(--text2);font-size:8px">'+s.name+'</span></span>'
    +'<button class="btn btn-sell btn-sm" onclick="removeSymbol(\''+s.id+'\')">删除</button></div>').join('');
}

async function fetchSymbolBase(s){
  try{
    const r=await fetchT(CORS_PROXY+BINANCE_API+'/api/v3/ticker/price?symbol='+s.id);
    const d=await r.json();
    if(d&&d.price){
      s.base=parseFloat(d.price);
      if(S.prices[s.id]){S.prices[s.id].last=s.base;S.prices[s.id].lastT=Date.now();}
      if(S.spark[s.id])S.spark[s.id]=Array(40).fill(s.base);
      if(S.sparkVol[s.id])S.sparkVol[s.id]=Array(40).fill(0);
    }
  }catch(e){}
}

function addSymbol(id){
  id=String(id||'').trim().toUpperCase();
  if(!/^[A-Z0-9]+USDT$/.test(id)){log('risk','交易对格式错误，需形如 PEPEUSDT');return false;}
  if(SYMS.some(s=>s.id===id)){log('risk','交易对已存在: '+id);return false;}
  if(SYMS.length>=20){log('risk','最多支持 20 个交易对');return false;}
  const name=id.replace('USDT','');
  const sym={id,name,icon:name.charAt(0),base:1,vol:0.03};
  SYMS.push(sym);
  initSymData(sym);
  fetchSymbolBase(sym);
  reconnectWS();
  saveSymbols();saveState(true);
  refreshSymbolSelectors();renderSymList();render();updateTexts();
  log('sys','已添加交易对: '+id);
  return true;
}

function removeSymbol(id){
  const idx=SYMS.findIndex(s=>s.id===id);
  if(idx<0)return false;
  if(S.pos.some(p=>p.sym===id)){log('risk','该币种存在持仓，请先平仓后再删除: '+id);return false;}
  SYMS.splice(idx,1);
  delete S.prices[id];delete S.okx[id];delete S.okxT[id];delete S.spark[id];delete S.sparkVol[id];
  delete S.history[id];delete S.hist1m[id];delete S.histT[id];delete S.indicators[id];delete S.klines[id];delete S.klinesT[id];delete S.klinesO[id];delete S.klinesH[id];delete S.klinesL[id];delete S.klinesV[id];
  delete S.fusion.fr[id];delete S.fusion.oi[id];delete S.fusion.frB[id];delete S.fusion.frO[id];delete S.fusion.oiB[id];delete S.fusion.oiO[id];delete S.fusion.frHis[id];delete S.fusion.oiHis[id];
  delete S.fusion.lsG[id];delete S.fusion.lsT[id];delete S.fusion.tk[id];
  S.active.delete(id);
  if(S.sel===id)S.sel=SYMS[0]?SYMS[0].id:'';
  reconnectWS();
  saveSymbols();saveState(true);
  refreshSymbolSelectors();renderSymList();render();updateTexts();
  log('sys','已删除交易对: '+id);
  return true;
}

function addSymbolInput(){const el=document.getElementById('newSymInput');if(el){addSymbol(el.value);el.value='';}}

function init(){
  SYMS.forEach(initSymData);
  const loaded=loadState();
  if(loaded){
    while(S.subs.length<P.count){
      const i=S.subs.length;
      S.subs.push({id:i+1,bal:P.size,st:'idle',pnl:0,ex:i%2===0?'Binance':'OKX',tr:0,w:0});
    }
    document.getElementById('riskPreset').value=rp;
    document.getElementById('maxPos').textContent=S.subs.length;
    applyMaxLev();
    saveState(true);
  }else{
    const ml=document.getElementById('setMaxLev');if(ml)ml.value=P.maxLev+'x';
    const aiMap={setMinConf:P.minConf,setAiMax:P.aiMax,setMaxOrder:P.maxOrder,setMaxDailyLoss:P.maxDailyLoss};
    Object.keys(aiMap).forEach(id=>{const el=document.getElementById(id);if(el)el.value=aiMap[id];});
    for(let i=0;i<P.count;i++)S.subs.push({id:i+1,bal:P.size,st:'idle',pnl:0,ex:i%2===0?'Binance':'OKX',tr:0,w:0});
  }
  updateTexts();
  S.total=S.subs.reduce((a,c)=>a+c.bal,0)+S.pos.reduce((a,c)=>a+(c.amt||c.entry*c.qty/c.lev)+c.pnl,0);
  renderVersion();
  render();
  refreshTerminal();
  log('sys','系统启动 | '+P.label+'模式');
  log('sys','正在获取真实市场数据...');
  setInterval(tick,800);
  setInterval(updateFusion,2000);
  setInterval(checkArb,1500);
  setInterval(updateAI,15000);
  setInterval(fetchAllFusionData,FUSION_API_INTERVAL);
  fetchAllFusionData();
  fetchOnChain();
  refreshOnChainKeyStatus();
  fetchWhaleData();
  setInterval(fetchWhaleData,120000);
  backfillKlines();
  refreshTechKlines();
  setInterval(refreshTechKlines,FUSION_API_INTERVAL);
  Promise.allSettled([fetchCoinGeckoPrices(),fetchOKXPrices(),fetchBinancePrices()]).then(()=>{
    render();
    log('sys','REST数据加载完成，启动WebSocket...');
    connectBinanceWS();
    connectOKXWS();
    setInterval(fetchBinancePrices,15000);
    setInterval(fetchOKXPrices,15000);
  });
}

function tick(){
  if(dataReady===0)return;
  const nowT=Date.now();
  const minM=Math.floor(nowT/60000)*60000;
  SYMS.forEach(s=>{
    const p=S.prices[s.id];
    if(!p||!p.last)return;
    S.history[s.id].push(p.last);
    S.histT[s.id].push(nowT);
    if(S.history[s.id].length>7200){S.history[s.id].shift();S.histT[s.id].shift();}
    // 1分钟聚合: 同一分钟取最后一价
    const h1=S.hist1m[s.id]||(S.hist1m[s.id]=[]);
    if(!h1.length||h1[h1.length-1].t!==minM)h1.push({t:minM,p:p.last});
    else h1[h1.length-1].p=p.last;
    if(h1.length>300)h1.shift();
  });
  updateIndicators();
  let posChanged=false;
  SYMS.forEach(s=>{
    const p=S.prices[s.id];
    if(!wsBin||wsBin.readyState!==1){
      if(dataReady&1){
        p.high=Math.max(p.high,p.last);p.low=Math.min(p.low,p.last);
      }
    }else{
      p.high=Math.max(p.high,p.last);p.low=Math.min(p.low,p.last);
    }
  });
  const PE=window.paperEngine;
  if(PE){PE.maybeSettleFunding();PE.checkLiquidations();}
  S.pos.forEach(pos=>{
    const c=S.prices[pos.sym].last;
    let curAmt=pos.amt||(pos.entry*pos.qty/pos.lev);
    pos.pnl=pos.side==='long'?(c-pos.entry)*pos.qty:(pos.entry-c)*pos.qty;
    pos.pnlPct=(pos.pnl/curAmt)*100;
    if(pos.side==='long'){
      pos.hi=Math.max(pos.hi||pos.entry,c);
    }else{
      pos.lo=Math.min(pos.lo||pos.entry,c);
    }
    if(!pos.pnlHis)pos.pnlHis=[0];
    pos.pnlHis.push(pos.pnl);
    if(pos.pnlHis.length>1200)pos.pnlHis=pos.pnlHis.filter((_,i)=>i%2===0);
    const alive=()=>PE?S.pos.includes(pos)&&pos.qty>0.00001:(pos.qty||0)>0;
    // 自适应参数引擎: 由当前市场状态决定离场参数
    const _ind1t=S.indicators[pos.sym]&&S.indicators[pos.sym]['1t'];
    const _pctHis=S.ai.atrSuper&&S.ai.atrSuper[pos.sym]&&S.ai.atrSuper[pos.sym]['1t']&&S.ai.atrSuper[pos.sym]['1t'].pctHis;
    const _state=_ind1t&&_ind1t.series?detectRegimeState(_ind1t.series,{pctHis:_pctHis}):null;
    const _rp=_state?regimeParams(_state):null;
    const _vf=_state?volFactor(_state):0.25;
    // 离场阈值 ATR% 基准化(价格×lev→margin%, 用 RP 预设值做 floor)
    const _ap=supervisedAtrPct(pos.sym);
    const _atrLv=_ap!=null?_ap*pos.lev:null;
    const _beThr=_atrLv!=null?Math.max(P.bp,_atrLv*THRESH.EXIT_BE_MULT):P.bp;
    const _trailThr=_atrLv!=null?Math.max(P.tp,_atrLv*(_rp?_rp.stopMult:THRESH.EXIT_TRAIL_MULT)):P.tp;
    const _ladder=_atrLv!=null?(_rp?_rp.ladderMult:THRESH.EXIT_LADDER_MULTS).map(function(m){return Math.max(P.bp,_atrLv*m);}):[20,35,50,80];
    if(!pos.be&&alive()&&pos.pnlPct>=_beThr){
      pos.be=true;
      if(PE)PE.closePartial(pos,{reason:'保本出',ratio:0.5,recordSig:!!pos.ai});posChanged=true;curAmt=pos.amt||0;
    }
    if(pos.tl<4&&alive()){const lv=_ladder;if(pos.pnlPct>=lv[pos.tl]){
      const ratio=pos.tl===3?1:_vf;
      if(PE)PE.closePartial(pos,{reason:'阶梯止盈 +'+lv[pos.tl].toFixed(1)+'%',ratio:ratio,recordSig:!!pos.ai});pos.tl++;posChanged=true;curAmt=pos.amt||0;
    }}
    if(alive()&&pos.side==='long'&&pos.hi>pos.entry){const dd=((pos.hi-c)/pos.hi)*100;
      if(dd>=_trailThr&&pos.pnlPct>0){if(PE)PE.exitPosition(pos,{reason:'跟踪止损 回撤'+dd.toFixed(1)+'%'});posChanged=true;}
    }
    if(alive()&&pos.side==='short'&&pos.lo<pos.entry){const dd=((c-pos.lo)/pos.lo)*100;
      if(dd>=_trailThr&&pos.pnlPct>0){if(PE)PE.exitPosition(pos,{reason:'跟踪止损 反弹'+dd.toFixed(1)+'%'});posChanged=true;}
    }
    // ===== 自适应止损: 由 regimeParams 决定止损倍数, 最小 1.5% 价格防超紧 =====
    {
      const _p=pos.entry||1;
      const _stopMult=_rp?_rp.stopMult:THRESH.ATR_STOP_MULT;
      const _atrOk=_ind1t&&_ind1t.atr>0&&isFinite(_ind1t.atr)?_ind1t.atr:_p*(THRESH.ATR_STOP_FALLBACK_PCT/100);
      const _dist=Math.max(_stopMult*_atrOk,_p*(THRESH.ATR_STOP_MIN_PCT/100));
      if(alive()&&pos.side==='long'&&c<=_p-_dist){if(PE)PE.exitPosition(pos,{reason:'ATR止损'});posChanged=true;}
      if(alive()&&pos.side==='short'&&c>=_p+_dist){if(PE)PE.exitPosition(pos,{reason:'ATR止损'});posChanged=true;}
    }
    // ===== 自适应超时: 波动率比伸缩(ADAPTIVE_PERCENTILE 已开启 → 走分位数分支) =====
    if(alive()&&pos.openTime){const hours=(Date.now()-pos.openTime)/3600000;
      let _toH=THRESH.ATR_TIMEOUT_BASE_H;
      const _sup=S.ai.atrSuper&&S.ai.atrSuper[pos.sym]&&S.ai.atrSuper[pos.sym]['1t'];
      if(_sup&&_sup.pctHis&&_sup.pctHis.length>=THRESH.ATR_TIMEOUT_MIN_SAMPLES){
        const _med=medianOf(_sup.pctHis);
        const _cur=_sup.pctHis[_sup.pctHis.length-1];
        if(_med>0&&_cur>0&&isFinite(_med)&&isFinite(_cur)){
          if(THRESH.ADAPTIVE_PERCENTILE){
            const _pq=percentileOf(_sup.pctHis,THRESH.ADAPTIVE_P);
            if(_pq&&_pq>0&&isFinite(_pq))_toH=THRESH.ATR_TIMEOUT_BASE_H*(_pq/_cur);
          }else{
            _toH=THRESH.ATR_TIMEOUT_BASE_H*(_med/_cur);
          }
        }
        _toH=Math.max(THRESH.ATR_TIMEOUT_MIN_H,Math.min(THRESH.ATR_TIMEOUT_MAX_H,_toH));
      }
      if(hours>=_toH){if(PE)PE.exitPosition(pos,{reason:'超时平仓('+Math.round(_toH)+'h)'});posChanged=true;}
    }
  });
  const filtered=S.pos.filter(p=>p.qty>.00001);
  if(filtered.length!==S.pos.length)posChanged=true;
  S.pos=filtered;
  S.subs.forEach(s=>{const p=S.pos.find(x=>x.sid===s.id);s.st=p?'active':'idle';s.pnl=p?p.pnl:0;});
  S.total=S.subs.reduce((a,c)=>a+c.bal,0)+S.pos.reduce((a,c)=>a+(c.amt||c.entry*c.qty/c.lev)+c.pnl,0);
  renderTickers();renderSidebar();renderPositions();renderStats();
  if(curPage==='pnl')renderPnlPage();
  saveState();
}

function computeIndicators(data, symId){
  const cfg=techConfig;
  const arr=data;
  const atrArr=atrClose(arr,14);
  const atrNow=atrArr[atrArr.length-1]||0;
  // 固定参数版本
  const e20=ema(arr,20), e120=ema(arr,120);
  const rsiArr=rsi(arr,14);
  const macdArr=macd(arr,12,26,9);
  const srsiArr=srsi(arr,14,14);
  // 自适应(AIS)版本：波动大→周期短
  const a20=ais(arr,20,8,32,14,2);
  const a120=ais(arr,120,40,180,14,2);
  const aRsi=ais(rsiArr,14,5,30,14,2);
  const aSrsi=ais(srsiArr,14,5,30,14,2);
  const aMacd=aisMacd(arr,12,26,9,14);
  const i=Math.max(0,arr.length-1);
  const last=(a)=>a&&a[i]!==null&&a[i]!==undefined?a[i]:null;
  const sig={
    price:arr[i],
    ema20:cfg.ais.ema20?last(a20.line):last(e20),
    ema120:cfg.ais.ema120?last(a120.line):last(e120),
    rsi:cfg.ais.rsi?last(aRsi.line):last(rsiArr),
    macd:cfg.ais.macd?last(aMacd.line):last(macdArr.line),
    macdSignal:cfg.ais.macd?last(aMacd.signal):last(macdArr.signal),
    macdHist:cfg.ais.macd?last(aMacd.hist):last(macdArr.hist),
    srsi:cfg.ais.srsi?last(aSrsi.line):last(srsiArr),
    aisLine:last(a20.line), aisUpper:last(a20.upper), aisLower:last(a20.lower),
    aisPeriod:a20.period, atr:atrNow
  };
  const res=resonance(sig);
  return {
    series:{
      price:arr,
      ema20:cfg.ais.ema20?a20.line:e20,
      ema120:cfg.ais.ema120?a120.line:e120,
      rsi:cfg.ais.rsi?aRsi.line:rsiArr,
      srsi:cfg.ais.srsi?aSrsi.line:srsiArr,
      macdLine:cfg.ais.macd?aMacd.line:macdArr.line,
      macdSignal:cfg.ais.macd?aMacd.signal:macdArr.signal,
      macdHist:cfg.ais.macd?aMacd.hist:macdArr.hist,
      aisLine:a20.line, aisUpper:a20.upper, aisLower:a20.lower,
      atr:atrNow
    },
    current:sig,
    resonance:res,
    atr:atrNow,
    n:arr.length,
    periods:{ ema20:a20.period, ema120:a120.period, rsi:aRsi.period, srsi:aSrsi.period, macdFast:aMacd.fastP, macdSlow:aMacd.slowP }
  };
}

// 取某周期序列: 1t=原始tick, 5t/10t/20t/50t=每N根取1, 1m=分钟聚合, 5m/15m/1h/4h/1d=Binance klines
function seriesForTF(symId, tf){
  if(tf==='1t')return S.history[symId];
  if(tf==='5t'||tf==='10t'||tf==='20t'||tf==='50t'){
    const step=parseInt(tf.replace('t',''),10);
    return resample(S.history[symId], step);
  }
  if(tf==='1m'){
    const h1=S.hist1m[symId];
    return h1&&h1.length?h1.map(x=>x.p):[];
  }
  const kl=S.klines[symId]&&S.klines[symId][tf];
  return kl&&kl.length?kl:[];
}
function timeSeriesFor(symId, tf){
  if(tf==='1t')return S.histT[symId];
  if(tf==='5t'||tf==='10t'||tf==='20t'||tf==='50t'){
    const step=parseInt(tf.replace('t',''),10);
    const ht=S.histT[symId];
    if(!ht||!ht.length)return [];
    const out=[];
    for(let i=step-1;i<ht.length;i+=step)out.push(ht[i]);
    return out;
  }
  if(tf==='1m'){
    const h1=S.hist1m[symId];
    return h1&&h1.length?h1.map(x=>x.t):[];
  }
  const klT=S.klinesT&&S.klinesT[symId]&&S.klinesT[symId][tf];
  return klT&&klT.length?klT:[];
}

// ===== ATR 监督集成 =====
// 每周期计算后调用: 用 superviseATR 校验/钳制/回退 ATR, 并把监督结果写回指标对象
// (替换 ind.atr / current.atr / series.atr), 供止损/超时/交易计划/波动率风控一致使用。
// 监督状态存 S.ai.atrSuper[sym][tf] = {prev, pctHis[], alerts[]}, 仅内存(不持久化,
// 避免用旧市场环境的中位数污染当前判断; 重启后 1~2 分钟即重建中位数)。
function medianOf(arr){
  if(!arr||!arr.length)return null;
  const s=[...arr].sort((a,b)=>a-b);
  return s[Math.floor(s.length/2)];
}
// 分位数: p 为百分位(0-100), 返回排序后 p 分位值; 小于 2 个元素返回 null
function percentileOf(arr,p){
  if(!arr||arr.length<2)return null;
  const s=[...arr].sort((a,b)=>a-b);
  const idx=Math.min(s.length-1,Math.max(0,Math.round((p/100)*(s.length-1))));
  return s[idx];
}
// 受监督的 1t ATR%(百分比数值): 取 pctHis 末位, 无效时回退中位数; 完全不可用返回 null
function supervisedAtrPct(sym){
  try{
    const st=S.ai.atrSuper&&S.ai.atrSuper[sym]&&S.ai.atrSuper[sym]['1t'];
    if(st&&st.pctHis&&st.pctHis.length){
      const cur=st.pctHis[st.pctHis.length-1];
      if(typeof cur==='number'&&isFinite(cur)&&cur>0&&cur<15)return cur;
      const med=medianOf(st.pctHis);
      if(med&&med>0&&med<15)return med;
    }
  }catch(e){}
  return null;
}
function superviseTFATR(symId,tf,ind){
  const price=ind&&ind.current&&ind.current.price;
  const raw=ind&&ind.atr;
  const S_AI=S.ai;
  if(!S_AI.atrSuper)S_AI.atrSuper={};
  if(!S_AI.atrSuper[symId])S_AI.atrSuper[symId]={};
  const st=S_AI.atrSuper[symId][tf]||(S_AI.atrSuper[symId][tf]={prev:null,pctHis:[],alerts:[],warned:0});
  // 用上次监督后的 atr 反弹出的 pctHis 求中位数(作为 Layer2/4 基准)
  const median=medianOf(st.pctHis);
  const hist={prev:st.prev,median:median||0};
  const atrPct=price>0?raw/price*100:0;
  let r;
  try{ r=superviseATR(raw,price,atrPct,hist); }
  catch(e){ return ind; }
  // 更新监督状态: prev 存本次最终(atr 绝对值), pctHis 存监督后 atrPct(40点滚动)
  st.prev={atr:r.atr,t:Date.now()};
  const usedPct=price>0?r.atr/price*100:null;
  if(usedPct!=null&&isFinite(usedPct)&&usedPct>0){st.pctHis.push(usedPct);if(st.pctHis.length>40)st.pctHis.shift();}
  if(r.alert){
    if(Date.now()-st.warned>30000){ // 同键预警节流: 30s 一次, 防刷屏
      st.warned=Date.now();
      st.alerts.push({t:Date.now(),msg:r.alert,state:r.state});
      if(st.alerts.length>20)st.alerts.shift();
      log('risk','[ATR监督] '+symId+' '+tf+' '+r.alert);
    }
  }
  // 写回指标对象
  if(r.atr!=null&&isFinite(r.atr)&&r.atr>0){
    ind.atr=r.atr;
    if(ind.current)ind.current.atr=r.atr;
    if(ind.series)ind.series.atr=r.atr;
  }
  return ind;
}

var _slowIndT=0;
function updateIndicators(){
  const techSym=techConfig.symbol;
  const nowT=Date.now();
  // 慢周期(10t/1m)节流: 每 1.5s 对全部币种重算, 避免每 tick 全币种重算造成的性能抖动
  const slowDue=nowT-_slowIndT>1500;
  SYMS.forEach(sym=>{
    const h=S.history[sym.id];
    const map={};
    // 1t 需等 tick 历史 ≥30 才计算（刚刷新时历史未攒够，K 线周期不受此卡点影响）
    if(h&&h.length>=30){
      try{ map['1t']=superviseTFATR(sym.id,'1t',computeIndicators(h,sym.id)); }catch(e){ map['1t']=null; }
    }
    if(slowDue){
      // 全部币种的非 1t 周期(10t/1m/5m/15m/1h/4h/1d…)都由各自数据直接计算，不等 1t 历史
      try{
        const need={};
        if(techConfig.primaryTF&&techConfig.primaryTF!=='1t')need[techConfig.primaryTF]=true;
        Object.keys(techConfig.timeframes||{}).forEach(tf=>{ if(techConfig.timeframes[tf]&&tf!=='1t')need[tf]=true; });
        // K线分析页：并入其勾选的 K 线周期，保证新页面对应周期有指标数据
        const kc=window.kConfig&&window.kConfig();
        if(kc&&kc.klineSel){ Object.keys(kc.klineSel).forEach(tf=>{ if(kc.klineSel[tf]&&tf!=='1t')need[tf]=true; }); }
        Object.keys(need).forEach(tf=>{
          const data=seriesForTF(sym.id,tf);
          if(data&&data.length>=30)map[tf]=superviseTFATR(sym.id,tf,computeIndicators(data,sym.id));
        });
      }catch(e){ /* 慢周期异常不影响 1t 实时数据 */ }
    }else{
      // 未到期: 复用上次缓存的非 1t 周期, 保持显示连续
      const prev=S.indicators[sym.id]||{};
      const reuse={};
      Object.keys(techConfig.timeframes||{}).forEach(tf=>{ if(tf!=='1t')reuse[tf]=true; });
      const kc=window.kConfig&&window.kConfig();
      if(kc&&kc.klineSel){ Object.keys(kc.klineSel).forEach(tf=>{ if(tf!=='1t')reuse[tf]=true; }); }
      Object.keys(reuse).forEach(tf=>{ if(prev[tf])map[tf]=prev[tf]; });
    }
    S.indicators[sym.id]=map;
  });
  if(slowDue)_slowIndT=nowT;
  if(curPage==='tech'&&window.__renderTechCanvas)window.__renderTechCanvas();
  if(window.__updateTechPanel)window.__updateTechPanel();
  if(curPage==='kchart'&&window.__renderKChart)window.__renderKChart();
}

function updateFusion(){
  SYMS.forEach(s=>{
    S.fusion.frHis[s.id].push(S.fusion.fr[s.id]||0);if(S.fusion.frHis[s.id].length>40)S.fusion.frHis[s.id].shift();
    S.fusion.oiHis[s.id].push(S.fusion.oi[s.id]||0);if(S.fusion.oiHis[s.id].length>40)S.fusion.oiHis[s.id].shift();
  });
  S.fusion.fgHis.push(S.fusion.fg);if(S.fusion.fgHis.length>40)S.fusion.fgHis.shift();
  if(curPage==='fusion')renderFusion();
}

function checkArb(){
  const on=document.getElementById('setArbOn')?.value==='1';if(!on)return;
  const both=document.getElementById('setBothSide')?.value==='1';
  if(!S.arb.lastTime)S.arb.lastTime={};
  const ms=parseFloat(document.getElementById('setMinSpread')?.value||.05);
  const minProfit=parseFloat(document.getElementById('setMinProfit')?.value||0.5);
  const slip=parseFloat(document.getElementById('setSlipProtect')?.value||SLIP);
  SYMS.forEach(s=>{
    const bp=S.prices[s.id].last,op=S.okx[s.id];
    if(!(bp>0)||!(op>0))return;
    if(both&&(!marketFresh(s.id)||!okxFresh(s.id)))return;
    const sp=Math.abs(bp-op)/Math.min(bp,op)*100;
    if(sp>=ms&&sp<=2){const buyE=bp<op?'Binance':'OKX',sellE=bp<op?'OKX':'Binance';
      const bP=Math.min(bp,op),sP=Math.max(bp,op),qty=500/bP;
      const buyPrice=bP*(1+slip),sellPrice=sP*(1-slip);
      const gross=(sellPrice-buyPrice)*qty;
      const fees=buyPrice*qty*FEE+sellPrice*qty*FEE;
      const net=gross-fees;
      if(net>=minProfit){S.arb.opp.unshift({sym:s.id,buyE,sellE,bP:buyPrice,sP:sellPrice,sp,net,gross,fees,t:Date.now()});
        if(S.arb.opp.length>5)S.arb.opp.pop();
        if(!S.arb.lastTime[s.id]||Date.now()-S.arb.lastTime[s.id]>60000){
          S.arb.lastTime[s.id]=Date.now();S.arb.cnt++;S.arb.profit+=net;
        }
        log('arb','套利: '+s.id+' 差'+sp.toFixed(2)+'% | 毛利:$'+gross.toFixed(2)+' 手续费:$'+fees.toFixed(2)+' 净利:$'+net.toFixed(2));
      }
    }
  });
}

function sanitizeSigScore(){
  const r=sanitizeSigScoreTable(S.ai.sigScore);
  if(r.changed){S.ai.sigScore=r.table;saveState(true);}
  S.ai.cleaned='v1.6';
}

function recordSigResult(sigStr,result,pnl){
  if(!sigStr)return;
  var names=sigStr.split('+');
  names.forEach(function(name){
    name=name.trim();if(!name)return;
    if(!S.ai.sigScore[name])S.ai.sigScore[name]={total:0,wins:0,losses:0,sumPnl:0};
    var s=S.ai.sigScore[name];
    s.total++;s.sumPnl+=pnl;
    if(result==='win')s.wins++;else s.losses++;
    s.winRate=s.wins/s.total;
    s.avgPnl=s.sumPnl/s.total;
  });
  S.ai.sigLog.push({sig:sigStr,result:result,pnl:pnl,t:Date.now()});
  if(S.ai.sigLog.length>200)S.ai.sigLog.shift();
}

function getSigScore(sigName){
  var s=S.ai.sigScore[sigName];
  var sTotal=s&&s.total? s.total:0;
  var baseScore=null;
  // 真实样本>=3 → 完全由真实成交学习接管(不再混入回测先验)
  if(sTotal>=3){
    var base=s.winRate*2;
    var pnlBonus=s.avgPnl>0?Math.min(2.0,s.avgPnl/1.5):Math.max(0.2,1+s.avgPnl/3);
    var recentBonus=1;
    if(s.total>=5){
      var recentPnl=0;
      // 精确匹配信号名(不子串误配): 与记录时 sigStr 按 '+' 拆分全等比较
      var logs=S.ai.sigLog.filter(function(l){
        if(!l.sig)return false;
        var parts=String(l.sig).split('+').map(function(x){return x.trim();});
        return parts.indexOf(sigName)>=0;
      }).slice(-5);
      logs.forEach(function(l){recentPnl+=l.pnl;});
      recentBonus=recentPnl>0?1.2:0.8;
    }
    baseScore=Math.max(0.2,Math.min(3.0,base*pnlBonus*recentBonus));
  }
  // 真实样本不足(<3) → 用 walk-forward 回测先验(只作先验, 不入 sigScore 表, 不伪造样本)
  else{
    var prior=S.ai.prior&&S.ai.prior[sigName];
    if(prior&&prior.wr!=null)baseScore=Math.max(0.2,Math.min(3.0,1+(prior.wr-0.5)*2));
    else if(sTotal>=1)baseScore=s.winRate*2;
    else baseScore=1;
  }
  // 阶段5: 信号权重随市场状态自适应(趋势市强化顺势信号, 震荡市强化均值回归信号)
  // S.ai._regime 由 updateAI 每个币循环开始时设置; 无上下文(AI进化页等)时权重=1
  var w=regimeSignalWeight(sigName,S.ai._regime);
  return baseScore*(w==null?1:w);
}

// ===== 自适应同向上限: 按方向历史胜率动态调整(类似AIS的自适应思想) =====
// 胜率≥65% → 上限7(加大投入) | 40~65% → 5(默认) | <40% → 3(收紧)
function dirCap(side){
  var st=S.ai.dirStat[side]||{w:0,l:0};
  var n=st.w+st.l;
  if(n<1)return 5; // 样本≥1即开始自适应(原3, 5h数据表明AI平仓太慢, 降为1让学习更快响应)
  var wr=st.w/n;
  if(wr>=0.65)return 7;
  if(wr>=0.4)return 5;
  return 3;
}

// ===== 总仓位上限: 子账户数的70%(防过度敞口, 但留足空间) =====
function totalCap(){
  return Math.max(5,Math.min(14,Math.round(S.subs.length*0.7)));
}

// 记录方向胜率(AI平仓时调用)
function recordDirResult(side,pnl){
  if(!S.ai.dirStat[side])S.ai.dirStat[side]={w:0,l:0};
  var st=S.ai.dirStat[side];
  if(pnl>0)st.w++;else st.l++;
}

// ===== LLM 信号接入 =====
function readLLMSettings(){
  return {
    on:document.getElementById('setLLMOn')?.value==='1',
    role:document.getElementById('setLLMRole')?.value||'signal',
    provider:document.getElementById('setLLMProvider')?.value||'deepseek',
    model:document.getElementById('setLLMModel')?.value||'deepseek-chat',
    url:document.getElementById('setLLMUrl')?.value||'',
    freq:document.getElementById('setLLMFreq')?.value||'5m',
    budgetMode:document.getElementById('setLLMBudgetMode')?.value||'calls',
    budget:parseFloat(document.getElementById('setLLMBudget')?.value||50),
    weight:parseFloat(document.getElementById('setLLMWeight')?.value||15),
    minConf:parseFloat(document.getElementById('setLLMMinConf')?.value||60),
    histPrompt:parseInt(document.getElementById('setLLMHistPrompt')?.value||8),
    histKeep:parseInt(document.getElementById('setLLMHistKeep')?.value||100),
    histDays:parseInt(document.getElementById('setLLMHistDays')?.value||7)
  };
}
function llmBudgetOk(cfg){
  var st=S.ai.llmStats;
  var day=aiDayStr();
  if(st.dayDate!==day){st.dayDate=day;st.calls=0;st.tokens=0;}
  return budgetAvailable(st,cfg.budgetMode,cfg.budget);
}
function llmCacheStale(cfg){
  if(cfg.freq==='off')return false;
  if(!S.ai.llm)return true;
  return Date.now()-(S.ai.llm.ts||0)>freqToMs(cfg.freq);
}
// 阶段四: 触发式LLM刷新判断 —— 超出固定频率 或 新鲜强触发(三层共振等)且距上次刷新>=最小间隔
function llmShouldRefresh(cfg){
  if(cfg.freq==='off')return false;
  if(!S.ai.llm)return true;
  var now=Date.now();
  if(now-(S.ai.llm.ts||0)>freqToMs(cfg.freq))return true;
  if(S.ai.llmTrigger&&(now-S.ai.llmTrigger.t)<THRESH.LLM_TRIGGER_FRESH&&(now-(S.ai.llm.ts||0))>THRESH.LLM_TRIGGER_MIN_GAP)return true;
  return false;
}
// 异步刷新 LLM 分析(不阻塞 15s 主循环); 结果写入 S.ai.llm 缓存
async function refreshLLMAnalysis(){
  var cfg=readLLMSettings();
  if(!cfg.on)return;
  if(S.ai.llmRefreshing)return;
  if(!llmBudgetOk(cfg)){
    if(S.ai.llmErr!=='budget'){S.ai.llmErr='budget';log('ai','[LLM] 今日预算已用尽, 已跳过本轮分析');}
    return;
  }
  var row=null;
  try{row=window.__getLLMKey?await window.__getLLMKey():null;}catch(e){}
  if(!row||!row.apiKey){
    if(S.ai.llmErr!=='nokey'){S.ai.llmErr='nokey';log('ai','[LLM] 未配置 API Key, 请在设置页加密保存');}
    return;
  }
  S.ai.llmRefreshing=true;S.ai.llmErr=null;
  var t0=Date.now();
  // 阶段四: 触发式分析 —— 本次刷新是否由真实信号触发
  var trigEvt=S.ai.llmTrigger;
  var isTriggered=trigEvt&&(Date.now()-trigEvt.t)<THRESH.LLM_TRIGGER_FRESH;
  try{
    var prompt=buildMarketPrompt(S,{syms:SYMS,winExamples:getWinExamples(S,5),loseExamples:getLoseExamples(S,3),history:S.ai.llmHistory||[],historyPrompt:cfg.histPrompt||8,trigger:isTriggered?trigEvt:null});
    var res=await chat(prompt,{provider:cfg.provider,baseUrl:cfg.url,model:cfg.model,apiKey:row.apiKey});
    var verdict=parseVerdict(res.text);
    consumeBudget(S.ai.llmStats,res.usage,prompt);
    S.ai.llm={ts:Date.now(),symbols:verdict.symbols,verdict:verdict.verdict,reasoning:verdict.reasoning,usage:res.usage||null,ms:Date.now()-t0};
    // 记录本次分析到历史(含价格快照,供下次对话参考)
    var priceSnap={};SYMS.forEach(function(s){var p=S.prices[s.id];if(p&&p.last)priceSnap[s.id]=p.last;});
    S.ai.llmHistory.push({ts:Date.now(),verdict:verdict.verdict,reasoning:verdict.reasoning,symbols:verdict.symbols,prices:priceSnap});
    // 按条数上限截断
    var histKeep=cfg.histKeep||100;
    if(S.ai.llmHistory.length>histKeep)S.ai.llmHistory.splice(0,S.ai.llmHistory.length-histKeep);
    // 按天数截断
    var histDays=cfg.histDays||7;
    var cutoff=Date.now()-histDays*86400000;
    S.ai.llmHistory=S.ai.llmHistory.filter(function(h){return !h.ts||h.ts>=cutoff;});
    saveState(true);
    var dirLabel=verdict.verdict==='long'?'看多':verdict.verdict==='short'?'看空':'中性';
    recordLedgerEvent('fusion','[LLM分析] '+Object.keys(verdict.symbols).length+'币, 整体'+dirLabel+' | 耗时'+((Date.now()-t0)/1000).toFixed(1)+'s'+(verdict.reasoning?' | '+verdict.reasoning:''));
    log('ai','[LLM] '+(isTriggered?'触发式':'定时')+'分析完成: '+Object.keys(verdict.symbols).length+'币, 整体'+dirLabel+' | 耗时'+((Date.now()-t0)/1000).toFixed(1)+'s | 今日 '+S.ai.llmStats.calls+'次/'+S.ai.llmStats.tokens+'tok');
    if(typeof renderAI==='function')renderAI();
  }catch(e){
    S.ai.llmErr=(e&&e.message)||'未知错误';
    recordLedgerEvent('fusion','[LLM分析] 失败: '+S.ai.llmErr);
    log('ai','[LLM] 调用失败: '+S.ai.llmErr);
  }finally{
    S.ai.llmRefreshing=false;
  }
}
// 测试连接(设置页按钮)
async function testLLMConnection(){
  var cfg=readLLMSettings();
  var st=document.getElementById('llmTestStatus');
  var row=null;
  try{row=window.__getLLMKey?await window.__getLLMKey():null;}catch(e){}
  if(!row||!row.apiKey){if(st){st.textContent='先保存 API Key';st.style.color='var(--red)';}return;}
  var conf=providerConfig({provider:cfg.provider,baseUrl:cfg.url,model:cfg.model});
  if(st){st.textContent='测试中... → '+conf.url;st.style.color='var(--text2)';}
  var r=await testConnection({provider:cfg.provider,baseUrl:cfg.url,model:cfg.model,apiKey:row.apiKey});
  if(st){st.textContent=r.ok?('✓ 已连通 '+r.ms+'ms'):('✗ '+r.error);st.style.color=r.ok?'var(--green)':'var(--red)';}
  log(r.ok?'sys':'risk',r.ok?('[LLM] 连接测试成功 '+r.ms+'ms → '+conf.url):('[LLM] 连接测试失败: '+r.error));
}
// 供应商切换: 自定义时显示 URL 行; 内置供应商时回填默认模型(自定义保留用户已填的模型名)
function onLLMProviderChange(){
  var p=document.getElementById('setLLMProvider')?.value||'deepseek';
  var row=document.getElementById('rowLLMUrl');
  if(row)row.style.display=p==='custom'?'flex':'none';
  if(p!=='custom'){
    var modelMap={deepseek:'deepseek-chat',openai:'gpt-4o-mini',openrouter:'openrouter/auto'};
    var mEl=document.getElementById('setLLMModel');
    if(mEl&&modelMap[p]!=null)mEl.value=modelMap[p];
  }
  saveState(true);
}
function onLLMRoleChange(){
  var cfg=readLLMSettings();
  window.log&&window.log('ai','[LLM] 角色已切换为: '+(cfg.role==='trade'?'可参与交易(高置信可直接触发开仓, 仍受全部风控)':'仅信号(加权融合)'));
  saveState(true);
}
// 加密保存 LLM API Key(复用 AES-GCM apiKeyStore, exchange='LLM')
async function saveLLMKey(){
  var keyEl=document.getElementById('setLLMKey');
  var key=(keyEl&&keyEl.value||'').trim();
  if(!key){window.log&&window.log('risk','[LLM] 请输入 API Key');return;}
  if(window.__saveLLMKey)await window.__saveLLMKey(key);
  if(keyEl)keyEl.value='';
  refreshLLMKeyStatus();
  window.log&&window.log('sys','[LLM] API Key 已加密保存 (AES-GCM)');
}
async function refreshLLMKeyStatus(){
  var row=null;
  try{row=window.__getLLMKey?await window.__getLLMKey():null;}catch(e){}
  var el=document.getElementById('llmKeyStatus');
  if(el){el.textContent=row&&row.apiKey?'已配置 (加密)':'未配置';el.style.color=row&&row.apiKey?'var(--green)':'var(--text2)';}
}
// 链上数据 API Key (Etherscan/BscScan V2, 免费) — 与 LLM Key 同 AES-GCM 加密存储
async function saveOnChainKey(){
  var keyEl=document.getElementById('setOnChainKey');
  var key=(keyEl&&keyEl.value||'').trim();
  if(!key){window.log&&window.log('risk','[链上] 请输入 Etherscan/BscScan API Key');return;}
  if(window.__saveOnChainKey)await window.__saveOnChainKey(key);
  if(keyEl)keyEl.value='';
  refreshOnChainKeyStatus();
  window.log&&window.log('sys','[链上] 链上数据 Key 已加密保存 (AES-GCM)');
}
async function refreshOnChainKeyStatus(){
  var row=null;
  try{row=window.__getOnChainKey?await window.__getOnChainKey():null;}catch(e){}
  var el=document.getElementById('onChainKeyStatus');
  if(el){el.textContent=row&&row.apiKey?'已配置 (加密)':'未配置';el.style.color=row&&row.apiKey?'var(--green)':'var(--text2)';}
}
// 平仓时记录交易轨迹(由 PaperEngine / closePos 调用)
function recordClosedTrade(pos,pnl,reason,exitPrice){
  recordTrade(S,pos,pnl,reason,exitPrice);
}

// 回测胜率先验缓存(供 sigScore 种子, 避免空表永远返回 1.0)
var __btSeed={};

// 实时动量%: 优先用 1m K线(近 ~3 根), 回退到 spark(近 12 点), 再回退 0
// 替代原 24h 静态涨跌(p.chg)用于超跌/超涨, 解决横盘市里因 24h 为负而虚假触发
function realMomentumPct(symId){
  var h=S.hist1m[symId];
  if(h&&h.length>=4){
    var p=h[h.length-1].p, ref=h[Math.max(0,h.length-4)].p;
    if(ref>0)return (p-ref)/ref*100;
  }
  var spk=S.spark[symId];
  if(spk&&spk.length>12){
    var a=spk[spk.length-1], b=spk[spk.length-12];
    if(b>0)return (a-b)/b*100;
  }
  return 0;
}

function updateAI(){
  if(S.ai.dec.length>8)S.ai.dec.shift();
  var bestSym=null,bestScore=-999,bestSide='long',bestConf=0,bestSig=[],bestTrigger=false,bestVolatile=false,bestLLMFire=false,bestLLMConf=0,bestRegime=null;
  var _regimeMap={};
  var activePos=S.pos.length;
  // 每日风控状态(按天自动重置)
  var day=aiDayStr();
  if(S.ai.dayDate!==day){S.ai.dayDate=day;S.ai.dayCount=0;S.ai.dayStartEquity=S.total||0;}
  var dayPnl=(S.total||0)-(S.ai.dayStartEquity||0);
  // 读取用户设置(全部真正生效)
  var autoOn=document.getElementById('setAiAuto')?.value==='1';
  var minConf=parseFloat(document.getElementById('setMinConf')?.value||65);
  var aiMax=parseInt(document.getElementById('setAiMax')?.value||20);
  var maxOrder=parseFloat(document.getElementById('setMaxOrder')?.value||100);
  var maxDailyLoss=parseFloat(document.getElementById('setMaxDailyLoss')?.value||500);
  var tradeMode=document.getElementById('setTradeMode')?.value||'standard';
  var llmCfg=readLLMSettings();
  if(isNaN(minConf))minConf=65;if(isNaN(aiMax))aiMax=20;if(isNaN(maxOrder))maxOrder=100;if(isNaN(maxDailyLoss))maxDailyLoss=500;
  // LLM 缓存过期则异步刷新(不阻塞 15s 主循环); 期间使用旧缓存
  // 阶段四: 触发式 LLM —— 真实信号触发(三层共振等)时不等固定频率, 立即补一次分析
  if(llmCfg.on&&!S.ai.llmRefreshing&&llmShouldRefresh(llmCfg)){
    refreshLLMAnalysis();
  }
  // 冷却基于上一次【实际执行】时间(修复: 原代码基于最近一次决策记录,导致冷却永不满足)
  var cooldownOK=!S.ai.lastExecT||Date.now()-S.ai.lastExecT>15000;
  if(!S.ai.atrHis)S.ai.atrHis={};
  SYMS.forEach(function(sym){
    var p=S.prices[sym.id];if(!p||!p.last)return;
    var fr=S.fusion.fr[sym.id]||0,fg=S.fusion.fg||50;
    var sig=[];var ls=0,ss=0;var trigger=false;var llmLv=null;var llmFire=false;var llmConfHere=0;
    // 阶段5: 记录该币当前市场状态 → getSigScore 用它做信号权重自适应(趋势/震荡强化不同信号)
    var _i1=S.indicators&&S.indicators[sym.id]&&S.indicators[sym.id]['1t'];
    var _pctHis1=S.ai.atrSuper&&S.ai.atrSuper[sym.id]&&S.ai.atrSuper[sym.id]['1t']&&S.ai.atrSuper[sym.id]['1t'].pctHis;
    S.ai._regime=_i1&&_i1.series?detectRegimeState(_i1.series,{pctHis:_pctHis1}):null;
    _regimeMap[sym.id]=S.ai._regime;
    // 超跌/超涨改用实时动量(近 ~3 分钟), 脱离 24h 静态涨跌(p.chg)
    var chgNow=realMomentumPct(sym.id);
    if(chgNow<-THRESH.MOM_CHG_SURGE_PCT){ls+=25*getSigScore('超跌');sig.push('超跌');trigger=true;}
    else if(chgNow<-1){ls+=12*getSigScore('超跌');sig.push('超跌');trigger=true;}
    if(chgNow>THRESH.MOM_CHG_SURGE_PCT){ss+=25*getSigScore('超涨');sig.push('超涨');trigger=true;}
    else if(chgNow>1){ss+=12*getSigScore('超涨');sig.push('超涨');trigger=true;}
    if(fusionOn('FR')){
      if(fr<-.0008){ls+=20*getSigScore('负费率');sig.push('负费率');trigger=true;}
      else if(fr<-.0002){ls+=8*getSigScore('负费率');sig.push('负费率');}
      if(fr>.0008){ss+=20*getSigScore('正费率');sig.push('正费率');trigger=true;}
      else if(fr>.0002){ss+=8*getSigScore('正费率');sig.push('正费率');}
    }
    if(fusionOn('Whale')){
      var w=S.fusion.whales.find(function(wh){return wh.sym===sym.id;});
      if(w&&w.dir==='in'){ls+=12*getSigScore('鲸鱼转入');sig.push('鲸鱼转入');trigger=true;}
      if(w&&w.dir==='out'){ss+=12*getSigScore('鲸鱼转出');sig.push('鲸鱼转出');trigger=true;}
    }
    var spk=S.spark[sym.id];
    if(spk&&spk.length>10){
      var oldP=spk[spk.length-11]||spk[0];
      var mom=(p.last-oldP)/oldP*100;
      if(mom>THRESH.MOM_RUSH_PCT){ss+=18*getSigScore('急涨');sig.push('急涨');trigger=true;}
      else if(mom>0.8){ss+=8*getSigScore('急涨');sig.push('急涨');}
      if(mom<-THRESH.MOM_RUSH_PCT){ls+=18*getSigScore('急跌');sig.push('急跌');trigger=true;}
      else if(mom<-0.8){ls+=8*getSigScore('急跌');sig.push('急跌');}
    }
    var ind=S.indicators&&S.indicators[sym.id];
    var res=ind&&ind['1t']&&ind['1t'].resonance;
    if(res&&res.buy){ls+=20*getSigScore('共振买入');sig.push('共振买入');trigger=true;}
    if(res&&res.sell){ss+=20*getSigScore('共振卖出');sig.push('共振卖出');trigger=true;}
    // ===== 情境(regime)过滤: 趋势市禁止逆势, 震荡市要求更强确认 =====
    var i1s=ind&&ind['1t']&&ind['1t'].series;
    if(i1s){
      var reg=detectRegime(i1s);
      if(reg.type==='trend-down'&&ls>ss){ls*=0.5;S.ai.lastRegime='下跌趋势压制做多';}
      else if(reg.type==='trend-up'&&ss>ls){ss*=0.5;S.ai.lastRegime='上涨趋势压制做空';}
      else if(reg.type==='range'&&Math.abs(ls-ss)<15){ls*=0.7;ss*=0.7;S.ai.lastRegime='震荡市弱信号降权';}
      else S.ai.lastRegime=reg.label;
    }
    // ===== 回测胜率反馈: 用 walk-forward 先验(非样本内) 高胜率加分, 低胜率降权 =====
    // BEFORE: 用 window.__techBT['1t'](同一序列全量回测) → 样本内污染。
    // NOW: 用 __btSeed 的 walkForward 先验, 且真实样本>=3 时不再使用回测反馈(真实学习接管)。
    var seedWf=__btSeed[sym.id]&&__btSeed[sym.id].wf;
    if(res&&(res.buy||res.sell)&&seedWf){
      var btSide=res.buy?'buy':'sell';
      var wfSide=btSide==='buy'?seedWf.buy:seedWf.sell;
      var sideWr=wfSide&&wfSide.winRate;
      var realName=res.buy?'共振买入':'共振卖出';
      var realS=S.ai.sigScore&&S.ai.sigScore[realName];
      if(sideWr!=null&&wfSide&&(wfSide.wins+wfSide.losses)>=THRESH.BT_PRIOR_MIN_SAMPLES&&(!realS||realS.total<THRESH.BT_REAL_MIN_SAMPLES)){
        if(sideWr>=THRESH.BT_VERIFY_HI){
          if(res.buy){ls+=THRESH.BT_VERIFY_BONUS*getSigScore('回测验证');sig.push('回测验证');}
          else{ss+=THRESH.BT_VERIFY_BONUS*getSigScore('回测验证');sig.push('回测验证');}
        }else if(sideWr<=THRESH.BT_VERIFY_LO){
          if(res.buy){ls*=THRESH.BT_VERIFY_PENALTY;}else{ss*=THRESH.BT_VERIFY_PENALTY;}
          S.ai.lastRegime=(S.ai.lastRegime||'')+' | 回测低胜率降权';
        }
      }
    }
    // 多周期确认: 大周期(10t,1m)与1t方向一致→加分,相反→降权
    var bigBuy=0,bigSell=0,bigTotal=0;
    ['10t','1m'].forEach(function(tf){
      if(!techConfig.timeframes[tf]||!ind||!ind[tf])return;
      bigTotal++;
      if(ind[tf].resonance.buy)bigBuy++;
      if(ind[tf].resonance.sell)bigSell++;
    });
    if(bigTotal>=1){
      if(res&&res.buy&&bigBuy===bigTotal){ls+=12*getSigScore('多周期确认');sig.push('多周期确认');}
      else if(res&&res.sell&&bigSell===bigTotal){ss+=12*getSigScore('多周期确认');sig.push('多周期确认');}
      if(res&&res.buy&&bigSell>0)ls*=0.7;
      if(res&&res.sell&&bigBuy>0)ss*=0.7;
    }
    // ===== 基于1t的多指标信号(所有币种都有1t数据) =====
    var i1=ind&&ind['1t']&&ind['1t'].series;
    if(i1){
      var e20=i1.ema20[i1.ema20.length-1], e120=i1.ema120[i1.ema120.length-1];
      var aisL=i1.aisLine[i1.aisLine.length-1];
      var srNow=i1.srsi[i1.srsi.length-1];
      var mL=i1.macdLine[i1.macdLine.length-1], mS=i1.macdSignal[i1.macdSignal.length-1];
      if(e20!=null&&e120!=null){
        if(e20>e120){ls+=8*getSigScore('短线多头');sig.push('短线多头');}
        else{ss+=8*getSigScore('短线空头');sig.push('短线空头');}
      }
      if(aisL!=null){
        if(p.last>aisL){ls+=5*getSigScore('站上AIS');sig.push('站上AIS');}
        else{ss+=5*getSigScore('跌破AIS');sig.push('跌破AIS');}
      }
      if(srNow!=null){
        if(srNow>80){ss+=12*getSigScore('SRSI超买');sig.push('SRSI超买');trigger=true;}
        else if(srNow<20){ls+=12*getSigScore('SRSI超卖');sig.push('SRSI超卖');trigger=true;}
      }
      if(mL!=null&&mS!=null){
        if(mL>mS){ls+=5*getSigScore('MACD多头');sig.push('MACD多头');}
        else{ss+=5*getSigScore('MACD空头');sig.push('MACD空头');}
      }
      // ===== 量价背离信号 (spark价格+sparkVol成交量, 经典顶/底背离) =====
      var spkV=S.sparkVol&&S.sparkVol[sym.id];
      if(spk&&spk.length>=20&&spkV&&spkV.length>=20){
        var vd=volumeDivergence(spk,spkV,20);
        if(vd&&vd.bear){ss+=18*getSigScore('量价顶背离');sig.push('量价顶背离');trigger=true;}
        if(vd&&vd.bull){ls+=18*getSigScore('量价底背离');sig.push('量价底背离');trigger=true;}
      }
      // ===== 支撑/阻力位信号: 价格贴近支撑(1×ATR内)→做多机会, 贴近阻力→做空机会 =====
      var srAt=i1&&i1.atr;
      if(spk&&spk.length>=5){
        var sr1=supportResistance(spk,40);
        if(sr1){
          if(sr1.sup!=null&&srAt>0&&p.last>0){
            var supGapPct=(p.last-sr1.sup)/p.last*100;
            var atrPctP=Math.max(0.2,srAt/p.last*100);
            if(supGapPct<atrPctP){ls+=12*getSigScore('触及支撑');sig.push('触及支撑');}
          }
          if(sr1.res!=null&&srAt>0&&p.last>0){
            var resGapPct=(sr1.res-p.last)/p.last*100;
            var atrPctR=Math.max(0.2,srAt/p.last*100);
            if(resGapPct<atrPctR){ss+=12*getSigScore('触及阻力');sig.push('触及阻力');}
          }
        }
      }
    }
    // ===== 自适应信号先验: 用 walk-forward 回测胜率给 sigScore 供先验(不再伪造样本) =====
    // 每 120s 重算一次(回测遍历~7200点, 不宜每 15s 跑)。
    // BEFORE: __btSeed 把回测胜率写成 wins=round(wr*20) 的假样本塞进 sigScore → 学习被污染。
    // NOW: 回测胜率存为独立先验 S.ai.prior(样本内污染解除), 仅当真实样本<3 时由 getSigScore 使用。
    if(i1){
      var sd=__btSeed[sym.id];
      if(!sd||Date.now()-sd.t>THRESH.BT_CACHE_MS){
        try{var wfRes=walkForwardWinRate(i1,{targetAtr:THRESH.BT_TARGET_ATR,horizon:THRESH.BT_HORIZON,lag:THRESH.BT_WF_LAG});
          sd=__btSeed[sym.id]={t:Date.now(),wf:wfRes};
        }catch(e){sd=__btSeed[sym.id]={t:Date.now(),wf:null};}
      }
      if(sd&&sd.wf&&sd.wf.buy&&sd.wf.sell){
        var _bw=sd.wf.buy.winRate,_sw=sd.wf.sell.winRate,_bn=sd.wf.buy.wins+sd.wf.buy.losses,_sn=sd.wf.sell.wins+sd.wf.sell.losses;
        if(!S.ai.prior)S.ai.prior={};
        if(_bw!=null&&_bn>=THRESH.BT_PRIOR_MIN_SAMPLES)S.ai.prior['共振买入']={wr:_bw,n:_bn,t:Date.now()};
        if(_sw!=null&&_sn>=THRESH.BT_PRIOR_MIN_SAMPLES)S.ai.prior['共振卖出']={wr:_sw,n:_sn,t:Date.now()};
      }
    }
    // ===== 持仓量(OI)信号: 上升=趋势确认, 下降=趋势减弱 =====
    if(fusionOn('OI')){
      var oiHis=S.fusion.oiHis&&S.fusion.oiHis[sym.id];
      if(oiHis&&oiHis.length>5){
        var oiNow=oiHis[oiHis.length-1],oiPrev=oiHis[oiHis.length-6];
        if(oiNow>oiPrev*1.02){
          if(sig.indexOf('短线多头')>=0){ls+=6*getSigScore('持仓量上升');sig.push('持仓量上升');}
          else if(sig.indexOf('短线空头')>=0){ss+=6*getSigScore('持仓量上升');sig.push('持仓量上升');}
        }else if(oiNow<oiPrev*0.98){
          if(sig.indexOf('短线多头')>=0){ls+=3*getSigScore('持仓量下降');sig.push('持仓量下降');}
          else if(sig.indexOf('短线空头')>=0){ss+=3*getSigScore('持仓量下降');sig.push('持仓量下降');}
        }
      }
    }
    // ===== 消息面(新闻)信号: CoinDesk RSS 关键词情绪 → 利好/利空 (三层分析之消息面) =====
    // 新鲜度: 最近 NEWS_FRESH_MAX 内拉取的新闻才参与信号; 情绪净分 |net|>=阈值触发
    var news=S.fusion.news&&S.fusion.news[sym.id];
    if(news&&news.items&&news.items.length&&Date.now()-news.t<THRESH.NEWS_FRESH_MAX){
      var ns=newsSentiment(news.items);
      if(ns.net>=THRESH.NEWS_SENTIMENT_THR){ls+=THRESH.NEWS_SENTIMENT_SCORE*getSigScore('新闻利好');sig.push('新闻利好');trigger=true;}
      else if(ns.net<=-THRESH.NEWS_SENTIMENT_THR){ss+=THRESH.NEWS_SENTIMENT_SCORE*getSigScore('新闻利空');sig.push('新闻利空');trigger=true;}
    }
    // ===== LLM 信号融合: 大模型判断作为独立信号源(仍受下方方向门/风控约束) =====
    if(llmCfg.on&&S.ai.llm&&S.ai.llm.symbols){
      var _lv=S.ai.llm.symbols[sym.id];
      if(_lv){llmLv=_lv;
        if(_lv.direction==='long'&&_lv.confidence>=llmCfg.minConf){ls+=llmCfg.weight*getSigScore('LLM做多');sig.push('LLM做多');trigger=true;}
        else if(_lv.direction==='short'&&_lv.confidence>=llmCfg.minConf){ss+=llmCfg.weight*getSigScore('LLM做空');sig.push('LLM做空');trigger=true;}
      }
    }
    // ===== 波动率风控: 记录1t ATR历史, 突发爆表标记 =====
    var atrNow=ind&&ind['1t']&&ind['1t'].atr;
    var vFlag=false;
    if(atrNow&&p.last>0){
      var atrPct=atrNow/p.last*100;
      if(atrPct>0){
        var ah=S.ai.atrHis[sym.id]||(S.ai.atrHis[sym.id]=[]);
        ah.push(atrPct);if(ah.length>40)ah.shift();
        var ahs=ah.slice().sort(function(a,b){return a-b;});
        var base=ahs[Math.floor(ahs.length/2)]||atrPct;
        if(atrPct>base*THRESH.ATR_BLOWUP_MULT&&atrPct>THRESH.ATR_BLOWUP_PCT)vFlag=true;
      }
    }
    // ===== 顺势过滤: 无对应趋势信号的方向降权(避免逆势开仓) =====
    if(sig.indexOf('短线多头')<0)ls*=0.4;
    if(sig.indexOf('短线空头')<0)ss*=0.4;
    // ===== 中期(1m)方向门(所有模式生效): 1m趋势定方向, 1t信号只做确认/回调 =====
    // 这是关键修复: 此前标准模式下1t信号可独立决定方向, 导致每4s方向翻转
    var h1m=S.hist1m[sym.id];
    var gate=h1m&&h1m.length>=30?trendGate(h1m.map(function(x){return x.p;})):{gate:'unknown',label:'1m数据不足'};
    S.ai.lastGate=gate.label;
    // 方向门抑制随 1m 斜率连续化: 斜率越大趋势越强→逆势越被压制; 横盘(slope≈0)→仅轻抑, 不再硬清零
    var slope=gate.slopePct||0;
    if(gate.gate==='long'){
      ss*=gateKeepFactor(slope);
      if(sig.indexOf('短线多头')<0)ls*=0.5;
      S.ai.lastGate+=' → 多头(逆势抑制×'+gateKeepFactor(slope).toFixed(2)+')';
    }else if(gate.gate==='short'){
      ls*=gateKeepFactor(slope);
      if(sig.indexOf('短线空头')<0)ss*=0.5;
      S.ai.lastGate+=' → 空头(逆势抑制×'+gateKeepFactor(slope).toFixed(2)+')';
    }else if(gate.gate==='none'){
      ls*=0.6;ss*=0.6;S.ai.lastGate+=' → 横盘轻微降权';
    }else{
      ls*=0.5;ss*=0.5;S.ai.lastGate+=' → 等待数据';
    }
    // ===== 顺势回调模式: 在1m方向门内, 额外要求 1t 回踩入场确认 =====
    if(tradeMode==='trend'&&i1){
      if(gate.gate==='long'){
        var pb=pullbackEntry(i1,'long');
        if(pb.ready){ls+=30*getSigScore('顺势回调');sig.push('顺势回调');trigger=true;S.ai.lastGate+=' → 回踩企稳做多';}
        else ls*=0.3;
      }else if(gate.gate==='short'){
        var pb2=pullbackEntry(i1,'short');
        if(pb2.ready){ss+=30*getSigScore('顺势回调');sig.push('顺势回调');trigger=true;S.ai.lastGate+=' → 反弹走弱做空';}
        else ss*=0.3;
      }
    }
    // 缓存未阻尼的原始评分, 供 AI 平仓管理(评分反转)使用
    S.ai.lastScores[sym.id]={ls:ls,ss:ss,side:ls>ss?'long':ss>ls?'short':'flat',sig:sig.slice(),t:Date.now()};
    var alreadyHas=S.pos.find(function(pos){return pos.sym===sym.id;});
    if(alreadyHas){ls*=0.3;ss*=0.3;}
    var side=ls>ss?'long':ss>ls?'short':'flat';
    // ===== LLM 可参与交易: 角色=trade 且 LLM 方向与最终方向一致且置信达标 → 独立触发开仓 =====
    // 注意: 方向门已在上方把 LLM 逆势方向清零, 故此处 side 与 llmLv.direction 一致才生效(门仍是硬约束)
    llmFire = llmCfg.on && llmCfg.role==='trade' && llmLv && llmLv.direction===side && llmLv.confidence>=llmCfg.minConf;
    llmConfHere = llmFire ? llmLv.confidence : 0;
    var conf=Math.min(95,50+Math.max(ls,ss));
    var signalCount=sig.length;
    if(signalCount>=2)conf+=5;
    // ===== 恐惧贪婪(FG)只调节置信度, 不参与方向判定 =====
    // 极贪(fg>75)时顺势做多降权/做空加权; 极恐(fg<25)时做空降权/做多加权
    var fgNow=S.fusion.fg||50;
    if(fgNow>75){conf+=side==='short'?8:0; if(side==='long')conf-=6;}
    else if(fgNow>60){conf+=side==='short'?4:0;}
    else if(fgNow<25){conf+=side==='long'?8:0; if(side==='short')conf-=6;}
    else if(fgNow<40){conf+=side==='long'?4:0;}
    conf=Math.min(95,conf);
    // ===== 三层共振 (阶段三): AI方向 × 量价背离 × 支撑/阻力 一致性确认 =====
    // 层1=side(AI方向), 层2=量价背离, 层3=贴近支撑/阻力(1×ATR内)。三层一致 → 强确认信号+置信加成。
    // 反向时(信号与 side 冲突)不加成不触发, 仅保留基础分, 避免噪声开仓。
    var tlRes=null;
    if((side==='long'||side==='short')&&spk&&spkV&&spk.length>=20&&spkV.length>=20){
      tlRes=threeLayerResonance(spk,spkV,i1&&i1.atr?i1.atr:null,side);
      if(tlRes&&tlRes.resonance){
        var tlName=side==='long'?'三层共振多':'三层共振空';
        sig.push(tlName);
        trigger=true;
        conf=Math.min(95,conf+15);
        S.ai.lastGate+=' → 三层共振'+(side==='long'?'多':'空')+'(量价+支撑阻力一致, +15置信)';
        // 阶段四: 三层共振=高价值触发事件, 记录供 LLM 立即分析
        S.ai.llmTrigger={sym:sym.id,reason:'三层共振'+(side==='long'?'多':'空')+'(量价+支撑阻力+AI方向一致)',conf:conf,t:Date.now()};
      }
    }
    var score=Math.max(ls,ss)-Math.min(ls,ss)*0.3+signalCount*3;
    if(score>bestScore){bestScore=score;bestSym=sym;bestSide=side;bestConf=conf;bestSig=filterSignalsBySide(sig,side);bestTrigger=trigger;bestVolatile=vFlag;bestLLMFire=llmFire;bestLLMConf=llmConfHere;bestRegime=_regimeMap[sym.id];}
  });
  S.ai._regime=null; // 循环结束, 复位 getSigScore 权重(防 AI 进化页拿到陈旧状态)
  manageAIExits();
  if(!bestSym)return;
  // 方向不可判定(ls=ss=0)时不开仓, 避免误入
  if(bestSide!=='long'&&bestSide!=='short')return;
  // ===== 方向翻转抑制: 若方向翻转但score优势<15, 沿用上次方向(减少噪声翻转) =====
  if(S.ai.lastSide&&bestSide!==S.ai.lastSide&&bestScore<15){
    bestSide=S.ai.lastSide;
    S.ai.lastGate+=' → 翻转抑制(维持'+(bestSide==='long'?'多':'空')+')';
  }
  S.ai.lastSide=bestSide;
  S.ai.dec.push({sym:bestSym.id,side:bestSide,conf:bestConf,reason:bestSig.join('+'),t:Date.now(),ex:false,gate:S.ai.lastGate||''});
  S.ai.prompt='市场: '+bestSym.id+' $'+bestSym.id+'\n信号: '+bestSig.join(', ')+'\n决策: '+(bestSide==='long'?'做多':'做空')+' '+bestConf+'%'+(S.ai.lastGate?'\n方向门: '+S.ai.lastGate:'');
  // 终端日志节流: 仅当决策内容变化 或 距上次日志>60s 才打印, 避免每 15s 刷屏
  {
    const aiLogLine='[AI] '+bestSym.id+' '+(bestSide==='long'?'做多':'做空')+' 置信:'+bestConf+'% | '+bestSig.join('+')+(S.ai.lastGate?' | 门:'+S.ai.lastGate:'');
    const nowL=Date.now();
    if(aiLogLine!==lastAiLog||nowL-lastAiLogT>60000){
      lastAiLog=aiLogLine;lastAiLogT=nowL;
      log('ai',aiLogLine);
    }
  }
  // 执行门槛: 常规=置信≥设置值 且 ≥2信号 且 有触发事件(共振/超买卖/急涨急跌/费率/恐慌等)
  // LLM 可参与交易角色: LLM 高置信本身即可作为触发条件与信号数量条件(仍受全部风控)
  var sub=null;
  var effConf=bestLLMFire?Math.max(bestConf,bestLLMConf):bestConf;
  var wantEnter=effConf>=minConf&&(bestSig.length>=2||bestLLMFire)&&(bestTrigger||bestLLMFire);
  // 阶段5: 每日 AI 上限随市场状态缩放(aiMaxScale: 高波/震荡降频, 趋势正常)
  var _rpBest=bestRegime?regimeParams(bestRegime):null;
  var aiMaxEff=Math.max(4,Math.round(aiMax*(_rpBest?_rpBest.aiMaxScale:1)));
  var longCount=S.pos.filter(function(x){return x.side==='long';}).length;
  var shortCount=S.pos.filter(function(x){return x.side==='short';}).length;
  var block='';
  if(wantEnter){
    if(!autoOn)block='自动交易未开启';
    else if(!marketFresh(bestSym.id))block='行情数据不新鲜';
    else if(bestVolatile)block='波动过大(ATR爆表)';
    else if(!cooldownOK)block='冷却中(15s)';
    else if(S.ai.dayCount>=aiMaxEff)block='已达每日AI上限('+aiMaxEff+')';
    else if(dayPnl<=-maxDailyLoss)block='已达每日最大亏损';
    else if(bestSide==='long'&&longCount>=dirCap('long'))block='同向仓位过多(多)['+dirCap('long')+']';
    else if(bestSide==='short'&&shortCount>=dirCap('short'))block='同向仓位过多(空)['+dirCap('short')+']';
    else if(S.pos.length>=totalCap())block='总仓位已达上限('+totalCap()+')';
    else if(S.ai.lastEnter&&S.ai.lastEnter.sym===bestSym.id&&S.ai.lastEnter.side===bestSide&&Date.now()-S.ai.lastEnter.t<THRESH.SAME_ENTER_COOLDOWN)block='同币同向冷却(60s)';
    else{sub=S.subs.find(function(s){return s.st==='idle'&&s.bal>=5;});if(!sub)block='无空闲子账户';}
  }
  if(block&&block!==S.ai.lastBlock){S.ai.lastBlock=block;log('ai','[AI] 拦截: '+block+' | '+bestSym.id+' '+(bestSide==='long'?'做多':'做空')+' '+bestConf+'% | '+bestSig.join('+'));}
  if(wantEnter&&!block&&sub){
    var amt;
    if(effConf>=85)amt=Math.round(Math.min(25,sub.bal*0.25));
    else if(effConf>=75)amt=Math.round(Math.min(20,sub.bal*0.2));
    else amt=Math.round(Math.min(15,sub.bal*0.15));
    amt=Math.max(5,amt);
    if(maxOrder>0&&amt>maxOrder)amt=Math.floor(maxOrder);
    if(amt>sub.bal)amt=Math.floor(sub.bal);
    if(amt<5){block='单笔小于$5';}
    var aiL=P.aiLev||{hi:15,mid:10,lo:5};
    var lev;
    if(effConf>=80)lev=Math.min(P.maxLev,aiL.hi);
    else if(effConf>=70)lev=Math.min(P.maxLev,aiL.mid);
    else lev=Math.min(P.maxLev,aiL.lo);
  if(block&&block!==S.ai.lastBlock){S.ai.lastBlock=block;recordLedgerEvent('risk','[AI拦截] '+block+' | '+bestSym.id+' '+(bestSide==='long'?'做多':'做空')+' '+bestConf+'% | '+bestSig.join('+'));log('ai','[AI] 拦截: '+block+' | '+bestSym.id+' '+(bestSide==='long'?'做多':'做空')+' '+bestConf+'% | '+bestSig.join('+'));}
    if(!block){
      var _llmTag=bestLLMFire?'[LLM触发]':'';
      S.ai.tt++;
      S.ai.dayCount++;
      S.ai.lastExecT=Date.now();
      S.ai.lastEnter={sym:bestSym.id,side:bestSide,t:Date.now()};
      S.ai.lastCtx={conf:effConf,llmTrade:bestLLMFire?1:0,gate:S.ai.lastGate||'',regime:S.ai.lastRegime||'',fg:S.fusion.fg||50,signals:bestSig.join('+')+_llmTag,posLong:longCount,posShort:shortCount,total:S.pos.length,totalEq:S.total||0};
      recordLedgerEvent('ai','[AI开仓] '+bestSym.id+' '+(bestSide==='long'?'做多':'做空')+' '+lev+'x $'+amt+' 置信'+effConf+'% | '+bestSig.join('+')+_llmTag+' | 门:'+(S.ai.lastGate||'-'));
      openTrade(bestSym.id,sub.id,bestSide,lev,amt,true,bestSig.join('+')+_llmTag,S.ai.lastCtx);
      S.ai.dec[S.ai.dec.length-1].ex=true;
    }
  }
  // 无交易时的心跳: 每 5 分钟记录一次最佳信号摘要(让账本保持活跃, 避免看上去系统"死掉")
  if(!S.ai._lastHeartbeat||Date.now()-S.ai._lastHeartbeat>300000){
    S.ai._lastHeartbeat=Date.now();
    var hbDir=bestSide==='long'?'做多':'做空';
    var hbBlock=block||(bestSym?'':'无有效信号');
    recordLedgerEvent('ai','[AI心跳] '+bestSym.id+' '+hbDir+' 置信'+bestConf+'% | 信号: '+bestSig.join('+')+(hbBlock?' | '+hbBlock:''));
  }
}

// ===== AI 平仓管理: 开关开启时, 对 AI 持仓提前平仓(LLM逆势 / 评分反转) =====
function manageAIExits(){
  var on=document.getElementById('setAiMgmtOn')?.value==='1';
  if(!on)return;
  var confThr=parseFloat(document.getElementById('setAiMgmtConf')?.value||THRESH.EXIT_CONF_THR);
  var holdMin=parseFloat(document.getElementById('setAiMgmtHoldMin')?.value||THRESH.EXIT_HOLD_MIN);
  var daily=parseInt(document.getElementById('setAiMgmtDaily')?.value||THRESH.EXIT_MAX_DAY);
  if(isNaN(confThr))confThr=THRESH.EXIT_CONF_THR;if(isNaN(holdMin))holdMin=THRESH.EXIT_HOLD_MIN;if(isNaN(daily))daily=THRESH.EXIT_MAX_DAY;
  // 每日提前平仓计数(跨天重置)
  var day=aiDayStr();
  if(S.ai.mgmtDayDate!==day){S.ai.mgmtDayDate=day;S.ai.mgmtCount=0;}
  if(S.ai.mgmtCount>=daily)return;
  var holdMs=holdMin*60000;
  var llm=S.ai.llm;
  var llmV=S.ai.llm&&S.ai.llm.symbols?S.ai.llm.symbols:{};
  // 初始化反转确认历史(仅内存, 跨 manageAIExits 帧计数; 不随 localStorage 持久化, 重启重建)
  if(!S.ai.reversalHist)S.ai.reversalHist={};
  // 倒序遍历, 平仓后 splice 不影响前面索引
  for(var i=S.pos.length-1;i>=0;i--){
    var pos=S.pos[i];
    if(!pos||!pos.ai)continue;
    if(Date.now()-pos.openTime<holdMs)continue; // 最短持有保护
    var sc=S.ai.lastScores[pos.sym]||null;
    var v=llmV[pos.sym]||null;
    // 自适应 exitSpreadThr: 由 regimeState 决定(震荡市低, 趋势市高)
    var _ind1t=S.indicators[pos.sym]&&S.indicators[pos.sym]['1t'];
    var _pctHis=S.ai.atrSuper&&S.ai.atrSuper[pos.sym]&&S.ai.atrSuper[pos.sym]['1t']&&S.ai.atrSuper[pos.sym]['1t'].pctHis;
    var _state=_ind1t&&_ind1t.series?detectRegimeState(_ind1t.series,{pctHis:_pctHis}):null;
    var _rp=_state?regimeParams(_state):null;
    var _exitThr=_rp?_rp.exitSpreadThr:THRESH.EXIT_SPREAD_THR;
    var r1=shouldScoreExit(pos,sc,_exitThr,{hist:S.ai.reversalHist,confirmBars:2});
    var r2=shouldLLMExit(pos,v,confThr);
    if(r1.exit||r2.exit){
      S.ai.mgmtCount++;
      var reason=r2.exit?r2.reason:r1.reason;
      log('ai','[AI] '+reason+' | '+pos.sym+' '+(pos.side==='long'?'多':'空')+' 盈亏$'+pos.pnl.toFixed(2));
      closePos(i,reason);
      if(S.ai.mgmtCount>=daily)return;
    }
  }
}

function fullMarketAnalysis(){
  const btn=document.getElementById('btnFullAnalysis');
  const el=document.getElementById('fullAnalysisResult');
  if(S.ai.faOpen){
    S.ai.faOpen=false;if(el)el.innerHTML='';renderFullAnalysis();
    if(btn)btn.innerHTML='&#9670; '+t('ai_full_label');
    return;
  }
  if(btn){btn.disabled=true;btn.innerHTML='&#9670; 分析中...';}
  var results=[];
  var bullCount=0,bearCount=0,neutCount=0;
  var totalFR=0,frCount=0;
  var whaleBias=0;
  var fg=S.fusion.fg||50;
  SYMS.forEach(function(sym){
    var p=S.prices[sym.id];
    var okxP=S.okx[sym.id]||0;
    var fr=S.fusion.fr[sym.id]||0;
    var oi=S.fusion.oi[sym.id]||0;
    var sig=[];var sigS=[];var ls=0,ss=0;
    if(p.chg<-3){ls+=25;sig.push('超跌'+p.chg.toFixed(1)+'%');sigS.push('跌多了可能反弹');}
    else if(p.chg<-1){ls+=10;sig.push('小跌'+p.chg.toFixed(1)+'%');sigS.push('在跌');}
    else if(p.chg>3){ss+=25;sig.push('超涨+'+p.chg.toFixed(1)+'%');sigS.push('涨太多了可能要跌');}
    else if(p.chg>1){ss+=10;sig.push('小涨+'+p.chg.toFixed(1)+'%');sigS.push('在涨');}
    else{sig.push('横盘'+p.chg.toFixed(1)+'%');sigS.push('没啥动静');}
    if(fr<-.001){ls+=20;sig.push('负费率'+(fr*100).toFixed(3)+'%');sigS.push('空头在付钱');}
    else if(fr<-.0003){ls+=10;sig.push('偏低费率');sigS.push('费用偏空');}
    else if(fr>.001){ss+=20;sig.push('正费率'+(fr*100).toFixed(3)+'%');sigS.push('多头在付钱');}
    else if(fr>.0003){ss+=10;sig.push('偏高费率');sigS.push('费用偏多');}
    totalFR+=fr;frCount++;
    if(fg<20){ls+=15;sig.push('极恐'+fg);sigS.push('市场很害怕');}
    else if(fg<35){ls+=8;sig.push('恐惧'+fg);sigS.push('市场害怕');}
    else if(fg>80){ss+=15;sig.push('极贪'+fg);sigS.push('市场太兴奋');}
    else if(fg>65){ss+=8;sig.push('贪婪'+fg);sigS.push('市场兴奋');}
    var ws=S.fusion.whales.filter(function(w){return w.sym===sym.id;});
    ws.forEach(function(w){
      if(w.dir==='in'){ls+=10;sig.push('鲸鱼转入$'+w.amt+'K');sigS.push('大户在买入');whaleBias++;}
      else{ss+=10;sig.push('鲸鱼转出$'+w.amt+'K');sigS.push('大户在卖出');whaleBias--;}
    });
    var spread=0;
    if(okxP>0){spread=Math.abs(p.last-okxP)/Math.min(p.last,okxP)*100;}
    if(spread>0.1){sig.push('价差'+spread.toFixed(3)+'%');sigS.push('两个交易所价差大');}
    var side=ls>ss?'long':ss>ls?'short':'neutral';
    var conf=Math.min(95,45+Math.max(ls,ss));
    if(side==='long')bullCount++;else if(side==='short')bearCount++;else neutCount++;
    results.push({sym:sym.id,last:p.last,chg:p.chg,fr:fr,side:side,conf:conf,sig:sig,sigS:sigS});
  });
  var avgFR=frCount>0?totalFR/frCount:0;
  var marketDir=bullCount>bearCount*1.5?'bullish':bearCount>bullCount*1.5?'bearish':'sideways';
  var dirLabel=marketDir==='bullish'?'整体偏多':marketDir==='bearish'?'整体偏空':'震荡观望';
  var dirColor=marketDir==='bullish'?'var(--green)':marketDir==='bearish'?'var(--red)':'var(--gold)';
  var fgLabel=fg<20?'极度恐惧':fg<35?'恐惧':fg<50?'偏恐惧':fg<65?'中性':fg<80?'贪婪':'极度贪婪';
  S.ai.fullAnalysis={ts:Date.now(),marketDir:marketDir,dirLabel:dirLabel,dirColor:dirColor,fg:fg,fgLabel:fgLabel,avgFR:avgFR,bullCount:bullCount,bearCount:bearCount,neutCount:neutCount,whaleBias:whaleBias,results:results};
  S.ai.faOpen=true;
  renderFullAnalysis();
  if(btn){btn.disabled=false;btn.innerHTML='&#9670; '+t('ai_full_close');}
}

function renderFullAnalysis(){
  var el=document.getElementById('fullAnalysisResult');if(!el)return;
  var a=S.ai.fullAnalysis;
  if(!a||!S.ai.faOpen){el.innerHTML='';return;}
  var sp=mode==='simple';
  var dirText=sp?(a.marketDir==='bullish'?'多数在涨':a.marketDir==='bearish'?'多数在跌':'没啥方向'):a.dirLabel;
  var fgText=sp?(a.fgLabel+'('+a.fg+'分)'):(a.fg+'('+a.fgLabel+')');
  var frText=sp?((a.avgFR*100).toFixed(2)+'%'):(a.avgFR*100).toFixed(4)+'%';
  var wText=sp?(a.whaleBias>0?'大户在买':a.whaleBias<0?'大户在卖':'大户没动'):(a.whaleBias>0?'净流入':a.whaleBias<0?'净流出':'平衡');
  var h='<div class="fa-summary"><h4>&#9670; '+(sp?'整体看啥情况':'市场总览')+' <span style="font-size:8px;color:var(--text2)">('+new Date(a.ts).toLocaleTimeString()+')</span></h4><div class="fa-row">'
    +'<div class="fa-tag" style="color:'+a.dirColor+';border:1px solid '+a.dirColor+'">'+dirText+'</div>'
    +'<div class="fa-tag">'+(sp?'情绪:':'F&G:')+' <span style="color:'+(a.fg<30?'var(--green)':a.fg>70?'var(--red)':'var(--gold)')+'">'+fgText+'</span></div>'
    +'<div class="fa-tag">'+(sp?'费用:':'均费率:')+' '+frText+'</div>'
    +'<div class="fa-tag">'+(sp?'涨:'+a.bullCount+' 跌:'+a.bearCount+' 平:'+a.neutCount:'多:'+a.bullCount+' 空:'+a.bearCount+' 观望:'+a.neutCount)+'</div>'
    +'<div class="fa-tag">'+(sp?'大户:':'鲸鱼:')+' '+wText+'</div>'
    +'</div></div>';
  a.results.forEach(function(r){
    var chgC=r.chg>=0?'var(--green)':'var(--red)';
    var dirC=r.side==='long'?'var(--green)':r.side==='short'?'var(--red)':'var(--text2)';
    var dirBg=r.side==='long'?'rgba(0,230,118,.15)':r.side==='short'?'rgba(255,82,82,.15)':'rgba(107,118,136,.1)';
    var dirText=r.side==='long'?(sp?'买涨':'做多'):r.side==='short'?(sp?'买跌':'做空'):(sp?'别动':'观望');
    var confC=r.conf>=70?'var(--green)':r.conf>=55?'var(--gold)':'var(--text2)';
    var sigText=sp?(r.sigS[0]||''):r.sig[0];
    var confText=sp?((r.conf>=70?'把握大':r.conf>=55?'还行':'不太确定')):(r.conf+'%');
    h+='<div class="fa-coin">'
      +'<div class="fa-coin-left"><span class="fa-coin-sym">'+r.sym.replace('USDT','')+'</span><span class="fa-coin-price">$'+fp(r.last)+'</span><span class="fa-coin-chg" style="color:'+chgC+'">'+(r.chg>=0?'+':'')+r.chg.toFixed(1)+'%</span></div>'
      +'<div class="fa-coin-right"><span class="fa-coin-sig" title="'+(sp?r.sigS.join(', '):r.sig.join(', '))+'">'+sigText+'</span><span class="fa-coin-dir" style="color:'+dirC+';background:'+dirBg+'">'+dirText+'</span><span class="fa-coin-conf" style="color:'+confC+'">'+confText+'</span></div></div>';
  });
  el.innerHTML=h;
}

function openTrade(sym,sid,side,lev,amt,aiFlag,sig,ctx){
  const price=S.prices[sym]&&S.prices[sym].last,sub=S.subs[sid-1];
  if(!price||!sub||sub.bal<amt)return;lev=Math.min(lev,P.maxLev);
  if(window.paperEngine){
    window.paperEngine.placeOrder({symbol:sym,sub:sid,side,lev,amt,ai:!!aiFlag,sig:sig||''});
    const np=window.paperEngine.S.pos[window.paperEngine.S.pos.length-1];
    if(np&&np.ai&&ctx)np.aiCtx=ctx;
    saveState(true);return;
  }
  const slip=parseFloat(document.getElementById('setSlipProtect')?.value||SLIP);
  const entryPrice=side==='long'?price*(1+slip):price*(1-slip);
  const qty=(amt*lev)/entryPrice;
  const fee=amt*lev*FEE;
  S.pos.push({sym,sid,side,lev,qty,entry:entryPrice,pnl:0,pnlPct:0,be:false,tl:0,hi:entryPrice,lo:entryPrice,fee:fee,ai:!!aiFlag,amt:amt,sig:sig||'',openTime:Date.now(),pnlHis:[0],aiCtx:ctx||null});
  sub.bal-=(amt+fee);sub.st='active';sub.tr++;
  log('trade','[sub-'+pf(sid)+'] '+(side==='long'?'做多':'做空')+' '+sym+' '+lev+'x $'+amt+' @ $'+entryPrice.toFixed(2)+' 手续费:$'+fee.toFixed(3));
  log('sub','[sub-'+pf(sid)+'] 开仓 '+sym+' '+(side==='long'?'做多':'做空')+' '+lev+'x $'+amt);
  saveState(true);
}

function closePos(i,reason){
  const pos=S.pos[i];if(!pos)return;
  const closeReason=reason||'手动平仓';
  if(window.paperEngine){
    window.paperEngine.exitPosition(pos,{reason:closeReason});
    saveState(true);render();return;
  }
  const sub=S.subs[pos.sid-1];
  const slip=parseFloat(document.getElementById('setSlipProtect')?.value||SLIP);
  const closeFee=pos.entry*pos.qty*FEE;
  const margin=pos.amt||(pos.entry*pos.qty/pos.lev);
  const ret=margin+pos.pnl-closeFee;
  sub.bal+=ret;S.realized+=(pos.pnl-closeFee);if(pos.pnl>0)sub.w++;
  if(pos.ai){if(pos.pnl>0)S.ai.w++;else S.ai.l++;}
  if(pos.ai&&pos.sig)recordSigResult(pos.sig,pos.pnl>=0?'win':'lose',pos.pnl);
  if(pos.ai)recordDirResult(pos.side,pos.pnl);
  if(pos.ai)recordClosedTrade(pos,pos.pnl-closeFee,closeReason,(S.prices[pos.sym]||{}).last);
  log('trade','[sub-'+pf(pos.sid)+'] 平仓 '+pos.sym+' 盈亏: $'+pos.pnl.toFixed(2)+' 手续费: $'+closeFee.toFixed(3));
  log('sub','[sub-'+pf(pos.sid)+'] 平仓 '+pos.sym+' 盈亏:$'+pos.pnl.toFixed(2));
  S.closed.push({t:Date.now(),sym:pos.sym,side:pos.side,lev:pos.lev,sub:pos.sid,pnl:Math.round((pos.pnl-closeFee)*100)/100,reason:closeReason,entry:pos.entry,exit:(S.prices[pos.sym]||{}).last});
   S.pos.splice(i,1);sub.st='idle';
   saveState(true);render();
}

function setRiskPreset(p){rp=p;Object.assign(P,RP[p]);
  const ml=document.getElementById('setMaxLev');if(ml)ml.value=P.maxLev+'x';
  // 联动 AI 风控参数到预设(置信度/每日上限/单笔/每日亏损)
  const aiMap={setMinConf:P.minConf,setAiMax:P.aiMax,setMaxOrder:P.maxOrder,setMaxDailyLoss:P.maxDailyLoss};
  Object.keys(aiMap).forEach(id=>{const el=document.getElementById(id);if(el)el.value=aiMap[id];});
  while(S.subs.length<P.count){
    const i=S.subs.length;
    S.subs.push({id:i+1,bal:P.size,st:'idle',pnl:0,ex:i%2===0?'Binance':'OKX',tr:0,w:0});
  }
  document.getElementById('maxPos').textContent=S.subs.length;
  recordLedgerEvent('risk','[风控] 切换到'+RP[p].label+'模式 | 最大'+P.maxLev+'x杠杆 | AI: 置信≥'+P.minConf+'% 日限'+P.aiMax+'次 单笔≤$'+P.maxOrder+' 日亏≤$'+P.maxDailyLoss);
  log('sys','切换到'+RP[p].label+'模式 | 最大'+P.maxLev+'x杠杆 | AI: 置信≥'+P.minConf+'% 日限'+P.aiMax+'次 单笔≤$'+P.maxOrder+' 日亏≤$'+P.maxDailyLoss);updateTexts();render();
  saveState(true);
}
function applyMaxLev(){
  const v=parseInt((document.getElementById('setMaxLev')?.value||'20').replace('x',''));
  if(v>0&&v!==P.maxLev){P.maxLev=v;log('sys','最大杠杆已设为 '+v+'x');}
  saveState(true);
}
function aiDayStr(){return new Date().toDateString();}
function marketFresh(sym){const t=S.prices[sym]&&S.prices[sym].lastT;return t&&Date.now()-t<THRESH.FRESH_SECS*1000;}
function okxFresh(sym){const t=S.okxT&&S.okxT[sym];return t&&Date.now()-t<120000;}
function fusionOn(k){const el=document.getElementById('setFusion'+k);return !el||el.value==='1';}
function restart(){localStorage.removeItem('smartTrader');location.reload();}

function log(tag,msg){const t=new Date().toTimeString().slice(0,8);S.logs.push({t,tag,msg});
  if(S.lf!=='all'&&S.lf!==tag)return;
  const b=document.getElementById('terminalBody');if(!b)return;
  b.innerHTML+='<div class="log-entry"><span class="log-time">'+t+'</span><span class="log-tag '+tag+'">['+tag.toUpperCase()+']</span><span class="log-msg">'+tl(msg)+'</span></div>';
  b.scrollTop=b.scrollHeight;if(b.children.length>200)b.removeChild(b.firstChild);}
// 账本事件: 仅记录有审计意义的金融/风控/AI 决策事件(终端日志不再入账本)
function recordLedgerEvent(tag,msg){if(window.__eventSink)try{window.__eventSink({type:'ledger',tag,msg,ts:Date.now()});}catch(e){}}

function setTermTab(el,f){document.querySelectorAll('.terminal-tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');S.lf=f;refreshTerminal();}

let curPage='dashboard';
function switchPage(p,el){document.querySelectorAll('.page').forEach(pg=>pg.classList.remove('active'));
  document.getElementById('page-'+p).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));el.classList.add('active');
  curPage=p;renderPage(p);
  if(p==='fusion'){fetchBinanceLSData();fetchMultiTF();fetchOnChain();}}

function render(){renderTickers();renderSidebar();renderPositions();renderStats();renderPage(curPage);}

function renderTickers(){
  memoizeRender('tickers',sigOfPrices()+S.sel+'|'+Math.round((S.fusion.fg||0)/5)+'|'+((S.fusion.fr['BTCUSDT']||0)*10000|0)+'|'+((S.fusion.oi['BTCUSDT']||0)/1e6|0)+'|'+S.active.size,()=>{
  const grid=document.getElementById('tickerGrid');
  grid.innerHTML=SYMS.filter(s=>S.active.has(s.id)).map(s=>{
    const p=S.prices[s.id],o=S.okx[s.id];
    const cc=p.chg>=0?'up':'down',cs=p.chg>=0?'+':'',sel=S.sel===s.id?' selected':'';
    const be=S.pos.find(x=>x.sym===s.id&&x.be);
    const sp=Math.abs(p.last-o)/Math.min(p.last,o)*100;
    const fr=S.fusion.fr[s.id],fgv=S.fusion.fg;
    const ind=S.indicators[s.id];
    const res=ind&&ind['1t']&&ind['1t'].resonance;
    const resBadge=res&&res.buy?'<span class="res-badge buy">▲</span>':res&&res.sell?'<span class="res-badge sell">▼</span>':'<span class="res-badge neut">◆</span>';
    return '<div class="ticker-card'+sel+'" onclick="selectSym(\''+s.id+'\')">'
      +'<div class="ticker-top"><div class="ticker-badge">'+s.id.replace('USDT','')+'</div><div class="ticker-top-right"><div class="ticker-sym">'+s.icon+' '+s.name+'</div>'+(be?'<div class="breakeven-badge">'+t('card_be')+'</div>':'')+'</div></div>'
      +'<div class="ticker-price">$'+fp(p.last)+resBadge+'</div>'
      +'<div class="ticker-chg '+cc+'">'+cs+p.chg.toFixed(2)+'% '+(p.chg>=0?'↑':'↓')+'</div>'
      +'<canvas class="ticker-spark" id="sp_'+s.id+'" width="165" height="24"></canvas>'
      +'<div class="spread-bar"><span style="color:var(--gold)">'+t('card_spread')+sp.toFixed(3)+'%</span>'
      +'<div class="spread-fill"><div class="spread-fill-inner" style="width:'+Math.min(100,sp*50)+'%;background:'+(sp>.2?'var(--gold)':'var(--border)')+'"></div></div></div>'
      +'<div class="ticker-data"><span style="color:'+(fr>=0?'var(--red)':'var(--green)')+'">'+t('card_fee')+(fr*100).toFixed(4)+'%</span>'
      +'<span>'+t('card_oi')+' $'+(S.fusion.oi[s.id]/1e6).toFixed(0)+'M</span>'
      +'<span style="color:'+(fgv<30?'var(--green)':fgv>70?'var(--red)':'var(--text2)')+'">'+t('card_fg')+' '+fgv+'</span></div>'
      +'<div class="ticker-actions">'
      +'<button class="btn btn-buy" onclick="event.stopPropagation();openModal(\''+s.id+'\',\'long\')">'+t('card_buy')+'</button>'
      +'<button class="btn btn-sell" onclick="event.stopPropagation();openModal(\''+s.id+'\',\'short\')">'+t('card_sell')+'</button>'
      +'<button class="btn btn-ai" onclick="event.stopPropagation();aiTrade(\''+s.id+'\')">'+t('card_ai')+'</button></div></div>';
  }).join('');
  SYMS.forEach(s=>{const cv=document.getElementById('sp_'+s.id);if(!cv)return;
    const ctx=cv.getContext('2d'),d=S.spark[s.id],mn=Math.min(...d),mx=Math.max(...d),rng=mx-mn||1;
    ctx.clearRect(0,0,165,24);const isUp=d[d.length-1]>=d[0];
    const grad=ctx.createLinearGradient(0,0,0,24);
    grad.addColorStop(0,isUp?'rgba(255,82,82,.2)':'rgba(0,230,118,.2)');grad.addColorStop(1,'transparent');
    ctx.beginPath();d.forEach((v,i)=>{const x=(i/(d.length-1))*165,y=22-((v-mn)/rng)*20;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)});
    ctx.lineTo(165,24);ctx.lineTo(0,24);ctx.fillStyle=grad;ctx.fill();
    ctx.beginPath();ctx.strokeStyle=isUp?'#FF5252':'#00E676';ctx.lineWidth=1.2;
    d.forEach((v,i)=>{const x=(i/(d.length-1))*165,y=22-((v-mn)/rng)*20;i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)});ctx.stroke();
  });
  });
}

function renderSidebar(){
  memoizeRender('sidebar',sigOfPrices()+S.sel+'|'+S.active.size+'|'+S.subs.slice(0,8).map(s=>s.id+','+Math.round(s.bal*10)+','+Math.round(s.pnl*100)+','+s.st).join(';'),()=>{
  document.getElementById('symbolList').innerHTML=SYMS.filter(s=>S.active.has(s.id)).map(s=>{
    const p=S.prices[s.id],c=p.chg>=0?'up':'down',dc=p.chg>=0?'var(--red)':'var(--green)';
    return '<div class="sym-item'+(S.sel===s.id?' active':'')+'" onclick="selectSym(\''+s.id+'\')">'
      +'<div class="sym-dot" style="background:'+dc+'"></div><div class="sym-name">'+s.id.replace('USDT','')+'</div>'
      +'<div class="sym-chg '+c+'">'+(p.chg>=0?'+':'')+p.chg.toFixed(1)+'%</div></div>';
  }).join('');
  document.getElementById('subList').innerHTML=S.subs.slice(0,8).map(sub=>{
    const sc=sub.st==='active'?'active':sub.st==='losed'?'losed':'idle';
    const pc=sub.pnl>=0?'var(--green)':'var(--red)';
    return '<div class="sub-item"><div class="sub-dot '+sc+'"></div><span>#'+sub.id+'</span>'
      +'<span style="color:var(--text2);font-size:9px">$'+sub.bal.toFixed(1)+'</span>'
      +'<span class="sub-pnl" style="color:'+pc+'">'+(sub.pnl>=0?'+':'')+'$'+sub.pnl.toFixed(2)+'</span></div>';
  }).join('');
  });
}

function renderPositions(){
  memoizeRender('positions',S.pos.map(p=>p.sym+','+p.sid+','+(p.qty*1000|0)+','+Math.round(p.pnl*100)+','+Math.round((p.pnlPct||0)*10)+','+(p.be?1:0)+','+p.tl).join(';')+'|'+sigOfPrices(),()=>{
  const pl=document.getElementById('positionList');
  if(!S.pos.length){pl.innerHTML='<div class="no-pos">'+t('dash_nopos')+'</div>'}
  else{pl.innerHTML=S.pos.map((pos,i)=>{
    const d=pos.side==='long'?t('pos_long'):t('pos_short'),ic=pos.side==='long'?'long':'short';
    const pc2=pos.pnl>=0?'var(--green)':'var(--red)';const price=S.prices[pos.sym].last;
    return '<div class="pos-card"><div class="pos-icon '+ic+'">'+d+'</div>'
      +'<div class="pos-info"><div class="pos-sym">'+pos.sym.replace('USDT','')+' <span style="font-size:8px;color:var(--text2)">'+pos.lev+'x '+(pos.side==='long'?t('pos_dolong'):t('pos_doshort'))+' | sub-'+pf(pos.sid)+'</span></div>'
      +'<div class="pos-det">'+t('pos_entry')+' $'+pos.entry.toFixed(2)+' → $'+price.toFixed(2)+(pos.be?' '+t('card_be'):'')+' '+t('pos_tp')+':'+pos.tl+'/4</div></div>'
      +'<div class="pos-pnl"><div class="pos-pnl-v" style="color:'+pc2+'">'+(pos.pnl>=0?'+':'')+'$'+pos.pnl.toFixed(2)+'</div>'
      +'<div class="pos-pnl-p" style="color:'+pc2+'">'+(pos.pnlPct>=0?'+':'')+pos.pnlPct.toFixed(1)+'%</div></div>'
      +'<button class="btn btn-sell btn-sm" style="margin-left:4px" onclick="closePos('+i+')">'+t('pos_close')+'</button></div>';
  }).join('')}
  });
}

function renderStats(){
  memoizeRender('stats',S.total.toFixed(2)+'|'+S.ai.tt+','+S.ai.w+','+S.ai.l+'|'+S.realized.toFixed(2)+'|'+S.pos.length+'|'+S.arb.cnt+','+S.arb.profit.toFixed(2)+'|'+S.subs.reduce((a,c)=>a+Math.round(c.bal*10),0),()=>{
  document.getElementById('totalAssets').textContent='$'+S.total.toFixed(2);
  const dailyPnl=S.total-1000;
  const dpEl=document.getElementById('dailyPnl');
  if(dpEl){dpEl.textContent=(dailyPnl>=0?'+':'')+'$'+dailyPnl.toFixed(2);dpEl.style.color=dailyPnl>=0?'var(--green)':'var(--red)';}
  const rp2=Math.min(100,(S.pos.length/S.subs.length)*100);
  const rf=document.getElementById('riskFill');rf.style.width=rp2+'%';rf.style.background=rp2>66?'var(--red)':rp2>33?'var(--gold)':'var(--green)';
  const wr=S.ai.tt>0?Math.round(S.ai.w/S.ai.tt*100):0;
  document.getElementById('aiWinRate').textContent=wr+'%';document.getElementById('arbCount').textContent=S.arb.cnt;
  document.getElementById('arbProfit').textContent='$'+S.arb.profit.toFixed(2);
  document.getElementById('activePos').textContent=S.pos.length;
  const subBal=S.subs.reduce((a,c)=>a+c.bal,0);
  const allMargin=S.pos.reduce((a,c)=>a+(c.amt||c.entry*c.qty/c.lev),0);
  const allFloat=S.pos.reduce((a,c)=>a+c.pnl,0);
  const setT=(id,v,color)=>{const el=document.getElementById(id);if(el){el.textContent=(v>=0?'+':'')+'$'+Math.abs(v).toFixed(2);if(color)el.style.color=color;}};
  setT('audBal',subBal);setT('audMargin',allMargin,undefined);setT('audFloat',allFloat,allFloat>=0?'var(--green)':'var(--red)');
  setT('audSum',subBal+allMargin+allFloat);setT('audReal',S.realized,S.realized>=0?'var(--green)':'var(--red)');
  setT('audInit',S.initCap||1000,undefined);
  const net=(subBal+allMargin+allFloat)-(S.initCap||1000);
  setT('audNet',net,net>=0?'var(--green)':'var(--red)');
  });
  updateDataStatus();
}

function renderVersion(){
  const v=(APP_TAG||('v'+APP_VERSION))+(APP_DIRTY?' (dirty)':'');
  const el=document.getElementById('appVersion');if(el)el.textContent=v;
  document.title='智能交易系统 '+v;
  const se=document.getElementById('appVerLine');
  if(se)se.textContent='版本 '+v+' | git '+APP_COMMIT+' | 构建 '+APP_BUILD_TIME.replace('T',' ').replace(/\.\d+Z/,'')+' UTC';
}

function updateDataStatus(){
  const el=document.getElementById('dataStatus');if(!el)return;
  const bLive=!!(wsBin&&wsBin.readyState===1),oLive=!!(wsOKX&&wsOKX.readyState===1);
  let label,color;
  if(bLive&&oLive){label='双所实时';color='var(--green)';}
  else if(bLive||oLive){label=(bLive?'Binance':'OKX')+'实时';color='var(--gold)';}
  else if(dataReady>0){label='行情(REST)';color='var(--gold)';}
  else{label='无实时数据';color='var(--red)';}
  el.textContent=label;el.style.color=color;
}

function renderPage(p){
  if(p==='dashboard')renderPositions();
   else if(p==='fusion'){renderFusion();ensureFusionBacktestPanel();}
  else if(p==='ai')renderAI();
  else if(p==='arb')renderArb();
  else if(p==='subs')renderSubs();
  else if(p==='pnl')renderPnlPage();
  else if(p==='ledger'&&window.__renderLedger)window.__renderLedger();
   else if(p==='settings'){if(window.__renderSettings)window.__renderSettings();renderSymList();renderSimCoinList();}
  else if(p==='tech'&&window.__renderTech)window.__renderTech();
  else if(p==='kchart'&&window.__renderKChart)window.__renderKChart();
}

function fusionScore(sym){
  const fr=S.fusion.fr[sym],oiHis=S.fusion.oiHis[sym],fgv=S.fusion.fg;
  const p=S.prices[sym],o=S.okx[sym];
  let score=50;const parts=[];
  if(typeof fr==='number'&&fr!==0){
    const frv=Math.min(15,Math.abs(fr)*3000);
    if(fr>0){score-=frv;parts.push('费率正(过热) −'+frv.toFixed(0));}
    else{score+=frv;parts.push('费率负(看空) +'+frv.toFixed(0));}
  }
  if(oiHis&&oiHis.length>5){
    const now=oiHis[oiHis.length-1],prev=oiHis[oiHis.length-6]||now;
    if(now>prev*1.02){score+=3;parts.push('OI上升 +3');}
    else if(now<prev*0.98){score-=3;parts.push('OI下降 −3');}
  }
  if(typeof fgv==='number'){
    const fgv2=Math.round(((50-fgv)/50)*10);
    score+=fgv2;parts.push((fgv<50?'恐惧偏多 ':'贪婪偏空 ')+(fgv2>=0?'+':'')+fgv2);
  }
  if(p&&o&&p.last&&o){
    const sp=(p.last-o)/Math.min(p.last,o);
    const sp2=Math.round(Math.abs(sp)*200);
    if(sp>0){score-=Math.min(5,sp2);parts.push('Binance溢价 −'+Math.min(5,sp2));}
    else if(sp<0){score+=Math.min(5,sp2);parts.push('OKX溢价 +'+Math.min(5,sp2));}
  }
  score=Math.max(5,Math.min(95,Math.round(score)));
  return {score,parts};
}

function renderFusion(){
  const fg=document.getElementById('fusionGrid');if(!fg)return;
  const sym=S.sel;
  refreshSymbolSelectors();
  const fr=S.fusion.fr[sym],oi=S.fusion.oi[sym],fgv=S.fusion.fg;
  const p=S.prices[sym],o=S.okx[sym];
  const fs=fusionScore(sym);
  const ind=S.indicators[sym];
  // 多周期小字: 对 1t/10t/1m 各取一次读数并并排显示(节流后三周期均可用)
  const tfMini=function(getter){
    return ['1t','10t','1m'].map(function(tf){
      var r=ind&&ind[tf]; if(!r)return null;
      var v; try{ v=getter(r,tf); }catch(e){ v=null; }
      if(!v)return null;
      var col=v.dir==='多'?'var(--green)':v.dir==='空'?'var(--red)':'var(--text2)';
      return '<div style="font-size:9px;line-height:1.5">'+tf+': '+(v.dir?'<b style="color:'+col+'">'+v.dir+'</b> ':'')+(v.txt||'')+'</div>';
    }).filter(Boolean).join('');
  };
  const fgLabel=fgv<20?t('fus_fear5'):fgv<40?t('fus_fear4'):fgv<60?t('fus_fear3'):fgv<80?t('fus_fear2'):t('fus_fear1');
  // 数据新鲜度指示
  const freshCls=function(t2){const s=Date.now()-t2;return s<90000?'var(--text2)':s<180000?'var(--gold)':'var(--red)';};
  const freshTxt=function(t2){if(!t2)return t('fus_never');const s=Date.now()-t2;return t('fus_fresh')+' '+(s<60000?Math.round(s/1000)+'s前':Math.round(s/60000)+'m前');};
  const frF=freshTxt(S.fusion.lastFR),oiF=freshTxt(S.fusion.lastOI),fgF=freshTxt(S.fusion.lastFG),lsF=freshTxt(S.fusion.lastLS);
  // 设置开关(可关闭部分卡片)
  const tog=function(id){return (document.getElementById(id)?.value||'1')==='1';};
  const onFR=tog('setFusionFR'),onOI=tog('setFusionOI'),onFG=tog('setFusionFG'),onWhale=tog('setFusionWhale'),onLS=tog('setFusionLS');
  // 鲸鱼按币种过滤
  const whales=S.fusion.whales.filter(w=>w.sym===sym).slice(0,3);
  // 市场广度: 全币种 24h 涨跌
  let upN=0,dnN=0;
  SYMS.forEach(s=>{const c=S.prices[s.id]&&S.prices[s.id].chg;if(c==null)return;if(c>0.05)upN++;else if(c<-0.05)dnN++;});
  const breadthTxt=SYMS.length?upN+'/'+dnN+' ('+(SYMS.length?Math.round(upN/Math.max(1,SYMS.filter(s=>S.prices[s.id]&&S.prices[s.id].chg!=null).length)*100):0)+'%涨)':'—';
  const bColor=upN>dnN?'var(--green)':upN<dnN?'var(--red)':'var(--text2)';
  // 多周期广度: 各周期统计 价格>EMA20 的币数 (需指标已算)
  const tfBreadth=['1t','10t','1m'].map(tf=>{
    let up=0,dn=0;
    SYMS.forEach(s=>{
      const ind=S.indicators[s.id]&&S.indicators[s.id][tf];
      const c=ind&&ind.current;
      if(!c||c.price==null||c.ema20==null)return;
      if(c.price>c.ema20)up++;else dn++;
    });
    return {tf,up,dn};
  });
  // 评分操作建议
  const act=fs.score>=60?t('fus_action_buy'):fs.score<=40?t('fus_action_sell'):t('fus_action_neutral');
  const actColor=fs.score>=60?'var(--green)':fs.score<=40?'var(--red)':'var(--gold)';
  const confLv=Math.abs(fs.score-50);
  const confTxt=confLv>=25?t('fus_confirm_high'):confLv>=12?t('fus_confirm_mid'):t('fus_confirm_low');
  // 多周期技术评分(1t/10t/1m) + 一致度
  const tsScores=['1t','10t','1m'].map(tf=>{
    const ind=S.indicators[sym]&&S.indicators[sym][tf];
    if(!ind||!ind.current)return {tf,score:null};
    const ts=techScore(ind.current,ind.resonance);
    return {tf,score:ts?ts.score:null};
  });
  const scoreRow=function(sc){
    if(sc==null)return '<span style="color:var(--text2)">—</span>';
    const col=sc>=60?'var(--green)':sc<=40?'var(--red)':'var(--gold)';
    return '<b style="color:'+col+'">'+sc+'</b>';
  };
  const tsOnes=tsScores.filter(x=>x.score!=null);
  const tsAgree=tsOnes.filter(x=>x.score>=60).length;
  const tsAgreeBear=tsOnes.filter(x=>x.score<=40).length;
  const tsConsist=tsOnes.length?(
    tsAgree>=2?'一致偏多'
    :tsAgreeBear>=2?'一致偏空'
    :'分歧('+tsAgree+'多/'+tsAgreeBear+'空)'
  ):'—';
  const tsConsistColor=tsConsist==='一致偏多'?'var(--green)':tsConsist==='一致偏空'?'var(--red)':'var(--gold)';
  const tsScoreHtml='<div class="fusion-sub" style="margin-top:4px;border-top:1px solid var(--border);padding-top:3px">周期: 1t '+scoreRow(tsScores[0].score)
    +' | 10t '+scoreRow(tsScores[1].score)+' | 1m '+scoreRow(tsScores[2].score)
    +' <span style="color:'+tsConsistColor+'">('+tsConsist+')</span></div>';
  // 卡片右上角 空/多 信号徽章
  const badge=function(s,c){return s?'<span style="float:right;font-size:8px;padding:1px 5px;border-radius:3px;background:'+c+';color:#fff;line-height:1.4">'+s+'</span>':'';};
  // 交易对后实时价格 + 多空比例
  const priceEl=document.getElementById('fusionPrice');
  if(priceEl){
    if(p&&p.last>0){
      priceEl.innerHTML=(p.chg>=0?'▲ ':'▼ ')+'$'+fp(p.last);
      priceEl.style.color=p.chg>=0?'var(--green)':'var(--red)';
    }else{priceEl.textContent='';}
  }
  // 顶部多空比改为: 读取下方所有卡片 h4 徽章(多/空/偏多/偏空) 聚合计数, 随卡片实时联动。
  // 每张卡徽章仍由各自原有规则计算, 这里只汇总展示。真正刷新放在 grid 渲染后(refreshFusionRatio)。
  // ---- 技术信号卡 (1t + 多周期共振) ----
  const i1=ind&&ind['1t'];
  let techHtml='';
  if(i1&&i1.current){
    const c=i1.current;
    const rsiV=c.rsi!=null?Math.round(c.rsi):null;
    const rsiSt=rsiV!=null?(rsiV>70?t('fus_ob'):rsiV<30?t('fus_os'):'正常'):'—';
    const mh=c.macdHist!=null?c.macdHist:null;
    const macdSt=mh==null?'—':(mh>0?t('fus_macd_bull'):t('fus_macd_bear'));
    const aboveAis=c.price!=null&&c.aisLine!=null?(c.price>=c.aisLine?'上方':'下方'):'—';
    const tfStates=[];
    ['1t','10t','1m'].forEach(tf=>{const r=ind[tf]&&ind[tf].resonance;if(r)tfStates.push({tf,buy:!!r.buy,sell:!!r.sell});});
    const combo=combineResonance(tfStates);
    const resTxt=combo.buy?t('fus_res_buy'):combo.sell?t('fus_res_sell'):t('fus_res_none');
    const resColor=combo.buy?'var(--green)':combo.sell?'var(--red)':'var(--text2)';
    const resStr=combo.strength==='strong'?t('fus_res_strong'):combo.strength==='medium'?t('fus_res_medium'):t('fus_res_weak');
    techHtml='<div class="fusion-val" style="color:'+(rsiV!=null?(rsiV>70||rsiV<30?'var(--gold)':'var(--text)'):'var(--text2)')+'">'+t('fus_tech_sub')+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">RSI: <b>'+(rsiV!=null?rsiV+' ('+rsiSt+')':'—')+'</b></div>'
      +'<div class="fusion-sub">'+macdSt+' | AIS线:'+aboveAis+'</div>'
      +'<div class="fusion-sub" style="margin-top:3px">多周期共振 <span style="color:'+resColor+';font-weight:bold">'+resTxt+'</span> ('+resStr+', '+combo.buyCount+'多/'+combo.sellCount+'空/'+combo.total+'周期)</div>';
    // 量价背离行
    const spkVArr=S.sparkVol&&S.sparkVol[sym];
    const spkArr=S.spark&&S.spark[sym];
    let vdTxt='—';
    if(spkArr&&spkArr.length>=20&&spkVArr&&spkVArr.length>=20){
      const vd=volumeDivergence(spkArr,spkVArr,20);
      vdTxt=vd&&vd.bear?'顶背离(做空)':vd&&vd.bull?'底背离(做多)':'正常';
    }
    // 支撑阻力行
    let srTxt='—';
    if(i1&&i1.series&&spkArr&&spkArr.length>=5){
      const sr1=supportResistance(spkArr,40);
      if(sr1&&(sr1.sup!=null||sr1.res!=null)){
        const parts=[];
        if(sr1.sup!=null)parts.push('支撑'+fp(sr1.sup)+(sr1.supDistPct!=null?'('+sr1.supDistPct.toFixed(1)+'%)':''));
        if(sr1.res!=null)parts.push('阻力'+fp(sr1.res)+(sr1.resDistPct!=null?'('+sr1.resDistPct.toFixed(1)+'%)':''));
        srTxt=parts.join(' | ');
      }
    }
    techHtml+='<div class="fusion-sub" style="margin-top:3px">量价: <b>'+vdTxt+'</b></div>'
      +'<div class="fusion-sub">支撑阻力: '+srTxt+'</div>';
    // 三层共振 (阶段三): AI方向 × 量价 × 支撑/阻力
    if(i1&&i1.atr&&spkArr&&spkArr.length>=20&&spkVArr&&spkVArr.length>=20){
      const ls=sym?S.ai.lastScores[sym]:null;
      const aiSide=ls?ls.side:null;
      if(aiSide==='long'||aiSide==='short'){
        const tl=threeLayerResonance(spkArr,spkVArr,i1.atr,aiSide);
        const tlTxt=tl.resonance?'<span style="color:var(--green);font-weight:bold">三层共振</span> (量价+支撑/阻力+AI一致)':
          tl.agree>=1?'<span style="color:var(--gold)">部分共振</span> ('+tl.layers.length+'/3层)':
          '<span style="color:var(--text2)">无共振</span>';
        techHtml+='<div class="fusion-sub" style="margin-top:3px">三层共振: '+tlTxt+'</div>';
      }
    }
  }else{
    techHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">数据积累中...</div>';
  }
  // ---- 市场情境卡 ----
  let regimeHtml='';
  const closes1m=S.hist1m[sym]?S.hist1m[sym].map(x=>x.p):[];
  const regime=i1&&i1.series&&i1.series.price&&i1.series.price.length>=30?detectRegime(i1.series):null;
  const gate=closes1m.length>=30?trendGate(closes1m):null;
  if(regime){
    const rT=regime.type==='trend-up'?t('fus_trend_up'):regime.type==='trend-down'?t('fus_trend_down'):regime.type==='range'?t('fus_range'):regime.type==='pullback-up'?t('fus_pullback_up'):regime.type==='pullback-down'?t('fus_pullback_down'):'未知';
    const rC=regime.type==='trend-up'?'var(--green)':regime.type==='trend-down'?'var(--red)':'var(--gold)';
    const rA=regime.atrState==='扩张'?t('fus_vol_exp'):regime.atrState==='收缩'?t('fus_vol_cont'):t('fus_vol_flat');
    const gT=gate?gate.label:'—';
    regimeHtml='<div class="fusion-val" style="color:'+rC+';font-size:13px">'+rT+'</div>'
      +'<div class="fusion-sub" style="margin-top:3px">AIS斜率: '+regime.slopePct.toFixed(2)+'% | '+rA+'</div>'
      +'<div class="fusion-sub">1m趋势: '+gT+'</div>';
  }else{
    regimeHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">数据积累中...</div>';
  }
  // ---- AI 多空评分卡 ----
  const ls=S.ai.lastScores[sym];
  const aiHtml=ls?(function(){const max=Math.max(1,ls.ls,ls.ss);const lsp=Math.round(ls.ls/max*100),ssp=Math.round(ls.ss/max*100);
    const sideTxt=ls.side==='long'?t('fus_ai_long'):t('fus_ai_short');
    const sideColor=ls.side==='long'?'var(--green)':'var(--red)';
    return '<div class="fusion-val" style="color:'+sideColor+';font-size:13px">'+sideTxt+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">多 <span style="color:var(--green)">'+Math.round(ls.ls)+'</span> | 空 <span style="color:var(--red)">'+Math.round(ls.ss)+'</span></div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+lsp+'%;background:var(--green)"></div></div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+ssp+'%;background:var(--red)"></div></div>'
      +'<div class="fusion-sub" style="margin-top:4px;font-size:9px">'+tSig(ls.sig?ls.sig.join('+'):'—')+'</div>'
      +'<div class="fusion-sub" style="font-size:9px;color:'+freshCls(ls.t)+'">'+freshTxt(ls.t)+'</div>';})()
    :'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">等待AI分析...</div>';
  // 链上活跃度行(追加到 AI 多空评分卡)
  const ocRow=(function(){
    const oc=S.fusion.onChain||{};const eth=oc.eth||null;
    if(!eth||(!eth.lastTx&&!eth.tx24h))return '';
    const tx=eth.lastTx||eth.tx24h||0;
    const dir=eth.dailyTx&&eth.dailyTx.length>=2?onChainTrend(parseInt(eth.dailyTx[eth.dailyTx.length-1].transactionCount)||0,parseInt(eth.dailyTx[eth.dailyTx.length-2].transactionCount)||0):null;
    const dirTxt=dir==='up'?'↑':dir==='down'?'↓':'→';
    const dirCol=dir==='up'?'var(--green)':dir==='down'?'var(--red)':'var(--text2)';
    return '<div class="fusion-sub" style="margin-top:4px;font-size:9px;border-top:1px solid var(--border);padding-top:3px">链上活跃度: '+Math.round(tx).toLocaleString('en-US')+'笔 <span style="color:'+dirCol+';font-weight:bold">'+dirTxt+'</span></div>';
  })();
  // ---- LLM 判断卡 ----
  const llmS=S.ai.llm&&S.ai.llm.symbols?S.ai.llm.symbols[sym]:null;
  const llmHtml=llmS?(function(){const d=llmS.direction;
    const dT=d==='long'?t('fus_llm_long'):d==='short'?t('fus_llm_short'):t('fus_llm_neutral');
    const dC=d==='long'?'var(--green)':d==='short'?'var(--red)':'var(--gold)';
    return '<div class="fusion-val" style="color:'+dC+';font-size:13px">'+dT+' (置信 '+Math.round(llmS.confidence||0)+'%)</div>'
      +'<div class="fusion-sub" style="margin-top:4px">'+(llmS.reason||'—')+'</div>';})()
    :'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+(S.ai.llm===null?t('fus_llm_off'):t('fus_llm_na'))+'</div>';
  // ---- 持仓状态卡 ----
  const pos=S.pos.filter(x=>x.sym===sym);
  const posHtml=pos.length?pos.map(x=>{
    const isL=x.side==='long';
    const col=isL?'var(--green)':'var(--red)';
    return '<div style="margin-bottom:3px"><span style="color:'+col+';font-weight:bold">'+(isL?t('pos_long'):t('pos_short'))+'</span> '+x.lev+'x x'+x.qty+' @'+fp(x.entry)
      +' <span style="color:'+(x.pnl>=0?'var(--green)':'var(--red)')+'">'+(x.pnl>=0?'+':'')+x.pnl.toFixed(2)+' ('+(x.pnlPct>=0?'+':'')+x.pnlPct.toFixed(1)+'%)</span></div>';
  }).join('')
    :'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_nopos')+'</div>';
  // ---- 24h 行情卡 ----
  const p24=p||{};
  const chg24=p24.chg!=null?p24.chg:0;
  const distHi=p24.high&&p24.last?(p24.high-p24.last)/p24.high*100:null;
  const distLo=p24.low&&p24.last?(p24.last-p24.low)/p24.low*100:null;
  const volTxt=p24.qVol?p24.qVol>=1e9?(p24.qVol/1e9).toFixed(2)+'B':(p24.qVol/1e6).toFixed(1)+'M':'—';
  const h24Html0='<div class="fusion-val" style="color:'+(chg24>=0?'var(--green)':'var(--red)')+'">'+(chg24>=0?'+':'')+chg24.toFixed(2)+'%</div>'
    +'<div class="fusion-sub" style="margin-top:4px">'+t('fus_high')+': '+fp(p24.high||0)+' (距'+ (distHi!=null?distHi.toFixed(2):'—')+'%)</div>'
    +'<div class="fusion-sub">'+t('fus_low')+': '+fp(p24.low||0)+' (距'+ (distLo!=null?distLo.toFixed(2):'—')+'%)</div>'
    +'<div class="fusion-sub">24h量: '+p24.vol+' '+sym.replace('USDT','')+' | $'+volTxt+'</div>';
  // 多周期实时动量 (1t/10t/1m, 各周期序列近10根)
  const h24TfHtml=['1t','10t','1m'].map(tf=>{
    const ind=S.indicators[sym]&&S.indicators[sym][tf];
    const s=ind&&ind.series&&ind.series.price;
    const mom=s?momentumPct(s,10):null;
    if(mom==null)return '<div style="font-size:9px;line-height:1.5">'+tf+': <span style="color:var(--text2)">—</span></div>';
    const col=mom>=0.05?'var(--green)':mom<=-0.05?'var(--red)':'var(--gold)';
    return '<div style="font-size:9px;line-height:1.5">'+tf+': <span style="color:'+col+';font-weight:bold">'+(mom>=0?'+':'')+mom.toFixed(2)+'%</span></div>';
  }).join('');
  let h24Html=h24Html0+(h24TfHtml?'<div style="margin-top:5px;border-top:1px solid var(--border);padding-top:3px">'+h24TfHtml+'</div>':'');
  // ---- 波动率卡 ----
  const atrHis=(S.ai.atrHis||{})[sym];
  let volHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">波动数据积累中...</div>';
  if(atrHis&&atrHis.length>5){
    const sorted=[...atrHis].sort((a,b)=>a-b);
    const med=sorted[Math.floor(sorted.length/2)];
    const cur=atrHis[atrHis.length-1];
    const st=cur>med*1.25?t('fus_vol_exp'):cur<med*0.75?t('fus_vol_cont'):t('fus_vol_flat');
    const sc=cur>med*1.25?'var(--red)':cur<med*0.75?'var(--green)':'var(--gold)';
    const curPct=cur*100;
    const medPct=med*100;
    volHtml='<div class="fusion-val" style="color:'+sc+';font-size:13px">'+st+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">当前波动: '+curPct.toFixed(2)+'% (1t)</div>'
      +'<div class="fusion-sub">中位数: '+medPct.toFixed(2)+'% ('+atrHis.length+'样本)</div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+Math.min(100,curPct/medPct*50)+'%;background:'+sc+'"></div></div>';
  }
  // ---- 多空比卡片 ----
  const lsG=S.fusion.lsG[sym],lsT=S.fusion.lsT[sym],tk=S.fusion.tk[sym];
  const lsBar=function(v){const lp=normLongRatio(v),sp2=100-lp;return '<div class="fusion-val" style="font-size:13px"><span style="color:var(--green)">'+lp.toFixed(1)+'%多</span> / <span style="color:var(--red)">'+sp2.toFixed(1)+'%空</span></div>'
    +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+lp+'%;background:var(--green)"></div></div>';};
  const lsGHtml=lsG?lsBar(lsG):'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_never')+'</div>';
  const lsTHtml=lsT?lsBar(lsT):'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_never')+'</div>';
  const tkHtml=tk?(function(){const bs=parseFloat(tk.buySellRatio)||1;const buyPct=takerBuyPct(tk);const sellPct=100-buyPct;
    return '<div class="fusion-val" style="font-size:13px"><span style="color:'+(bs>=1?'var(--green)':'var(--red)')+'">买 '+buyPct+'%</span> / <span style="color:'+(bs<1?'var(--red)':'var(--text2)')+'">卖 '+sellPct+'%</span></div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+buyPct+'%;background:'+(bs>=1?'var(--green)':'var(--red)')+'"></div></div>'
      +'<div class="fusion-sub" style="margin-top:3px">主动买卖比 '+bs.toFixed(2)+'</div>';})()
    :'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_never')+'</div>';

  const cards=[];
  // ---- 第1卡: 多周期涨跌 (5m~30d, 上中下三行 x 3列, 箭头标识) ----
  {
    const mtf=S.fusion.multiTF[sym];
    const tfGroups=[['5m','15m','30m'],['1h','4h','8h'],['1d','7d','30d']];
    const mtfHtml=(function(){
      if(!mtf&&!p)return '<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
      const cells=function(row){return row.map(function(tf,i,arr){
        const pct=mtf&&mtf.pct?mtf.pct[tf]:null;
        if(pct==null)return '<div style="flex:1;text-align:center;padding:3px 0"><span style="font-size:8px;color:var(--text2)">'+tf+'</span> <span style="font-size:10px;color:var(--text2)">—</span></div>';
        const up=pct>0.05,dn=pct<-0.05;
        const col=up?'var(--green)':dn?'var(--red)':'var(--text2)';
        const arrow=up?'▲':dn?'▼':'◆';
        return '<div style="flex:1;text-align:center;padding:3px 0;border-right:'+(i<arr.length-1?'1px solid var(--border)':'none')+'"><span style="font-size:8px;color:var(--text2)">'+tf+'</span> <span style="font-size:10px;color:'+col+';font-weight:bold">'+arrow+' '+(pct>=0?'+':'')+pct.toFixed(2)+'%</span></div>';
      }).join('');};
      const rows=tfGroups.map(function(row,i){return '<div style="display:flex;border-bottom:'+(i<tfGroups.length-1?'1px solid var(--border)':'none')+'">'+cells(row)+'</div>';}).join('');
      const dir=mtf&&mtf.overall==='long'?t('fus_action_buy'):mtf&&mtf.overall==='short'?t('fus_action_sell'):t('fus_action_neutral');
      const dirColor=mtf&&mtf.overall==='long'?'var(--green)':mtf&&mtf.overall==='short'?'var(--red)':'var(--gold)';
      const fresh=mtf?freshTxt(S.fusion.lastTF):(t('fus_never'));
      return '<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden;margin-bottom:4px">'+rows+'</div>'
        +'<div class="fusion-sub" style="display:flex;justify-content:space-between"><span>多周期 <b style="color:'+dirColor+'">'+dir+'</b></span><span style="color:'+freshCls(S.fusion.lastTF)+'">'+fresh+'</span></div>';
    })();
    const dirBadge=mtf?(mtf.overall==='long'?t('fus_mtf_long'):mtf.overall==='short'?t('fus_mtf_short'):''):'';
    const dirColor=mtf?(mtf.overall==='long'?'var(--green)':mtf.overall==='short'?'var(--red)':'var(--gold)'):'var(--text2)';
    cards.push('<div class="fusion-card"><h4>'+t('fus_mtf')+badge(dirBadge,dirColor)+'</h4>'+mtfHtml+'</div>');
  }
  if(onFR)cards.push('<div class="fusion-card"><h4>'+t('fus_rate')+badge(fr>=0?'空':'多',fr>=0?'var(--red)':'var(--green)')+'</h4><div class="fusion-val" style="color:'+(fr>=0?'var(--red)':'var(--green)')+'">'+(fr*100).toFixed(4)+'%</div><div class="fusion-sub">'+(fr>=0?t('fus_rate_long'):t('fus_rate_short'))+'</div><div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+Math.min(100,Math.abs(fr)*10000)+'%;background:'+(fr>=0?'var(--red)':'var(--green)')+'"></div></div><div class="fusion-sub" style="margin-top:4px;color:'+freshCls(S.fusion.lastFR)+'">'+frF+'</div></div>');
  // ---- 消息面(新闻)卡: CoinDesk RSS 按币过滤, 每条标题+时间+情绪徽章 ----
  {
    const news=S.fusion.news&&S.fusion.news[sym];
    const newsStale=!S.fusion.lastNews||Date.now()-S.fusion.lastNews>THRESH.NEWS_FRESH_MAX;
    let newsHtml;
    if(news&&news.items&&news.items.length&&!newsStale){
      const ns=newsSentiment(news.items);
      const nsTxt=ns.net>=THRESH.NEWS_SENTIMENT_THR?t('fus_news_pos'):ns.net<=-THRESH.NEWS_SENTIMENT_THR?t('fus_news_neg'):'中性';
      const nsCol=ns.net>=THRESH.NEWS_SENTIMENT_THR?'var(--green)':ns.net<=-THRESH.NEWS_SENTIMENT_THR?'var(--red)':'var(--gold)';
      newsHtml='<div class="fusion-val" style="color:'+nsCol+';font-size:13px">'+nsTxt+'</div>'
        +'<div class="fusion-sub" style="margin-top:4px;font-size:9px;line-height:1.6">'+news.items.slice(0,3).map(function(it){
          const t=it.title||'';
          const when=it.pubDate?(' · '+Math.max(0,Math.round((Date.now()-new Date(it.pubDate).getTime())/3600000))+'h前'):'';
          return '<div style="margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
            +(it.link?'<a href="'+it.link+'" target="_blank" rel="noopener" style="color:var(--text)">':'')
            +(t.length>42?t.slice(0,42)+'…':t)
            +(it.link?'</a>':'')
            +'<span style="color:var(--text2)">'+when+'</span></div>';
        }).join('')+'</div>'
        +'<div class="fusion-sub" style="margin-top:3px;font-size:9px;color:'+freshCls(S.fusion.lastNews)+'">'+freshTxt(S.fusion.lastNews)+'</div>';
    }else{
      newsHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_news_stale')+'</div>';
    }
    cards.push('<div class="fusion-card"><h4>'+t('fus_news')+badge('', '')+'</h4>'+newsHtml+'</div>');
  }
  if(onOI)cards.push('<div class="fusion-card"><h4>'+t('fus_oi')+'</h4><div class="fusion-val">$'+(oi/1e6).toFixed(0)+'M</div><div class="fusion-sub">'+t('fus_oi_sub')+'</div><div class="fusion-sub" style="margin-top:4px;color:'+freshCls(S.fusion.lastOI)+'">'+oiF+'</div></div>');
  if(onFG)cards.push('<div class="fusion-card"><h4>'+t('fus_fg')+badge(fgv<30?'多':fgv>70?'空':'',fgv<30?'var(--green)':'var(--red)')+'</h4><div class="fusion-val" style="color:'+(fgv<30?'var(--green)':fgv>70?'var(--red)':'var(--gold)')+'">'+fgv+'</div><div class="fusion-sub">'+fgLabel+'</div><div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+fgv+'%;background:linear-gradient(90deg,var(--green),var(--gold),var(--red))"></div></div><div class="fusion-sub" style="margin-top:4px;color:'+freshCls(S.fusion.lastFG)+'">'+fgF+'</div></div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_spread')+badge(p.last>o?'多':'空',p.last>o?'var(--green)':'var(--red)')+'</h4><div class="fusion-val" style="color:var(--gold)">'+(Math.abs(p.last-o)/Math.min(p.last,o)*100).toFixed(3)+'%</div><div class="fusion-sub">Binance: $'+fp(p.last)+' | OKX: $'+fp(o)+'</div></div>');
  if(onWhale)cards.push('<div class="fusion-card"><h4>'+t('fus_whale')+badge(whales[0]?(whales[0].dir==='in'?'多':'空'):'',whales[0]&&whales[0].dir==='in'?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="margin-top:4px">'+(whales.length?whales.map(w=>'<div style="margin-bottom:3px">'+w.sym.replace('USDT','')+' $'+w.amt+' '+(w.dir==='in'?'→转入':'←转出')+'</div>').join(''):t('fus_nowhale'))+'</div></div>');
  const tfBreadthHtml=tfBreadth.map(b=>{
    const tot=b.up+b.dn;
    if(!tot)return '<div style="font-size:9px;line-height:1.5">'+b.tf+': <span style="color:var(--text2)">—</span></div>';
    const col=b.up>b.dn?'var(--green)':b.up<b.dn?'var(--red)':'var(--gold)';
    return '<div style="font-size:9px;line-height:1.5">'+b.tf+': <span style="color:'+col+';font-weight:bold">'+b.up+'↑/'+b.dn+'↓</span></div>';
  }).join('');
  const tfBWidthAll=tfBreadth.every(b=>(b.up+b.dn)>0);
  const tfBBadge=tfBWidthAll?(tfBreadth.filter(b=>b.up>b.dn).length>=2?'多':tfBreadth.filter(b=>b.up<b.dn).length>=2?'空':''):'';
  cards.push('<div class="fusion-card"><h4>'+t('fus_breadth')+badge(upN>dnN?'多':upN<dnN?'空':'',upN>dnN?'var(--green)':'var(--red)')+'</h4><div class="fusion-val" style="color:'+bColor+'">'+breadthTxt+'</div><div class="fusion-sub">'+t('fus_breadth_sub')+'</div><div style="margin-top:5px;border-top:1px solid var(--border);padding-top:3px">'+tfBreadthHtml+'</div></div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_score')+badge(fs.score>=60?'多':fs.score<=40?'空':'',fs.score>=60?'var(--green)':'var(--red)')+'</h4><div class="fusion-val" style="color:'+(fs.score>=60?'var(--green)':fs.score<=40?'var(--red)':'var(--gold)')+'">'+fs.score+'</div><div class="fusion-sub">'+t('fus_score_sub')+' | 置信:'+confTxt+'</div><div class="fusion-sub" style="margin-top:3px"><span style="color:'+actColor+';font-weight:bold">'+act+'</span></div><div class="fusion-sub" style="margin-top:4px">'+fs.parts.join(' | ')+(fs.parts.length?'':'（数据不足，中性）')+'</div>'+tsScoreHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_tech')+badge(i1&&i1.resonance?(i1.resonance.buy?'多':i1.resonance.sell?'空':''):'',i1&&i1.resonance&&i1.resonance.buy?'var(--green)':'var(--red)')+'</h4>'+techHtml+tfMini(function(r){var res=r.resonance;return {dir:res&&res.buy?'多':res&&res.sell?'空':'',txt:''};})+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_regime')+badge(regime?(regime.type==='trend-up'?'多':regime.type==='trend-down'?'空':''):'',regime&&regime.type==='trend-up'?'var(--green)':'var(--red)')+'</h4>'+regimeHtml+tfMini(function(r){var s=r.series;var reg=s&&s.price&&s.price.length>=30?detectRegime(s):null;if(!reg)return null;var dir=reg.type==='trend-up'?'多':reg.type==='trend-down'?'空':'';return {dir:dir,txt:reg.label||''};})+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_ai')+badge(ls?(ls.side==='long'?'多':ls.side==='short'?'空':''):'',ls&&ls.side==='long'?'var(--green)':'var(--red)')+'</h4>'+aiHtml+ocRow+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_llm')+badge(llmS?(llmS.direction==='long'?'多':llmS.direction==='short'?'空':''):'',llmS&&llmS.direction==='long'?'var(--green)':'var(--red)')+'</h4>'+llmHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_pos')+badge(pos[0]?(pos[0].side==='long'?'多单':'空单'):'',pos[0]&&pos[0].side==='long'?'var(--green)':'var(--red)')+'</h4>'+posHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_24h')+badge(chg24>=0?'多':'空',chg24>=0?'var(--green)':'var(--red)')+'</h4>'+h24Html+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_vol')+'</h4>'+volHtml+tfMini(function(r){var s=r.series;if(!s||!s.price||!s.price.length)return null;var a=r.atr;if(a==null)return null;var atrPct=a/s.price[s.price.length-1]*100;return {dir:'',txt:atrPct.toFixed(2)+'%'};})+'</div>');
  if(onLS){
    cards.push('<div class="fusion-card"><h4>'+t('fus_ls')+badge(lsG?normLongRatio(lsG)>50?'多':'空':'',lsG&&normLongRatio(lsG)>50?'var(--green)':'var(--red)')+'</h4>'+lsGHtml+'<div class="fusion-sub" style="margin-top:3px;color:'+freshCls(S.fusion.lastLS)+'">'+lsF+'</div></div>');
    cards.push('<div class="fusion-card"><h4>'+t('fus_top')+badge(lsT?normLongRatio(lsT)>50?'多':'空':'',lsT&&normLongRatio(lsT)>50?'var(--green)':'var(--red)')+'</h4>'+lsTHtml+'<div class="fusion-sub" style="margin-top:3px;color:'+freshCls(S.fusion.lastLS)+'">'+lsF+'</div></div>');
    cards.push('<div class="fusion-card"><h4>'+t('fus_taker')+badge(tk?((parseFloat(tk.buySellRatio)||1)>=1?'多':'空'):'',tk&&(parseFloat(tk.buySellRatio)||1)>=1?'var(--green)':'var(--red)')+'</h4>'+tkHtml+'<div class="fusion-sub" style="margin-top:3px;color:'+freshCls(S.fusion.lastLS)+'">'+lsF+'</div></div>');
  }
  // ---- 费率趋势卡 (40点历史) ----
  const frHisArr=S.fusion.frHis[sym]||[];
  let frTrendHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(frHisArr.length>5){
    const curF=frHisArr[frHisArr.length-1],prev20F=frHisArr[Math.max(0,frHisArr.length-21)];
    const dF=curF-prev20F;
    const dirFT=dF>0.0001?t('fus_rise'):dF<-0.0001?t('fus_fall'):t('fus_flat');
    const dirFC=dF>0.0001?'var(--red)':dF<-0.0001?'var(--green)':'var(--text2)';
    const maxAbs=Math.max(...frHisArr.map(x=>Math.abs(x)),1e-6);
    frTrendHtml='<div class="fusion-val" style="color:'+dirFC+';font-size:13px">'+dirFT+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">当前: '+(curF*100).toFixed(4)+'% | 20点前: '+(prev20F*100).toFixed(4)+'%</div>'
      +'<div class="fusion-sub">变化: '+(dF>=0?'+':'')+(dF*100).toFixed(4)+'%</div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+Math.min(100,Math.abs(dF)/maxAbs*100)+'%;background:'+dirFC+'"></div></div>';
  }
  // ---- OI 趋势卡 ----
  const oiHisArr=S.fusion.oiHis[sym]||[];
  let oiTrendHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(oiHisArr.length>5){
    const nowO=oiHisArr[oiHisArr.length-1],prev5O=oiHisArr[Math.max(0,oiHisArr.length-6)]||nowO,prev20O=oiHisArr[Math.max(0,oiHisArr.length-21)]||nowO;
    const chg5=(nowO-prev5O)/Math.max(1e-9,prev5O)*100,chg20=(nowO-prev20O)/Math.max(1e-9,prev20O)*100;
    const inFlow=chg20>1;
    const dirOT=inFlow?t('fus_inflow'):chg20<-1?t('fus_outflow'):t('fus_flat');
    const dirOC=inFlow?'var(--green)':chg20<-1?'var(--red)':'var(--text2)';
    oiTrendHtml='<div class="fusion-val" style="color:'+dirOC+';font-size:13px">'+dirOT+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">5点变化: '+(chg5>=0?'+':'')+chg5.toFixed(2)+'% | 20点: '+(chg20>=0?'+':'')+chg20.toFixed(2)+'%</div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+Math.min(100,Math.abs(chg20)*20)+'%;background:'+dirOC+'"></div></div>';
  }
  // ---- 价格走势卡 (spark 动量) ----
  const spkArr=S.spark[sym]||[];
  let priceTrendHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(spkArr.length>10){
    const lastP=spkArr[spkArr.length-1],oldP=spkArr[spkArr.length-11]||spkArr[0];
    const mom=(lastP-oldP)/oldP*100;
    const mnP=Math.min(...spkArr),mxP=Math.max(...spkArr);
    const rangePct=mnP>0?(mxP-mnP)/mnP*100:0;
    const momC=mom>=0.8?'var(--red)':mom<=-0.8?'var(--green)':'var(--text2)';
    // P2-2: 动量状态统一走 momentumState 纯函数(与测试同源)
    const st=momentumState(spkArr); // '急涨'|'急跌'|'偏涨'|'偏跌'|'平稳' 或 null
    const momLbl=st==='急涨'?t('fus_mom_up'):st==='急跌'?t('fus_mom_down'):(mom>=0?'+':'-')+Math.abs(mom).toFixed(2)+'%';
    priceTrendHtml='<div class="fusion-val" style="color:'+momC+';font-size:13px">'+(mom>=0?'+':'')+mom.toFixed(2)+'%</div>'
      +'<div class="fusion-sub" style="margin-top:4px">10点动量: '+momLbl+(st==='急涨'?'('+t('fus_mom_up')+')':st==='急跌'?'('+t('fus_mom_down')+')':'')+'</div>'
      +'<div class="fusion-sub">40点区间: '+rangePct.toFixed(2)+'%</div>';
  }
  // 多周期动量 (1t/10t/1m 序列动量, 更细粒度看一致度)
  const ptTfHtml=['1t','10t','1m'].map(tf=>{
    const ind=S.indicators[sym]&&S.indicators[sym][tf];
    const s=ind&&ind.series&&ind.series.price;
    const m=s?momentumPct(s,10):null;
    if(m==null)return '<div style="font-size:9px;line-height:1.5">'+tf+': <span style="color:var(--text2)">—</span></div>';
    const col=m>=0.05?'var(--green)':m<=-0.05?'var(--red)':'var(--gold)';
    return '<div style="font-size:9px;line-height:1.5">'+tf+': <span style="color:'+col+';font-weight:bold">'+(m>=0?'+':'')+m.toFixed(2)+'%</span></div>';
  }).join('');
  const ptTfCounts=ptTfHtml&&['1t','10t','1m'].map(tf=>{
    const ind=S.indicators[sym]&&S.indicators[sym][tf];
    const s=ind&&ind.series&&ind.series.price;
    const m=s?momentumPct(s,10):null;
    return m==null?null:Math.sign(m);
  }).filter(x=>x!=null);
  const ptConsist=ptTfCounts&&ptTfCounts.length?
    (ptTfCounts.filter(x=>x>0).length>=2?'consist-up':ptTfCounts.filter(x=>x<0).length>=2?'consist-dn':'mixed'):null;
  const ptConsistTxt=ptConsist==='consist-up'?'<span style="color:var(--green)">周期一致偏多</span>'
    :ptConsist==='consist-dn'?'<span style="color:var(--red)">周期一致偏空</span>'
    :ptConsist==='mixed'?'<span style="color:var(--gold)">周期分歧</span>':'';
  if(ptTfHtml)priceTrendHtml+='<div style="margin-top:5px;border-top:1px solid var(--border);padding-top:3px">'+ptTfHtml
    +(ptConsistTxt?'<div style="font-size:9px;line-height:1.5;margin-top:2px">'+ptConsistTxt+'</div>':'')+'</div>';
  // ---- 恐惧贪婪趋势卡 ----
  const fgHisArr=S.fusion.fgHis||[];
  let fgTrendHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(fgHisArr.length>5){
    const curG=fgHisArr[fgHisArr.length-1],prevG=fgHisArr[Math.max(0,fgHisArr.length-6)]||curG;
    const dG=curG-prevG;
    const dirGT=dG>=3?t('fus_heat'):dG<=-3?t('fus_cool'):t('fus_flat');
    const dirGC=dG>=3?'var(--red)':dG<=-3?'var(--green)':'var(--text2)';
    fgTrendHtml='<div class="fusion-val" style="color:'+dirGC+';font-size:13px">'+dirGT+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">当前: '+curG+' | 5点前: '+prevG+' (变化 '+(dG>=0?'+':'')+dG+')</div>';
  }
  // ---- AI 信号胜率卡 ----
  const sigWrHtml=ls&&ls.sig&&ls.sig.length?(function(){
    return '<div class="fusion-sub" style="margin-top:4px">'+ls.sig.slice(0,6).map(n=>{
      const s=S.ai.sigScore[n];
      if(!s||!s.total)return '<div style="margin-bottom:2px;font-size:9px"><b>'+n+'</b> <span style="color:var(--text2)">'+t('fus_noRec')+'</span></div>';
      const wr=Math.round(s.winRate*100);
      const c=wr>=60?'var(--green)':wr>=40?'var(--gold)':'var(--red)';
      return '<div style="margin-bottom:2px;font-size:9px"><b>'+n+'</b> <span style="color:'+c+'">'+s.wins+'/'+s.total+' ('+wr+'%)</span> <span style="color:var(--text2)">avgPnl '+(s.avgPnl>=0?'+':'')+s.avgPnl.toFixed(2)+'</span></div>';
    }).join('')+'</div>';
  })():'<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_noRec')+'</div>';
  // ---- AI 战绩卡 ----
  const wT=(S.ai.winTrades||[]).filter(x=>x.sym===sym);
  const lT=(S.ai.loseTrades||[]).filter(x=>x.sym===sym);
  const tT=wT.length+lT.length;
  let aiRecHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_noRec')+'</div>';
  if(tT>0){
    const wr=Math.round(wT.length/tT*100);
    const netPnl=wT.reduce((a,x)=>a+(x.pnl||0),0)+lT.reduce((a,x)=>a+(x.pnl||0),0);
    const c=netPnl>=0?'var(--green)':'var(--red)';
    aiRecHtml='<div class="fusion-val" style="color:'+c+';font-size:13px">'+(netPnl>=0?'+':'')+netPnl.toFixed(2)+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">'+wr+'% 胜率 ('+wT.length+'/'+tT+') | '+tT+'笔</div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+wr+'%;background:'+(wr>=50?'var(--green)':'var(--red)')+'"></div></div>';
  }
  // ---- 近期平仓卡 ----
  const closedRec=(S.closed||[]).filter(x=>x.sym===sym).slice(-3).reverse();
  let closedHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_noRec')+'</div>';
  if(closedRec.length){
    closedHtml=closedRec.map(x=>{
      const isL=x.side==='long';
      const c=x.pnl>=0?'var(--green)':'var(--red)';
      const d=new Date(x.t);const hm=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
      return '<div style="margin-bottom:2px;font-size:9px"><span style="color:'+(isL?'var(--green)':'var(--red)')+'">'+(isL?'多':'空')+'</span> <span style="color:'+c+'">'+(x.pnl>=0?'+':'')+x.pnl.toFixed(2)+'</span> <span style="color:var(--text2)">'+(x.reason||'')+' '+hm+'</span></div>';
    }).join('');
  }
  // ---- AIS 通道位置卡 ----
  let aisPosHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(i1&&i1.current&&i1.current.price!=null&&i1.current.aisUpper!=null&&i1.current.aisLower!=null){
    const cc=i1.current,up=cc.aisUpper,lo=cc.aisLower;
    const rng=(up-lo)||1;
    const posPct=Math.max(0,Math.min(100,(cc.price-lo)/rng*100));
    const distUp=(up-cc.price)/cc.price*100,distLo=(cc.price-lo)/cc.price*100;
    const zone=posPct>70?'上沿':posPct<30?'下沿':'中部';
    const zc=posPct>70?'var(--red)':posPct<30?'var(--green)':'var(--gold)';
    aisPosHtml='<div class="fusion-val" style="color:'+zc+';font-size:13px">'+posPct.toFixed(1)+'% ('+zone+')</div>'
      +'<div class="fusion-sub" style="margin-top:4px">上轨: '+fp(up)+' (距'+(distUp>=0?'+':'')+distUp.toFixed(2)+'%)</div>'
      +'<div class="fusion-sub">下轨: '+fp(lo)+' (距'+(distLo>=0?'+':'')+distLo.toFixed(2)+'%)</div>'
      +'<div class="fusion-bar"><div class="fusion-bar-fill" style="width:'+posPct+'%;background:'+zc+'"></div></div>';
  }
  // ---- EMA 趋势卡 ----
  let emaHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  if(i1&&i1.current&&i1.current.ema20!=null&&i1.current.ema120!=null){
    const cc=i1.current,e20=cc.ema20,e120=cc.ema120;
    const cross=e20>e120?t('fus_gold'):e20<e120?t('fus_dead'):t('fus_nocross');
    const c=e20>e120?'var(--green)':'var(--red)';
    const diff=e120?(e20-e120)/e120*100:0;
    emaHtml='<div class="fusion-val" style="color:'+c+';font-size:13px">'+cross+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px">EMA20: '+fp(e20)+' | EMA120: '+fp(e120)+'</div>'
      +'<div class="fusion-sub">价差: '+(diff>=0?'+':'')+diff.toFixed(2)+'%</div>';
  }
  // ---- 回测胜率卡 (缓存60s) ----
  let btHtml='<div class="fusion-sub" style="margin-top:4px;color:var(--text2)">'+t('fus_accum')+'</div>';
  const btSeries=i1&&i1.series&&i1.series.price&&i1.series.price.length>50?i1.series:null;
  if(btSeries){
    const cached=__btCache[sym];
    if(!cached||Date.now()-cached.t>60000){
      try{__btCache[sym]={t:Date.now(),stats:signalBacktest(btSeries).stats};}catch(e){}
    }
    const st=__btCache[sym]&&__btCache[sym].stats;
    if(st){
      const b=st.buy&&(st.buy.wins+st.buy.losses)>0?Math.round(st.buy.wins/(st.buy.wins+st.buy.losses)*100):null;
      const s2=st.sell&&(st.sell.wins+st.sell.losses)>0?Math.round(st.sell.wins/(st.sell.wins+st.sell.losses)*100):null;
      const bc=b!=null?'var(--green)':'var(--text2)';
      const sc2=s2!=null?'var(--red)':'var(--text2)';
      btHtml='<div class="fusion-sub" style="margin-top:4px">买: <b style="color:'+bc+'">'+(b!=null?b+'%':'—')+'</b> | 卖: <b style="color:'+sc2+'">'+(s2!=null?s2+'%':'—')+'</b></div>'
        +'<div class="fusion-sub">总样本: '+(st.total||0)+' ('+t('fus_bt_sub')+')</div>';
    }
  }
  // 各卡信号判定(右上角徽章)
  const sFrd=frHisArr.length>5?(frHisArr[frHisArr.length-1]-frHisArr[Math.max(0,frHisArr.length-21)]):0;
  const sOi=oiHisArr.length>5?((oiHisArr[oiHisArr.length-1]-oiHisArr[Math.max(0,oiHisArr.length-21)])/(oiHisArr[Math.max(0,oiHisArr.length-21)]||1)*100):0;
  const sMom=spkArr.length>10?((spkArr[spkArr.length-1]-(spkArr[spkArr.length-11]||spkArr[0]))/(spkArr[spkArr.length-11]||spkArr[0])*100):0;
  const sFgD=fgHisArr.length>5?(fgHisArr[fgHisArr.length-1]-fgHisArr[Math.max(0,fgHisArr.length-6)]):0;
  const sBt=__btCache[sym]&&__btCache[sym].stats?__btCache[sym].stats:null;
  const sBtB=sBt&&sBt.buy&&(sBt.buy.wins+sBt.buy.losses)>0?sBt.buy.wins/(sBt.buy.wins+sBt.buy.losses):null;
  const sBtS=sBt&&sBt.sell&&(sBt.sell.wins+sBt.sell.losses)>0?sBt.sell.wins/(sBt.sell.wins+sBt.sell.losses):null;
  const sAis=(i1&&i1.current&&i1.current.price!=null&&i1.current.aisUpper!=null&&i1.current.aisLower!=null)?Math.max(0,Math.min(100,(i1.current.price-i1.current.aisLower)/((i1.current.aisUpper-i1.current.aisLower)||1)*100)):null;
  const sEma=(i1&&i1.current&&i1.current.ema20!=null&&i1.current.ema120!=null)?(i1.current.ema20-i1.current.ema120):null;
  const sigBull=[];
  (ls&&ls.sig||[]).forEach(n=>{if(['超跌','负费率','鲸鱼转入','急跌','共振买入','SRSI超卖','顺势回调','多周期确认'].includes(n))sigBull.push(n);});
  const sigBear=[];
  (ls&&ls.sig||[]).forEach(n=>{if(['超涨','正费率','鲸鱼转出','急涨','共振卖出','SRSI超买','顺势回调空'].includes(n))sigBear.push(n);});
  const sSig=(function(){
    let b=0,bb=0,bo=0;
    sigBull.forEach(n=>{const s=S.ai.sigScore[n];if(s&&s.total){bb++;if(s.winRate>=0.6)b++;}});
    sigBear.forEach(n=>{const s=S.ai.sigScore[n];if(s&&s.total){bo++;if(s.winRate>=0.6)b--;}});
    if(!bb&&!bo)return null;
    return b>0?'多':b<0?'空':null;
  })();
  const sAiRec=(function(){if(tT===0)return null;const net=wT.reduce((a,x)=>a+(x.pnl||0),0)+lT.reduce((a,x)=>a+(x.pnl||0),0);return net>=0?'多':'空';})();
  const sClosed=(S.closed||[]).filter(x=>x.sym===sym).slice(-1)[0];
  cards.push('<div class="fusion-card"><h4>'+t('fus_frTrend')+badge(sFrd<-0.0001?'多':sFrd>0.0001?'空':'',sFrd>0.0001?'var(--red)':'var(--green)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_frTrend_sub')+'</div>'+frTrendHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_oiTrend')+badge(sOi>1?'多':sOi<-1?'空':'',sOi>1?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_oiTrend_sub')+'</div>'+oiTrendHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_priceTrend')+badge(sMom>0.8?'多':sMom<-0.8?'空':'',sMom>0.8?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_priceTrend_sub')+'</div>'+priceTrendHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_fgTrend')+badge(sFgD<-3?'多':sFgD>3?'空':'',sFgD>3?'var(--red)':'var(--green)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_fgTrend_sub')+'</div>'+fgTrendHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_sigWR')+badge(sSig||'',sSig==='多'?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_sigWR_sub')+'</div>'+sigWrHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_aiRec')+badge(sAiRec||'',sAiRec==='多'?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_aiRec_sub')+'</div>'+aiRecHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_closedRec')+badge(sClosed?(sClosed.side==='long'?'多':'空'):'',sClosed&&sClosed.side==='long'?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_closedRec_sub')+'</div>'+closedHtml+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_aisPos')+badge(sAis!=null?(sAis<30?'多':sAis>70?'空':''):'',sAis!=null&&sAis>70?'var(--red)':'var(--green)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_aisPos_sub')+'</div>'+aisPosHtml+tfMini(function(r){var c=r.current;if(!c||c.price==null||c.aisUpper==null||c.aisLower==null)return null;var lo=c.aisLower,hi=c.aisUpper;var posPct=Math.max(0,Math.min(100,(c.price-lo)/((hi-lo)||1)*100));var zone=posPct>70?'上沿':posPct<30?'下沿':'中部';return {dir:posPct<30?'多':posPct>70?'空':'',txt:posPct.toFixed(0)+'% '+zone};})+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_emaT')+badge(sEma!=null?(sEma>0?'多':sEma<0?'空':''):'',sEma!=null&&sEma>0?'var(--green)':'var(--red)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_emaT_sub')+'</div>'+emaHtml+tfMini(function(r){var c=r.current;if(!c||c.ema20==null||c.ema120==null)return null;var d=c.ema20-c.ema120;var pct=d/((c.ema120)||1)*100;return {dir:d>0?'多':'空',txt:Math.abs(pct).toFixed(1)+'%'};})+'</div>');
  cards.push('<div class="fusion-card"><h4>'+t('fus_bt')+badge(sBtB!=null&&sBtS!=null?(sBtB>sBtS?'多':sBtB<sBtS?'空':''):'',sBtB!=null&&sBtS!=null&&sBtB<sBtS?'var(--red)':'var(--green)')+'</h4><div class="fusion-sub" style="color:var(--text2)">'+t('fus_bt_sub')+'</div>'+btHtml+tfMini(function(r,tf){var s=r.series;if(!s||!s.price||s.price.length<=50)return null;var key=sym+'|'+tf;var c=__btCache[key];if(!c||Date.now()-c.t>60000){try{c={t:Date.now(),stats:signalBacktest(s).stats};__btCache[key]=c;}catch(e){return null;}}var st=c.stats;var b=st.buy,w=st.sell;var bw=(b.wins+b.losses)>0?Math.round(b.wins/(b.wins+b.losses)*100):null;var sw=(w.wins+w.losses)>0?Math.round(w.wins/(w.wins+w.losses)*100):null;return {dir:'',txt:'买'+(bw!=null?bw+'%':'—')+' 卖'+(sw!=null?sw+'%':'—')};})+'</div>');
  // ---- 链上活跃度卡 (阶段二: ETH/BSC on-chain) ----
  {
    const oc=S.fusion.onChain||{};
    const eth=oc.eth||null,bnb=oc.bnb||null;
    const ethTx=eth?(eth.lastTx||eth.tx24h||null):null;
    const bnbTx=bnb?(bnb.lastTx||null):null;
    const ethActive=ethTx!=null?Math.round(ethTx).toLocaleString('en-US'):'—';
    const bnbActive=bnbTx!=null?Math.round(bnbTx).toLocaleString('en-US'):'—';
    const ethBlocks=eth&&eth.blocks24h?Math.round(eth.blocks24h).toLocaleString('en-US'):null;
    // 方向徽章: 用 dailytx 最近两日对比 (BNB 同理), 无历史时无徽章
    const ethDir=eth&&eth.dailyTx&&eth.dailyTx.length>=2?
      onChainTrend(parseInt(eth.dailyTx[eth.dailyTx.length-1].transactionCount)||0,parseInt(eth.dailyTx[eth.dailyTx.length-2].transactionCount)||0):null;
    const bnbDir=bnb&&bnb.dailyTx&&bnb.dailyTx.length>=2?
      onChainTrend(parseInt(bnb.dailyTx[bnb.dailyTx.length-1].transactionCount)||0,parseInt(bnb.dailyTx[bnb.dailyTx.length-2].transactionCount)||0):null;
    const badgeTxt=ethDir==='up'?'多':ethDir==='down'?'空':'';
    const badgeCol=ethDir==='up'?'var(--green)':ethDir==='down'?'var(--red)':'var(--text2)';
    const ocHtml='<div class="fusion-val" style="font-size:13px">'+t('fus_onchain_eth')+' 24h: <b>'+(ethActive!=='—'?ethActive:'暂无')+'</b> 笔</div>'
      +'<div class="fusion-sub" style="margin-top:4px">ETH 区块: '+(ethBlocks||'—')+(ethBlocks?' / 24h':'')+(ethBlocks?'':'')+'</div>'
      +'<div class="fusion-sub">BNB 24h: <b>'+(bnbActive!=='—'?bnbActive:'—')+'</b> 笔'+(bnbDir?' <span style="color:'+(bnbDir==='up'?'var(--green)':bnbDir==='down'?'var(--red)':'var(--text2)')+';font-weight:bold">'+(bnbDir==='up'?'↑':bnbDir==='down'?'↓':'→')+'</span>':'')+'</div>'
      +'<div class="fusion-sub" style="margin-top:4px;color:'+freshCls(S.fusion.lastOnChain)+'">'+freshTxt(S.fusion.lastOnChain)+' <span style="color:var(--text2)">('+(eth?eth.src:'—')+(bnb&&bnb.src!=='keyless'?'/'+bnb.src:'')+')</span></div>';
    cards.push('<div class="fusion-card"><h4>'+t('fus_onchain')+badge(badgeTxt,badgeCol)+'</h4>'+ocHtml+'</div>');
  }
  // ---- BNB销毁/ETH供应卡 (阶段二) ----
  {
    const oc=S.fusion.onChain||{};
    const eth=oc.eth||null,bnb=oc.bnb||null;
    const ethSupply=eth&&eth.supplyEth?eth.supplyEth:null;
    const ethSupplyTxt=ethSupply!=null?(ethSupply/1e6).toFixed(1)+'M ETH':'—';
    const burn=bnb&&bnb.burn?bnb.burn:null;
    const burnTotal=burn&&burn.total?Math.round(burn.total).toLocaleString('en-US'):null;
    const burnAuto=burn&&burn.auto?Math.round(burn.auto).toLocaleString('en-US'):null;
    const burnDir=burn?null:null;
    const supplyHtml='<div class="fusion-val" style="font-size:13px">ETH 总供应: <b>'+ethSupplyTxt+'</b></div>'
      +'<div class="fusion-sub" style="margin-top:4px">'+t('fus_onchain_bnb')+': '+(burnTotal?burnTotal+' BNB':'<span style="color:var(--text2)">'+(bnb?'—':'需配置 Key')+'</span>')+'</div>'
      +(burnAuto?'<div class="fusion-sub">自动销毁: '+burnAuto+' BNB</div>':'')
      +'<div class="fusion-sub" style="margin-top:4px;color:'+freshCls(S.fusion.lastOnChain)+'">'+freshTxt(S.fusion.lastOnChain)+'</div>';
    cards.push('<div class="fusion-card"><h4>'+t('fus_onchain2')+'</h4>'+supplyHtml+'</div>');
  }
  if(!window.__fusionDrag){fg.innerHTML=cards.join('');applyFusionOrder();}
  if(!window.__fusionDrag)initFusionDnD();
  refreshFusionRatio(sym);
}

// ---- 融合卡片拖放排序(HTML5 DnD + localStorage 持久化) ----
let __fusionDnDInited=false;
function getFusionOrder(){
  try{const r=localStorage.getItem('smartTrader_fusionOrder');if(!r)return null;const a=JSON.parse(r);return Array.isArray(a)?a:null;}catch(e){return null;}
}
function saveFusionOrderFromDOM(){
  try{
    const fg=document.getElementById('fusionGrid');if(!fg)return;
    const order=Array.prototype.map.call(fg.children,el=>el.dataset&&el.dataset.c).filter(Boolean);
    localStorage.setItem('smartTrader_fusionOrder',JSON.stringify(order));
  }catch(e){}
}
function resetFusionOrder(){try{localStorage.removeItem('smartTrader_fusionOrder');}catch(e){}renderFusion();}

// ---- 顶部多空比: 汇总下方所有卡片 h4 徽章的多/空方向 (复用各卡已有判定, 不改卡片规则) ----
function refreshFusionRatio(sym){
  const ratioEl=document.getElementById('fusionLSRatio');
  const fg=document.getElementById('fusionGrid');
  const badgeTexts=[];
  if(fg&&fg.children.length){
    Array.prototype.forEach.call(fg.children,el=>{
      const h4=el.querySelector('h4');
      if(!h4)return;
      // 徽章是 h4 内 float:right 的 span 文本(多/空/偏多/偏空), 标题文本在 childNodes[0]
      Array.prototype.forEach.call(h4.childNodes,n=>{
        if(n.nodeType===1&&n.innerHTML&&n.textContent){
          const txt=n.textContent.trim();
          if(txt&&(txt.indexOf('多')>=0||txt.indexOf('空')>=0))badgeTexts.push(txt);
        }
      });
    });
  }
  let up=0,dn=0;
  badgeTexts.forEach(txt=>{
    // 偏多/多 → 多; 偏空/空 → 空
    if(txt.indexOf('偏多')>=0||txt==='多')up++;
    else if(txt.indexOf('偏空')>=0||txt==='空')dn++;
  });
  const total=up+dn;
  let inner='';
  if(total>0){
    // 多空数量转百分比, 只显示 "看多X% / 看空Y%"
    const upPct=Math.round(up/total*100),dnPct=100-upPct;
    inner='<span style="color:var(--green)">看多'+upPct+'%</span> / <span style="color:var(--red)">看空'+dnPct+'%</span>';
  }else{
    // 无任何卡片有方向徽章时回退: 显示多空账户比(lsG 散户多空), 避免顶部空白
    const lgv=S.fusion.lsG[sym];
    if(lgv){
      const lp=normLongRatio(lgv);
      inner='<span style="color:var(--green)">看多'+lp.toFixed(0)+'%</span> / <span style="color:var(--red)">看空'+(100-lp).toFixed(0)+'%</span> <span style="color:var(--text2);font-size:9px">(账户比)</span>';
    }
  }
  if(ratioEl)ratioEl.innerHTML=inner;
}
function applyFusionOrder(){
  const fg=document.getElementById('fusionGrid');if(!fg||!fg.children.length)return;
  const rev={};
  Object.keys(T).forEach(k=>{if(k.indexOf('fus_')===0){const v=t(k);if(v&&!rev[v])rev[v]=k;}});
  const byId={};
  Array.prototype.forEach.call(fg.children,el=>{
    const h4=el.querySelector('h4');
    const key=h4&&h4.childNodes[0]?rev[h4.childNodes[0].nodeValue]:null;
    if(key){el.dataset.c=key;byId[key]=el;}else{delete el.dataset.c;}
    el.draggable=true;
  });
  const saved=getFusionOrder();
  if(!saved||!saved.length)return;
  const snapshot=Array.prototype.slice.call(fg.children);
  const placed=new Set();
  saved.forEach(k=>{const el=byId[k];if(el&&!placed.has(el)){fg.appendChild(el);placed.add(el);}});
  snapshot.forEach(el=>{if(!placed.has(el))fg.appendChild(el);});
}
function initFusionDnD(){
  const fg=document.getElementById('fusionGrid');if(!fg||__fusionDnDInited)return;
  __fusionDnDInited=true;
  fg.addEventListener('dragstart',e=>{
    const el=e.target.closest('.fusion-card');if(!el||!el.dataset.c)return;
    e.dataTransfer.effectAllowed='move';
    e.dataTransfer.setData('text/plain',el.dataset.c);
    el.classList.add('dragging');
    window.__fusionDrag=true;
  });
  fg.addEventListener('dragover',e=>{
    e.preventDefault();e.dataTransfer.dropEffect='move';
    const dragEl=fg.querySelector('.dragging');if(!dragEl)return;
    const t=e.target.closest('.fusion-card');if(!t||t===dragEl)return;
    const rect=t.getBoundingClientRect();
    fg.insertBefore(dragEl,(e.clientX-rect.left)>(rect.width/2)?t.nextSibling:t);
  });
  fg.addEventListener('drop',e=>{
    e.preventDefault();
    const dragEl=fg.querySelector('.dragging');
    if(dragEl)dragEl.classList.remove('dragging');
    window.__fusionDrag=false;
    saveFusionOrderFromDOM();
    renderFusion();
  });
  fg.addEventListener('dragend',e=>{
    if(e.target&&e.target.classList)e.target.classList.remove('dragging');
    window.__fusionDrag=false;
  });
}

function setFusionSym(sym){S.sel=sym;render();fetchBinanceLSData();fetchMultiTF();fetchOnChain();}

// 把币种映射到链上数据源: ETH→'eth', BNB→'bnb', 其余→null
function chainOf(sym){
  if(!sym)return null;
  const base=(sym.replace(/USDT$|USDC$|BUSD$|USD$/i,'')||'').toUpperCase();
  if(base==='ETH')return 'eth';
  if(base==='BNB')return 'bnb';
  return null;
}
function renderAI(){
  const ad=document.getElementById('aiDecisions');if(ad){
    ad.innerHTML=S.ai.dec.length?S.ai.dec.slice().reverse().map(d=>{
      const cc2=d.conf>=75?'var(--red)':d.conf>=60?'var(--gold)':'var(--text2)';
      const cb2=d.conf>=75?'rgba(0,230,118,.12)':d.conf>=60?'rgba(255,215,64,.12)':'rgba(107,118,136,.12)';
      return '<div class="ai-decision"><div class="ai-action">'+symId(d.sym)+' '+(d.side==='long'?t('pos_dolong'):t('pos_doshort'))+(d.ex?' <span style="color:var(--red)">'+t('ai_exec')+'</span>':' <span style="color:var(--text2)">'+t('ai_wait')+'</span>')+'</div>'
        +'<div class="ai-reason">'+tSig(d.reason)+'</div><div class="ai-conf" style="color:'+cc2+';background:'+cb2+'">'+t('ai_conf')+' '+d.conf+'%</div></div>';
    }).join(''):'<div class="no-pos">'+t('ai_waitmsg')+'</div>';
  }
  const as=document.getElementById('aiStats');if(as){
    const wr=S.ai.tt>0?Math.round(S.ai.w/S.ai.tt*100):0;
    const aiMaxEl=document.getElementById('setAiMax');
    const aiMax=parseInt(aiMaxEl?aiMaxEl.value:'20')||20;
    as.innerHTML='<div class="ai-stat"><div class="ai-stat-val">'+S.ai.tt+'</div><div class="ai-stat-lbl">'+t('ai_total')+'</div></div>'
      +'<div class="ai-stat"><div class="ai-stat-val" style="color:var(--red)">'+wr+'%</div><div class="ai-stat-lbl">'+t('ai_winrate')+'</div></div>'
      +'<div class="ai-stat"><div class="ai-stat-val" style="color:var(--green)">'+S.ai.w+'</div><div class="ai-stat-lbl">'+t('ai_win')+'</div></div>'
      +'<div class="ai-stat"><div class="ai-stat-val" style="color:var(--red)">'+S.ai.l+'</div><div class="ai-stat-lbl">'+t('ai_lose')+'</div></div>'
      +'<div class="ai-stat"><div class="ai-stat-val" style="color:'+(S.ai.dayCount>=aiMax?'var(--red)':'var(--gold)')+'">'+(S.ai.dayCount||0)+'/'+aiMax+'</div><div class="ai-stat-lbl">今日已用</div></div>';
  }
  const ap=document.getElementById('aiPrompt');if(ap)ap.textContent=tPrompt(S.ai.prompt)||t('ai_waitdata');
  const ag=document.getElementById('aiGate');
  if(ag)ag.textContent=S.ai.lastGate?('方向门: '+S.ai.lastGate):'方向门: 等待数据…';
  var ac=document.getElementById('aiCap');
  if(ac){
    var ds=S.ai.dirStat;
    var lw=(ds.long.w+ds.long.l)||0,sw=(ds.short.w+ds.short.l)||0;
    var lwr=lw>0?Math.round(ds.long.w/lw*100)+'%':'--';
    var swr=sw>0?Math.round(ds.short.w/sw*100)+'%':'--';
    ac.innerHTML='<div style="font-size:9px;color:var(--text2);margin-top:6px;border-top:1px solid var(--border);padding-top:4px;line-height:1.6">'
      +'<span>上限: 多'+dirCap('long')+'/'+totalCap()+'总 / 空'+dirCap('short')+'</span>'
      +'&nbsp;&nbsp;|&nbsp;&nbsp;'
      +'<span>多胜率: '+lwr+' ('+ds.long.w+'/'+lw+')</span>'
      +'&nbsp;&nbsp;|&nbsp;&nbsp;'
      +'<span>空胜率: '+swr+' ('+ds.short.w+'/'+sw+')</span>'
      +'</div>';
  }
  var aw=document.getElementById('aiWarn');
  if(aw)aw.innerHTML='<div style="color:var(--gold);font-size:8px;padding:4px 0;line-height:1.4">⚠ AI交易存在风险，历史表现不代表未来收益。模拟环境仅供参考。</div>';
  var sc=document.getElementById('aiSigScores');
  if(sc){
    var keys=Object.keys(S.ai.sigScore).filter(function(k){return S.ai.sigScore[k].total>=2;});
    keys.sort(function(a,b){return getSigScore(b)-getSigScore(a);});
    if(keys.length>0){
      var sh='<div style="font-size:9px;color:var(--text2);margin-top:8px;border-top:1px solid var(--border);padding-top:6px">';
      sh+='<div style="margin-bottom:4px;color:var(--accent)">&#9670; '+(mode==='simple'?'AI学会了这些招数':'信号评分')+'</div>';
      keys.slice(0,6).forEach(function(k){
        var s=S.ai.sigScore[k];var sc2=getSigScore(k);
        var bar=Math.round(sc2/2.5*100);
        var c2=sc2>=1.5?'var(--green)':sc2>=0.8?'var(--gold)':'var(--red)';
        var label=mode==='simple'?(sc2>=1.5?'靠谱':sc2>=0.8?'还行':'别信'):(sc2>=1.5?'强信号':sc2>=0.8?'中性':'弱信号');
        sh+='<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">';
        sh+='<span style="min-width:60px;color:var(--text)">'+k+'</span>';
        sh+='<div style="flex:1;height:4px;background:var(--border);border-radius:2px"><div style="height:100%;width:'+bar+'%;background:'+c2+';border-radius:2px"></div></div>';
        sh+='<span style="min-width:45px;font-size:8px;color:'+c2+'">'+s.wins+'/'+s.total+' '+label+'</span></div>';
      });
      sh+='</div>';sc.innerHTML=sh;
    }else{
      sc.innerHTML='<div style="font-size:9px;color:var(--text2);margin-top:8px;border-top:1px solid var(--border);padding-top:6px">'+(mode==='simple'?'AI还在学习中...':'信号学习中...')+'</div>';
    }
  }
  var btn=document.getElementById('btnFullAnalysis');
  if(btn)btn.innerHTML='&#9670; '+(S.ai.faOpen?t('ai_full_close'):t('ai_full_label'));
  renderFullAnalysis();
  renderLLMBlock();
  renderLLMHistory();
  renderTradeLib();
}
function renderLLMBlock(){
  var el=document.getElementById('aiLLMBlock');if(!el)return;
  var st=document.getElementById('llmBudgetDisplay');
  var cfg=readLLMSettings();
  if(st){
    var sm=S.ai.llmStats||{calls:0,tokens:0};
    st.textContent=cfg.on?('今日: '+(cfg.budgetMode==='tokens'?((sm.tokens||0)/1000).toFixed(0)+'/'+cfg.budget+'K tok':(sm.calls||0)+'/'+cfg.budget+'次')):'LLM 关闭';
  }
  if(!cfg.on){el.innerHTML='<div class="no-pos">LLM 未开启 (设置页可开启)</div>';return;}
  var llm=S.ai.llm;
  if(!llm){el.innerHTML='<div class="no-pos">等待首次分析...'+(S.ai.llmErr?(' (最近错误: '+S.ai.llmErr+')'):'')+'</div>';return;}
  var dirLabel=llm.verdict==='long'?'看多':llm.verdict==='short'?'看空':'中性';
  var dCol=llm.verdict==='long'?'var(--green)':llm.verdict==='short'?'var(--red)':'var(--text2)';
  var age=Math.round((Date.now()-(llm.ts||0))/60000);
  var rows=Object.keys(llm.symbols||{}).map(function(sym){
    var v=llm.symbols[sym];
    var lbl=v.direction==='long'?'多':v.direction==='short'?'空':'中性';
    var col=v.direction==='long'?'var(--green)':v.direction==='short'?'var(--red)':'var(--text2)';
    return '<div style="display:flex;gap:8px;padding:3px 4px;border-bottom:1px dashed var(--border);font-size:9px">'
      +'<span style="min-width:70px;font-weight:bold">'+symId(sym)+'</span>'
      +'<span style="color:'+col+';min-width:30px">'+lbl+'</span>'
      +'<span style="color:var(--text2);min-width:42px">'+(v.confidence||0)+'%</span>'
      +'<span style="color:var(--text2);flex:1">'+(v.reason||'')+'</span></div>';
  }).join('');
  var modeLabel=cfg.role==='trade'?'可参与交易':'仅信号';
  var histHtml=(S.ai.llmHistory&&S.ai.llmHistory.length)?'<div style="border-top:1px solid var(--border);margin-top:4px;padding-top:4px;font-size:9px;color:var(--text2)">最近'+Math.min(S.ai.llmHistory.length,6)+'次分析: <span style="color:var(--green)">'+S.ai.llmHistory.filter(function(h){return h.verdict==='long';}).length+'多</span> / <span style="color:var(--red)">'+S.ai.llmHistory.filter(function(h){return h.verdict==='short';}).length+'空</span></div>':'';
  el.innerHTML='<div style="font-size:10px;margin-bottom:4px">模式: <b>'+modeLabel+'</b> | 整体: <b style="color:'+dCol+'">'+dirLabel+'</b> <span style="color:var(--text2);font-size:9px">'+age+'分钟前</span>'+(llm.ms?' <span style="color:var(--text2);font-size:9px">'+llm.ms+'ms</span>':'')+'</div>'
    +(llm.reasoning?'<div style="font-size:9px;color:var(--text2);margin-bottom:4px">'+llm.reasoning+'</div>':'')
    +'<div style="border-top:1px solid var(--border)">'+rows+'</div>'
    +histHtml
    +(S.ai.llmErr?'<div style="font-size:9px;color:var(--gold);margin-top:4px">最近错误: '+S.ai.llmErr+'</div>':'');
}
function renderLLMHistory(){
  var el=document.getElementById('aiLLMHist');if(!el)return;
  var hist=S.ai.llmHistory||[];
  if(!hist.length){el.innerHTML='<div class="no-pos">暂无历史会话 (每次分析后自动积累)</div>';return;}
  var total=hist.length;
  el.innerHTML='<div style="font-size:9px;color:var(--text2);margin-bottom:4px">共保留 '+total+' 条会话记录</div>'
    +'<div style="max-height:260px;overflow-y:auto;padding-right:2px">'
    +hist.slice().reverse().slice(0,20).map(function(h){
    var dir=h.verdict==='long'?'看多':h.verdict==='short'?'看空':'中性';
    var col=h.verdict==='long'?'var(--green)':h.verdict==='short'?'var(--red)':'var(--text2)';
    var age=Math.round((Date.now()-(h.ts||0))/60000);
    var ageStr=age<60?age+'分钟前':Math.round(age/60)+'小时前';
    var d=new Date(h.ts||Date.now());
    var hh=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
    var perSym=Object.keys(h.symbols||{}).map(function(sym){
      var v=h.symbols[sym];if(!v||v.direction==='neutral')return '';
      var lbl=v.direction==='long'?'多':'空';
      return '<span style="color:'+col+';margin-right:6px">'+symId(sym)+' '+lbl+' '+Math.round(v.confidence||0)+'%</span>';
    }).join('');
    return '<div style="background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:5px 8px;margin-bottom:5px;font-size:9px">'
      +'<div><b style="color:'+col+'">'+dir+'</b> <span style="color:var(--text2)">'+ageStr+' ('+hh+')</span></div>'
      +'<div style="color:var(--text2);margin-top:2px">'+(perSym||'全部中性')+'</div>'
      +(h.reasoning?'<div style="color:var(--text2);margin-top:2px">'+h.reasoning+'</div>':'')
      +'</div>';
  }).join('')+'</div>';
}
function renderTradeLib(){
  var el=document.getElementById('aiTradeLib');if(!el)return;
  var tab=S.ai.tradeLibTab||'win';
  var list=tab==='win'?(S.ai.winTrades||[]):(S.ai.loseTrades||[]);
  if(!list.length){el.innerHTML='<div class="no-pos">暂无'+(tab==='win'?'成功':'失败')+'交易记录 (AI 平仓后自动积累, 含完整信号轨迹)</div>';return;}
  el.innerHTML=list.slice().reverse().slice(0,20).map(function(t){
    var green=t.pnl>=0;
    var col=green?'var(--green)':'var(--red)';
    var dir=t.side==='long'?'做多':'做空';
    return '<div style="background:var(--card2);border:1px solid var(--border);border-radius:6px;padding:6px 8px;margin-bottom:5px;font-size:9px;line-height:1.6">'
      +'<div><b>'+symId(t.sym)+'</b> '+dir+' '+t.lev+'x | <span style="color:'+col+'">'+(green?'+':'')+'$'+t.pnl+' ('+t.pnlPct+'%)</span> | '+t.date+' | 持有'+t.holdMin+'分钟</div>'
      +'<div style="color:var(--text2)">入场$'+t.entry+' → 出场$'+t.exit+' | 置信'+t.conf+' | 门:'+t.gate+' | 情境:'+t.regime+'</div>'
      +'<div style="color:var(--text2)">信号: '+(t.signals?tl(t.signals):'--')+'</div>'
      +'<div style="color:var(--text2)">环境: FG:'+t.fg+' 多仓'+t.posLong+' 空仓'+t.posShort+' 总仓'+t.totalPos+' | 原因:'+t.reason+'</div></div>';
  }).join('');
}
function switchTradeLibTab(tab){
  S.ai.tradeLibTab=tab;
  renderTradeLib();
}
function renderArb(){
  const al=document.getElementById('arbList');if(!al)return;
  al.innerHTML=S.arb.opp.length?S.arb.opp.map(a=>'<div class="arb-card">'
    +'<div class="arb-icon">&#8644;</div>'
    +'<div class="arb-info"><div class="arb-sym">'+a.sym+'</div><div class="arb-detail">'+a.buyE+' $'+fp(a.bP)+' → '+a.sellE+' $'+fp(a.sP)+' | '+t('card_spread')+a.sp.toFixed(3)+'%</div></div>'
    +'<div class="arb-profit"><div class="arb-profit-val">+$'+a.net.toFixed(2)+'</div></div></div>').join('')
    :'<div class="no-pos">'+t('arb_wait')+'</div>';
}
function renderSubs(){
  const sd=document.getElementById('subDetailGrid');if(!sd)return;
  sd.innerHTML=S.subs.map(s=>'<div class="sub-detail-card"><div class="sd-id">Sub #'+s.id+' <span style="color:var(--text2)">'+s.ex+'</span></div>'
    +'<div class="sd-bal" style="color:'+(s.bal>=P.size?'var(--green)':'var(--red)')+'">$'+s.bal.toFixed(2)+'</div>'
    +'<div class="sd-status '+s.st+'">'+(s.st==='idle'?t('sub_idle'):s.st==='active'?t('sub_active'):t('sub_losed'))+'</div>'
    +'<div class="sd-pnl" style="color:'+(s.pnl>=0?'var(--green)':'var(--red)')+'">'+(s.pnl>=0?'+':'')+'$'+s.pnl.toFixed(2)+'</div></div>').join('');
}

function histRow(c){
  const sym=c.sym.replace('USDT','');
  const time=new Date(c.t).toTimeString().slice(0,8);
  const green=c.pnl>=0;
  const col=green?'var(--green)':'var(--red)';
  const side=c.side==='long'?'做多':'做空';
  return '<div class="pnl-hist-row"><span style="color:var(--text2)">'+time+'</span><span class="pnl-sym">'+sym+' '+side+' '+c.lev+'x</span>'
    +'<span style="color:var(--text2)">Sub#'+pf(c.sub)+'</span><span style="color:var(--text2)">'+c.reason+'</span>'
    +'<span style="color:'+col+'">'+(green?'+':'')+'$'+c.pnl.toFixed(2)+'</span></div>';
}

function renderPnlPage(){
  memoizeRender('pnlPage',(S.closed||[]).length+','+S.realized.toFixed(2)+'|'+S.pos.map(p=>p.sym+','+Math.round(p.pnl*100)).join(';')+'|'+sigOfPrices(),()=>{
  const closed=S.closed||[];
  const wins=closed.filter(c=>c.pnl>=0);
  const losses=closed.filter(c=>c.pnl<0);
  const empty='<div class="pnl-empty">暂无记录</div>';
  document.getElementById('pnlWin').innerHTML=wins.length?wins.slice(-12).reverse().map(histRow).join(''):empty;
  document.getElementById('pnlLoss').innerHTML=losses.length?losses.slice(-12).reverse().map(histRow).join(''):empty;
  const histEl=document.getElementById('pnlHist');
  if(histEl){
    histEl.innerHTML='<div class="pnl-hist-head"><span>时间</span><span>交易</span><span>子账户</span><span>原因</span><span>盈亏</span></div>'
      +(closed.length?closed.slice().reverse().map(histRow).join(''):'<div class="pnl-empty">暂无交易记录</div>');
  }
  const allFloat=S.pos.reduce((a,c)=>a+c.pnl,0);
  const net=S.realized+allFloat;
  const re=document.getElementById('pnlReal'),fl=document.getElementById('pnlFloat'),nt=document.getElementById('pnlNet'),cnt=document.getElementById('pnlCount');
  if(re){re.textContent=(S.realized>=0?'+':'')+'$'+S.realized.toFixed(2);re.style.color='var(--purple)';}
  if(fl){fl.textContent=(allFloat>=0?'+':'')+'$'+allFloat.toFixed(2);fl.style.color=allFloat>=0?'var(--green)':'var(--red)';}
  if(nt){nt.textContent=(net>=0?'+':'')+'$'+net.toFixed(2);nt.style.color=net>=0?'var(--green)':'var(--red)';}
  if(cnt){cnt.textContent=closed.length;}
  const cvWrap=document.getElementById('pnlCurves');
  if(cvWrap){
    const openPos=S.pos.filter(p=>p.qty>0.00001);
    cvWrap.innerHTML=openPos.length?openPos.map(pos=>{
      const green=pos.pnl>=0,side=pos.side==='long'?'做多':'做空';
      const cur=pos.pnl>=0?'+':'';
      return '<div class="pnl-curve-item"><div class="pnl-curve-label">'+pos.sym.replace('USDT','')+' '+side+' '+pos.lev+'x Sub#'+pf(pos.sid)+'<div style="color:'+(green?'var(--green)':'var(--red)')+'">'+cur+'$'+pos.pnl.toFixed(2)+'</div></div>'
        +'<canvas class="pnl-curve-canvas" id="pv_'+pos.sid+'" width="320" height="34"></canvas></div>';
    }).join(''):'<div class="pnl-empty">暂无持仓</div>';
    openPos.forEach(pos=>drawCurve('pv_'+pos.sid,pos.pnlHis||[0],pos.pnl));
  }
  });
}

function drawCurve(id,his,curPnl){
  const cv=document.getElementById(id);if(!cv)return;
  const ctx=cv.getContext('2d'),W=cv.width,H=cv.height;
  ctx.clearRect(0,0,W,H);
  const mid=H/2;
  ctx.strokeStyle='rgba(107,118,136,.4)';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(4,mid);ctx.lineTo(W-4,mid);ctx.stroke();
  if(!his||his.length<2)return;
  const mn=Math.min(0,...his),mx=Math.max(0,...his),rng=mx-mn||0.0001;
  const X=i=>4+((his.length===1?0:i)/(his.length-1))*(W-8);
  const Y=v=>mid-((v-mn)/rng)*(H-12)+6;
  const fill='#00E676',crit='#FF5252';
  ctx.beginPath();ctx.moveTo(4,mid);
  his.forEach((v,i)=>{ctx.lineTo(X(i),Y(v))});
  ctx.lineTo(X(his.length-1),mid);ctx.closePath();
  const lg=ctx.createLinearGradient(0,mid,0,H);
  lg.addColorStop(0,curPnl>=0?'rgba(0,230,118,.25)':'rgba(255,82,82,.25)');lg.addColorStop(1,'transparent');
  ctx.fillStyle=lg;ctx.fill();
  ctx.beginPath();ctx.lineWidth=1.4;
  his.forEach((v,i)=>{const x=X(i),y=Y(v);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)});
  ctx.strokeStyle=curPnl>=0?fill:crit;ctx.stroke();
  ctx.fillStyle=curPnl>=0?fill:crit;
  ctx.beginPath();ctx.arc(X(his.length-1),Y(his[his.length-1]),2,0,Math.PI*2);ctx.fill();
}

function fp(p){return p>=1000?p.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:2}):p>=1?p.toFixed(2):p.toFixed(4)}
function pf(id){return String(id).padStart(2,'0')}
function selectSym(id){S.sel=id;render()}
function aiTrade(sym){const sub=S.subs.find(s=>s.st==='idle'&&s.bal>=10);if(sub)openTrade(sym,sub.id,Math.random()>.5?'long':'short',10,10);}

let mSym='',mSide='long';
function openModal(sym,side){mSym=sym;mSide=side;
  document.getElementById('modalTitle').textContent=(side==='long'?'买入 ':'卖出 ')+sym;
  document.getElementById('modalSide').value=side;
  const idleSubs=S.subs.filter(s=>s.st==='idle'&&s.bal>=10);
  const allSubs=S.subs;
  if(idleSubs.length>0){
    document.getElementById('modalSub').innerHTML=idleSubs.map(s=>'<option value="'+s.id+'">Sub #'+s.id+' ('+s.ex+') $'+s.bal.toFixed(1)+'</option>').join('');
  }else{
    document.getElementById('modalSub').innerHTML=allSubs.map(s=>'<option value="'+s.id+'">Sub #'+s.id+' ('+s.ex+') $'+s.bal.toFixed(1)+(s.st==='active'?' [持仓中]':'')+'</option>').join('');
  }
  const cb=document.getElementById('modalConfirm');cb.textContent=side==='long'?t('modal_conf_buy'):t('modal_conf_sell');cb.className=side==='long'?'btn btn-buy':'btn btn-sell';
  document.getElementById('tradeModal').classList.add('show');
}
function closeModal(){document.getElementById('tradeModal').classList.remove('show')}
function updateModalFees(){
  const amt=parseFloat(document.getElementById('modalAmount').value)||0;
  const lev=parseInt(document.getElementById('modalLeverage').value)||10;
  const fee=(amt*lev*FEE).toFixed(3);
  const slip=(amt*lev*SLIP).toFixed(3);
  const fd=document.getElementById('modalFeeDisplay');if(fd)fd.textContent='$'+fee;
  const sd=document.getElementById('modalSlipDisplay');if(sd)sd.textContent='$'+slip;
}
function confirmTrade(){const sid=parseInt(document.getElementById('modalSub').value),side=document.getElementById('modalSide').value;
  const lev=parseInt(document.getElementById('modalLeverage').value),amt=parseFloat(document.getElementById('modalAmount').value);
  if(!sid||!amt)return;openTrade(mSym,sid,side,lev,amt);closeModal();}
var _closePosIdx=-1,_closePosTimer=null;
function showClosePosModal(idx){
  const pos=S.pos[idx];if(!pos)return;
  _closePosIdx=idx;
  const d=pos.side==='long'?'做多':'做空';
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('closePosTitle',symId(pos.sym)+' 平仓确认');
  set('closePosDirLev',d+' '+(pos.lev||1)+'x');
  set('closePosEntry','$'+pos.entry.toFixed(2));
  set('closePosQty',pos.qty.toFixed(4));
  const el=document.getElementById('closePosModal');if(el)el.classList.add('show');
  updateClosePosPnl();
  if(_closePosTimer)clearInterval(_closePosTimer);
  _closePosTimer=setInterval(updateClosePosPnl,1000);
}
function updateClosePosPnl(){
  const pos=_closePosIdx>=0?S.pos[_closePosIdx]:null;
  if(!pos){closePosModal();return;}
  const curP=(S.prices[pos.sym]||{}).last||0;
  const pnl=curP?(pos.side==='long'?(curP-pos.entry)*pos.qty:(pos.entry-curP)*pos.qty):0;
  const pnlPct=pos.entry?pnl/(pos.entry*pos.qty)*100:0;
  const e=document.getElementById('closePosPnl');if(!e)return;
  e.textContent=(curP?'$'+curP.toFixed(2)+'  ':'')+(pnl>=0?'+':'')+'$'+pnl.toFixed(2)+' ('+(pnlPct>=0?'+':'')+pnlPct.toFixed(2)+'%)';
  e.style.color=pnl>=0?'var(--green)':'var(--red)';
  const c=document.getElementById('closePosCur');if(c)c.textContent='$'+curP.toFixed(2);
}
function closePosModal(){
  if(_closePosTimer){clearInterval(_closePosTimer);_closePosTimer=null;}
  _closePosIdx=-1;
  const el=document.getElementById('closePosModal');if(el)el.classList.remove('show');
}
function confirmClosePosModal(){
  const idx=_closePosIdx;if(idx<0)return;
  closePosModal();
  closePos(idx);
  if(window.__renderTechCanvas)window.__renderTechCanvas();
}

var GLOSSARY=[
{t:'做多',en:'Long',cat:'交易基础',d:'预期价格上涨，先买入等涨了再卖出赚钱',b:'就像你看到房价要涨，先贷款买了套房，涨了再卖掉赚差价。或者你觉得黄金要涨，先买根金条放着',m:'看涨就买，跌了就亏'},
{t:'做空',en:'Short',cat:'交易基础',d:'预期价格下跌，先借币卖掉，等跌了再买回来还',b:'就像你借了邻居一箱苹果，按100块卖掉。过了两天苹果跌到60块，你花60买一箱还给邻居，白赚40块差价',m:'觉得要跌也能赚钱，先卖后买'},
{t:'开仓',en:'Open Position',cat:'交易基础',d:'建立一个新的交易头寸',b:'就像你去赌场换了筹码坐上赌桌，这就是"开仓"了',m:'开始一笔交易'},
{t:'平仓',en:'Close Position',cat:'交易基础',d:'结束已有的交易头寸，实现盈亏',b:'就像你把买了的股票卖掉，把赚了或亏了的钱拿到手',m:'结束交易，钱到手'},
{t:'入场价',en:'Entry Price',cat:'交易基础',d:'开仓时的成交价格',b:'就像你买东西时的成交价，比如你10块钱买了1个比特币，那10块就是你的入场价',m:'你买入时的价格'},
{t:'杠杆',en:'Leverage',cat:'杠杆保证金',d:'用少量保证金放大交易规模',b:'就像房贷：你首付10万撬动了一套100万的房子，这就是10倍杠杆。赚了10倍爽，跌了也亏10倍',m:'借钱炒股，赚的多亏的也多'},
{t:'保证金',en:'Margin',cat:'杠杆保证金',d:'开仓时实际投入的资金',b:'就像你买房的首付，100万的房子你掏了10万首付，这10万就是你的保证金',m:'你自己出的那部分钱'},
{t:'手续费',en:'Fee/Commission',cat:'杠杆保证金',d:'每次交易平台收取的费用',b:'就像你去菜市场买菜要交摊位费，或者转账要收手续费，每笔交易都要交一点给平台',m:'平台的过路费'},
{t:'滑点',en:'Slippage',cat:'杠杆保证金',d:'下单价格和实际成交价格的差异',b:'就像你在网上看到可乐3块钱，下单时变成3块5了——网页标价和实际结账不一样',m:'价格和你看到的不一样'},
{t:'止损',en:'Stop Loss',cat:'风险管理',d:'设定一个亏损上限，到了就自动平仓',b:'就像设了个闹钟：亏到100块就走人，不管后面还会不会涨回来。宁可小亏也不大亏',m:'亏够了就跑，别死扛'},
{t:'止盈',en:'Take Profit',cat:'风险管理',d:'设定一个盈利目标，到了就自动平仓锁定利润',b:'就像你抓娃娃机，抓到3个就走。贪心再多抓几个，可能又全吐回去',m:'赚够了就收手'},
{t:'跟踪止损',en:'Trailing Stop',cat:'风险管理',d:'随着价格上涨动态提高止损位，保护已有利润',b:'就像遛狗时你跟在后面：狗往右跑你也往右跟，但狗一回头你就站在那里不跟了——保住已经走过的距离',m:'赚了就锁住利润，别让它跑掉'},
{t:'阶梯止盈',en:'Tiered Take Profit',cat:'风险管理',d:'分批在不同涨幅卖出，逐步锁定利润',b:'就像吃自助餐不能一次吃撑，先吃一半垫底，好吃再加。分批来，不怕全亏',m:'分批卖，别全押'},
{t:'保本出',en:'Break-even Exit',cat:'风险管理',d:'当盈利达到一定程度时先平一半，确保不亏',b:'就像你打牌赢了一把后先把本拿回来，剩下的钱随便玩。反正本金已经保住了',m:'先保本，剩下的随便玩'},
{t:'回撤',en:'Drawdown',cat:'风险管理',d:'从最高点回落的幅度',b:'就像你坐过山车到了最高点然后往下掉，掉的那段高度就是回撤',m:'从最高点掉了多少'},
{t:'止盈目标',en:'Take Profit Target',cat:'风险管理',d:'预设的获利平仓价格',b:'就像你钓鱼设了个目标：钓到3条就回家。到了就收手，不贪',m:'赚到目标就走'},
{t:'强平',en:'Liquidation',cat:'风险管理',d:'亏损达到保证金上限，平台强制平仓',b:'就像你贷款买房断供了，银行把房子收走了——你的首付全没了',m:'亏光了被强制卖'},
{t:'置信度',en:'Confidence',cat:'AI交易',d:'AI对自己判断的把握程度（0-100%）',b:'就像你考试前的自信程度：这题我95%确定选A，那题我55%猜的',m:'AI觉得自己有多靠谱'},
{t:'信号',en:'Signal',cat:'AI交易',d:'AI用来判断买卖的技术指标组合',b:'就像天气预报看云、温度、风向来判断要不要带伞。AI看各种数据来判断该买还是该卖',m:'AI判断的依据'},
{t:'胜率',en:'Win Rate',cat:'AI交易',d:'盈利交易占总交易的百分比',b:'就像你投篮命中率：投了100个中了60个，胜率就是60%',m:'赢的次数占多少'},
{t:'资金费率',en:'Funding Rate',cat:'市场数据',d:'永续合约中多空双方互相支付的费率',b:'就像租房的租金：多头和空头互相"租"对方的头寸，谁该付钱取决于市场偏向哪边',m:'多空双方的过夜费'},
{t:'持仓量',en:'Open Interest (OI)',cat:'市场数据',d:'市场上未平仓合约的总价值',b:'就像赌场里所有人桌上的筹码总和。筹码越多说明玩的人越多，市场越热',m:'市场上所有还没了结的赌注'},
{t:'恐惧贪婪指数',en:'Fear & Greed Index',cat:'市场数据',d:'衡量市场整体情绪的综合指标（0-100）',b:'就像菜市场大妈指数：大妈都疯狂买菜的时候该囤货了，大妈都不买的时候便宜货来了',m:'市场是害怕还是贪婪'},
{t:'鲸鱼',en:'Whale',cat:'市场数据',d:'持有大量资金的大户投资者',b:'就像鲸鱼游过小鱼群——它翻个身浪就很大，小鱼都被影响了。大资金动一下市场就跟着晃',m:'有钱大佬，一动市场就晃'},
{t:'多头',en:'Longs',cat:'市场数据',d:'买入做多的一方',b:'就像看涨房价的购房者，觉得房价要涨所以先买入',m:'觉得会涨的人'},
{t:'空头',en:'Shorts',cat:'市场数据',d:'卖出做空的一方',b:'就像觉得房价要跌所以先把房子卖掉的人，等跌了再买回来',m:'觉得会跌的人'},
{t:'净流入',en:'Net Inflow',cat:'市场数据',d:'资金净流入市场',b:'就像一个水池进水管比出水管粗，水在增多——钱在涌入市场',m:'钱在往里进'},
{t:'净流出',en:'Net Outflow',cat:'市场数据',d:'资金净流出市场',b:'就像水池出水管比进水管粗，水在减少——钱在撤离市场',m:'钱在往外跑'},
{t:'价差',en:'Spread',cat:'套利',d:'同一资产在不同交易所的价格差异',b:'就像同一瓶矿泉水，超市A卖2块，超市B卖3块。这1块钱的差就是价差',m:'两个地方价格不一样'},
{t:'套利',en:'Arbitrage',cat:'套利',d:'利用不同市场的价格差低风险赚取利润',b:'就像你发现A菜市场的白菜3块，B菜市场卖5块。你从A买了跑去B卖，净赚2块',m:'低买高卖，稳赚不赔'},
{t:'净利润',en:'Net Profit',cat:'套利',d:'扣除手续费和滑点后的实际利润',b:'就像你摆摊卖水果，毛赚100块但摊位费20块、路费10块，实际只赚70块——这就是净利润',m:'到手的钱才是真钱'},
{t:'超跌',en:'Oversold',cat:'AI信号',d:'价格短时间跌太多，可能要反弹',b:'就像打折打得太狠的商场——原价1000的东西卖200了，太便宜了可能要涨价',m:'跌太多了，可能要反弹'},
{t:'超涨',en:'Overbought',cat:'AI信号',d:'价格短时间涨太多，可能要回调',b:'就像演唱会门票被黄牛炒到天价——太高了迟早要跌回来',m:'涨太多了，可能要跌'},
{t:'极恐',en:'Extreme Fear',cat:'AI信号',d:'市场极度恐慌，大家疯狂抛售',b:'就像超市打折谣言说要关门了，所有人都去抢购抛售手里的东西',m:'所有人都在卖，慌了'},
{t:'极贪',en:'Extreme Greed',cat:'AI信号',d:'市场极度贪婪，大家疯狂买入',b:'就像比特币涨到6万9的时候朋友圈都在晒收益，菜场大妈都在问怎么买',m:'所有人都在买，疯了'},
{t:'模拟盘',en:'Paper Trading',cat:'系统模式',d:'用虚拟资金进行交易练习',b:'就像学驾照时的教练车——不是真上路，但操作一模一样，练好了再上真路',m:'假钱练习，不亏真金白银'},
{t:'TP',en:'Take-Profit Stage',cat:'仓位管理',d:'止盈阶段计数器（如TP:2/4表示已经触发2次止盈）',b:'就像你吃自助餐的进度：吃了2轮/共4轮，每次到了止盈点就自动卖掉一部分',m:'已经卖了几波了'},
{t:'子账户',en:'Sub-account',cat:'系统模式',d:'系统自动分配的虚拟交易账户，每个有独立余额',b:'就像银行给你开了8张信用卡，每张额度100块，你可以用不同卡做不同的交易',m:'分出来的独立小钱包'},
{t:'[SYS]',en:'System Log',cat:'日志标签',d:'系统级日志，显示启动、连接、数据加载等信息',b:'就像你电脑开机时屏幕显示的那些字——"正在加载驱动""网络已连接"，系统在告诉你它在干嘛',m:'系统在自言自语'},
{t:'[SUB]',en:'Sub-account Log',cat:'日志标签',d:'子账户操作日志，记录仓位的保本、止盈、止损等动作',b:'就像你的每张信用卡的消费记录——刷了多少、还了多少、余额多少',m:'每个小钱包的流水账'},
{t:'[TRADE]',en:'Trade Log',cat:'日志标签',d:'交易执行日志，记录开仓和平仓操作',b:'就像你在券商APP里看到的"已买入BTC 0.1个""已卖出ETH 2个"的提示',m:'买卖记录'},
{t:'[AI]',en:'AI Decision Log',cat:'日志标签',d:'AI决策日志，记录AI的分析和交易决策',b:'就像有个分析师每天给你发报告："我觉得BTC要涨，建议买10块钱的"',m:'AI在说它想干嘛'},
{t:'[RISK]',en:'Risk Control Log',cat:'日志标签',d:'风控触发日志，记录止损等风险控制动作',b:'就像你老婆把你信用卡冻结了——"你今天花太多了！"风控在保护你不亏光',m:'有人在喊停'},
{t:'[ARB]',en:'Arbitrage Log',cat:'日志标签',d:'套利操作日志，记录发现的套利机会',b:'就像你在两个超市之间发现价差，系统帮你记录"XX超市白菜3块，YY超市5块，差价2块"',m:'发现赚钱机会了'},
{t:'[FUSION]',en:'Data Fusion Log',cat:'日志标签',d:'数据融合日志，记录市场数据的获取和更新',b:'就像气象站收集温度、湿度、风速各种数据来预报天气——系统在收集各种市场数据',m:'数据收集记录'},
{t:'REST API',en:'REST API',cat:'系统模式',d:'普通的HTTP数据请求接口，非实时',b:'就像你发短信问朋友"现在BTC多少钱"，他回你一条——不是实时的，问一次答一次',m:'发消息问价格，不是直播'},
{t:'WebSocket',en:'WebSocket',cat:'系统模式',d:'实时双向数据推送连接，像直播',b:'就像你关注了一个主播，价格一变他就推给你看——不用你一直问，他自己推',m:'实时直播价格'},
{t:'Binance',en:'Binance',cat:'交易所',d:'全球最大的加密货币交易所（币安）',b:'就像炒股要去证券交易所，炒币最大的"交易所"就是Binance，量最大',m:'最大的那个菜市场'},
{t:'OKX',en:'OKX',cat:'交易所',d:'全球第三大加密货币交易所（欧易）',b:'就像除了菜市场A，旁边还有一个菜市场B，两边价格有时候不一样',m:'隔壁那个菜市场'},
{t:'CoinGecko',en:'CoinGecko',cat:'交易所',d:'加密货币数据聚合网站，提供价格、市值等基础数据',b:'就像大众点评——它自己不卖东西，但告诉你哪家店评分高、哪家便宜',m:'给交易所打分的网站'},
{t:'顺势交易',en:'Trade with the Trend',cat:'交易纪律',d:'主图大周期上升时只做多/回调低吸，大周期下降时只做空/反弹做空。逆势操作胜率天然低，即使偶尔赚到，长期必亏。用K线分析页的统一周期选择器判断大方向，再在小周期找入场点',b:'就像你在高速公路上开车——顺行方向你踩油门就行，逆行方向你技术再好也迟早出事。交易也一样，别跟大盘对着干',m:'大趋势向上就只做多，向下就只做空，别逆着来'},
{t:'多周期共振',en:'Multi-timeframe Confluence',cat:'交易纪律',d:'多个周期信号同向才可信。用K线分析页的SRSI速览表判断：如果多个周期同时超买/超卖/金叉/死叉，信号强度倍增；如果周期之间分歧（一个看多一个看空），应观望或降仓',b:'就像天气预报：当地气象台、省气象局、中央气象台都说要下雨，那肯定带伞。只有你家门口的天气APP说下雨，不一定准',m:'多个周期都指向同一个方向，信号才靠谱'},
{t:'逆势信号警惕',en:'Counter-trend Trap',cat:'交易纪律',d:'SRSI是逆势指标，在强趋势中经常发出"假信号"：大周期上升+小周期死叉（SRSI超买）只是回调不是反转，此时追空胜率极低；大周期下降+小周期金叉（SRSI超卖）只是反弹不是反转，此时追多容易被套。用主图大周期过滤小周期信号',b:'就像你看到斑马线上绿灯亮了（小周期信号），但远处有辆大卡车高速冲过来（大周期趋势），这时候你冲出去就是找死——信号对，但时机不对',m:'强趋势里逆势信号大多是坑，别上当'},
{t:'回调≠反转',en:'Pullback vs Reversal',cat:'交易纪律',d:'回调是顺势中的短暂反向波动（如上升趋势中的下跌），反转是趋势真正转向。判断方法：大周期EMA/趋势线方向不变+小周期逆势=回调；大周期方向改变+小周期同向=反转。回调是机会（加仓/入场），反转是危险（该离场）',b:'就像你开车上山，偶尔遇到下坡路——只要山还在那（大趋势没变），下坡只是暂时的，等会儿还得继续爬。但如果你已经开到山顶开始下山了，那就是反转了',m:'回调是暂时的，反转是永久的——别把回调当反转'},
{t:'信号只是提示',en:'Signal = Hint, Not Order',cat:'交易纪律',d:'任何单周期技术信号都只是"提示"而非"指令"。看到信号后应用hover验证：检查价格结构（支撑/阻力）、成交量、多周期一致性，再决定是否入场。SRSI速览表、K线主图、hover联动栏三者配合使用，缺一不可',b:'就像你朋友推荐了一家餐厅——你会先看大众点评评分、再看菜单价格、最后才决定去不去。信号就是朋友的推荐，别一听就冲',m:'信号只是告诉你"可能有戏"，还得自己验证确认'}];

function toggleGlossary(){
  var ov=document.getElementById('glossaryOverlay');
  if(ov.classList.contains('open')){ov.classList.remove('open');}
  else{ov.classList.add('open');backToTags();}
}

function backToTags(){
  var panel=document.querySelector('.glossary-panel');
  if(panel)panel.classList.remove('explain-mode');
  renderGlossaryTags('');
  document.getElementById('glossarySearch').value='';
  document.getElementById('glossaryContent').innerHTML='<div class="glossary-empty">点击上方标签查看术语解释</div>';
  document.getElementById('glossarySearch').focus();
}

function renderGlossaryTags(filter){
  var tags=document.getElementById('glossaryTags');
  var items=GLOSSARY;
  if(filter){items=items.filter(function(g){return g.t.indexOf(filter)>=0||g.en.toLowerCase().indexOf(filter.toLowerCase())>=0||g.cat.indexOf(filter)>=0;});}
  var cats={};items.forEach(function(g){if(!cats[g.cat])cats[g.cat]=[];cats[g.cat].push(g);});
  var html='';
  Object.keys(cats).forEach(function(cat){
    html+='<div class="glossary-cat-label">'+cat+'</div><div class="glossary-tag-wrap" style="display:flex;flex-wrap:wrap;gap:4px;padding:4px 0">';
    cats[cat].forEach(function(g){html+='<span class="glossary-tag" onclick="showGlossary(\''+g.t.replace(/'/g,"\\'")+'\')">'+g.t+'</span>';});
    html+='</div>';
  });
  if(!items.length)html='<div class="glossary-empty">没有找到匹配的术语</div>';
  tags.innerHTML=html;
}

function filterGlossary(){
  var v=document.getElementById('glossarySearch').value.trim();
  renderGlossaryTags(v);
}

function showGlossary(term){
  var g=GLOSSARY.find(function(x){return x.t===term;});
  if(!g)return;
  var panel=document.querySelector('.glossary-panel');
  if(panel)panel.classList.add('explain-mode');
  var el=document.getElementById('glossaryContent');
  el.innerHTML='<div class="glossary-item-title">📌 '+g.t+'</div>'
    +'<div class="glossary-item-en">'+g.en+' · '+g.cat+'</div>'
    +'<div class="glossary-section"><h5>📚 专业解释</h5><p>'+g.d+'</p></div>'
    +'<div class="glossary-section"><h5>🗣️ 大白话</h5><p>'+g.m+'</p></div>'
    +'<div class="glossary-analogy"><h5>🎯 生活比喻</h5><p>'+g.b+'</p></div>';
  el.scrollTop=0;
}

function initApp(){
  if(window.__appInit)return;
  window.__appInit=true;
  init();
}

(function exposeGlobals(){
  const names=[
    'mode','S','P','rp','curPage','mSym','mSide','GLOSSARY','SYMS','T','RP','STATE_VER',
    'APP_VERSION','APP_TAG','APP_COMMIT','APP_DESCRIBE','APP_DIRTY',
    't','tl','tSig','tPrompt','updateTexts','toggleMode','refreshTerminal','saveState','loadState',
    'fetchBinancePrices','fetchOKXPrices','fetchCoinGeckoPrices','fetchWhaleData',
    'fetchBinanceFundingRate','fetchBinanceOI','fetchOKXFundingRate','fetchOKXOI','fetchFearGreed',
    'fetchMarkPrices','getMarkPrice',
    'fetchAllFusionData','connectBinanceWS','connectOKXWS','init','tick','updateFusion','checkArb',
    'addSymbol','removeSymbol','addSymbolInput','setFusionSym','fusionScore','renderSymList','refreshSymbolSelectors',
    'recordSigResult','getSigScore','recordDirResult','dirCap','totalCap','updateAI','fullMarketAnalysis','renderFullAnalysis','openTrade',
    'closePos','setRiskPreset','restart','log','setTermTab','switchPage','render','renderTickers',
    'renderSidebar','renderPositions','renderStats','renderPage','renderFusion','renderAI','renderArb',
    'renderSubs','renderPnlPage','histRow','drawCurve','fp','pf','selectSym','aiTrade','openModal',
    'closeModal','updateModalFees','confirmTrade','toggleGlossary','backToTags','renderGlossaryTags',
    'filterGlossary','showGlossary','initApp','techConfig','updateIndicators','backfillKlines',
    'seriesForTF','timeSeriesFor','computeIndicators','showClosePosModal','closePosModal','confirmClosePosModal',
    'refreshLLMAnalysis','testLLMConnection','saveLLMKey','onLLMProviderChange','recordClosedTrade',
    'refreshLLMKeyStatus','switchTradeLibTab','renderLLMBlock','renderLLMHistory','renderTradeLib','readLLMSettings',
    'llmShouldRefresh','llmCacheStale',
    'resetFusionOrder','refreshFusionRatio',
    'volumeDivergence','supportResistance','threeLayerResonance',
    'fetchOnChain','saveOnChainKey','refreshOnChainKeyStatus',
    'chainOf',
    'detectRegimeState','regimeParams','volFactor','regimeSignalWeight','sanitizeSigScoreTable','shouldScoreExit','THRESH',
    'renderSimCoinList','onSimChange','onSimReset','onKchartTradeOnChange','onKchartLinkChange','onKchartTsevOnChange'
  ];
  const glob={mode,S,P,rp,curPage,mSym,mSide,GLOSSARY,SYMS,T,RP,STATE_VER,
    APP_VERSION,APP_TAG,APP_COMMIT,APP_DESCRIBE,APP_DIRTY,
    t,tl,tSig,tPrompt,updateTexts,toggleMode,refreshTerminal,saveState,loadState,
    fetchBinancePrices,fetchOKXPrices,fetchCoinGeckoPrices,fetchWhaleData,
    fetchBinanceFundingRate,fetchBinanceOI,fetchOKXFundingRate,fetchOKXOI,fetchFearGreed,
    fetchMarkPrices,getMarkPrice,
    fetchAllFusionData,connectBinanceWS,connectOKXWS,init,tick,updateFusion,checkArb,
    addSymbol,removeSymbol,addSymbolInput,setFusionSym,fusionScore,renderSymList,refreshSymbolSelectors,
    recordSigResult,getSigScore,recordDirResult,dirCap,totalCap,updateAI,fullMarketAnalysis,renderFullAnalysis,openTrade,
    closePos,setRiskPreset,restart,log,setTermTab,switchPage,render,renderTickers,
    renderSidebar,renderPositions,renderStats,renderPage,renderFusion,renderAI,renderArb,
    renderSubs,renderPnlPage,histRow,drawCurve,fp,pf,selectSym,aiTrade,openModal,
    closeModal,updateModalFees,confirmTrade,toggleGlossary,backToTags,renderGlossaryTags,
    filterGlossary,showGlossary,initApp,techConfig,updateIndicators,backfillKlines,
    seriesForTF,timeSeriesFor,computeIndicators,showClosePosModal,closePosModal,confirmClosePosModal,
    refreshLLMAnalysis,testLLMConnection,saveLLMKey,onLLMProviderChange,recordClosedTrade,
    refreshLLMKeyStatus,switchTradeLibTab,renderLLMBlock,renderLLMHistory,renderTradeLib,readLLMSettings,
    llmShouldRefresh,llmCacheStale,
    resetFusionOrder,refreshFusionRatio,
    volumeDivergence,supportResistance,threeLayerResonance,
    fetchOnChain,saveOnChainKey,refreshOnChainKeyStatus,
    chainOf,
    detectRegimeState,regimeParams,volFactor,regimeSignalWeight,sanitizeSigScoreTable,shouldScoreExit,THRESH,
    renderSimCoinList,onSimChange,onSimReset,onKchartTradeOnChange,onKchartLinkChange,onKchartTsevOnChange};
  names.forEach(n=>{window[n]=glob[n];});
})();

export { initApp };
