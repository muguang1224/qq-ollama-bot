#!/usr/bin/env node
/**
 * QQ ↔ 本地大模型（Ollama）直连桥
 *
 * 架构：
 *   QQ ←→ OneBot v11 实现（SnowLuma / NapCat 都可以）←→ 本脚本 ←→ Ollama
 *
 * OneBot 后端：
 *   当前用 SnowLuma（默认 3001）。NapCat 也兼容 —— 两者都说 OneBot v11，
 *   只是各自的 accessToken 不同，改 config.json 的 onebot.accessToken 即可切换。
 *   NapCat 换成 SnowLuma 的原因：NapCat 的 OneBot 适配器反复掉线
 *   （QQ 进程还在，但 3001 端口不再监听），表现为机器人静默不回消息。
 *
 * 不依赖 DSH、不依赖 qq-bridge。纯 Node，零第三方依赖。
 *
 * 用法：
 *   node bridge.mjs                 # 正常启动
 *   node bridge.mjs --dry-run       # 不连 OneBot，只在本地测试模型
 *   node bridge.mjs --config a.json # 指定配置
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { fileUrl, platformLabel, IS_WINDOWS } from './platform.mjs';
import { PERSONA, DEFAULTS } from './persona.mjs';
import * as Mem from './memory.mjs';
import * as AutoFriend from './autofriend.mjs';
import * as Proactive from './proactive.mjs';
import * as Emo from './emotion.mjs';
import * as Stickers from './stickers.mjs';
import * as Video from './video.mjs';
import * as Qzone from './qzone.mjs';
import * as TTS from './tts.mjs';
import * as Search from './search.mjs';
import * as Douyin from './douyin.mjs';
import * as Bili from './bili.mjs';
import * as Vram from './vram.mjs';
import * as Asr from './asr.mjs';

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
    owner: 0,
    _owner说明: '主人 QQ 号。填了之后这个人在对话里被当作主人，称呼用 ownerName。0 = 不启用。',
    ownerName: '主人',
    _ownerName说明: '怎么称呼主人。例：爸爸 / 老板 / 哥。',
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
  followUp: {
    _说明: '会话内追问：回复后有时再补一句，让对话不是一问一答就结束。',
    enabled: true,
    chance: 0.3,
  },
  video: {
    _说明: '视频处理：下载后抽帧识别。注意这只是"看几张截图"，不是真的理解视频。',
    enabled: true,
    frames: 3,
    width: 256,
    maxMB: 80,
  },
  audio: {
    _说明: '语音处理：用 fetch_ptt_text 把语音转成文字。',
    enabled: true,
  },
  qzone: { ...Qzone.QZONE_DEFAULTS },
  tts: { ...TTS.TTS_DEFAULTS },
  search: { ...Search.SEARCH_DEFAULTS },
  bili: { ...Bili.BILI_DEFAULTS },
  vram: { autoFree: true, minFreeVramMB: 6000, waitMs: 4000 },
  asr: { ...Asr.ASR_DEFAULTS },
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
    followUp: { enabled: true, chance: 0.3, ...(raw.followUp || {}) },
    video: { enabled: true, frames: 3, width: 256, maxMB: 80, ...(raw.video || {}) },
    audio: { enabled: true, ...(raw.audio || {}) },
    qzone: { ...Qzone.QZONE_DEFAULTS, ...(raw.qzone || {}) },
    tts: { ...TTS.TTS_DEFAULTS, ...(raw.tts || {}) },
    search: { ...Search.SEARCH_DEFAULTS, ...(raw.search || {}) },
    bili: { ...Bili.BILI_DEFAULTS, ...(raw.bili || {}) },
    vram: { autoFree: true, minFreeVramMB: 6000, waitMs: 4000, ...(raw.vram || {}) },
    asr: { ...Asr.ASR_DEFAULTS, ...(raw.asr || {}) },
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

// ---------------------------------------------------------------- 上下文持久化
//
// 原来历史只存在内存里，**重启桥接就全丢** ——
// 重启后第一句话，模型不知道刚才聊过什么，表现出来就是"前言不搭后语"。
// 现在落盘到 <root>/context/<key>.json，重启后自动恢复。
const CTX_DIR = join(ROOT, 'context');
if (!existsSync(CTX_DIR)) mkdirSync(CTX_DIR, { recursive: true });

const ctxFile = (key) => join(CTX_DIR, key.replace(/[:\\/*?"<>|]/g, '-') + '.json');

/** 从磁盘读一个会话的历史 */
function loadCtx(key) {
  const f = ctxFile(key);
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return Array.isArray(j.msgs) ? j.msgs : [];
  } catch { return []; }
}

/** 写回磁盘（失败不影响聊天） */
function saveCtx(key, msgs) {
  try {
    writeFileSync(ctxFile(key), JSON.stringify({
      key, updatedAt: new Date().toISOString(), msgs,
    }));
  } catch { /* 写盘失败只影响持久化，不影响本轮回话 */ }
}

function memKey(ev) {
  return ev.message_type === 'group'
    ? 'g:' + ev.group_id
    : 'p:' + ev.user_id;
}

/** 记录一条消息（别人的，或机器人自己的） */
function remember(key, role, content, keepTurns) {
  let arr = memory.get(key);
  if (!arr) {
    // 首次访问这个会话：先从磁盘恢复（重启后不会失忆）
    arr = loadCtx(key);
    // LRU：超限就丢最旧的
    if (memory.size >= MEM_LIMIT) memory.delete(memory.keys().next().value);
    memory.set(key, arr);
  }
  arr.push({ role, content });
  // 只保留最近 N 轮（1 轮 = user + assistant）
  const max = (keepTurns || 10) * 2;
  if (arr.length > max) arr.splice(0, arr.length - max);
  saveCtx(key, arr);
}

/** 读一个会话的历史（会从磁盘恢复） */
function history(key) {
  let arr = memory.get(key);
  if (!arr) {
    arr = loadCtx(key);
    memory.set(key, arr);
  }
  return arr;
}

function wipe(key) {
  memory.delete(key);
  try { rmSync(ctxFile(key), { force: true }); } catch {}
}

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

/**
 * 清理模型输出：去掉 markdown、多余换行、可能的自我暴露
 *
 * @param {string} text
 * @param {object} [ctx] 上下文，用于「不该叫的称呼」拦截
 *        ctx.isOwner  — 当前说话人是不是主人
 *        ctx.ownerName — 主人的称呼（默认「爸爸」）
 *        ctx.isGroup  — 是不是群聊
 */
function sanitize(text, ctx) {
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

  // —— 反编造兜底 ——
  // 模型有时会编造"没吃饭""刚回来"这类外部经历。
  // 主动聊天在 proactive.mjs 里有拦截，但日常回复之前没有，这里补上。
  // 命中不丢弃整句（那会变成不回复），而是换成不会撒谎的软话。
  const fake = detectFakeExperience(t);
  if (fake) {
    log('  ⚠️ 检测到编造外部经历，已替换：' + t.slice(0, 40));
    return '我一直在待着呀 没别的事呢';
  }

  // —— 否认自己能力的兜底 ——
  // 模型会周期性地"忘记"自己已经具备的能力，说些过时的话。
  // 已经见过三次：
  //   · "我进不去 QQ 空间"       ← 其实能发说说
  //   · "语音没开着/我不会发语音" ← 其实能发
  //   · "还在等新音色上线/现在是静音状态" ← 音色早就弄好了
  // 这类话在人格里已经写了反例，但模型仍会偶尔复读（一旦说过一次
  // 就会顺着上下文继续说），所以在代码层再兜一层。
  const DENY_PATTERNS = [
    /静音状态|还是静音|在静音/,
    /等.{0,8}音色/,
    /音色.{0,6}(上线|还在|没弄|没做|没调)/,
    /(没|没有|发不出|发不了).{0,3}(声音|语音)/,
    /(不会|不能).{0,4}(发语音|说话|出声)/,
    /嗓子.{0,4}(还没|没好|不行|长)/,
    /(进不去|打不开).{0,6}(QQ\s*)?空间/,
  ];
  const denied = DENY_PATTERNS.find((re) => re.test(t));
  if (denied) {
    log('  ⚠️ 检测到否认自己能力（' + denied + '），已替换：' + t.slice(0, 40));
    return '我在呢 你说吧';
  }

  // —— 称呼兜底：不该叫的时候不许叫 ——
  // 规则：
  //   · 群聊 → **一律**不许用亲属称呼（哪怕说话的是主人，群里有别人看着）
  //   · 私聊非主人 → 也不许用
  //   · 只有「私聊主人」这一种情况保留
  //
  // 实现说明：一开始用了带 lookahead 的正则，但「爸你…」这种最常见的
  // 组合（称呼后直接跟「你」）反而匹配不到，所以改成直接字符串替换，
  // 更笨但更可靠。按长度从长到短替换，避免「爸爸」被「爸」先吃掉。
  const blockOwnerAddr = ctx && (ctx.isGroup || !ctx.isOwner);
  if (blockOwnerAddr) {
    const words = [ctx.ownerName || '爸爸', '爸爸', '老爸', '爸', '爹', '爹爹'];
    const before = t;
    for (const w of [...new Set(words)].sort((a, b) => b.length - a.length)) {
      if (!w) continue;
      t = t.split(w).join('你');
    }
    // 收敛替换后的瑕疵：
    //  · 「你你」重复
    //  · 「你，你…」这种称呼后残留的标点（原来是「爸，你…」）
    t = t.replace(/你{2,}/g, '你');
    t = t.replace(/你[，,]\s*你/g, '你');
    if (t !== before) {
      log('  ⚠️ ' + (ctx.isGroup ? '群聊' : '非主人') +
          '场景出现主人称呼，已改为「你」：' + before.slice(0, 40));
    }
  }

  return t.trim();
}

// ---------------------------------------------------------------- 记忆渲染

/**
 * 检测"编造外部经历"。
 *
 * 它没有身体、不能上网，凡是"我做了什么/看到什么"都是编的。
 * 主动聊天（proactive.mjs）和日常回复（本文件）都要用，所以放在这里共用。
 *
 * @returns {RegExp|null} 命中的规则，没命中返回 null
 */
const FAKE_EXPERIENCE_RULES = [
  /刚(刚)?(看|刷|瞅|瞄)(到|了|见)?/,              // 刚看到 / 刚刷到
  /(看|刷)到(个|了)?(视频|新闻|帖子|段子|图|文章|直播)/, // 刷到个视频
  /刚(吃|喝|睡|醒|起|出门|回家|下班|上班)/,        // 刚吃饭 / 刚出门
  /我(在|正)(做|吃|喝|玩|打|写|看)(饭|菜|游戏|东西)?/, // 我在做饭/打游戏
  /(今天|外面|这边)(天气|下雨|下雪|出太阳)/,        // 今天天气
  /(去了|路过|经过|逛了)/,                        // 去了某地
  /我(这边|这儿)(刚|正)/,
  /(没|还没)(吃饭|吃|睡|起床|出门)/,               // 没吃饭 / 还没睡
  /我(刚|才)(回来|到家|出门|起床|睡醒)/,
];
function detectFakeExperience(text) {
  const s = String(text || '');
  for (const re of FAKE_EXPERIENCE_RULES) {
    if (re.test(s)) return re;
  }
  return null;
}

