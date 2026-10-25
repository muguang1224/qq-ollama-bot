// QQ 空间自动发说说
//
// 设计：
//   1. 用情绪系统决定"今天想不想发"和"发什么调性"
//   2. 用主模型 + 人格生成内容（像真人随手发一句）
//   3. 随机决定要不要配图（从表情库挑，跟随心情）
//   4. 低频限制：一天最多 1 条，两条间隔至少 20 小时
//   5. 调用腾讯接口发布
//
// 风控措施：一天≤1条、只在真人作息时段发、内容短、发布间隔带随机抖动。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONA } from './persona.mjs';
import { publishShuo, getZoneCredentials } from './qzone-api.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = join(ROOT, 'qzone');
const STATE_FILE = join(STATE_DIR, 'state.json');
const EMO_DIR = join(ROOT, 'emotions');

export const QZONE_DEFAULTS = {
  enabled: false,       // 总开关，默认关闭（安全）
  maxPerDay: 1,         // 每天最多几条（自动发）
  maxPerDayManual: 3,   // 每天最多几条（含你要求发的）—— 按需发布的上限
  minGapHours: 20,      // 自动发：两条之间至少间隔几小时
  manualMinGapMin: 5,   // 按需发：两条之间最少间隔几分钟（防误操作连发）
  activeStart: 9,       // 最早几点发
  activeEnd: 23,        // 最晚几点发
  chance: 0.35,         // 每次检查时的发布概率（避免太规律）
  imageChance: 0.4,     // 配图概率
  ugcRight: 1,          // 可见范围：1所有人 4好友 64仅自己
  maxChars: 40,         // 内容最大字数
  checkEveryMin: 60,    // 多久检查一次
};

export function loadState() {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    if (!existsSync(STATE_FILE)) return { history: [] };
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { history: [] };
  }
}

export function saveState(st) {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
  } catch {}
}

/** 读所有情绪记录，算整体心情 */
export function overallMood() {
  const vals = [];
  try {
    if (existsSync(EMO_DIR)) {
      for (const f of readdirSync(EMO_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const r = JSON.parse(readFileSync(join(EMO_DIR, f), 'utf8'));
          if (typeof r.mood === 'number') vals.push(r.mood);
        } catch {}
      }
    }
  } catch {}
  if (!vals.length) return { mood: 60, count: 0 };
  return { mood: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length), count: vals.length };
}

/** 判断现在能不能发 */
export function canPublish(cfg) {
  const q = { ...QZONE_DEFAULTS, ...(cfg.qzone || {}) };
  if (!q.enabled) return { ok: false, reason: '未开启' };

  const hour = new Date().getHours();
  if (hour < q.activeStart || hour >= q.activeEnd) {
    return { ok: false, reason: `不在活跃时段（${q.activeStart}-${q.activeEnd}点）` };
  }

  const st = loadState();
  const now = Date.now();
  const dayStart = new Date().setHours(0, 0, 0, 0);

  const todayCount = (st.history || []).filter((h) => h.at >= dayStart).length;
  if (todayCount >= q.maxPerDay) {
    return { ok: false, reason: `今天已发 ${todayCount} 条（上限 ${q.maxPerDay}）` };
  }

  const last = (st.history || []).slice(-1)[0];
  if (last) {
    const gapH = (now - last.at) / 3600000;
    if (gapH < q.minGapHours) {
      return { ok: false, reason: `距上次只过了 ${gapH.toFixed(1)} 小时（需 ${q.minGapHours}）` };
    }
  }
  return { ok: true, q };
}

/**
 * 生成说说内容
 * @param {Function} chat
 * @param {object} cfg
 * @param {number} mood
 * @param {string} [request] 用户的内容要求（可选）
 */
