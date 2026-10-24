// 情绪系统：心情值 + 亲密度
//
// 设计：
//   mood       0-100  当前心情。被夸/被关心上升，被骂/被冷落下降
//   intimacy   0-100  对这个人的亲密度。聊得越多越高，长期不聊会衰减
//   energy     0-100  精力。深夜下降，休息后恢复（可选，先简单做）
//
// 关键：数值要真的影响说话，否则就是装饰品。
// 做法是把数值翻译成自然语言指令拼进 system prompt。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EMO_DIR = join(ROOT, 'emotions');
if (!existsSync(EMO_DIR)) mkdirSync(EMO_DIR, { recursive: true });

export const EMOTION_DEFAULTS = {
  enabled: true,
  // 每条消息对心情的影响
  moodUpOnPraise: 6,      // 被夸
  moodUpOnCare: 3,        // 被关心
  moodDownOnInsult: 8,    // 被骂
  moodDownOnCold: 2,      // 被冷落
  moodDriftTo: 55,        // 自然回归的基准值
  moodDriftRate: 0.05,    // 每条消息向基准回归的比例
  // 亲密度
  intimacyUpPerMsg: 1.2,  // 每聊一条
  intimacyDecayPerDay: 4, // 每天不聊衰减
  // 精力（按小时）
  nightStart: 23,
  nightEnd: 7,
  energyDrainNight: 6,
  energyRecoverDay: 3,
};

function fileOf(key) {
  const safe = String(key).replace(/:/g, '-').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return join(EMO_DIR, safe + '.json');
}

function blank(key) {
  return {
    key,
    mood: 60,
    intimacy: 5,
    energy: 80,
    lastSeen: Date.now(),
    history: [],     // 最近的心情变化，便于调试
    updatedAt: new Date().toISOString(),
  };
}

export function load(key) {
  const f = fileOf(key);
  if (!existsSync(f)) return blank(key);
  try { return { ...blank(key), ...JSON.parse(readFileSync(f, 'utf8')), key }; }
  catch { return blank(key); }
}

export function save(rec) {
  rec.mood = clamp(rec.mood, 0, 100);
  rec.intimacy = clamp(rec.intimacy, 0, 100);
  rec.energy = clamp(rec.energy, 0, 100);
  rec.updatedAt = new Date().toISOString();
  if (rec.history && rec.history.length > 50) rec.history = rec.history.slice(-50);
  writeFileSync(fileOf(rec.key), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

export function forget(key) {
  const f = fileOf(key);
  if (existsSync(f)) { try { require('node:fs').unlinkSync(f); } catch {} }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(v * 100) / 100));

// ---------------------------------------------------------------- 变化

/** 分析一条对方消息，判断它对情绪的影响 */
export function analyze(text) {
  const t = String(text || '');
  const r = { praise: false, insult: false, care: false, cold: false, emoji: false };

  if (/厉害|牛逼|牛啊|强啊|优秀|好棒|真行|聪明|喜欢你|爱你|谢谢|多谢|感谢|好评|可以啊|真不错|太强|厉害了/.test(t)) r.praise = true;
  if (/笨|蠢|傻|垃圾|废物|滚|闭嘴|烦人|讨厌|丑|烂|菜|弱智|智障/.test(t)) r.insult = true;
  if (/你怎么样|你好吗|还好吗|注意身体|早点休息|多喝|别累着|辛苦了|担心你|保重/.test(t)) r.care = true;
  if (/^(嗯|哦|额|额额|呵|。。。|\.\.\.|6|\?|？)$/.test(t.trim())) r.cold = true;
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(t)) r.emoji = true;

  return r;
}

/**
 * 应用一次互动对情绪的影响。
 * @param {object} rec   情绪记录
 * @param {string} text  对方消息
 * @param {object} cfg   配置
 * @param {object} extra { ignored:boolean }
 */