/**
 * 把人物档案渲染成 system prompt 片段。
 * 统一入口：把「主人」配置（cfg.bot.owner / ownerName）一并传下去，
 * 这样 memory.mjs 不需要硬编码任何 QQ 号，公开仓库里也不会泄漏个人信息。
 *
 * speakerQQ：当前发消息的人。群聊里 rec.key 是 g:群号，光看 key
 * 无法判断说话的是谁，主人判定会失效（表现为对谁都叫"爸"）。
 */
function renderMemory(rec, cfg, speakerQQ) {
  return Mem.render(rec, cfg.bot?.name, {
    ownerQQ: cfg.bot?.owner || 0,
    ownerName: cfg.bot?.ownerName || '主人',
    speakerQQ: speakerQQ || 0,
  });
}

// ---------------------------------------------------------------- 触发判断

/**
 * 群聊「对话状态」登记表：group_id -> 过期时间戳
 *
 * 为什么需要：
 *   群聊默认只在被 @ 时回复。但 @ 一次之后，对方往往会连着说几句，
 *   如果每句都要重新 @，体验很割裂（截图里的问题）。
 *   所以被 @（或命中前缀）后，接下来 groupSessionMs 毫秒内，
 *   该群的普通消息也会回复；超时自动退出，避免长期刷屏。
 */
const groupSession = new Map();
const GROUP_SESSION_MS_DEFAULT = 5 * 60 * 1000; // 5 分钟

/** 该群是否处于对话状态 */
function inGroupSession(groupId, cfg) {
  const until = groupSession.get(String(groupId));
  if (!until) return false;
  if (Date.now() > until) {
    groupSession.delete(String(groupId));
    return false;
  }
  return true;
}

/** 进入/续期对话状态 */
function touchGroupSession(groupId, cfg) {
  const ms = cfg.reply?.groupSessionMs ?? GROUP_SESSION_MS_DEFAULT;
  if (ms > 0) groupSession.set(String(groupId), Date.now() + ms);
}

function shouldReply(ev, cfg, selfId) {
  // 自己发的消息不回复
  if (String(ev.user_id) === String(selfId)) return false;

  const isPrivate = ev.message_type === 'private';
  if (isPrivate) return !!cfg.reply.privateReply;

  // 群聊
  const text = plainText(ev);
  const atMe = cfg.reply.replyOnAt && isAtMe(ev, selfId);
  const byPrefix = cfg.reply.groupPrefixes?.some((p) => text.startsWith(p));

  // 被 @ 或命中前缀 → 一定回复，并且开启/续期对话状态
  if (atMe || byPrefix) {
    touchGroupSession(ev.group_id, cfg);
    return true;
  }

  // 群聊全开
  if (cfg.reply.groupReply) return true;

  // 处于对话状态 → 也回复（这就是「@ 一次后能连续聊」）
  if (inGroupSession(ev.group_id, cfg)) {
    touchGroupSession(ev.group_id, cfg); // 有互动就续期
    return true;
  }

  return false;
}

function isAtMe(ev, selfId) {
  return (ev.message || []).some(
    (s) => s.type === 'at' && String(s.data?.qq) === String(selfId)
  );
}

// ---------------------------------------------------------------- 卡片解析

/**
 * 从 QQ 卡片消息（json / xml）里尽量抠出可读信息。
 *
 * 卡片结构五花八门，各平台（B站/网易云/QQ音乐/公众号）都不一样，
 * 所以策略是「按优先级找几个常见字段，找到就用，找不到就退回原文裁一段」。
 *
 * 典型 B站卡片长这样：
 *   {"app":"com.tencent.structmsg","meta":{"news":{
 *      "title":"【标题】","desc":"...","jumpUrl":"https://b23.tv/xxx"}}}
 *
 * @returns {string} 拼接好的可读文本，失败返回 ''
 */
