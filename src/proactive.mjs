// 主动聊天模块
//
// 设计目标：
//   1. 随机间隔冒泡，像真人而不是定时机器人
//   2. 有"自己的思考"——不是随机挑模板，而是让模型根据对这个人的了解
//      和最近的对话，决定「要不要说」「说什么」「什么时候说」
//   3. 对方不想聊就不追（关键：判断上一条回复的冷热）
//   4. 聊天数据用于迭代：记录主动效果，回头可用于优化
//
// 安全阀：
//   - 每个目标有冷却时间
//   - 全局每小时上限
//   - 深夜静默
//   - 连续被冷落就拉长间隔

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

const STATE_DIR = join(ROOT, 'proactive');
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

const STATE_FILE = join(STATE_DIR, 'state.json');

export const PROACTIVE_DEFAULTS = {
  enabled: false,          // 总开关
  targets: [],             // 目标 QQ 号列表（空 = 用 config.bot.ownerQQ 或全部好友）
  allFriends: false,       // true = 对所有好友主动
  minGapMin: 40,           // 最小间隔（分钟）
  maxGapMin: 80,           // 最大间隔（分钟）
  maxPerHour: 1,           // 全局每小时最多主动几次
  quietStart: 1,           // 静默开始（小时，0-23）
  quietEnd: 8,             // 静默结束
  thinkBeforeSend: true,   // 发之前先让模型判断「现在适合开口吗」
  skipIfIgnored: 2,        // 连续被冷落几次后停止主动找这个人
  cooldownAfterColdMin: 360, // 被冷落后冷却多久（分钟）
};

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { lastGlobal: 0, perTarget: {}, sentLog: [] };
  }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); }
  catch { return { lastGlobal: 0, perTarget: {}, sentLog: [] }; }
}