export async function generateContent(chat, cfg, mood, request) {
  const q = { ...QZONE_DEFAULTS, ...(cfg.qzone || {}) };
  const tone = mood >= 70 ? '心情挺好，语气轻快'
    : mood >= 50 ? '心情一般，随口感叹'
    : mood >= 35 ? '有点低落，话少'
    : '心情很差，敷衍一句';

  const sys = PERSONA + `

【当前任务】
你要发一条 QQ 空间说说。这不是回复别人，是你自己随手发的动态。
- 字数 ${q.maxChars} 字以内，越短越自然。
- 语气：${tone}
- 像真人随手发的那种：一句感慨、一个念头、一点小情绪都行。
- 不要问句，不要 @ 人，不要 emoji，不要引号。
- 直接输出说说正文，不要任何解释。

【重要：不许编造外部经历】
你没有身体、不能上网、不能出门。所以**不要**写这类内容：
- "刚吃完饭""刚刷到个视频""今天天气真服了""出去玩了一天"
只能写你的**内心状态**：心情、念头、感受、想要什么、觉得什么没意思。

【示例】
今天有点提不起劲
突然想找人说说话
发呆了一下午 也不知道在想什么
有点困 但又不太想睡
想被人惦记一下`;

  // 如果用户提了具体要求，作为额外参考（不强制，避免和"不许编造"冲突）
  let userMsg = '发一条说说';
  if (request && String(request).trim()) {
    userMsg = '发一条说说。对方希望你写的内容是：「' + String(request).trim() +
              '」。可以参考，但必须遵守上面的规则（不编造外部经历、不超字数）。';
  }

  const out = await chat(
    [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ],
    { numPredict: 80, temperature: 1.0 }
  );

  let t = String(out || '').trim();
  t = t.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  t = t.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  if (t.length > q.maxChars) t = t.slice(0, q.maxChars);
  return t;
}

/**
 * 执行一次发布检查（主入口）
 * @param {object} opt
 * @param {Function} opt.chat      统一模型调用 (messages, opts) => string
 * @param {object}   opt.cfg       配置
 * @param {Function} opt.log       日志
 * @param {Function} opt.getCred   拿凭证 (可选，不传则自己调 OneBot)
 */
export async function maybePublish({ chat, cfg, log, getCred }) {
  const check = canPublish(cfg);
  if (!check.ok) {
    log?.('📱 空间：跳过（' + check.reason + '）');
    return { published: false, reason: check.reason };
  }
  const q = check.q;

  if (Math.random() > q.chance) {
    log?.('📱 空间：这次不打算发');
    return { published: false, reason: '概率未命中' };
  }

  const { mood } = overallMood();
  const content = await generateContent(chat, cfg, mood);
  if (!content) {
    log?.('📱 空间：生成内容为空，跳过');
    return { published: false, reason: '内容为空' };
  }

  const cred = await getCred();
  const r = await publishShuo(content, cred, { ugcRight: q.ugcRight });

  if (r.ok) {
    const st = loadState();
    st.history = [...(st.history || []), { at: Date.now(), content, tid: r.tid, mood }].slice(-50);
    saveState(st);
    log?.(`📱 空间已发布：${content}  (tid ${r.tid})`);
    return { published: true, content, tid: r.tid };
  }

  log?.(`📱 空间发布失败：code=${r.code} ${r.message || ''} ${r.raw || ''}`.slice(0, 200));
  return { published: false, reason: r.message || 'code ' + r.code };
}

// ---------------------------------------------------------------- 按需发布
//
// 用途：用户在 QQ 里说「发个空间」，就真的发一条（不是只答应）。
//
// 与自动发布的区别：
//   · 不看 chance 概率（说了就发）
//   · 不看 20 小时间隔，改用更短的 manualMinGapMin（防连点）
//   · 上限用 maxPerDayManual（默认 3），比自动发宽松
//   · 内容仍然由模型按人格生成，可以在用户给了要求时参考要求

/**
 * 检查现在能不能「按需」发
 * @returns {{ok:boolean, q?:object, reason?:string}}
 */
export function canPublishManual(cfg) {
  const q = { ...QZONE_DEFAULTS, ...(cfg.qzone || {}) };
  if (!q.enabled) return { ok: false, reason: '空间功能未开启' };

  const hour = new Date().getHours();
  if (hour < q.activeStart || hour >= q.activeEnd) {
    return { ok: false, reason: `不在活跃时段（${q.activeStart}-${q.activeEnd}点）` };
  }

  const st = loadState();
  const now = Date.now();
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const today = (st.history || []).filter((h) => h.at >= dayStart);

  const cap = q.maxPerDayManual ?? 3;
  if (today.length >= cap) {
    return { ok: false, reason: `今天已经发了 ${today.length} 条（上限 ${cap}）` };
  }

  // 防连点：两次按需发之间要有间隔
  const lastManual = [...(st.history || [])].reverse().find((h) => h.manual);
  if (lastManual) {
    const gapMin = (now - lastManual.at) / 60000;
    const need = q.manualMinGapMin ?? 5;
    if (gapMin < need) {
      return { ok: false, reason: `刚发过（${gapMin.toFixed(1)} 分钟前），等 ${Math.ceil(need - gapMin)} 分钟再来` };
    }
  }

  return { ok: true, q };
}