function extractCard(seg) {
  const raw = seg.data?.data || seg.data?.text || '';
  if (!raw) return '';

  let obj = null;
  try { obj = JSON.parse(raw); } catch { /* xml 或非 JSON，走下面的正则 */ }

  const parts = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (!s || s.length > 150) return;
    if (parts.some((x) => x.includes(s))) return;
    parts.push(s);
  };

  if (obj && typeof obj === 'object') {
    const meta = obj.meta || {};
    for (const key of Object.keys(meta)) {
      const m = meta[key];
      if (!m || typeof m !== 'object') continue;
      const t = String(m.title || '').trim();
      if (t && t.length <= 120) add('《' + t + '》');
      add(m.desc);
      // 链接字段名各平台不同
      add(m.jumpUrl || m.url || m.qqdocurl || m.sourceUrl || m.musicUrl);
      if (m.tag) add('[' + m.tag + ']');
    }
    add(obj.prompt);
  }

  // 从原始字符串里兜底找链接（XML 也能覆盖）
  if (!parts.some((x) => /^https?:\/\//.test(x))) {
    const u = /https?:\/\/[^\s"'<>\\]+/.exec(raw);
    if (u) add(u[0].replace(/\\\//g, '/'));
  }
  if (!parts.length) {
    const t = /"title"\s*:\s*"([^"]{2,80})"/.exec(raw);
    if (t) add('《' + t[1] + '》');
  }

  // 还是空就退回原文（裁一段，去掉转义符）
  if (!parts.length) {
    const cut = raw.replace(/\\\//g, '/').replace(/\\n/g, ' ').slice(0, 200);
    return cut ? '[卡片:' + cut + ']' : '';
  }

  return '[卡片] ' + parts.join(' ');
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
      // QQ 的表情包有多种类型，之前漏了这些 → 整条消息变空
      if (s.type === 'mface' || s.type === 'marketface' || s.type === 'bface') {
        const sum = s.data?.summary || s.data?.text || '';
        return '[表情包' + (sum ? ':' + sum : '') + ']';
      }
      if (s.type === 'record') return '[语音]';
      if (s.type === 'video') return '[视频]';
      if (s.type === 'file') return '[文件:' + (s.data?.name || s.data?.file || '') + ']';
      // 卡片消息（json/xml）
      //
      // 原来直接返回 '[卡片消息]'，等于把内容全丢了。
      // 而 B站/网易云 这类分享卡片里其实带着标题和链接 ——
      // 丢掉之后就变成"收到卡片啦 是什么内容呀 给我看看"这种答非所问。
      // 这里尽量把可读信息抠出来。
      if (s.type === 'json' || s.type === 'xml') {
        const txt = extractCard(s);
        return txt || '[卡片消息]';
      }
      if (s.type === 'forward' || s.type === 'node') return '[聊天记录]';
      if (s.type === 'poke') return '[戳一戳]';
      if (s.type === 'reply') return '';
      // 未知类型也标出来，避免整条消息变空
      return '[' + s.type + ']';
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

  const media = segs.filter((s) => ['image', 'mface', 'marketface', 'bface'].includes(s.type));
  if (!media.length) return;

  // 用对方这句话作为这张图的"使用场景"
  // 注意：纯媒体消息（没文字）时 text 会是 "[图片]" 这类占位，不算有效场景
  const context = text && !/^\[[^\]]*\]$/.test(text.trim()) ? text : '';

  for (const seg of media) {
    const d = seg.data || {};
    const file = d.file || d.file_id || d.url || d.path || '';
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

  const media = segs.filter((s) => ['image', 'mface', 'marketface', 'bface'].includes(s.type));
  if (!media.length) return;

  const seg = media[0];   // 只处理第一张，避免拖慢
  // 不同消息段的文件字段名不一样，都试一遍
  const file = seg.data?.file || seg.data?.file_id || seg.data?.url || seg.data?.path;
  if (!file) return;

  try {
    // 和视频一样：看图也要先腾显存，否则视觉模型加载会失败
    await Vram.prepareForVision(cfg_cache.cfg || {}, log);

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
    const hist = history(key);
    if (hist && hist.length) {
      // 找到刚存进去的那条（最后一条 user）
      const last = [...hist].reverse().find((m) => m.role === 'user');
      if (last) last.content = (last.content || '') + '\n[对方发了一张图：' + desc + ']';
      saveCtx(key, hist);   // 改完要落盘，否则重启后这次识别就丢了
    }
    // 记进 sticker 库的语义
    return desc;
  } catch (e) {
    log('  👁 识别出错: ' + e.message);
  }
}

/**
 * 让对方发的视频"被看见"。
 *
 * 做法：get_file 下载 → ffmpeg 抽几帧 → 逐帧交给视觉模型 → 拼成描述。
 *
 * 重要限制（要在上下文里说清楚，否则模型会以为它真看懂了）：
 *   - 这只是抽了几帧，不知道过程，也听不到声音
 *   - 抽帧宽度必须 ≤256，512 会因内存不足失败
 */
/**
 * 取视频/文件的本地路径。
 *
 * 坑（SnowLuma 报错原文）：
 *   get_file only resolves cached image/voice ids;
 *   for group/normal files use get_group_file_url or get_private_file_url
 *
 * 也就是说 get_file 只对「图片/语音」有效，视频这类普通文件必须走
 * get_private_file_url（私聊）/ get_group_file_url（群）。NapCat 那边
 * get_file 有时也能凑合，所以这里按顺序都试一遍，谁先成功用谁。
 *
 * @returns {Promise<string|null>} 本地路径
 */
async function fetchVideoFile(bot, ev, seg, file) {
  const isGroup = ev.message_type === 'group';
  const attempts = [];

  // 视频消息段里可用的字段（SnowLuma 的 file_id 在段里叫 file）
  const fileId = seg.data?.file_id || seg.data?.file || '';
  // file_hash：SnowLuma 的说明是「必要时原样传」，
  // 段里可能叫 file_hash / hash / md5
  const fileHash = seg.data?.file_hash || seg.data?.hash || seg.data?.md5 || '';

  // ① 正路：SnowLuma 文档里写的参数是 { user_id, file_id[, file_hash] }
  if (isGroup) {
    attempts.push(['get_group_file_url', { group_id: ev.group_id, file_id: fileId }]);
    if (fileHash) attempts.push(['get_group_file_url', { group_id: ev.group_id, file_id: fileId, file_hash: fileHash }]);
  } else {
    attempts.push(['get_private_file_url', { user_id: ev.user_id, file_id: fileId }]);
    if (fileHash) attempts.push(['get_private_file_url', { user_id: ev.user_id, file_id: fileId, file_hash: fileHash }]);
  }

  // ② 有些实现用 file 而不是 file_id
  if (fileId) {
    if (isGroup) attempts.push(['get_group_file_url', { group_id: ev.group_id, file: fileId }]);
    else attempts.push(['get_private_file_url', { user_id: ev.user_id, file: fileId }]);
  }

  // ③ 兜底：get_file（对图片/语音有效，视频看后端实现）
  if (file) attempts.push(['get_file', { file }]);

  // ④ 有些实现直接给 url，那就下载
  const directUrl = seg.data?.url;

  for (const [action, params] of attempts) {
    try {
      const r = await bot.call(action, params, 120000);
      // 可能是 {file: path} 也可能是 {url: 'http://...'}
      const p = r?.file || r?.path || r?.data?.file;
      if (p && existsSync(p)) return p;
      const u = r?.url || r?.data?.url;
      if (u && /^https?:\/\//.test(u)) {
        const dl = await downloadToTemp(u, 'video');
        if (dl) return dl;
      }
    } catch (e) {
      log('  🎬 ' + action + ' 失败: ' + String(e.message || e).slice(0, 100));
    }
  }

  // ④ 最后试原始 url
  if (directUrl && /^https?:\/\//.test(directUrl)) {
    const dl = await downloadToTemp(directUrl, 'video');
    if (dl) return dl;
  }

  return null;
}

/** 下载到临时目录，返回本地路径 */
async function downloadToTemp(url, tag) {
  try {
    const dir = join(ROOT, '.video-work');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const out = join(dir, tag + '_' + Date.now() + '.mp4');
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    writeFileSync(out, buf);
    log('  🎬 已下载 ' + (buf.length / 1048576).toFixed(1) + ' MB');
    return out;
  } catch (e) {
    log('  🎬 下载失败: ' + e.message);
    return null;
  }
}

async function describeIncomingVideo(bot, ev, key) {
  if (cfg_cache.video?.enabled === false) return;
  const segs = ev.message;
  if (!Array.isArray(segs)) return;

  const seg = segs.find((s) => Video.isVideoSeg(s));
  if (!seg) return;

  const file = seg.data?.file || seg.data?.file_id || seg.data?.url;
  if (!file) return;

  try {
    log('  🎬 收到视频，正在取文件…');

    // 视觉模型要吃 ~8.5GB，而 GPT-SoVITS 常驻占约 1.5GB 显存，
    // 两个同时在场时 Ollama 必然加载失败（实测报 9.9GiB 不足）。
    // 所以识别前先让它让位 —— 8GB 显存物理上放不下两个。
    await Vram.prepareForVision(cfg_cache.cfg || {}, log);

    // 把段里的字段打出来，方便定位接口参数该怎么传
    // （SnowLuma 的 get_private_file_url 要 file_id，段里叫 file，
    //   而且"必要时传 file_hash" —— 到底有没有，看日志最快）
    log('  🎬 视频段字段: ' + JSON.stringify(seg.data || {}).slice(0, 300));

    const local = await fetchVideoFile(bot, ev, seg, file);
    if (!local) {
      log('  🎬 视频文件拿不到，跳过');
      return;
    }

    const sizeMB = (safeStatSize(local) / 1048576).toFixed(1);
    log('  🎬 已下载 ' + sizeMB + ' MB，抽帧中…');

    const { frames, duration, error } = await Video.extractFrames(local, cfg_cache.cfg || {});
    if (error) { log('  🎬 抽帧失败: ' + error); return; }
    if (!frames.length) { log('  🎬 没抽到帧'); return; }

    log('  🎬 抽到 ' + frames.length + ' 帧，识别中…');
    const { summary, parts } = await Video.describeVideo(
      frames, cfg_cache.cfg || {}, Stickers.describe, log, duration
    );
    Video.cleanupFrames(frames);

    if (!summary) { log('  🎬 帧识别都没成功'); return; }

    log('  🎬 视频内容: ' + summary.slice(0, 70));

    // —— 语音转文字 ——
    // 视频信息有一半在声音里。只有画面时它能说"一个红发女孩"，
    // 但不知道发生了什么；有了台词才谈得上"看懂"。
    // 转录不占显存（CPU 跑），所以不用参与显存仲裁。
    let asr = null;
    if (cfg_cache.asr?.enabled !== false) {
      try {
        const t0 = Date.now();
        log('  🎧 正在转写视频里的语音…');
        asr = await Asr.transcribe(local, cfg_cache.cfg || {}, log);
        if (asr.ok && asr.segments?.length) {
          log('  🎧 转写完成（' + ((Date.now() - t0) / 1000).toFixed(0) + 's，' +
              asr.segments.length + ' 段）: ' + asr.text.slice(0, 60));
        } else if (asr.ok) {
          log('  🎧 没有人声（可能是纯音乐）');
        } else {
          log('  🎧 转写失败: ' + asr.error);
        }
      } catch (e) {
        log('  🎧 转写异常: ' + e.message);
      }
    }

    // 写进上下文：画面 + 台词
    const note = Video.renderVideoNote({ duration, summary }) +
                 (asr?.ok ? Asr.renderTranscript(asr) : '');
    const hist = history(key);
    if (hist && hist.length) {
      const last = [...hist].reverse().find((m) => m.role === 'user');
      if (last) last.content = (last.content || '') + note;
      saveCtx(key, hist);
    }
    return { summary, duration, parts, asr };
  } catch (e) {
    log('  🎬 视频处理出错: ' + e.message);
  }
}

function safeStatSize(p) {
  try { return statSync(p).size; } catch { return 0; }
}

/**
 * 让对方发的语音"被听懂"。
 *
 * 实测要点（重要）：
 *   - fetch_ptt_text 只传 message_id/raw_message 会超时失败
 *   - 必须同时传 file 字段才成功
 *   - 返回 { text: "识别出的文字" }
 *   - 失败时退回 get_record 转 mp3（但没做语音识别，只能拿到音频）
 */
async function describeIncomingAudio(bot, ev, key) {
  if (cfg_cache.audio?.enabled === false) return;
  const segs = ev.message;
  if (!Array.isArray(segs)) return;

  const seg = segs.find((s) => Video.isVoiceSeg(s));
  if (!seg) return;

  const file = seg.data?.file;
  if (!file) return;

  try {
    log('  🎤 收到语音，尝试转文字…');

    // 关键：必须带 file。实测只传 message_id/raw_message 会超时失败，
    // 带上 file 就能成功。另外语音刚收到时腾讯侧可能还没处理完，
    // 所以失败要重试几次。
    let text = '';
    for (let attempt = 1; attempt <= 3 && !text; attempt++) {
      try {
        const r = await bot.call('fetch_ptt_text', { message_id: ev.message_id, file }, 30000);
        text = String(r?.text ?? r?.data?.text ?? (typeof r === 'string' ? r : '')).trim();
      } catch (e) {
        if (attempt < 3) await new Promise((res) => setTimeout(res, 1500 * attempt));
      }
      if (!text && attempt < 3) {
        log('  🎤 第 ' + attempt + ' 次失败，重试…');
        await new Promise((res) => setTimeout(res, 1500 * attempt));
      }
    }

    if (text) {
      log('  🎤 语音内容: 「' + text + '」');
      // 写进上下文：把占位的 [语音] 换成真实内容
      const hist = history(key);
      if (hist && hist.length) {
        const last = [...hist].reverse().find((m) => m.role === 'user');
        if (last) {
          last.content = String(last.content || '').replace(/\[语音\]/g, '') +
            '\n[对方发了一条语音，说：' + text + ']';
        }
        saveCtx(key, hist);
      }
      return { text };
    }

    const size = seg.data?.file_size ? Number(seg.data.file_size) : 0;
    log('  🎤 语音转文字失败（重试 3 次）' + (size ? '，音频 ' + (size / 1024).toFixed(0) + 'KB' : ''));
    return null;
  } catch (e) {
    log('  🎤 语音处理出错: ' + e.message);
  }
}

/**
 * 会话内追问：回复之后，有时再补一句。
 *
 * 为什么要做：真人聊天不是一问一答就结束，
 * 常常会追问、会分享、会接着聊。这一步让它更像真人。
 *
 * 用概率控制，避免每条都补（那样很烦）。
 * 情绪和关系会提高概率：心情好、关系熟 → 更愿意多聊。
 */
async function maybeFollowUp(bot, ev, key, emoRec, userText, reply) {
  const fc = cfg_cache.followUp || {};
  if (fc.enabled === false) return;

  // 概率基础值
  let chance = fc.chance ?? 0.3;
  if (emoRec.mood >= 75) chance += 0.15;
  if (emoRec.mood <= 35) chance -= 0.2;
  if (emoRec.intimacy >= 60) chance += 0.1;
  if (emoRec.intimacy <= 10) chance -= 0.15;
  chance = Math.max(0, Math.min(0.75, chance));

  // 冷却：同一会话短时间内不连续补
  if (!Proactive.canFollowUp(key, cfg_cache.cfg || {})) return;
  if (Math.random() > chance) return;

  try {
    const d = await Proactive.thinkFollowUp({
      persona: PERSONA,
      userText,
      reply,
      now: new Date(),
    }, cfg_cache.cfg || {});

    if (!d.follow || !d.message) {
      if (d.reason && d.reason !== 'JSON 解析失败') log('  💬 不补话（' + d.reason + '）');
      return;
    }

    // 稍微延迟一下，像真人在打字。
    //
    // 原来是 1.2~3 秒。实测下来太急了 —— 主回复发完 4 秒就追一条，
    // 连着两条消息在 QQ 里看起来像刷屏，尤其在对方还没回复的时候。
    // 真人补话通常是「想了一下才再说」，所以拉长到 4~9 秒。
    const delay = 4000 + Math.floor(Math.random() * 5000);
    log('  💬 打算补一句，等 ' + (delay / 1000).toFixed(1) + 's 再发…');
    await new Promise((r) => setTimeout(r, delay));

    // 等待期间对方可能已经回话了 —— 那就别再补，否则像在自说自话。
    // lastReplyAt 会在收到并回复新消息时被刷新，用它判断。
    const since = Date.now() - (lastReplyAt.get(key) || 0);
    if (since < delay - 500) {
      log('  💬 等待期间已经聊上了，不补话');
      return;
    }

    // 补的话也要过 sanitize —— 主回复是过滤过的，追问之前没过滤，
    // 会出现「主回复没标点、补的那句反而带标点」，语气不一致。
    const followText = sanitize(d.message, {
      isOwner: !!cfg_cache.cfg?.bot?.owner &&
               String(ev.user_id) === String(cfg_cache.cfg.bot.owner),
      ownerName: cfg_cache.cfg?.bot?.ownerName || '爸爸',
      isGroup: ev.message_type === 'group',
    });
    if (!followText) return;

    // 补的话如果和刚发的那句几乎一样，就别发了 —— 看起来像复读。
    // 出现过「主回复」和「补一句」内容雷同、只差标点的情况。
    if (isNearDuplicate(followText, reply)) {
      log('  💬 补话与上一条雷同，跳过: ' + followText.slice(0, 30));
      return;
    }

    if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, followText);
    else await bot.sendPrivate(ev.user_id, followText);

    // 补的话也要进历史，否则下一轮模型不知道它自己刚说过什么
    remember(key, 'assistant', followText, cfg_cache.cfg?.reply?.contextTurns ?? 10);

    Proactive.markFollowUp(key);
    log('  💬 补一句: ' + followText + '   [' + d.reason + ']');
  } catch (e) {
    log('  💬 补话失败: ' + e.message);
  }
}

/**
 * 并发的媒体理解 + 超时保护。
 *
 * 为什么这么做：
 *   原来三个 media 处理是串行 await。视频要下载 + 抽帧 + 逐帧识别，
 *   一卡就是几十秒，**回复被拖死甚至完全不回**（实测踩过）。
 *
 * 现在：
 *   - 三种媒体并发跑
 *   - 各自有超时，图片 25s / 语音 20s / 视频 45s
 *   - 超时或失败都不影响回复，只是这次没"看懂"
 */
// 视频在后台跑，可以给足时间；图片/语音是同步等的，要短
const MEDIA_TIMEOUT = { image: 20000, audio: 15000, video: 120000 };

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时 ' + (ms / 1000) + 's')), ms)),
  ]);
}