function saveState(s) {
  // 只保留最近 200 条日志
  if (s.sentLog && s.sentLog.length > 200) s.sentLog = s.sentLog.slice(-200);
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

/** 现在是否处于静默时段 */
export function inQuietHours(cfg, now = new Date()) {
  const h = now.getHours();
  const { quietStart: a, quietEnd: b } = cfg.proactive;
  if (a === b) return false;
  // 跨零点的情况，例如 23 -> 8
  return a < b ? (h >= a && h < b) : (h >= a || h < b);
}

/** 距离上次全局发送过了多少毫秒 */
export function sinceLastGlobal(state) {
  return Date.now() - (state.lastGlobal || 0);
}

/**
 * 判断现在能不能发。
 * 返回 { ok, reason, target }
 */
export function canSend(cfg, state, now = new Date()) {
  const pc = cfg.proactive;
  if (!pc.enabled) return { ok: false, reason: '主动聊天未开启' };
  if (inQuietHours(cfg, now)) return { ok: false, reason: '静默时段 (' + pc.quietStart + '-' + pc.quietEnd + '点)' };

  // 全局频率：至少隔 60/maxPerHour 分钟
  const minGlobalGap = (60 / Math.max(1, pc.maxPerHour)) * 60 * 1000;
  const since = sinceLastGlobal(state);
  if (since < minGlobalGap) {
    const left = Math.ceil((minGlobalGap - since) / 60000);
    return { ok: false, reason: '距上次发送仅 ' + Math.round(since / 60000) + ' 分钟，还需等 ' + left + ' 分钟' };
  }

  return { ok: true, reason: '' };
}

/** 挑一个合适的目标 */
export function pickTarget(cfg, state, friendIds) {
  const pc = cfg.proactive;
  let pool = friendIds.slice();

  if (!pc.allFriends) {
    if (pc.targets?.length) pool = pool.filter((id) => pc.targets.map(String).includes(String(id)));
    else return null;
  }

  const now = Date.now();
  const eligible = pool.filter((id) => {
    const t = state.perTarget[String(id)];
    if (!t) return true;
    // 冷却中
    if (t.cooldownUntil && now < t.cooldownUntil) return false;
    // 每人间隔 = 全局间隔 × 1.5，避免总找同一个人
    const minGap = ((pc.minGapMin + pc.maxGapMin) / 2) * 1.5 * 60 * 1000;
    if (t.lastSent && now - t.lastSent < minGap) return false;
    // 被冷落太多次
    if ((t.ignored || 0) >= pc.skipIfIgnored) return false;
    return true;
  });

  if (!eligible.length) return null;

  // 优先找最久没联系的；同样久则随机
  eligible.sort((a, b) => {
    const ta = state.perTarget[String(a)]?.lastSent || 0;
    const tb = state.perTarget[String(b)]?.lastSent || 0;
    return ta - tb;
  });
  // 在前 3 个里随机，避免完全确定性
  const top = eligible.slice(0, Math.min(3, eligible.length));
  return top[Math.floor(Math.random() * top.length)];
}

/** 记录一次发送 */
export function markSent(state, targetId, text) {
  state.lastGlobal = Date.now();
  const k = String(targetId);
  state.perTarget[k] = state.perTarget[k] || {};
  state.perTarget[k].lastSent = Date.now();
  state.perTarget[k].sent = (state.perTarget[k].sent || 0) + 1;
  state.sentLog = state.sentLog || [];
  state.sentLog.push({ t: Date.now(), to: k, text: text.slice(0, 100) });
  return state;
}

/** 对方回了（说明不是冷场）→ 清空冷落计数 */
export function markReplied(state, targetId) {
  const k = String(targetId);
  if (state.perTarget[k]) {
    state.perTarget[k].ignored = 0;
    state.perTarget[k].replied = (state.perTarget[k].replied || 0) + 1;
  }
  return state;
}

/** 对方没回（冷落）→ 累加 */
export function markIgnored(state, targetId, cfg) {
  const k = String(targetId);
  state.perTarget[k] = state.perTarget[k] || {};
  state.perTarget[k].ignored = (state.perTarget[k].ignored || 0) + 1;
  if (state.perTarget[k].ignored >= cfg.proactive.skipIfIgnored) {
    state.perTarget[k].cooldownUntil = Date.now() + cfg.proactive.cooldownAfterColdMin * 60000;
  }
  return state;
}

export { loadState, saveState, STATE_FILE };

// ---------------------------------------------------------------- 让模型思考

const THINK_PROMPT = `你是一个 QQ 上的人格角色，现在要决定「要不要主动找这个人说话」。

你的角色设定：
{PERSONA}

你对这个人的了解：
{ABOUT}

你们最近的对话（如果有）：
{RECENT}

现在时间：{TIME}

判断原则：
- 你是【主动】开口的一方。真人在 QQ 上主动找人，本来就是随口一句、不一定有正事。
- **可以分享你自己的"状态"**：刚看到什么、在做什么、想到什么、心情如何。
  真人的主动消息常常是这种：「刚看到个好笑的」「今天不想干活」「外面下雨了」。
- 也可以接着上次的话题问下去：「上次你说的那个事后来怎么样了」。
- 但如果对话记录里，对方最后说的话明显是「结束语」（比如「拜拜」「我先忙」「睡了」「回头聊」），
  那就选择不说。
- 语气要符合你和对方的关系：不熟就别太亲昵，别用「想你」这种话。

必须选择不说的情况：
- 对方最后一句是结束语（拜拜/先忙/睡了/回头聊/下次聊）
- 深更半夜（0-7 点）

除此之外，倾向开口。

如果要说，内容要求：
- 自然、口语，1-2 句，15-35 字。**不要只说三五个字**。
- **禁止只有「在吗」「在干嘛」「最近咋样」这种空问候** —— 必须带一点具体内容。
- 可以是一句分享、一个具体的问题、一句吐槽、接上次的话题。
- 好的例子：
  · 「刚刷到个视频笑死 你睡觉了没」
  · 「今天干了啥 我这边闲得慌」
  · 「上次你说的那个考试 过了吗」
  · 「突然想问你个事 你喜欢吃辣吗」
- 坏的例子（不要这样）：
  · 「在吗」
  · 「在干嘛」
  · 「你好」

只输出 JSON，不要解释、不要 markdown：
{"speak":true/false,"reason":"简短理由","message":"要说的话（speak为false时留空）"}`;

export async function thinkWhetherToSpeak(ctx, cfg) {
  const { persona, about, recent, now } = ctx;

  // —— 代码层硬拦截（不依赖模型自觉）——
  const hour = now.getHours();
  // 测试钩子：端到端测试需要绕过深夜限制
  const skipQuiet = process.env.QQBRIDGE_TEST_NOQUIET === '1';
  if (!skipQuiet && hour >= 0 && hour < 7) {
    return { speak: false, reason: '深夜（' + hour + ' 点）不打扰', message: '' };
  }
  if (recent) {
    const lastUser = recent.split('\n').filter((l) => l.startsWith('对方')).pop() || '';
    if (/拜拜|再见|先忙|去忙|睡了|睡觉|回头聊|下次聊|不聊了|下线|出门了/.test(lastUser)) {
      return { speak: false, reason: '对方最后一句是结束语', message: '' };
    }
  }
  // 已经发过、对方还没回 → 不连发（由调用方通过 awaitingReply 保证，这里再兜一层）
  if (ctx.lastProactiveUnanswered) {
    return { speak: false, reason: '上一条主动消息还没被回', message: '' };
  }
  const prompt = THINK_PROMPT
    .replace('{PERSONA}', persona.slice(0, 800))
    .replace('{ABOUT}', about || '（还不太了解）')
    .replace('{RECENT}', recent || '（还没有聊过）')
    .replace('{TIME}', now.toLocaleString('zh-CN'));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  let raw = '';
  try {
    const r = await fetch(cfg.ollama.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.ollama.model, stream: false, think: false,
        messages: [{ role: 'user', content: prompt }],
        options: { num_predict: 300, temperature: 0.9, top_p: 0.9 },
      }),
    });
    raw = ((await r.json()).message?.content || '').trim();
  } finally { clearTimeout(timer); }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { speak: false, reason: '模型没返回合法 JSON', message: '' };
  try {
    const o = JSON.parse(m[0]);
    let msg = String(o.message || '').trim();

    // —— 输出质量校验 ——
    if (o.speak) {
      if (!msg) return { speak: false, reason: '生成了空消息', message: '' };

      const bare = msg.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');

      // 太短没内容（如「在」「。」）
      if (bare.length < 2) {
        return { speak: false, reason: '消息太短没内容: ' + msg, message: '' };
      }

      // 空问候 / 无内容的开场（必须带具体内容）
      // 之前只拦了「在吗」，结果「在干嘛」溜过去了
      if (/^(在吗|在么|在不在|在干嘛|在干什么|干嘛呢|干啥呢|最近咋样|最近怎么样|你好|hi|hello|哈喽|喂|在吗在吗)[？?。!！~，,\s]*$/i.test(msg)) {
        return { speak: false, reason: '空问候（没有实质内容）: ' + msg, message: '' };
      }

      // 明显是「回复语」而不是「开场白」—— 主动开口不该说这些
      if (/^(在\s*咋了|在\s*怎么了|咋了|怎么了|没事了|好的|嗯嗯|收到|行吧|哦哦)$/i.test(msg)) {
        return { speak: false, reason: '这是回复语，不适合当开场白: ' + msg, message: '' };
      }

      // 太短且像个纯问句 → 信息量不足
      if (bare.length <= 6 && /[？?]$/.test(msg)) {
        return { speak: false, reason: '问句太短，信息量不足: ' + msg, message: '' };
      }

      // 关系不熟时的越界称呼
      if (/想你|爱你|宝贝|亲爱的|老婆|老公/.test(msg)) {
        return { speak: false, reason: '称呼越界: ' + msg, message: '' };
      }

      // 客服腔 / 工具腔
      if (/作为(一个)?(AI|人工智能|智能助手)|希望对你有帮助|有什么可以帮|在待命|已收到/.test(msg)) {
        return { speak: false, reason: '客服腔: ' + msg, message: '' };
      }

      msg = msg.slice(0, 200);
    }

    return {
      speak: !!o.speak,
      reason: String(o.reason || '').slice(0, 60),
      message: o.speak ? msg : '',
    };
  } catch {
    return { speak: false, reason: 'JSON 解析失败', message: '' };
  }
}