export function applyInteraction(rec, text, cfg, extra = {}) {
  const c = cfg.emotion || EMOTION_DEFAULTS;
  const a = analyze(text);
  const before = { mood: rec.mood, intimacy: rec.intimacy, energy: rec.energy };
  const reasons = [];

  // 自然回归
  rec.mood += (c.moodDriftTo - rec.mood) * c.moodDriftRate;

  if (a.praise) { rec.mood += c.moodUpOnPraise; reasons.push('被夸 +' + c.moodUpOnPraise); }
  if (a.care) { rec.mood += c.moodUpOnCare; reasons.push('被关心 +' + c.moodUpOnCare); }
  if (a.insult) { rec.mood -= c.moodDownOnInsult; reasons.push('被骂 -' + c.moodDownOnInsult); }
  if (a.cold) { rec.mood -= c.moodDownOnCold; reasons.push('被敷衍 -' + c.moodDownOnCold); }
  if (extra.ignored) { rec.mood -= c.moodDownOnCold * 2; reasons.push('被冷落 -' + c.moodDownOnCold * 2); }

  // 亲密度
  rec.intimacy += c.intimacyUpPerMsg;
  if (a.insult) rec.intimacy -= c.intimacyUpPerMsg * 2;

  // 精力：按当前小时判断
  const h = new Date().getHours();
  const isNight = c.nightStart <= c.nightEnd
    ? (h >= c.nightStart && h < c.nightEnd)
    : (h >= c.nightStart || h < c.nightEnd);
  rec.energy += isNight ? -c.energyDrainNight : c.energyRecoverDay;

  rec.lastSeen = Date.now();
  rec.mood = clamp(rec.mood, 0, 100);
  rec.intimacy = clamp(rec.intimacy, 0, 100);
  rec.energy = clamp(rec.energy, 0, 100);

  rec.history = rec.history || [];
  rec.history.push({ t: Date.now(), text: String(text).slice(0, 30), reasons, before, after: { mood: rec.mood, intimacy: rec.intimacy, energy: rec.energy } });

  return { rec, reasons, a };
}

/** 长时间没聊 → 亲密度和心情衰减 */
export function applyDecay(rec, cfg) {
  const c = cfg.emotion || EMOTION_DEFAULTS;
  const days = (Date.now() - (rec.lastSeen || Date.now())) / 86400000;
  if (days < 0.5) return rec;
  const decay = Math.floor(days * c.intimacyDecayPerDay);
  if (decay > 0) {
    rec.intimacy = clamp(rec.intimacy - decay, 0, 100);
    rec.mood = clamp(rec.mood - decay * 0.5, 0, 100);
  }
  return rec;
}

// ---------------------------------------------------------------- 翻译成语气

/** 把数值翻译成给模型的自然语言指令 */
export function render(rec) {
  const moodP = [
    [80, '心情很好，话可以多一点，愿意主动搭话'],
    [60, '心情不错，正常聊天'],
    [40, '心情一般，有点懒得说话，回复偏短'],
    [20, '心情不太好，有点烦，不想多聊，可能怼人'],
    [0, '心情很差，很冷淡，回复极短甚至不想理人'],
  ];
  const intiP = [
    [80, '关系很熟，可以开玩笑、调侃、用亲昵的称呼'],
    [60, '比较熟了，说话可以随意一些'],
    [35, '认识一阵了，不陌生但也别太亲昵'],
    [15, '还不太熟，保持礼貌距离，不要自来熟'],
    [0, '基本陌生，客气点，别乱开玩笑'],
  ];
  const energyP = [
    [70, '精神挺好'],
    [40, '有点累'],
    [0, '很累/困，可能想睡了'],
  ];

  const pick = (table, v) => table.find(([th]) => v >= th)?.[1] || table[table.length - 1][1];

  return `\n\n【你当前的情绪状态】\n- 心情 ${Math.round(rec.mood)}/100：${pick(moodP, rec.mood)}\n- 亲密度 ${Math.round(rec.intimacy)}/100：${pick(intiP, rec.intimacy)}\n- 精力 ${Math.round(rec.energy)}/100：${pick(energyP, rec.energy)}\n（按这个状态说话。心情差就短、就敷衍；关系不熟就别用亲昵称呼。别直接说出这些数字。）`;
}

/** 给外部看的一行摘要 */
export function summary(rec) {
  return '心情 ' + Math.round(rec.mood) + ' / 亲密 ' + Math.round(rec.intimacy) + ' / 精力 ' + Math.round(rec.energy);
}