async function understandMedia(bot, ev, key, opt = {}) {
  const segs = Array.isArray(ev.message) ? ev.message : [];
  if (!segs.length) return;

  const hasImage = segs.some((s) => ['image', 'mface', 'marketface', 'bface'].includes(s.type));
  const hasVideo = !opt.skipVideo && segs.some((s) => Video.isVideoSeg(s));
  const hasAudio = segs.some((s) => Video.isVoiceSeg(s));

  const jobs = [];
  if (hasImage) {
    jobs.push(withTimeout(describeIncomingImages(bot, ev, key), MEDIA_TIMEOUT.image, '图片识别')
      .catch((e) => log('  ⚠️ ' + e.message + '，跳过这次看图')));
  }
  if (hasAudio) {
    jobs.push(withTimeout(describeIncomingAudio(bot, ev, key), MEDIA_TIMEOUT.audio, '语音识别')
      .catch((e) => log('  ⚠️ ' + e.message + '，跳过这次听语音')));
  }
  if (hasVideo) {
    jobs.push(withTimeout(describeIncomingVideo(bot, ev, key), MEDIA_TIMEOUT.video, '视频识别')
      .catch((e) => log('  ⚠️ ' + e.message + '，跳过这次看视频')));
  }

  if (!jobs.length) return;

  const t0 = Date.now();
  await Promise.all(jobs);
  log('  📎 媒体理解完成，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
}

/** 这条消息里有没有视频 */
function hasVideoSeg(ev) {
  const segs = Array.isArray(ev.message) ? ev.message : [];
  return segs.some((s) => Video.isVideoSeg(s));
}

/**
 * 视频理解。
 *
 * 设计演进（这段历史值得留着）：
 *
 * v1：完全后台，不挡回复。
 *     结果是回复先发出去（「视频是啥呀？我有点好奇」），
 *     84 秒后才识别完 —— 用户看到的是机器人明明在看却装作没看见。
 *
 * v2（现在）：等一下再回复。
 *     收到视频时先给个"正在看"的信号，然后等识别结果，
 *     拿到内容后连同回复一起发出去。这样它是真的在"看了再说"。
 *
 *     等待有上限（waitMs，默认 100 秒），超时就退回 v1 的行为 ——
 *     后台继续识别，先把回复发出去，总比让用户干等强。
 *
 * @returns {Promise<{summary?:string, waited:boolean, timedOut:boolean}>}
 */
const videoBusy = new Set();

async function understandVideoBeforeReply(bot, ev, key, log) {
  const vc = cfg_cache.video || {};
  if (videoBusy.has(key)) {
    log('  🎬 已有视频在处理，这次不等');
    return { waited: false, timedOut: true };
  }
  videoBusy.add(key);

  const waitMs = vc.waitMs ?? 100000;
  const t0 = Date.now();
  let summary = null;
  let timedOut = false;

  try {
    const task = describeIncomingVideo(bot, ev, key)
      .then((r) => { summary = r?.summary || null; return r; })
      .catch((e) => { log('  ⚠️ 视频识别失败: ' + e.message); return null; })
      .finally(() => videoBusy.delete(key));

    // 等，但不超过 waitMs
    const timeout = new Promise((r) => setTimeout(() => r('__TIMEOUT__'), waitMs));
    const winner = await Promise.race([task, timeout]);

    if (winner === '__TIMEOUT__') {
      timedOut = true;
      log('  🎬 识别还没完（已等 ' + ((Date.now() - t0) / 1000).toFixed(0) +
          's），先回复，识别继续在后台跑');
    } else if (summary) {
      log('  🎬 视频已理解（耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's）');
    }
  } catch (e) {
    log('  ⚠️ 视频处理异常: ' + e.message);
  }

  return { summary, waited: true, timedOut };
}

/** 缓存配置引用（供 collectStickers 使用） */
/** 配置缓存（模块级函数用它，避免拿不到 main() 里的 cfg） */
const cfg_cache = {
  stickerCollect: true,
  vision: true,
  stickers: { enabled: true, chance: 0.25, cooldownMin: 20 },
  followUp: { enabled: true, chance: 0.3 },
  video: { enabled: true, frames: 3, width: 256, maxMB: 80 },
  audio: { enabled: true },
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

  // 用 join 拼路径，再用 fileUrl 转成 OneBot 认的形式。
  // 原来是 (dir + '\\' + file).replace(/\\/g,'/') —— Linux 上必然出错：
  // STICKER_DIR 是 /home/x/stickers，加反斜杠会变成 /home/x/stickers\a.gif
  const abs = fileUrl(join(StickerDirAbs, st.file));
  try {
    const msg = [{ type: 'image', data: { file: abs } }];
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

// ---------------------------------------------------------------- 发语音

const lastVoiceAt = new Map();

/**
 * 按概率决定要不要把回复用【语音】再发一遍。
 *
 * 设计：
 *   · 原文字回复照常发（保证一定能看到内容）
 *   · 语音是「额外」补一条，像真人聊到兴头上会发条语音
 *   · 只在实际发出后才记冷却
 *
 * 保守约束（语音比文字慢、也更容易被风控）：
 *   · 默认关闭（tts.enabled = false）
 *   · 概率默认 0.15
 *   · 太短（"嗯""在"）和太长（>60字）都不发
 *   · 同一个人冷却默认 30 分钟
 *   · 需要联网（edge-tts 是微软在线服务）
 */
async function maybeSendVoice(bot, ev, emoRec, reply) {
  const tc = cfg_cache.tts || {};
  if (tc.enabled !== true) return;

  const text = String(reply || '').trim();
  if (!text) return;
  if (text.length < (tc.minChars ?? 2)) return;
  if (text.length > (tc.maxChars ?? 60)) return;

  const key = String(ev.message_type === 'group' ? 'g:' + ev.group_id : 'p:' + ev.user_id);
  const now = Date.now();
  const cd = (tc.cooldownMin ?? 30) * 60000;
  if (lastVoiceAt.has(key) && now - lastVoiceAt.get(key) < cd) return;

  let chance = tc.chance ?? 0.15;
  // 情绪加成：心情好、关系熟时更愿意"开口说话"
  if (emoRec?.mood >= 75) chance += 0.08;
  if (emoRec?.intimacy >= 60) chance += 0.07;
  if (emoRec?.mood <= 30) chance -= 0.08;
  chance = Math.max(0, Math.min(0.5, chance));

  if (Math.random() > chance) return;

  // 合成
  const t0 = Date.now();
  const r = await TTS.synthesize(text, cfg_cache);
  if (!r.ok) {
    log('  🎤 语音合成失败: ' + r.error);
    return;
  }

  // 发送：OneBot 的 record 段，NapCat 会自动转 SILK
  try {
    const msg = [{ type: 'record', data: { file: r.fileUrl } }];
    if (ev.message_type === 'group') await bot.call('send_group_msg', { group_id: ev.group_id, message: msg }, 60000);
    else await bot.call('send_private_msg', { user_id: ev.user_id, message: msg }, 60000);
    lastVoiceAt.set(key, now);
    log('  🎤 语音已发（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）: ' + text.slice(0, 30));
    try { TTS.cleanupCache(30); } catch {}
  } catch (e) {
    log('  🎤 发语音失败: ' + e.message);
  }
}

// ---------------------------------------------------------------- 联网搜索

/**
 * 决定这次要不要联网搜，以及搜什么词。
 *
 * 两种触发：
 *   1. 明确要求（「搜一下XX」「查一下XX」）—— 直接搜，不问模型，省一次调用
 *   2. 模型自主判断（AutoSearch）—— 问一次模型：这句需要实时信息吗？
 *
 * 为什么让模型判断而不是关键词硬匹配：
 *   「今天有什么新闻」该搜，「我今天好累」不该搜 —— 两者都没有"搜"字，
 *   硬匹配要么漏要么误伤。
 *
 * @returns {Promise<{need:boolean, query?:string}>}
 */
async function decideSearch(text, cfg) {
  const sc = cfg.search || {};
  if (sc.enabled !== true) return { need: false };

  // 快速路径：明确要求
  if (Search.isSearchRequest(text)) {
    const q = Search.extractQuery(text);
    if (q) return { need: true, query: q };
  }

  if (sc.autoSearch === false) return { need: false };

  // 让模型判断
  try {
    const out = await ollamaChat(Search.needSearchPrompt(text, PERSONA), {
      ...cfg,
      reply: { ...cfg.reply, maxTokens: 80, temperature: 0.2 },
    });
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (!m) return { need: false };
    const j = JSON.parse(m[0]);
    const q = String(j.query || '').trim().slice(0, 30);
    if (j.need && q) return { need: true, query: q };
  } catch (e) {
    log('  🔍 搜索判断失败: ' + e.message);
  }
  return { need: false };
}

/**
 * 执行搜索，返回给模型看的文本。失败返回 null（就当没搜，不打断对话）。
 */
async function runSearch(query, cfg) {
  const r = await Search.search(query, cfg);
  if (!r.ok) {
    log('  🔍 搜索失败（' + query + '）: ' + r.error);
    return null;
  }
  log('  🔍 已搜索「' + query + '」→ ' + r.results.length + ' 条' + (r.cached ? '（缓存）' : ''));
  return Search.format(r.results);
}

/**
 * 判断对方是不是在要求发语音。
 *
 * 和「发个空间」一样，用户说了就该真发，而不是等 15% 的随机概率 ——
 * 之前出现过用户说「你发条语音」，机器人回「我又不会变声器」的尴尬情况。
 */
function isVoiceRequest(text) {
  const s = String(text || '');
  // 提到"语音/声音/说句话"这类词
  const hasVoice = /语音|声音|声线|说句话|说一句|讲句话|开口|出声/.test(s);
  if (!hasVoice) return false;
  // 否定式不算（"你发不了语音吧"）—— 但「能发吗/可以发吗」是询问，
  // 用户问就是在要，所以不拦。
  if (/(发不了|发不出|不会发|没法发|不能发|怎么发|如何发)/.test(s)) return false;
  // 要有请求或询问意味
  return /发|打|来一|说一|讲一|整一|弄一|听听|让我听|试试|你会|你能|可以|能发/.test(s);
}

/**
 * 按对方要求发一条语音（不走随机概率）。
 *
 * @param {string} speak 要说的内容；空则由模型生成一句
 * @returns {Promise<{ok:boolean, reply:string}>}
 */
async function sendVoiceOnDemand(bot, ev, emoRec, speak) {
  const tc = cfg_cache.tts || {};
  if (tc.enabled !== true) {
    return { ok: false, reply: '我这边语音没开着呀' };
  }

  // 冷却：防连点
  const key = String(ev.message_type === 'group' ? 'g:' + ev.group_id : 'p:' + ev.user_id);
  const cd = 8000;
  const last = lastVoiceAt.get(key) || 0;
  if (Date.now() - last < cd) {
    return { ok: false, reply: '刚发过呀 等会儿再给你说' };
  }

  let text = String(speak || '').trim();
  if (!text) {
    // 没指定内容 -> 让模型说一句短的
    try {
      const sys = PERSONA + '\n\n【当前任务】对方让你发条语音。说一句简短自然的话（15 字以内），只输出要说的内容。';
      const out = await ollamaChat(
        [{ role: 'system', content: sys }, { role: 'user', content: '（发条语音）' }],
        { ...cfg_cache.cfg, reply: { ...cfg_cache.cfg.reply, maxTokens: 40 } }
      );
      text = sanitize(out, {
        isOwner: !!cfg_cache.cfg?.bot?.owner &&
                 String(ev.user_id) === String(cfg_cache.cfg.bot.owner),
        ownerName: cfg_cache.cfg?.bot?.ownerName || '爸爸',
        isGroup: ev.message_type === 'group',
      });
    } catch (e) {
      return { ok: false, reply: '我想不出说什么呀' };
    }
  }
  if (!text) return { ok: false, reply: '我想不出说什么呀' };

  // 太长的截断（语音合成慢）
  const maxChars = tc.maxChars ?? 60;
  if (text.length > maxChars) text = text.slice(0, maxChars);

  const t0 = Date.now();
  const r = await TTS.synthesize(text, cfg_cache.cfg);
  if (!r.ok) {
    log('  🎤 按需发语音失败: ' + r.error);
    return { ok: false, reply: '我这边声音出了点问题呀 晚点再试' };
  }

  try {
    const msg = [{ type: 'record', data: { file: r.fileUrl } }];
    if (ev.message_type === 'group') await bot.call('send_group_msg', { group_id: ev.group_id, message: msg }, 60000);
    else await bot.call('send_private_msg', { user_id: ev.user_id, message: msg }, 60000);
    lastVoiceAt.set(key, Date.now());
    log('  🎤 按需语音已发（' + ((Date.now() - t0) / 1000).toFixed(1) + 's, ' + r.engine + '）: ' + text);
    try { TTS.cleanupCache(30); } catch {}
    return { ok: true, reply: '' };   // 语音本身就是回复，不用再打字
  } catch (e) {
    log('  🎤 按需发语音失败: ' + e.message);
    return { ok: false, reply: '发出去好像失败了呀' };
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

/** 上次回复时间：key -> 时间戳（用于 reply.cooldownMs 限速，防群聊刷屏） */
const lastReplyAt = new Map();

/**
 * 已处理过的消息 id（去重用）。
 * OneBot 正常不会重复推送，但适配器重连、多个后端同时在线时可能重复，
 * 表现就是同一句话被回两遍。用 message_id 兜一层。
 *
 * 注意：这个 Set 只在【本进程内】有效。如果同时跑了两个 bridge，
 * 它们各有各的 Set，去重就不起作用了 —— 那种情况由下面的
 * 单实例锁（acquireSingleInstanceLock）在启动阶段直接拦住。
 */
const seenMessageIds = new Set();

// ---------------------------------------------------------------- 单实例锁
//
// 为什么需要：曾出现过 3 个 bridge 同时连 3001，结果同一条消息被回 3 次，
// 而且每条的措辞还不一样（各自独立调模型），看起来就像机器人在胡言乱语。
//
// 做法：启动时独占创建一个锁文件，写入自己的 pid。
//   · 创建成功 -> 说明没有别的实例，继续启动
//   · 创建失败 -> 读锁文件里的 pid
//       - 该进程还活着  -> 拒绝启动（真的重复了）
//       - 该进程已不存在 -> 说明是上次崩溃留下的僵尸锁，抢占重写
//
// 进程正常退出时会删掉锁文件；被强杀（Stop-Process -Force）则删不掉，
// 所以必须有上面「检查 pid 是否还活着」的兜底，否则一次强杀就再也起不来了。
const LOCK_FILE = join(ROOT, '.bridge.lock');

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);   // 信号 0：只探测存在性，不真的发信号
    return true;
  } catch (e) {
    return e.code === 'EPERM';   // 存在但没权限 -> 也算活着
  }
}

/**
 * 尝试取得单实例锁
 * @returns {{ok:boolean, otherPid?:number}}
 */
export function acquireSingleInstanceLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim();
      const otherPid = parseInt(raw, 10);
      if (Number.isFinite(otherPid) && otherPid !== process.pid && isPidAlive(otherPid)) {
        return { ok: false, otherPid };
      }
      // 僵尸锁：进程没了，抢占
      log('发现残留锁（pid ' + raw + ' 已不存在），接管。');
    }
    writeFileSync(LOCK_FILE, String(process.pid));
    return { ok: true };
  } catch (e) {
    // 锁文件不可写等异常：不让它挡住启动，只提醒
    log('⚠️ 单实例锁异常（继续启动）: ' + e.message);
    return { ok: true };
  }
}

