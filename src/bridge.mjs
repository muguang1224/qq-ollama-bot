#!/usr/bin/env node
/**
 * QQ ↔ 本地大模型（Ollama）直连桥
 *
 * 架构：
 *   QQ 客户端 ←→ NapCat（OneBot v11，WS 反向/正向）←→ 本脚本 ←→ Ollama
 *
 * 不依赖 DSH、不依赖 qq-bridge。纯 Node，零第三方依赖。
 *
 * 用法：
 *   node bridge.mjs                 # 正常启动
 *   node bridge.mjs --dry-run       # 不连 OneBot，只在本地测试模型
 *   node bridge.mjs --config a.json # 指定配置
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONA, DEFAULTS } from './persona.mjs';
import * as Mem from './memory.mjs';
import * as AutoFriend from './autofriend.mjs';
import * as Proactive from './proactive.mjs';
import * as Emo from './emotion.mjs';
import * as Stickers from './stickers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 项目根目录（src 的上一级）。config/日志/数据都放这里，
// 让代码和用户数据分开。
const ROOT = dirname(__dirname);

// ---------------------------------------------------------------- 配置

const CFG_PATH = (() => {
  const i = process.argv.indexOf('--config');
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : join(ROOT, 'config.json');
})();

const EXAMPLE = {
  _说明: '复制成 config.json 后按需修改。所有字段都有默认值，最简可以只填 adminQQ。',
  onebot: {
    _说明: 'NapCat 的 OneBot 连接方式。二选一：正向 WS（url）或反向 WS（reversePort）。',
    url: 'ws://127.0.0.1:3001',
    accessToken: '',
    reversePort: 0,
    _reversePort说明: '填 0 用正向连接；填端口号（如 3001）则本脚本监听，等 NapCat 反向连过来',
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen3.5-4b',
  },
  bot: {
    name: '小鲸鱼',
    adminQQ: 0,
    _adminQQ说明: '你的 QQ 号。填了之后只有你能用管理命令。',
  },
  reply: { ...DEFAULTS },
  autoAccept: {
    _说明: '自动处理加好友/入群申请。默认全关，确认白名单后再开。',
    enabled: false,
    friend: false,
    groupJoin: false,
    groupInvite: false,
    acceptAnyone: false,
    whitelist: [],
    blacklist: [],
    requireKeyword: '',
    maxPerHour: 5,
  },
  proactive: { ...Proactive.PROACTIVE_DEFAULTS },
  emotion: { ...Emo.EMOTION_DEFAULTS },
  stickers: {
    _说明: '表情包收集与发送。enabled=false 关闭配图；chance 是基础概率。',
    enabled: true,
    chance: 0.25,
    cooldownMin: 20,
  },
  vision: {
    _说明: '用视觉模型"看"图片。model 填 Ollama 里的视觉模型名。',
    enabled: true,
    model: 'qwen2.5vl:3b',
    batch: 3,
    gapMs: 5000,
  },
};

function loadConfig() {
  if (!existsSync(CFG_PATH)) {
    writeFileSync(CFG_PATH, JSON.stringify(EXAMPLE, null, 2), 'utf8');
    log('已生成默认配置: ' + CFG_PATH);
    log('请填好 adminQQ 等字段后重新启动。');
    process.exit(0);
  }
  const raw = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
  return {
    onebot: { ...EXAMPLE.onebot, ...(raw.onebot || {}) },
    ollama: { ...EXAMPLE.ollama, ...(raw.ollama || {}) },
    bot: { ...EXAMPLE.bot, ...(raw.bot || {}) },
    reply: { ...DEFAULTS, ...(raw.reply || {}) },
    autoAccept: { ...AutoFriend.AUTO_ACCEPT_DEFAULTS, ...(raw.autoAccept || {}) },
    proactive: { ...Proactive.PROACTIVE_DEFAULTS, ...(raw.proactive || {}) },
    emotion: { ...Emo.EMOTION_DEFAULTS, ...(raw.emotion || {}) },
    stickers: { enabled: true, chance: 0.25, cooldownMin: 20, ...(raw.stickers || {}) },
    vision: { enabled: true, model: 'qwen2.5vl:3b', batch: 3, gapMs: 5000, ...(raw.vision || {}) },
  };
}

// ---------------------------------------------------------------- 日志

const LOG_DIR = join(ROOT, 'logs');
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, 'bridge-' + new Date().toISOString().slice(0, 10) + '.log');

function log(...a) {
  const line = '[' + new Date().toLocaleTimeString('zh-CN') + '] ' + a.join(' ');
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

// ---------------------------------------------------------------- 上下文记忆

/** key -> [{role, content}] */
const memory = new Map();
const MEM_LIMIT = 200; // 最多记多少个会话，防内存膨胀