// ---------------------------------------------------------------- 会话内追问
//
// 「回复后也会主动接话」：回完一句后，有时再补一句追问或分享，
// 让对话不是一问一答就结束。

const FOLLOWUP_PROMPT = `你是一个 QQ 上的人格角色，刚回完对方一句话。

你的角色设定：
{PERSONA}

对方说：{USER}
你回：{REPLY}

现在判断：要不要再补一句？

补一句的理由（真人的习惯）：
- 你回完之后又想到点什么，想接着聊
- 你好奇对方的情况，想追问一下（「你呢」「后来呢」「那你打算咋办」）
- 你想分享一句自己的状态（「我这边也差不多」）

不要补的理由：
- 你的回复已经把话说完，再补就是啰嗦
- 对方只是随口一句，没什么可展开的

真人在 QQ 上聊天，**经常会接着说一句**：追问一下、补一句自己的想法、
或者顺着对方的话往下聊。不要把每句话都当"已回复完毕"。

倾向补（大约一半的情况）：
- 对方说了具体的事（累、开心、烦、在做某件事）→ 值得再接一句
- 你对对方的情况有好奇 → 问一句具体的
- 你有相关的感受想分享

不补的情况：
- 对方只是打招呼或极简回应（「在吗」「嗯」「哦」）
- 你上一句已经把话说完，确实没什么可接的
- 深夜

如果补，要求：
- 1 句，10-25 字
- 必须和上一句衔接自然，不要重复
- 不要「还有什么需要帮忙吗」这种客服话

只输出 JSON：
{"follow":true/false,"reason":"简短理由","message":"要补的话（follow为false时留空）"}`;