/** 释放锁（只在还是自己的时候删） */
export function releaseSingleInstanceLock() {
  try {
    if (!existsSync(LOCK_FILE)) return;
    const raw = readFileSync(LOCK_FILE, 'utf8').trim();
    if (String(process.pid) === raw) unlinkSync(LOCK_FILE);
  } catch {}
}

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
        // 关键：排除自己。
        // 注意 QQ 允许"自己加自己为好友"，所以自己会出现在好友列表里。
        // bot.selfId 在连接刚建立时可能还是 null，这里现取一次做双保险。
        let selfId = bot.selfId;
        if (!selfId) {
          try {
            const me = await bot.call('get_login_info');
            selfId = me?.user_id;
            if (selfId) bot.selfId = selfId;
          } catch {}
        }
        const selfStr = selfId != null ? String(selfId) : null;
        friends = (list || [])
          .map((f) => String(f.user_id))
          .filter((id) => selfStr === null || id !== selfStr);
        if (selfStr !== null && (list || []).some((f) => String(f.user_id) === selfStr)) {
          log('主动聊天：已从好友列表排除自己（' + selfStr + '）');
        }
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
      const hist = history(key).slice(-6)
        .map((m) => (m.role === 'user' ? '对方' : '你') + '：' + m.content)
        .join('\n');

      let message = '';
      let reason = '';

      if (cfg.proactive.thinkBeforeSend) {
        const d = await Proactive.thinkWhetherToSpeak({
          persona: PERSONA,
          about: renderMemory(rec, cfg, target),
          recent: hist,
          now: new Date(),
        }, cfg);
        if (!d.speak) {
          log('💭 主动聊天：决定不说（' + d.reason + '）');
          return;
        }
        message = sanitize(d.message, {
          isOwner: !!cfg.bot?.owner && String(target) === String(cfg.bot.owner),
          ownerName: cfg.bot?.ownerName || '爸爸',
          isGroup: false,
        });
        reason = d.reason;
      } else {
        // 不走思考：直接让模型基于记忆生成一句
        const msgs = [
          { role: 'system', content: PERSONA + renderMemory(rec, cfg, target) },
          { role: 'user', content: '（现在没人跟你说话。你主动开个话题，说一句简短自然的话。只输出要发的内容。）' },
        ];
        message = sanitize(await ollamaChat(msgs, cfg), {
          isOwner: !!cfg.bot?.owner && String(target) === String(cfg.bot.owner),
          ownerName: cfg.bot?.ownerName || '爸爸',
          isGroup: false,
        });
        reason = '直接生成';
      }

      if (!message) {
        log('💭 主动聊天：生成内容为空，跳过');
        return;
      }

      await bot.sendPrivate(target, message);

      // ★ 必须把它自己说过的话记进历史 ★
      //
      // 之前漏了这一步，导致"前言不搭后语"：
      //   机器人主动说「刚看到个视频笑死 你睡觉了没」
      //   用户回「没有，下午三点我睡什么觉」
      //   下一轮模型看不到自己问过什么 → 反过来说"你咋突然问这个"
      remember(key, 'assistant', message, cfg.reply.contextTurns);

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

// ---------------------------------------------------------------- QQ 空间

// ---------------------------------------------------------------- B站主动分享

/**
 * B 站"刷到好玩的就聊"调度器。
 *
 * 和主动聊天的区别：
 *   主动聊天是"想起来就找你说句话"（无素材）
 *   这个是"看到个视频，想跟你说"（有具体素材）
 *
 * 约束（避免变成刷屏机）：
 *   · 默认关闭，要显式开 bili.proactiveShare
 *   · 每天上限 + 最小间隔
 *   · 每次看热门时只有 shareChance 概率真的发
 *   · 安静时段不发
 *   · 只对主人发（和主动聊天保持一致，不骚扰别人）
 */
const BILI_STATE_FILE = join(ROOT, 'bili', 'state.json');

function loadBiliState() {
  try {
    if (!existsSync(BILI_STATE_FILE)) return { history: [] };
    return JSON.parse(readFileSync(BILI_STATE_FILE, 'utf8'));
  } catch { return { history: [] }; }
}
function saveBiliState(st) {
  try {
    const dir = join(ROOT, 'bili');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BILI_STATE_FILE, JSON.stringify(st, null, 2));
  } catch {}
}