function memKey(ev) {
  return ev.message_type === 'group'
    ? 'g:' + ev.group_id
    : 'p:' + ev.user_id;
}

/** 记录一条消息（别人的，或机器人自己的） */
function remember(key, role, content, keepTurns) {
  let arr = memory.get(key);
  if (!arr) {
    arr = [];
    // LRU：超限就丢最旧的
    if (memory.size >= MEM_LIMIT) memory.delete(memory.keys().next().value);
    memory.set(key, arr);
  }
  arr.push({ role, content });
  // 只保留最近 N 轮（1 轮 = user + assistant）
  const max = keepTurns * 2;
  if (arr.length > max) arr.splice(0, arr.length - max);
}

function wipe(key) { memory.delete(key); }

// ---------------------------------------------------------------- Ollama

async function ollamaChat(messages, cfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.reply.timeoutMs);
  try {
    const res = await fetch(cfg.ollama.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.ollama.model,
        messages,
        stream: false,
        think: false, // 关掉思考链，否则短回复会被思考吃光
        options: {
          num_predict: cfg.reply.maxTokens,
          temperature: cfg.reply.temperature,
          top_p: 0.9,
          repeat_penalty: 1.1,
        },
      }),
    });
    if (!res.ok) throw new Error('Ollama HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
    const j = await res.json();
    return (j.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
}

/** 清理模型输出：去掉 markdown、多余换行、可能的自我暴露 */
function sanitize(text) {
  let t = text;
  t = t.replace(/\*\*([^*]*)\*\*/g, '$1');       // **粗体**
  t = t.replace(/^#{1,6}\s*/gm, '');              // # 标题
  t = t.replace(/^\s*[-*+]\s+/gm, '');            // - 列表
  t = t.replace(/^\s*\d+[.、]\s+/gm, '');         // 1. 编号
  t = t.replace(/`([^`]*)`/g, '$1');              // `代码`
  t = t.replace(/\n{2,}/g, '\n');                 // 压缩空行
  t = t.split('\n').map((s) => s.trim()).filter(Boolean).join(' ');

  // —— 标点收敛（新人格要求「基本不用标点」）——
  // 去掉句末的句号/感叹号/省略号，保留逗号和问号。
  // 注意只在句末处理，不动句中的逗号。
  t = t.replace(/[。！!…]+$/g, '');               // 整句结尾
  t = t.replace(/([。！!…]+)(\s|$)/g, '$2');      // 句中断句处的句号、感叹号
  t = t.replace(/[,，]\s*$/, '');                 // 结尾多余逗号
  t = t.replace(/\s{2,}/g, ' ').trim();

  // 兜底：如果还是自曝 AI 身份，直接重写成一句糊弄
  if (/作为(一个)?(AI|人工智能|智能助手|语言模型)/i.test(t) || /我(无法|不能)直接(访问|获取)/.test(t)) {
    return '啊这 你说啥呢';
  }
  return t.trim();
}

// ---------------------------------------------------------------- 触发判断

function shouldReply(ev, cfg, selfId) {
  // 自己发的消息不回复
  if (String(ev.user_id) === String(selfId)) return false;

  const isPrivate = ev.message_type === 'private';
  if (isPrivate) return !!cfg.reply.privateReply;

  // 群聊
  if (!cfg.reply.groupReply) {
    // 群聊总开关关着时，只放行 @ 和前缀
    const text = plainText(ev);
    if (cfg.reply.replyOnAt && isAtMe(ev, selfId)) return true;
    if (cfg.reply.groupPrefixes?.some((p) => text.startsWith(p))) return true;
    return false;
  }
  // 总开关开着时，也允许按 @ 限制
  return true;
}

function isAtMe(ev, selfId) {
  return (ev.message || []).some(
    (s) => s.type === 'at' && String(s.data?.qq) === String(selfId)
  );
}

/** 把消息段数组转成纯文本 */
function plainText(ev) {
  const segs = ev.message;
  if (typeof segs === 'string') return segs;
  if (!Array.isArray(segs)) return ev.raw_message || '';
  return segs
    .map((s) => {
      if (s.type === 'text') return s.data?.text || '';
      if (s.type === 'at') return '@' + (s.data?.qq || '');
      if (s.type === 'image') return '[图片]';
      if (s.type === 'face') return '[表情]';
      if (s.type === 'record') return '[语音]';
      return '';
    })
    .join('')
    .trim();
}

// ---------------------------------------------------------------- 人设进化

/** 记录正在进化的会话，避免同一会话并发进化导致互相覆盖 */
const evolving = new Set();

/**
 * 后台提炼档案 —— 不阻塞回复。
 * 加了 5 秒延迟，避免和刚发出的回复抢显存。
 */
function evolveInBackground(rec, history, cfg, key) {
  if (evolving.has(key)) return;
  evolving.add(key);
  setTimeout(async () => {
    try {
      const next = await Mem.evolve(Mem.load(key), history, cfg);
      Mem.save(next);
      const bits = [];
      if (next.knownAs) bits.push('称呼=' + next.knownAs);
      if (next.facts?.length) bits.push('事实+' + next.facts.length);
      if (next.attitude) bits.push('态度=' + next.attitude);
      log('  🧠 档案进化 v' + next.version + '  ' + bits.join('  '));
    } catch (e) {
      log('  ⚠️ 档案进化失败: ' + e.message);
    } finally {
      evolving.delete(key);
    }
  }, 5000);
}

// ---------------------------------------------------------------- 表情收集

/** 正在收集中的图片数，防止并发过多 */
let collecting = 0;
const COLLECT_MAX = 3;

/**
 * 从一条消息里找出图片/表情，下载并存进素材库。
 * 用 get_image 拿本地路径（NapCat 会缓存下载），再读出来存库。
 */
function collectStickers(bot, ev, text, key) {
  if (!cfg_cache.stickerCollect) return;
  if (collecting >= COLLECT_MAX) return;

  const segs = ev.message;
  if (!Array.isArray(segs)) return;

  const media = segs.filter((s) => ['image', 'face', 'mface', 'marketface'].includes(s.type));
  if (!media.length) return;

  // 用对方这句话作为这张图的"使用场景"
  const context = text && text.length >= 2 && text !== '[图片]' ? text : '';

  for (const seg of media) {
    const d = seg.data || {};
    const file = d.file || d.file_id || '';
    if (!file) continue;

    collecting++;
    (async () => {
      try {
        const r = await bot.call('get_image', { file }, 30000);
        const local = r?.file;
        if (!local || !existsSync(local)) {
          log('  🖼 图片下载失败: ' + file.slice(0, 30));
          return;
        }
        const buf = readFileSync(local);
        const res = Stickers.collect(buf, {
          summary: d.summary || '',
          from: (ev.message_type === 'group' ? 'group:' + ev.group_id : 'friend:' + ev.user_id),
          kind: seg.type,
          fileName: file,
          context,
        });
        if (res.added) {
          log('  🖼 新表情入库 (' + (buf.length / 1024).toFixed(0) + 'KB)' + (context ? ' 场景="' + context.slice(0, 15) + '"' : ''));
        }
      } catch (e) {
        log('  🖼 收集出错: ' + e.message);
      } finally {
        collecting--;
      }
    })();
  }
}

/**
 * 让对方发的图片"被看见"。
 *
 * 做法：下载图片 → 用视觉模型生成描述 → 写入这一段对话的上下文，
 * 这样主模型在回复时就知道对方发了什么图。
 *
 * 注意：这会串行等待视觉模型，所以限制一次最多 1 张，避免拖慢回复。
 */
async function describeIncomingImages(bot, ev, key) {
  if (cfg_cache.vision === false) return;
  const segs = ev.message;
  if (!Array.isArray(segs)) return;

  const media = segs.filter((s) => ['image', 'face', 'mface', 'marketface'].includes(s.type));
  if (!media.length) return;

  const seg = media[0];   // 只处理第一张，避免拖慢
  const file = seg.data?.file || seg.data?.file_id;
  if (!file) return;

  try {
    const r = await bot.call('get_image', { file }, 30000);
    const local = r?.file;
    if (!local || !existsSync(local)) {
      log('  👁 图片拿不到本地路径，跳过识别');
      return;
    }

    const d = await Stickers.describe(local, cfg_cache.cfg || {}, 60000);
    const desc = [d.visual, d.emotion].filter(Boolean).join(' / ');
    if (!desc) return;

    log('  👁 看到图片: ' + desc);

    // 写进上下文：让对方发的图变成一句"可读"的信息
    const hist = memory.get(key);
    if (hist && hist.length) {
      // 找到刚存进去的那条（最后一条 user）
      const last = [...hist].reverse().find((m) => m.role === 'user');
      if (last) last.content = (last.content || '') + '\n[对方发了一张图：' + desc + ']';
    }
    // 记进 sticker 库的语义
    return desc;
  } catch (e) {
    log('  👁 识别出错: ' + e.message);
  }
}

/** 缓存配置引用（供 collectStickers 使用） */
/** 配置缓存（模块级函数用它，避免拿不到 main() 里的 cfg） */
const cfg_cache = {
  stickerCollect: true,
  vision: true,
  stickers: { enabled: true, chance: 0.25, cooldownMin: 20 },
  cfg: null,
};

/** 表情素材库的绝对路径（供拼接 file:// 用） */
const StickerDirAbs = Stickers.STICKER_DIR;

/**
 * 按情绪和情境决定要不要配一张表情。
 *
 * 规则（保守，避免刷屏）：
 *   - 总开关关闭 → 不发
 *   - 素材库为空 → 不发
 *   - 心情好 / 关系熟 → 概率更高
 *   - 同一个人刚发过 → 本次不发（有冷却）
 */
const lastStickerAt = new Map();
async function maybeSendSticker(bot, ev, emoRec, userText, reply) {
  if (!cfg_cache.stickerCollect) return;
  const sc = cfg_cache.stickers || {};
  if (sc.enabled === false) return;

  const key = String(ev.message_type === 'group' ? 'g:' + ev.group_id : 'p:' + ev.user_id);
  const now = Date.now();
  const cd = (sc.cooldownMin ?? 20) * 60000;
  if (lastStickerAt.has(key) && now - lastStickerAt.get(key) < cd) return;

  let chance = sc.chance ?? 0.25;
  // 情绪加成：心情好更容易发表情；关系熟也更容易
  if (emoRec.mood >= 75) chance += 0.15;
  if (emoRec.mood <= 30) chance -= 0.15;
  if (emoRec.intimacy >= 60) chance += 0.1;
  if (emoRec.intimacy <= 10) chance -= 0.15;
  chance = Math.max(0, Math.min(0.8, chance));

  if (Math.random() > chance) return;

  // —— 让模型从候选图里自己挑 ——
  const st = await pickStickerByModel(bot, ev, emoRec, userText, reply, sc);
  if (!st) return;

  const abs = (StickerDirAbs + '\\' + st.file).replace(/\\/g, '/');
  try {
    const msg = [{ type: 'image', data: { file: 'file:///' + abs } }];
    if (ev.message_type === 'group') await bot.call('send_group_msg', { group_id: ev.group_id, message: msg });
    else await bot.call('send_private_msg', { user_id: ev.user_id, message: msg });
    Stickers.markSent(st.id);
    lastStickerAt.set(key, now);
    log('  🖼 配图: ' + st.file.slice(0, 20) +
        '  「' + (st.visual || st.contexts?.[0] || '无描述').slice(0, 30) + '」' +
        '  (心情' + Math.round(emoRec.mood) + '/亲密' + Math.round(emoRec.intimacy) + ')');
  } catch (e) {
    log('  🖼 发表情失败: ' + e.message);
  }
}

/**
 * 让模型从候选表情里挑一张。
 *
 * 流程：候选（按场景/情绪粗筛）→ 把描述交给模型 → 模型决定发哪张或都不发。
 * 这样"什么时候发什么图"由模型判断，而不是死板的关键词匹配。
 */
async function pickStickerByModel(bot, ev, emoRec, userText, reply, sc) {
  const idx = Stickers.loadIndex();
  if (!idx.items.length) return null;

  // 先粗筛出候选（最多 6 张），避免把整个库塞给模型
  const cands = [];
  const seen = new Set();
  const push = (it) => { if (it && !seen.has(it.id)) { seen.add(it.id); cands.push(it); } };

  const ctx = (userText + ' ' + reply).slice(0, 40);
  const byScene = Stickers.pick({ context: ctx, moodHint: moodWord(emoRec) });
  push(byScene);
  for (const it of idx.items) { if (cands.length >= 6) break; push(it); }

  if (!cands.length) return null;
  if (cands.length === 1) return cands[0];   // 只有一张就不用问模型了

  // 把候选列给模型
  const list = cands.map((it, i) =>
    (i + 1) + '. ' + (it.visual || '（还没描述）') +
    (it.emotion ? ' [' + it.emotion + ']' : '') +
    (it.contexts?.length ? '  常见于："' + it.contexts.slice(-2).join('" / "') + '"' : '')
  ).join('\n');

  const prompt = `你在 QQ 上聊天。刚和对方说了这些：

对方：${userText.slice(0, 80)}
你：${reply.slice(0, 80)}

你现在的心情：${moodWord(emoRec)}

下面是你收藏的表情包：
${list}

请决定：要不要配一张表情？如果要，选第几张？
表情要贴合当前气氛（比如对方在夸你就别发哭脸）。如果都不合适，就选 0。

只输出 JSON：{"n": 数字, "why": "简短理由"}`;

  try {
    const r = await fetch((cfg_cache.cfg?.ollama?.baseUrl || 'http://127.0.0.1:11434') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg_cache.cfg?.ollama?.model || 'qwen3.5-4b',
        messages: [{ role: 'user', content: prompt }],
        stream: false, think: false,
        options: { num_predict: 80, temperature: 0.7 },
      }),
    });
    const j = await r.json();
    const raw = (j.message?.content || '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const o = JSON.parse(m[0]);
      const n = Number(o.n) || 0;
      if (n === 0) { log('  🖼 模型决定不发图（' + String(o.why || '').slice(0, 30) + '）'); return null; }
      if (n >= 1 && n <= cands.length) return cands[n - 1];
      log('  🖼 模型返回越界序号 ' + n + '，忽略');
      return null;
    }
  } catch (e) {
    log('  🖼 选图失败，用默认候选: ' + e.message);
  }
  return cands[0];   // 失败时退回粗筛结果
}

/** 把情绪翻译成给选图用的词 */
function moodWord(r) {
  const w = [];
  if (r.mood >= 70) w.push('开心');
  else if (r.mood <= 30) w.push('不高兴');
  else w.push('平静');
  if (r.intimacy >= 60) w.push('关系好');
  else if (r.intimacy <= 15) w.push('不熟');
  return w.join(' ');
}

// ---------------------------------------------------------------- 主动聊天

/** 等待对方回复的登记表：key -> { since, text } */
const awaitingReply = new Map();

/**
 * 主动聊天调度器。
 * 每 2 分钟检查一次：现在适合开口吗？该找谁？说什么？
 */
function startProactive(bot, cfg) {
  if (!cfg.proactive?.enabled) {
    log('主动聊天：未开启（config.json 的 proactive.enabled）');
    return;
  }

  log('主动聊天：已开启，间隔 ' + cfg.proactive.minGapMin + '-' + cfg.proactive.maxGapMin +
      ' 分钟，静默 ' + cfg.proactive.quietStart + '-' + cfg.proactive.quietEnd + ' 点');

  let state = Proactive.loadState();

  const tick = async () => {
    try {
      if (!bot.ready) return;

      const chk = Proactive.canSend(cfg, state, new Date());
      if (!chk.ok) return;

      // 取好友列表当候选
      let friends = [];
      try {
        const list = await bot.call('get_friend_list');
        friends = (list || []).map((f) => String(f.user_id)).filter((id) => id !== String(bot.selfId));
      } catch (e) {
        log('主动聊天：取好友列表失败 ' + e.message);
        return;
      }
      if (!friends.length) return;

      const target = Proactive.pickTarget(cfg, state, friends);
      if (!target) return;

      // 让对方模型先想一下：现在该不该开口
      const key = 'p:' + target;
      const rec = Mem.load(key);
      const hist = (memory.get(key) || []).slice(-6)
        .map((m) => (m.role === 'user' ? '对方' : '你') + '：' + m.content)
        .join('\n');

      let message = '';
      let reason = '';

      if (cfg.proactive.thinkBeforeSend) {
        const d = await Proactive.thinkWhetherToSpeak({
          persona: PERSONA,
          about: Mem.render(rec, cfg.bot.name),
          recent: hist,
          now: new Date(),
        }, cfg);
        if (!d.speak) {
          log('💭 主动聊天：决定不说（' + d.reason + '）');
          return;
        }
        message = sanitize(d.message);
        reason = d.reason;
      } else {
        // 不走思考：直接让模型基于记忆生成一句
        const msgs = [
          { role: 'system', content: PERSONA + Mem.render(rec, cfg.bot.name) },
          { role: 'user', content: '（现在没人跟你说话。你主动开个话题，说一句简短自然的话。只输出要发的内容。）' },
        ];
        message = sanitize(await ollamaChat(msgs, cfg));
        reason = '直接生成';
      }

      if (!message) {
        log('💭 主动聊天：生成内容为空，跳过');
        return;
      }

      await bot.sendPrivate(target, message);
      state = Proactive.markSent(state, target, message);
      Proactive.saveState(state);
      awaitingReply.set(key, { since: Date.now(), text: message });

      log('💬 主动发送给 ' + target + '：' + message + '   [' + reason + ']');
    } catch (e) {
      log('主动聊天出错：' + e.message);
    }
  };

  // 首次延迟 30 秒，之后每 2 分钟检查
  setTimeout(tick, 30000);
  setInterval(tick, 120000);

  // 冷落检测：每分钟扫一次，发出超过 10 分钟没人回就算冷落
  setInterval(() => {
    const now = Date.now();
    for (const [key, info] of awaitingReply) {
      if (now - info.since < 10 * 60000) continue;
      const target = key.slice(2);
      state = Proactive.markIgnored(state, target, cfg);
      Proactive.saveState(state);
      const ig = state.perTarget[target]?.ignored || 0;
      log('🥶 主动聊天：' + target + ' 没回（累计 ' + ig + ' 次）');
      awaitingReply.delete(key);
    }
  }, 60000);
}

// ---------------------------------------------------------------- OneBot 客户端

class OneBot {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.selfId = null;
    this.ready = false;
    this.handlers = new Map();
    this.pending = new Map(); // echo -> {resolve, reject}
    this.echo = 0;
    this.retry = 0;
  }

  on(action, fn) { this.handlers.set(action, fn); }

  /** 正向 WS：主动连 NapCat */
  connectForward() {
    const url = this.cfg.onebot.url;
    log('正在连接 OneBot（正向）: ' + url);
    this.#open(url, () => {
      log('已连接。等待 NapCat 推送消息…');
    });
  }

  /** 反向 WS：本脚本当服务端，等 NapCat 连进来 */
  async connectReverse() {
    const { createServer } = await import('node:http');
    const { WebSocketServer } = await import('ws').catch(() => ({}));
    if (!WebSocketServer) {
      log('反向模式需要 ws 模块。请用正向模式（config.onebot.url），或 npm i ws');
      process.exit(1);
    }
    const port = this.cfg.onebot.reversePort;
    const http = createServer((req, res) => { res.writeHead(404); res.end(); });
    const wss = new WebSocketServer({ server: http });
    log('反向模式：监听 ws://127.0.0.1:' + port + '，请在 NapCat 里配置反向 WS 指向这里');
    wss.on('connection', (ws, req) => {
      const auth = req.headers['authorization'] || '';
      const want = this.cfg.onebot.accessToken;
      if (want && auth !== 'Bearer ' + want) {
        log('拒绝一个鉴权失败的反向连接');
        return ws.close(1008, 'unauthorized');
      }
      log('NapCat 已反向连接进来');
      this.#attach(ws);
    });
    http.listen(port, '127.0.0.1');
  }

  #open(url, onOpen) {
    // 用 Node 内置 WebSocket（Node 22+ 自带）
    const headers = {};
    if (this.cfg.onebot.accessToken) headers['Authorization'] = 'Bearer ' + this.cfg.onebot.accessToken;
    const ws = new WebSocket(url, { headers });
    ws.addEventListener('open', () => { this.retry = 0; onOpen(); });
    ws.addEventListener('message', (e) => this.#onMessage(e.data));
    ws.addEventListener('close', () => {
      this.ready = false;
      const wait = Math.min(30000, 3000 * ++this.retry);
      log('连接断开，' + (wait / 1000) + ' 秒后重连…');
      setTimeout(() => this.#open(url, onOpen), wait);
    });
    ws.addEventListener('error', (e) => log('WS 错误: ' + (e.message || e.type)));
    this.#attach(ws);
  }

  #attach(ws) {
    this.ws = ws;
    this.ready = true;
    // 拉一下自己的账号信息
    this.call('get_login_info').then((r) => {
      this.selfId = r?.user_id;
      log('机器人账号: ' + (r?.nickname || '?') + '(' + this.selfId + ')');
    }).catch(() => {});
  }

  #onMessage(data) {
    let ev;
    try { ev = JSON.parse(data); } catch { return; }

    // 是我们发出去的 API 请求的回包
    if (ev.echo !== undefined && this.pending.has(ev.echo)) {
      const { resolve, reject } = this.pending.get(ev.echo);
      this.pending.delete(ev.echo);
      if (ev.status === 'ok' || ev.retcode === 0) resolve(ev.data);
      else reject(new Error(ev.message || ev.wording || 'OneBot 调用失败'));
      return;
    }

    // 心跳等元事件
    if (ev.post_type === 'meta_event') {
      if (ev.meta_event_type === 'lifecycle') log('OneBot 生命周期: ' + ev.sub_type);
      return;
    }

    if (ev.post_type === 'message') {
      const fn = this.handlers.get('message');
      if (fn) fn(ev).catch((e) => log('处理消息出错: ' + e.message));
      return;
    }

    // 加好友 / 入群申请
    if (ev.post_type === 'request') {
      const fn = this.handlers.get('request');
      if (fn) fn(ev).catch((e) => log('处理申请出错: ' + e.message));
      return;
    }

    // 追踪开关：记录所有其他事件类型
    const tf = this.handlers.get('trace');
    if (tf && ev.post_type !== 'meta_event') tf(ev);

    // 其他（notice 等）先忽略，但记录一次便于排查
    if (ev.post_type === 'notice' && process.env.QQBRIDGE_DEBUG_NOTICE) {
      log('notice: ' + JSON.stringify(ev).slice(0, 200));
    }
  }

  /** 调 OneBot API */
  call(action, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.ready) return reject(new Error('OneBot 未连接'));
      const echo = String(++this.echo);
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error('OneBot 调用超时: ' + action));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendPrivate(userId, text) { return this.call('send_private_msg', { user_id: userId, message: text }); }
  sendGroup(groupId, text) { return this.call('send_group_msg', { group_id: groupId, message: text }); }
}

// ---------------------------------------------------------------- 主流程

const DRY = process.argv.includes('--dry-run');

async function main() {
  const cfg = loadConfig();
  const bot = new OneBot(cfg);

  // 把配置接进模块级缓存
  cfg_cache.stickerCollect = cfg.stickers?.enabled !== false;
  cfg_cache.stickers = cfg.stickers || {};
  cfg_cache.vision = cfg.vision?.enabled !== false;
  cfg_cache.cfg = cfg;

  log('='.repeat(56));
  log('QQ ↔ 本地模型桥 启动');
  log('模型: ' + cfg.ollama.model + ' @ ' + cfg.ollama.baseUrl);
  log('人格: ' + PERSONA.split('\n')[0].replace(/^你是/, '').slice(0, 40));
  log('='.repeat(56));

  // 检查 Ollama
  try {
    const r = await fetch(cfg.ollama.baseUrl + '/api/tags');
    const tags = await r.json();
    const have = (tags.models || []).map((m) => m.name);
    if (!have.some((n) => n === cfg.ollama.model || n.startsWith(cfg.ollama.model + ':'))) {
      log('⚠️ Ollama 里没有模型「' + cfg.ollama.model + '」。已有: ' + have.join(', '));
      log('   请先跑: ollama pull ' + cfg.ollama.model);
      process.exit(1);
    }
    log('Ollama 就绪，模型在册');
  } catch (e) {
    log('⚠️ 连不上 Ollama (' + cfg.ollama.baseUrl + '): ' + e.message);
    log('   请先启动 Ollama。');
    process.exit(1);
  }

  // 预热：让模型进显存
  log('预热模型中…');
  const t0 = Date.now();
  await ollamaChat([{ role: 'system', content: PERSONA }, { role: 'user', content: '在吗' }], cfg);
  log('预热完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  if (DRY) {
    log('--dry-run：跳过 OneBot 连接。');
    const tests = ['在吗', '我电脑好卡 是不是内存不够', '今天加班到现在 累死了', '你是不是机器人'];
    for (const t of tests) {
      const out = sanitize(await ollamaChat(
        [{ role: 'system', content: PERSONA }, { role: 'user', content: t }], cfg));
      log('  > ' + t + '\n    ' + out);
    }
    return;
  }

  // 消息处理
  bot.on('message', async (ev) => {
    const key = memKey(ev);
    const text = plainText(ev);

    // 记录所有进来的话（含没触发回复的，这样上下文更完整）
    remember(key, 'user', text, cfg.reply.contextTurns);

    // 对方回了 → 说明主动聊天没被冷落，清空计数
    if (awaitingReply.has(key)) {
      awaitingReply.delete(key);
      try {
        const st = Proactive.loadState();
        Proactive.markReplied(st, String(ev.user_id));
        Proactive.saveState(st);
      } catch {}
    }

    // 标点学习：统计对方怎么写标点（纯统计，不调用模型）
    try {
      const r0 = Mem.load(key);
      Mem.accumulatePunct(r0, text);
      Mem.save(r0);
    } catch (e) { /* 统计失败不影响主流程 */ }

    // —— 表情包收集：把对方发的图片/表情存进素材库 ——
    try {
      collectStickers(bot, ev, text, key);
    } catch (e) { log('  表情收集失败: ' + e.message); }

    // —— 让模型"看到"图片：把描述拼进上下文 ——
    try {
      await describeIncomingImages(bot, ev, key);
    } catch (e) { log('  图片识别失败: ' + e.message); }

    // —— 情绪更新：分析这条消息对心情/亲密度的影响 ——
    try {
      const e0 = Emo.load(key);
      Emo.applyInteraction(e0, text, cfg);
      Emo.save(e0);
    } catch (e) { /* 情绪失败不影响主流程 */ }

    if (!shouldReply(ev, cfg, bot.selfId)) return;

    // 管理命令
    if (cfg.bot.adminQQ && String(ev.user_id) === String(cfg.bot.adminQQ)) {
      if (text === '/reset' || text === '重置') {
        wipe(key);
        return void bot.call(ev.message_type === 'group' ? 'send_group_msg' : 'send_private_msg',
          ev.message_type === 'group' ? { group_id: ev.group_id, message: '上下文已清空' }
                                     : { user_id: ev.user_id, message: '上下文已清空' });
      }
    }

    const who = ev.sender?.card || ev.sender?.nickname || ev.user_id;
    log('收到 [' + (ev.message_type === 'group' ? '群' + ev.group_id : '私聊') + '] ' + who + ': ' + text);

    // QQ 会把「请求添加你为好友」这类系统提示当普通私聊推过来。
    // 这不是真的好友申请事件，但值得单独标出来，避免模型乱接。
    if (/请求添加你为好友|请求加你为好友|添加你为好友/.test(text)) {
      log('  ℹ️ 这是 QQ 的陌生人/加好友提示文本（不是 request 事件）');
    }

    try {
      // 读取这个人/群的进化档案，拼在基础人格后面
      const rec = Mem.load(key);
      // 情绪状态也拼进去 —— 让数值真的影响说话
      const emoRec = Emo.load(key);
      const systemPrompt = PERSONA + Mem.render(rec, cfg.bot.name) +
        (cfg.emotion?.enabled !== false ? Emo.render(emoRec) : '');

      const msgs = [
        { role: 'system', content: systemPrompt },
        ...(memory.get(key) || []).slice(0, -1), // 不含刚存进去的这条
        { role: 'user', content: text },
      ];
      const raw = await ollamaChat(msgs, cfg);
      const reply = sanitize(raw);
      if (!reply) return void log('  模型输出为空，跳过');

      remember(key, 'assistant', reply, cfg.reply.contextTurns);

      if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, reply);
      else await bot.sendPrivate(ev.user_id, reply);
      log('  回复: ' + reply);

      // —— 按情绪决定要不要配一张表情包 ——
      await maybeSendSticker(bot, ev, emoRec, text, reply);

      // —— 人设进化：每 N 轮后台提炼一次，不阻塞回复 ——
      rec.turns += 1;
      Mem.save(rec);
      const every = cfg.reply.evolveEvery ?? 4;
      if (every > 0 && rec.turns - rec.evolvedTurns >= every) {
        const hist = memory.get(key) || [];
        evolveInBackground(rec, hist, cfg, key);
      }
    } catch (e) {
      log('  生成失败: ' + e.message);
    }
  });

  // 加好友 / 入群申请自动处理
  bot.on('request', async (ev) => {
    await AutoFriend.handleRequest(ev, cfg, bot, log);
  });

  // 记录所有非消息事件，便于排查（申请事件为何没来）
  if (process.env.QQBRIDGE_TRACE) {
    bot.on('trace', (ev) => {
      log('🔎 事件: ' + ev.post_type +
        (ev.request_type ? '/' + ev.request_type : '') +
        (ev.notice_type ? '/' + ev.notice_type : '') +
        '  ' + JSON.stringify(ev).slice(0, 160));
    });
  }

  if (cfg.onebot.reversePort) await bot.connectReverse();
  else bot.connectForward();

  // 主动聊天调度器
  startProactive(bot, cfg);

  // 表情库后台标注：空闲时慢慢把没收据的图"看"一遍
  if (cfg.vision?.enabled !== false) {
    const st = Stickers.describeStats();
    log('图片识别：视觉模型 ' + (cfg.vision?.model || 'qwen2.5vl:3b') +
        (st.pending ? '，待标注 ' + st.pending + ' 张' : '，素材库已全部标注'));
    const label = () => Stickers.labelPending(cfg, log, {
      maxPerRound: cfg.vision?.batch ?? 3,
      gapMs: cfg.vision?.gapMs ?? 5000,
    }).catch(() => {});
    setTimeout(label, 20000);          // 启动 20 秒后开始第一轮
    setInterval(label, 5 * 60000);     // 之后每 5 分钟补一轮
  }

  process.on('SIGINT', () => { log('收到 Ctrl+C，退出。'); process.exit(0); });
}

main().catch((e) => { log('启动失败: ' + e.stack); process.exit(1); });