/**
 * 按用户要求发一条说说
 *
 * @param {object} opt
 * @param {Function} opt.chat   模型调用
 * @param {object}   opt.cfg    配置
 * @param {Function} opt.log    日志
 * @param {Function} opt.getCred 取凭证
 * @param {string}  [opt.request] 用户的原话（比如"发个空间说今天很开心"），
 *                                作为生成内容的参考，但不强制
 * @returns {Promise<{ok:boolean, content?:string, tid?:string, reply:string}>}
 */
export async function publishOnDemand({ chat, cfg, log, getCred, request }) {
  const check = canPublishManual(cfg);
  if (!check.ok) {
    return { ok: false, reply: '现在发不了呀，' + check.reason };
  }
  const q = check.q;

  const { mood } = overallMood();

  // 生成内容：把用户的要求作为额外提示
  let content;
  try {
    content = await generateContent(chat, cfg, mood, request);
  } catch (e) {
    log?.('📱 按需发：生成内容失败 ' + e.message);
    return { ok: false, reply: '我想不出来发什么呀，等会儿再说吧' };
  }
  if (!content) {
    return { ok: false, reply: '我想不出来发什么呀，等会儿再说吧' };
  }

  let cred;
  try {
    cred = await getCred();
  } catch (e) {
    log?.('📱 按需发：拿凭证失败 ' + e.message);
    return { ok: false, reply: '我这边连不上空间呀，等会儿再试试' };
  }

  const r = await publishShuo(content, cred, { ugcRight: q.ugcRight });

  if (r.ok) {
    const st = loadState();
    st.history = [
      ...(st.history || []),
      { at: Date.now(), content, tid: r.tid, mood, manual: true },
    ].slice(-50);
    saveState(st);
    log?.(`📱 按需发已发布：${content}  (tid ${r.tid})`);
    return { ok: true, content, tid: r.tid, reply: '发好啦「' + content + '」 你去看看' };
  }

  log?.(`📱 按需发失败：code=${r.code} ${r.message || ''} ${r.raw || ''}`.slice(0, 200));
  return { ok: false, reply: '发了但好像没成功呀，等会儿再试试' };
}

/**
 * 判断用户这句话是不是在要求发空间
 * @returns {boolean}
 */
export function isPublishRequest(text) {
  const s = String(text || '');
  // 必须同时提到"空间/说说/动态" + 动作词
  const hasTarget = /空间|说说|动态/.test(s);
  if (!hasTarget) return false;
  // 「发不了/进不去/不会发」这类否定，不算要求
  if (/(发不了|发不出去|进不去|不会发|没法发|不能发)/.test(s)) return false;
  // 抱怨/疑问式，不算要求（「你怎么不发空间」「为什么不发」）
  if (/(怎么不|为啥不|为什么不|不是说|你不是说)/.test(s)) return false;
  const hasAction = /发|写|来一|整一|搞一|弄一|更新/.test(s);
  return hasAction;
}

/** 从用户原话里提取内容要求（去掉指令词） */
export function extractRequest(text) {
  let s = String(text || '');
  s = s.replace(/帮我|给我|你|能不能|可以|一下|一个|一条|个|条|呗|吧|呀|啊/g, ' ');
  s = s.replace(/发|写|来|整|搞|弄|更新/g, ' ');
  s = s.replace(/空间|说说|动态/g, ' ');
  s = s.replace(/[，,。！!？?、\s]+/g, ' ').trim();
  // 太短或明显是虚词的内容，视为"没提具体要求"
  if (s.length < 3) return '';
  if (/^(说|的|了|吗|呢)+$/.test(s)) return '';
  return s;
}