function startBiliShare(bot, cfg) {
  const bc = cfg.bili || {};
  if (bc.enabled !== true || bc.proactiveShare !== true) return;

  const owner = cfg.bot?.owner;
  if (!owner) {
    log('B站分享：未配置 bot.owner，不知道该发给谁，跳过');
    return;
  }

  log('B站分享：已开启，每 ' + (bc.checkEveryMin ?? 120) + ' 分钟看一次热门，' +
      '概率 ' + Math.round((bc.shareChance ?? 0.25) * 100) + '%，' +
      '每天最多 ' + (bc.maxSharePerDay ?? 2) + ' 条');

  const tick = async () => {
    try {
      const h = new Date().getHours();
      if (h >= (bc.quietStart ?? 1) && h < (bc.quietEnd ?? 8)) return;

      const st = loadBiliState();
      const today = st.history.filter((x) => x.at >= new Date().setHours(0, 0, 0, 0));
      if (today.length >= (bc.maxSharePerDay ?? 2)) return;

      const last = st.history[st.history.length - 1];
      if (last && Date.now() - last.at < (bc.minGapHours ?? 6) * 3600000) return;

      if (Math.random() > (bc.shareChance ?? 0.25)) return;

      const pop = await Bili.popular(cfg);
      if (!pop.ok || !pop.videos.length) {
        log('B站分享：拿热门失败 ' + (pop.error || ''));
        return;
      }

      const seen = new Set(st.history.map((x) => x.bvid));
      const fresh = pop.videos.filter((v) => v.bvid && !seen.has(v.bvid));
      if (!fresh.length) return;

      const pick = await Bili.thinkShare({
        persona: PERSONA,
        videos: fresh,
        history: st.history.slice(-5),
        // 复用主模型调用；thinkShare 需要 (messages, opts) 形态
        chat: (messages, opt = {}) => ollamaChat(messages, {
          ...cfg,
          reply: {
            ...cfg.reply,
            maxTokens: opt.numPredict ?? 200,
            temperature: opt.temperature ?? 0.9,
          },
        }),
      }, cfg);
      if (!pick || !pick.message) return;

      // 挑中的那个视频。
      //
      // 坑：模型返回的 bvid 经常对不上（少一位、大小写错），
      // 直接 find 会失败并退到 fresh[0]，结果文字说 A、链接给 B。
      // 所以按 bvid → 标题 → 编号 三级兜底，标题匹配用去标点后的包含关系。
      const norm = (s) => String(s || '')
        .replace(/[《》【】\[\]（）()\s·:：,，.。!！?？\-_|]/g, '');
      const byBvid = fresh.find((v) => v.bvid && pick.bvid &&
                                    v.bvid.toLowerCase() === String(pick.bvid).toLowerCase());
      let byTitle = null;
      if (!byBvid) {
        const t = norm(pick.title || pick.message);
        if (t) {
          byTitle = fresh.find((v) => {
            const vt = norm(v.title);
            if (!vt) return false;
            // 双向包含：标题被提到，或提到的那段属于标题
            if (t.includes(vt) || vt.includes(t)) return true;
            // 再退一步：标题前 8 个字出现过
            const core = vt.slice(0, 8);
            return core.length >= 4 && t.includes(core);
          });
        }
      }
      const byIndex = (!byBvid && !byTitle && Number.isInteger(pick.index) && pick.index >= 0)
        ? fresh[pick.index] : null;
      const picked = byBvid || byTitle || byIndex || fresh[0];

      if (!byBvid) {
        log('  ⚠️ bvid 没对上（模型给的是 ' + (pick.bvid || '空') + '），' +
            (byTitle ? '按标题匹配到「' + picked.title.slice(0, 20) + '」'
             : byIndex ? '按编号匹配到「' + picked.title.slice(0, 20) + '」'
             : '⚠️ 都没匹配上，退到第一条「' + picked.title.slice(0, 20) + '」'));
      }

      // —— 发送：文字 + 链接分两条 ——
      // 只发标题对方还得自己去搜，不算分享。分两条发是因为：
      //   · 文字和链接混在一条里，QQ 的链接预览会把文字挤没
      //   · 先说一句、再甩链接，更像真人分享的习惯
      let outMsg = pick.message;

      // 兜底保险：如果连标题都没匹配上（说明模型记错了/编了标题），
      // 那句文字里提到的视频多半是它自己发挥的，直接发会配错链接。
      // 这种情况把话换成一句不指名的，保证"说什么就发什么"。
      if (!byBvid && !byTitle && !byIndex) {
        outMsg = '欸 B站首页有个视频看着挺有意思的';
        log('  ⚠️ 匹配全失败，文字改为不指名的说法，避免文不对图');
      }

      await bot.sendPrivate(owner, outMsg);
      if (picked.url) {
        await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
        await bot.sendPrivate(owner, picked.url);
      }

      st.history = [...st.history, {
        at: Date.now(), bvid: picked.bvid,
        title: picked.title,
        message: outMsg,
      }].slice(-100);
      saveBiliState(st);
      log('📺 主动分享 B 站: ' + outMsg + '  →  ' + picked.url +
          '   [' + (pick.reason || '') + ']');
    } catch (e) {
      log('B站分享出错：' + e.message);
    }
  };

  setTimeout(tick, 5 * 60000);   // 启动 5 分钟后第一次
  setInterval(tick, (bc.checkEveryMin ?? 120) * 60000);
}

// ---------------------------------------------------------------- QQ 空间

/** QQ空间的运行时句柄（startQzone 里填充），供消息处理里的「按需发布」使用 */
const qzoneRuntime = { ready: false, chat: null, getCred: null };

function startQzone(bot, cfg) {
  const q = cfg.qzone || {};
  if (!q.enabled) {
    log('QQ空间：未开启（config.json 的 qzone.enabled）');
    return;
  }

  log('QQ空间：已开启，每天最多 ' + q.maxPerDay + ' 条，活跃时段 ' +
      q.activeStart + '-' + q.activeEnd + ' 点');

  // 统一的模型调用（复用 ollamaChat）
  const chat = (messages, opt = {}) => ollamaChat(messages, {
    ...cfg,
    reply: {
      ...cfg.reply,
      maxTokens: opt.numPredict ?? cfg.reply.maxTokens,
      temperature: opt.temperature ?? cfg.reply.temperature,
    },
  });

  // 从 OneBot 拿 QQ空间凭证
  // 注意：本项目的 bot.call() 已经把 ev.data 解包后返回，
  //      所以 r 直接就是 { cookies: "..." }，没有 r.status / r.data 外层。
  //      这里两种格式都兼容，避免换实现时又踩坑。
  const getCred = async () => {
    const r = await bot.call('get_cookies', { domain: 'user.qzone.qq.com' });
    const cookieStr = r?.cookies || r?.data?.cookies;
    if (!cookieStr) {
      const why = r?.message || r?.wording || (r ? JSON.stringify(r).slice(0, 120) : '无返回');
      throw new Error('拿不到 QQ空间凭证: ' + why);
    }
    const { parseCookies, calcBkn } = await import('./qzone-api.mjs');
    const ck = parseCookies(cookieStr);
    const pSkey = ck.p_skey || ck.skey || '';
    return {
      raw: cookieStr,
      uin: (ck.uin || '').replace(/^o/, ''),
      pSkey,
      g_tk: calcBkn(pSkey),
    };
  };

  const tick = async () => {
    try {
      await Qzone.maybePublish({ chat, cfg, log, getCred });
    } catch (e) {
      log('QQ空间出错：' + e.message);
    }
  };

  // 把句柄暴露出去，消息处理里「按需发布」要用
  qzoneRuntime.ready = true;
  qzoneRuntime.chat = chat;
  qzoneRuntime.getCred = getCred;

  // 首次延迟 3 分钟（等桥接稳定），之后按配置间隔检查
  const everyMs = (q.checkEveryMin || 60) * 60000;
  setTimeout(tick, 3 * 60000);
  setInterval(tick, everyMs);
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
    this.seen = new Set();   // 已处理的消息 id，用于去重
    this.echo = 0;
    this.retry = 0;
  }

  on(action, fn) { this.handlers.set(action, fn); }

  /** 正向 WS：主动连 NapCat */
  connectForward() {
    const url = this.cfg.onebot.url;
    log('正在连接 OneBot（正向）: ' + url);
    this.#open(url, () => {
      log('已连接。等待 OneBot 推送消息…');
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
      // 去重：NapCat 偶尔会重复推送同一条
      const mid = ev.message_id;
      if (mid !== undefined && this.seen.has(mid)) return;
      if (mid !== undefined) {
        this.seen.add(mid);
        if (this.seen.size > 500) {
          // 只留最近的，避免无限增长
          const arr = [...this.seen].slice(-300);
          this.seen = new Set(arr);
        }
      }

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

  /**
   * 发送私聊。
   *
   * 诊断：这里统一记一条日志，带调用来源。
   * 起因是出现过「同一句话发两遍」（一条带标点、一条不带），
   * 需要区分是模型真的生成了两条，还是同一段代码走了两条路径。
   * caller 从调用栈里取，不用调用方传参。
   */
  sendPrivate(userId, text) {
    log('  → 私聊 ' + userId + ' [sendPrivate/' + callerTag() + ']: ' + String(text).slice(0, 40));
    return this.call('send_private_msg', { user_id: userId, message: text });
  }

  sendGroup(groupId, text) {
    log('  → 群 ' + groupId + ' [sendGroup/' + callerTag() + ']: ' + String(text).slice(0, 40));
    return this.call('send_group_msg', { group_id: groupId, message: text });
  }
}

/** 从调用栈里找出第一个非 bridge 内部的调用者名字，用于诊断重复发送 */
function callerTag() {
  const st = new Error().stack || '';
  const lines = st.split('\n').slice(1);
  for (const ln of lines) {
    // 匹配 "at xxx (file:line:col)" 或 "at file:line:col"
    const m = /\s+at\s+(?:([^\s(]+)\s+\()?([^)]+):(\d+):(\d+)\)?/.exec(ln);
    if (!m) continue;
    const fn = m[1] || '(anon)';
    const line = m[3];
    // 跳过 OneBot 类自己的方法
    if (fn === 'sendPrivate' || fn === 'sendGroup' || fn === 'callerTag') continue;
    return fn + '@' + line;
  }
  return '?';
}

/**
 * 判断两句话是否「几乎是同一句」。
 *
 * 用途：追问功能有时会生成和主回复几乎一样的句子（只差标点/空格），
 * 发出去就像复读机。
 *
 * 做法：去掉所有标点、空白、常见语气词后比较。
 * 归一化后相等 → 重复；否则算长度相近的包含关系。
 */