/**
 * 判断回复之后要不要再补一句。
 */
export async function thinkFollowUp(ctx, cfg) {
  const { persona, userText, reply, now } = ctx;

  // 硬拦截：深夜不补
  const h = (now || new Date()).getHours();
  if (h >= 0 && h < 7) return { follow: false, reason: '深夜', message: '' };

  // 回复本身很短 → 不再补
  if (!reply || reply.length < 4) return { follow: false, reason: '回复太短', message: '' };

  // 对方只是打招呼/极简回应 → 补了显得啰嗦（实测「在吗」也会被补，很烦）
  const u = String(userText || '').trim();
  if (/^(在吗|在么|在不在|你好|hi|hello|哈喽|喂|嗯+|哦+|额+|啊+)[？?。!！~，,\s]*$/i.test(u)) {
    return { follow: false, reason: '对方只是打招呼', message: '' };
  }

  const prompt = FOLLOWUP_PROMPT
    .replace('{PERSONA}', persona.slice(0, 500))
    .replace('{USER}', String(userText).slice(0, 120))
    .replace('{REPLY}', String(reply).slice(0, 120));

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  let raw = '';
  try {
    const r = await fetch((cfg.ollama?.baseUrl || 'http://127.0.0.1:11434') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.ollama?.model || 'qwen3.5-4b',
        messages: [{ role: 'user', content: prompt }],
        stream: false, think: false,
        options: { num_predict: 120, temperature: 0.85, top_p: 0.9 },
      }),
    });
    raw = ((await r.json()).message?.content || '').trim();
  } catch {
    return { follow: false, reason: '判断超时', message: '' };
  } finally { clearTimeout(timer); }

  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { follow: false, reason: 'JSON 解析失败', message: '' };
  try {
    const o = JSON.parse(m[0]);
    const msg = String(o.message || '').trim();

    if (!o.follow || !msg) {
      return { follow: false, reason: String(o.reason || '').slice(0, 40), message: '' };
    }

    // 质量校验
    const bare = msg.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    if (bare.length < 3) return { follow: false, reason: '补的话太短', message: '' };
    if (/作为(一个)?(AI|人工智能|智能助手)|有什么可以帮|在待命|已收到|希望对你有帮助/.test(msg)) {
      return { follow: false, reason: '客服腔', message: '' };
    }
    if (msg === reply || reply.includes(msg)) {
      return { follow: false, reason: '和上一句重复', message: '' };
    }

    return { follow: true, reason: String(o.reason || '').slice(0, 40), message: msg.slice(0, 120) };
  } catch {
    return { follow: false, reason: 'JSON 解析失败', message: '' };
  }
}

/** 追问冷却：同一会话短时间内不连续补 */
const lastFollowAt = new Map();
export function canFollowUp(key, cfg) {
  const gap = (cfg.reply?.followUpCooldownSec ?? 90) * 1000;
  return Date.now() - (lastFollowAt.get(key) || 0) > gap;
}
export function markFollowUp(key) { lastFollowAt.set(key, Date.now()); }