function isNearDuplicate(a, b) {
  const norm = (s) => String(s || '')
    .replace(/[\s，,。.！!？?、~～…·:：;；"'「」『』()（）]/g, '')
    .replace(/[呀啊呢吧啦嘛哦喔诶哎嗯哈]+$/g, '');
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 短句包含长句的大部分内容，也视为重复
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 6 && long.includes(short)) return true;
  return false;
}

// ---------------------------------------------------------------- 主流程

const DRY = process.argv.includes('--dry-run');

async function main() {
  const cfg = loadConfig();
  const bot = new OneBot(cfg);

  // —— 单实例锁 ——
  // 必须在连接 OneBot 之前挡住重复实例，否则两个进程都连上去，
  // 同一条消息会被回复两次（各自独立生成，措辞还不一样）。
  // dry-run 不需要锁（它不连 OneBot）。
  if (!DRY) {
    const lock = acquireSingleInstanceLock();
    if (!lock.ok) {
      log('='.repeat(56));
      log('❌ 已经有一个机器人在运行（PID ' + lock.otherPid + '），不再启动第二个。');
      log('');
      log('   两个机器人同时连同一个 QQ，会把每条消息回复两遍。');
      log('');
      log('   想重启的话：');
      log('     1. 先关掉正在运行的那个窗口（或结束 PID ' + lock.otherPid + '）');
      log('     2. 再运行本程序');
      log('='.repeat(56));
      process.exit(1);
    }
    // 退出时释放锁，避免留下僵尸锁
    const bye = () => { releaseSingleInstanceLock(); };
    process.on('exit', bye);
    process.on('SIGINT', () => { bye(); process.exit(0); });
    process.on('SIGTERM', () => { bye(); process.exit(0); });
  }

  // 把配置接进模块级缓存
  // ⚠️ 新增配置段时一定要在这里补一行 —— maybeSendVoice / sendVoiceOnDemand
  // 读的是 cfg_cache.tts，漏了这行它们就永远认为功能没开（真出过这个 bug：
  // 启动日志显示"发语音已开启"，但用户说"发条语音"时它回"我这边语音没开着呀"）。
  cfg_cache.stickerCollect = cfg.stickers?.enabled !== false;
  cfg_cache.stickers = cfg.stickers || {};
  cfg_cache.vision = cfg.vision?.enabled !== false;
  cfg_cache.followUp = cfg.followUp || {};
  cfg_cache.video = cfg.video || {};
  cfg_cache.audio = cfg.audio || {};
  cfg_cache.qzone = cfg.qzone || {};
  cfg_cache.tts = cfg.tts || {};
  cfg_cache.search = cfg.search || {};
  cfg_cache.douyin = cfg.douyin || {};
  cfg_cache.bili = cfg.bili || {};
  cfg_cache.vram = cfg.vram || {};
  cfg_cache.asr = cfg.asr || {};
  cfg_cache.cfg = cfg;

  log('='.repeat(56));
  log('QQ ↔ 本地模型桥 启动');
  log('平台: ' + platformLabel() + '   根目录: ' + ROOT);
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

    // —— 消息去重 ——
    // 出现过「同一句话被处理两次」的现象（一条带标点、一条不带）。
    // OneBot 的消息都带 message_id，同一 id 重复推送就只处理一次。
    // 这既能挡掉适配器的重复推送，也能防止重连后重放旧消息。
    if (ev.message_id !== undefined && ev.message_id !== null) {
      const mid = String(ev.message_id);
      if (seenMessageIds.has(mid)) {
        log('  ⏭ 重复消息已跳过 (message_id=' + mid + '): ' + String(text).slice(0, 30));
        return;
      }
      seenMessageIds.add(mid);
      // 只保留最近 500 个 id，避免长期运行内存涨
      if (seenMessageIds.size > 500) {
        const first = seenMessageIds.values().next().value;
        seenMessageIds.delete(first);
      }
    }

    log('  ← 收到 [' + (ev.message_type === 'group' ? '群' + ev.group_id : '私聊') + '] ' +
        (ev.sender?.card || ev.sender?.nickname || ev.user_id) + ' (mid=' + ev.message_id + ')');

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

    // —— 媒体理解：图片 / 语音（快，同步等）——
    //
    // 实测踩过的坑：原来把视频也串行 await，视频要下载+抽帧+逐帧识别，
    // 一卡就是几十秒，**回复被拖死甚至完全不回**。
    //
    // 现在分两档：
    //   - 图片(≤1s)、语音(≤2s)：同步等，这样回复时就能用上内容
    //   - 视频(几十秒)：等一下再回复（见下面），有超时兜底
    if (hasVideoSeg(ev)) {
      log('  🎬 消息段含视频: ' + JSON.stringify(
        (Array.isArray(ev.message) ? ev.message : []).map((s) => s.type)
      ));
    }
    await understandMedia(bot, ev, key, { skipVideo: true });

    // 视频：等一下，识别完再回复。
    //
    // v1 是纯后台（先回复、结果留到下一轮），实测体验很差：
    // 用户发了视频，机器人回「视频是啥呀？我有点好奇」，
    // 84 秒后才识别完 —— 明明在看却装作没看见。
    // 现在改成等（有上限），拿到内容一起回复。超时再退回旧行为。
    if (cfg.video?.enabled !== false && hasVideoSeg(ev)) {
      log('  🎬 检测到视频段，等识别完再回复（最多 ' +
          ((cfg_cache.video?.waitMs ?? 100000) / 1000).toFixed(0) + 's）');
      const vr = await understandVideoBeforeReply(bot, ev, key, log);
      if (!vr.summary) {
        // 没等到结果：告诉模型"你还在看"，先应一声
        try {
          const hist = history(key);
          if (hist && hist.length) {
            const last = [...hist].reverse().find((m) => m.role === 'user');
            if (last && !/\[对方发了一段视频/.test(String(last.content || ''))) {
              last.content = String(last.content || '') +
                '\n[对方发了一段视频，你还在看，可以先应一声]';
            }
          }
        } catch {}
      }
    }

    // —— 情绪更新：分析这条消息对心情/亲密度的影响 ——
    try {
      const e0 = Emo.load(key);
      Emo.applyInteraction(e0, text, cfg);
      Emo.save(e0);
    } catch (e) { /* 情绪失败不影响主流程 */ }

    if (!shouldReply(ev, cfg, bot.selfId)) return;

    // —— 回复冷却 ——
    // 群聊全开后，如果不限速，群里每句话都会立刻被回复，很容易刷屏被踢。
    // cooldownMs 之前只是个没被使用的配置项，这里真正接上：
    //   · 同一个人（私聊）或同一个群（群聊）在冷却期内的消息不再回复
    //   · 冷却只影响"回不回"，消息仍会进历史，所以上下文不会断
    {
      const cdMs = cfg.reply?.cooldownMs ?? 0;
      if (cdMs > 0) {
        const now = Date.now();
        const last = lastReplyAt.get(key) || 0;
        if (now - last < cdMs) {
          log('  （冷却中，跳过回复，距上次 ' + ((now - last) / 1000).toFixed(1) + 's）');
          return;
        }
      }
    }

    // —— 按需发语音 ——
    // 用户说「你发条语音」「说句话听听」时，真的发一条语音条。
    // 之前没有这个分支，机器人只会打字拒绝（"我又不会变声器"），很尴尬。
    if (isVoiceRequest(text)) {
      lastReplyAt.set(key, Date.now());
      log('收到 [' + (ev.message_type === 'group' ? '群' + ev.group_id : '私聊') + '] ' +
          (ev.sender?.card || ev.sender?.nickname || ev.user_id) + ' 要求发语音: ' + text);

      const emoRec = Emo.load(key);
      // 把"发条语音说我今天很开心"里的内容部分抠出来当台词
      const speak = text
        .replace(/你|帮我|给我|能不能|可以|一下|一条|一个|呗|吧|呀|啊/g, ' ')
        .replace(/发|来|说|讲|整|弄|试试|听听|让我听|语音|声音|声线|句话|一句/g, ' ')
        .replace(/[，,。！!？?、\s]+/g, ' ').trim();

      const r = await sendVoiceOnDemand(bot, ev, emoRec, speak.length >= 2 ? speak : '');
      if (!r.ok && r.reply) {
        remember(key, 'assistant', r.reply, cfg.reply.contextTurns);
        if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, r.reply);
        else await bot.sendPrivate(ev.user_id, r.reply);
        log('  回复: ' + r.reply);
      }
      return;
    }

    // —— 按需发空间 ——
    // 用户说「发个空间」「帮我发条说说」时，真的发一条（不是只答应）。
    // 放在冷却之后，避免和普通回复抢。
    if (Qzone.isPublishRequest(text)) {
      lastReplyAt.set(key, Date.now());   // 占一次冷却，避免紧接着又回一条
      const who0 = ev.sender?.card || ev.sender?.nickname || ev.user_id;
      log('收到 [' + (ev.message_type === 'group' ? '群' + ev.group_id : '私聊') + '] ' + who0 +
          ' 要求发空间: ' + text);

      if (!qzoneRuntime.ready) {
        const msg = '我这边空间功能没开着呀';
        if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, msg);
        else await bot.sendPrivate(ev.user_id, msg);
        return;
      }

      let reply;
      try {
        const r = await Qzone.publishOnDemand({
          chat: qzoneRuntime.chat,
          cfg,
          log,
          getCred: qzoneRuntime.getCred,
          request: Qzone.extractRequest(text),
        });
        reply = r.reply;
      } catch (e) {
        log('  按需发空间出错: ' + e.message);
        reply = '刚才发的时候出了点问题呀，等会儿再试试';
      }

      remember(key, 'assistant', reply, cfg.reply.contextTurns);
      if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, reply);
      else await bot.sendPrivate(ev.user_id, reply);
      log('  回复: ' + reply);
      return;
    }

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
      let systemPrompt = PERSONA + renderMemory(rec, cfg, ev.user_id) +
        (cfg.emotion?.enabled !== false ? Emo.render(emoRec) : '');

      // —— 联网搜索 ——
      // 需要实时信息时先搜，把结果塞进 system prompt 再让模型回答。
      // 这样模型说的是真实查到的内容，不是编的。
      let searchNote = '';
      if (cfg.search?.enabled === true) {
        const d = await decideSearch(text, cfg);
        if (d.need && d.query) {
          const ctx = await runSearch(d.query, cfg);
          if (ctx) {
            systemPrompt += '\n\n【联网搜到的资料（刚查的，可以用）】\n' + ctx +
              '\n\n（这是真实搜索结果。用它来回答，但别念标题、别说"根据搜索结果"，' +
              '像自己知道一样自然说出来。资料里没有的就别编。）';
            searchNote = d.query;
          }
        }
      }

      // —— 抖音链接 ——
      // 抖音反爬是字节码级的（实测：视频页只返回空壳 JS，
      // oembed 返回空 body，第三方 API 已失效），只能尽力从分享页取标题。
      // 取到就写进上下文当谈资；取不到就把真实情况告诉模型，
      // 让它自然地说"打不开"，并提示对方直接发视频文件过来 ——
      // 后者是可靠的，本地视频能力是通的。
      if (cfg.douyin?.enabled !== false) {
        const dyLink = Douyin.findDouyinLink(text);
        if (dyLink) {
          log('  📱 检测到抖音链接: ' + dyLink.slice(0, 50));
          const dy = await Douyin.parse(dyLink, cfg);
          if (dy.ok) {
            log('  📱 拿到文案: ' + String(dy.title).slice(0, 50));
            systemPrompt += '\n\n【对方发的抖音，你看到的信息】\n' +
              String(dy.title).slice(0, 300) +
              '\n\n（这是从抖音分享页拿到的真实文案。围绕它自然聊，别说是"抓取"来的。）';
          } else {
            log('  📱 拿不到文案: ' + (dy.error || ''));
            systemPrompt += '\n\n【对方发了个抖音链接，但你打不开】\n' +
              '（真实原因：抖音的反爬挡住了，你只能拿到标题，这次连标题都没拿到。）\n' +
              '你要坦率说打不开 —— 别说"我看过了"，那是撒谎。\n' +
              '可以顺口说一句：你直接把视频下下来发我，我能看。';
          }
        }
      }

      // —— B 站 ——
      // B 站有正规开放 API（实测 code:0 直连可用），所以这里是真的能拿到数据。
      // 两种触发：① 消息里有 B 站链接/BV号 ② 明确问 B 站热门/排行
      if (cfg.bili?.enabled === true) {
        // 先说一个已知的死路：QQ 小程序分享卡片。
        // 它的链接是 m.q.qq.com/a/s/xxx，页面里只有小程序图标，
        // 真实视频地址要打开 QQ 小程序才有 —— 网页端拿不到（实测）。
        // 所以别让模型猜，直接告诉它该怎么回。
        if (/m\.q\.qq\.com/.test(text)) {
          log('  📺 收到 QQ 小程序卡片（网页端拿不到内容）');
          systemPrompt += '\n\n【对方发的是 QQ 小程序分享卡片】\n' +
            '（真实情况：这种卡片的内容锁在 QQ 小程序里，你打不开，' +
            '不是你的问题，是链接形式的问题。）\n' +
            '你要说清楚：小程序卡片你看不了，请对方改用「复制链接」的方式 ——\n' +
            '「你在B站里点分享 → 复制链接，把那个 b23.tv 的链接发我，我就能看了」。\n' +
            '语气自然点，像在教人怎么弄，别像报错。';
        }

        const bl = Bili.findBiliLink(text);
        if (bl) {
          log('  📺 检测到 B 站链接: ' + bl.type + ' ' + bl.id);
          let info = null;
          if (bl.type === 'bvid') {
            info = await Bili.videoInfo(bl.id, cfg);
          } else if (bl.type === 'short') {
            // b23.tv 短链要先跳转才知道是哪个视频
            const bv = await Bili.resolveShort(bl.id, cfg);
            log('  📺 短链解析 → ' + (bv || '失败'));
            if (bv && /^BV/.test(bv)) info = await Bili.videoInfo(bv, cfg);
          }
          if (info && info.ok) {
            log('  📺 拿到视频信息: ' + info.video.title.slice(0, 40));
            systemPrompt += '\n\n【对方发的 B 站视频，你查到的真实信息】\n' +
              '标题：' + info.video.title + '\n' +
              'UP主：' + info.video.up + '\n' +
              '播放：' + info.video.views + '   时长：' + info.video.duration + '\n' +
              (info.video.desc ? '简介：' + info.video.desc + '\n' : '') +
              '\n（这些是真实数据。可以聊标题和简介的内容，但你**没看过视频本身**，' +
              '所以别评论"里面讲了什么"这种只有看过才知道的事。）';
          } else {
            systemPrompt += '\n\n【对方发了个 B 站链接】\n' +
              '（你没取到详细信息。）可以说你打不开/没查到，别编内容。';
          }
        } else if (Bili.isBiliRequest(text)) {
          log('  📺 有人在问 B 站内容');
          const pop = await Bili.popular(cfg);
          if (pop.ok && pop.videos.length) {
            log('  📺 热门拿到 ' + pop.videos.length + ' 条');
            systemPrompt += '\n\n【B 站当前热门，你刚查到的真实数据】\n' +
              Bili.formatVideos(pop.videos) +
              '\n\n【对应的链接（要发给对方的话就用这些，原样贴，别改）】\n' +
              pop.videos.map((v, i) => (i + 1) + '. ' + v.url).join('\n') +
              '\n\n（这是真实的 B 站热门列表。挑一两个自然地说说，' +
              '比如哪个有意思、谁播放高。别念列表，别说是"查到的"，像自己刚刷到一样。' +
              '对方感兴趣的话，**把对应链接一起发给他**（单独一行贴 URL，别改链接）。' +
              '但你只是看到了标题和播放量，**没看过视频内容** —— 别编里面讲了什么。）';
          } else {
            log('  📺 热门没拿到: ' + (pop.error || ''));
          }
        }
      }

      // 取上下文：不包括"刚存进去的这条"（下面会单独作为 user 消息传入）
      //
      // 原来写的是 slice(0, -1)，假设"最后一条一定是刚存的 text"。
      // 但这个假设不牢：媒体识别会改写历史条目，并发消息也可能插进来，
      // 一旦假设不成立就会【误删一条真实对话】，表现为模型失忆。
      // 现在改成从尾部找到那条内容相同的再排除，更稳。
      const ctxHist = history(key).slice();
      if (
        ctxHist.length &&
        ctxHist[ctxHist.length - 1].role === 'user' &&
        ctxHist[ctxHist.length - 1].content === text
      ) {
        ctxHist.pop();
      } else {
        // 兜底：从尾部往前找第一条内容匹配的（媒体识别可能给它加了后缀）
        for (let i = ctxHist.length - 1; i >= Math.max(0, ctxHist.length - 4); i--) {
          if (ctxHist[i].role === 'user' && String(ctxHist[i].content || '').startsWith(text)) {
            ctxHist.splice(i, 1);
            break;
          }
        }
      }

      const msgs = [
        { role: 'system', content: systemPrompt },
        ...ctxHist,
        { role: 'user', content: text },
      ];
      const raw = await ollamaChat(msgs, cfg);
      const reply = sanitize(raw, {
        isOwner: !!cfg.bot?.owner && String(ev.user_id) === String(cfg.bot.owner),
        ownerName: cfg.bot?.ownerName || '爸爸',
        isGroup: ev.message_type === 'group',
      });
      if (!reply) return void log('  模型输出为空，跳过');

      remember(key, 'assistant', reply, cfg.reply.contextTurns);

      if (ev.message_type === 'group') await bot.sendGroup(ev.group_id, reply);
      else await bot.sendPrivate(ev.user_id, reply);
      log('  回复: ' + reply);

      // 记录本次回复时间，供冷却判断使用
      lastReplyAt.set(key, Date.now());

      // —— 按情绪决定要不要配一张表情包 ——
      await maybeSendSticker(bot, ev, emoRec, text, reply);

      // —— 按概率把刚说的话用语音再发一遍 ——
      await maybeSendVoice(bot, ev, emoRec, reply);

      // —— 会话内追问：有时再补一句，让对话不是一问一答就结束 ——
      await maybeFollowUp(bot, ev, key, emoRec, text, reply);

      // —— 人设进化：每 N 轮后台提炼一次，不阻塞回复 ——
      rec.turns += 1;
      Mem.save(rec);
      const every = cfg.reply.evolveEvery ?? 4;
      if (every > 0 && rec.turns - rec.evolvedTurns >= every) {
        const hist = history(key);
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

  // 等 OneBot 真正连上（最多 30 秒），再启动需要调 API 的调度器
  for (let i = 0; i < 60 && !bot.ready; i++) await new Promise((r) => setTimeout(r, 500));

  // 主动聊天调度器
  startProactive(bot, cfg);

  // QQ空间自动发说说
  startQzone(bot, cfg);

  // B站"刷到好玩的就聊"
  startBiliShare(bot, cfg);

  // —— 配置缓存自检 ——
  // 踩过的坑：新增了 config 段，但忘了往 cfg_cache 里搬，
  // 导致启动日志说"已开启"、运行时却当成"没开"（语音功能就这么坏了半天）。
  // 这里逐项核对，任何一项对不上就在启动阶段直接报出来。
  {
    const checks = [
      ['stickers', cfg.stickers],
      ['vision', cfg.vision],
      ['followUp', cfg.followUp],
      ['video', cfg.video],
      ['audio', cfg.audio],
      ['qzone', cfg.qzone],
      ['tts', cfg.tts],
      ['search', cfg.search],
      ['douyin', cfg.douyin],
      ['bili', cfg.bili],
      ['vram', cfg.vram],
      ['asr', cfg.asr],
    ];
    const missing = checks
      .filter(([k, v]) => v !== undefined && cfg_cache[k] === undefined)
      .map(([k]) => k);
    if (missing.length) {
      log('⚠️ 配置缓存缺失: ' + missing.join(', ') +
          ' —— 相关功能会误判为未开启，请检查 main() 里的 cfg_cache 赋值');
    }
  }

  // 语音合成状态
  {
    const tc = cfg.tts || {};
    if (tc.enabled !== true) {
      log('发语音：未开启（config.json 的 tts.enabled）');
    } else if (tc.engine === 'sovits') {
      log('发语音：已开启，引擎 GPT-SoVITS 克隆音色 ' + tc.sovitsUrl +
          '，概率 ' + Math.round((tc.chance ?? 0.15) * 100) + '%' +
          '，冷却 ' + (tc.cooldownMin ?? 30) + ' 分钟');
      // 异步探测克隆服务，别拖慢启动
      TTS.sovitsAvailable(cfg).then((ok) => {
        if (ok) log('  ✅ GPT-SoVITS 服务在线');
        else log('  ⚠️ GPT-SoVITS 服务没响应（' + tc.sovitsUrl +
                 '）—— 发语音会回退到 edge-tts。启动它：' +
                 'D:\\GPT-SoVITS\\...\\runtime\\python.exe api_v2.py');
      }).catch(() => {});
    } else {
      const why = TTS.unavailableReason(cfg);
      if (why) {
        log('⚠️ 发语音：不可用 —— ' + why);
      } else {
        log('发语音：已开启，引擎 edge-tts，语音 ' + (tc.voice || 'zh-CN-XiaoyiNeural') +
            '，概率 ' + Math.round((tc.chance ?? 0.15) * 100) + '%' +
            '，冷却 ' + (tc.cooldownMin ?? 30) + ' 分钟');
      }
    }
  }

  // 联网搜索状态
  {
    const sc = cfg.search || {};
    if (sc.enabled !== true) {
      log('联网搜索：未开启（config.json 的 search.enabled）');
    } else {
      log('联网搜索：已开启，引擎 ' + (sc.engine || 'bing') +
          (sc.autoSearch !== false ? '，它自己判断何时搜' : '，仅你说"搜一下"时搜'));
    }
  }

  // 抖音解析状态
  {
    const dc = cfg.douyin || {};
    if (dc.enabled === false) {
      log('抖音解析：未开启');
    } else {
      log('抖音解析：已开启（注意：抖音反爬很严，只能尽力取标题，' +
          '取不到会说打不开；发视频文件给它看是可靠的）');
    }
  }

  // B站状态
  {
    const bc = cfg.bili || {};
    if (bc.enabled !== true) {
      log('B站：未开启（config.json 的 bili.enabled）');
    } else {
      log('B站：已开启' + (bc.proactiveShare === true
        ? '，会主动刷热门分享（每 ' + (bc.checkEveryMin ?? 120) + ' 分钟看一次）'
        : '，只在被问到时查'));
    }
  }

  // 显存仲裁状态
  {
    const vc = cfg.vram || {};
    if (vc.autoFree === false) {
      log('显存仲裁：未开启（看图可能因显存不足失败）');
    } else {
      const free = Vram.freeVramMB();
      log('显存仲裁：已开启，看图/视频前自动让 GPT-SoVITS 让位' +
          (free >= 0 ? '（当前显存空闲 ' + free + ' MB）' : ''));
    }
  }

  // 语音转文字状态
  {
    const ac = cfg.asr || {};
    if (ac.enabled === false) {
      log('语音转文字：未开启');
    } else if (!ac.pythonPath || !existsSync(ac.pythonPath)) {
      log('⚠️ 语音转文字：找不到 python（' + (ac.pythonPath || '未配置') +
          '），视频只会看画面、听不到台词');
    } else {
      log('语音转文字：已开启，模型 ' + (ac.model || 'medium') +
          '（CPU 转写，视频会连台词一起理解）');
    }
  }

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