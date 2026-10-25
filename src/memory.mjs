// 记忆与人设进化模块
// 设计：基础人格(PERSONA)固定不变，进化的是「它对这个人的了解」。
// 两者拼接后送进模型，避免聊久了人格漂移。

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

export const MEM_DIR = join(ROOT, 'memories');

if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });

/** 会话 key -> 安全文件名
 *
 *  ⚠️ Windows 上 ':' 是非法文件名字符，会被 NTFS 当成「备用数据流(ADS)」：
 *     写 "p:123.json" 实际会创建文件 "p" 的一个数据流，dir 只看到 "p" 且为 0 字节。
 *     所以这里把 ':' 也替换掉。 */
function fileOf(key) {
  const safe = String(key).replace(/:/g, '-').replace(/[^a-zA-Z0-9_\-]/g, '_');
  return join(MEM_DIR, safe + '.json');
}

/** 空档案 */
function blank(key) {
  return {
    key,
    version: 1,
    updatedAt: new Date().toISOString(),
    // —— 模型自动进化的部分 ——
    knownAs: '',            // 它怎么称呼对方（若有）
    facts: [],              // 记住的对方信息
    topics: [],             // 共同话题/经历
    tics: [],               // 提炼出的口头禅
    attitude: '',           // 对这个人的态度
    // —— 标点习惯（纯统计，不用模型）——
    punct: null,            // { comma, period, question, exclaim, none, samples }
    // —— 运行统计 ——
    turns: 0,
    evolvedTurns: 0,
  };
}

/** 统计一条消息里的标点使用情况 */
export function countPunct(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const len = t.length;
  if (len < 3) return null;   // 太短的不算样本
  return {
    comma: (t.match(/[，,]/g) || []).length,
    period: (t.match(/[。.]/g) || []).length,
    question: (t.match(/[？?]/g) || []).length,
    exclaim: (t.match(/[！!]/g) || []).length,
    tilde: (t.match(/[~～]/g) || []).length,
    ellipsis: (t.match(/[…]{1,}|\.{3,}/g) || []).length,
    len,
  };
}

/**
 * 累积标点统计（指数滑动平均，新样本权重高一点）。
 * 这样对方的习惯变了，它也能跟上。
 */
export function accumulatePunct(rec, text) {
  const s = countPunct(text);
  if (!s) return rec;

  const a = 0.25; // 新样本权重
  if (!rec.punct) {
    rec.punct = { ...s, samples: 1 };
  } else {
    const p = rec.punct;
    for (const k of ['comma', 'period', 'question', 'exclaim', 'tilde', 'ellipsis', 'len']) {
      p[k] = (p[k] ?? 0) * (1 - a) + s[k] * a;
    }
    p.samples = (p.samples || 0) + 1;
  }
  return rec;
}

/**
 * 把统计结果变成给模型的指令。
 * 只有在样本足够时才生效，避免刚聊两句就乱改风格。
 */
export function renderPunctuation(rec) {
  const p = rec.punct;
  if (!p || (p.samples || 0) < 6) {
    return '\n\n【标点】\n按你默认的习惯来：很少用标点，断句用逗号或空格。';
  }

  const rules = [];
  // 用「每 20 字出现几次」判断是否常用
  const rate = (k) => (p[k] || 0) / Math.max(1, (p.len || 1) / 20);

  rules.push(rate('comma') >= 0.3
    ? '逗号用得挺多，可以跟着用逗号断句'
    : '偶尔才用逗号，多数时候直接空格断句');

  if (rate('period') < 0.15) rules.push('基本不写句号');
  else if (rate('period') >= 0.5) rules.push('对方每句都用句号，你也跟着用');
  if (rate('question') >= 0.3) rules.push('问句会带问号');
  else rules.push('问句也常省略问号');
  if (rate('exclaim') >= 0.3) rules.push('感叹号用得比较多');
  else rules.push('不用感叹号');
  if (rate('tilde') >= 0.2) rules.push('偶尔用波浪号');
  if (rate('ellipsis') >= 0.2) rules.push('偶尔用省略号');

  const avgLen = Math.round(p.len || 0);
  if (avgLen > 0) {
    rules.push('对方平均一条消息约 ' + avgLen + ' 字，你的长度保持相近或更短');
  }

  return '\n\n【标点与长度（从和这个人的聊天里学到的）】\n- ' + rules.join('\n- ');
}

export function load(key) {
  const f = fileOf(key);
  if (!existsSync(f)) return blank(key);
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { ...blank(key), ...j, key };
  } catch {
    return blank(key);
  }
}

export function save(rec) {
  const f = fileOf(rec.key);
  rec.updatedAt = new Date().toISOString();
  writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8');
}

export function listAll() {
  if (!existsSync(MEM_DIR)) return [];
  return readdirSync(MEM_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(MEM_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
}

export function forget(key) {
  const f = fileOf(key);
  if (existsSync(f)) unlinkSync(f);
}

/** 把档案渲染成给模型看的上下文片段 */
export function render(rec, botName, opts = {}) {
  const parts = [];

  // —— 主人身份判定 ——
  // 规则：
  //   · 私聊主人     → 认主人，用「爸爸」这个称呼
  //   · 群聊（任何人，包括主人） → 一律不认称呼，统一用「你」
  //     原因：群里有别人看着，叫「爸爸」很怪，也容易让人误会。
  //
  // 两种场景的 key 不同：
  //   私聊：rec.key = 'p:<对方QQ>'，直接比 key
  //   群聊：rec.key = 'g:<群号>'，比不了；改用 bridge 传进来的 speakerQQ
  const ownerQQ = opts.ownerQQ ? String(opts.ownerQQ) : '';
  const ownerName = opts.ownerName || '主人';
  const speakerQQ = opts.speakerQQ ? String(opts.speakerQQ) : '';
  const isPrivate = String(rec.key || '').startsWith('p:');
  const isGroup = String(rec.key || '').startsWith('g:');

  // 群里永远不算"主人场景"（无论说话的是谁）
  const isOwner = !!ownerQQ && !isGroup && isPrivate && rec.key === 'p:' + ownerQQ;
  const isOwnerInGroup = !!ownerQQ && isGroup && speakerQQ && speakerQQ === ownerQQ;

  if (isOwner) {
    parts.push('【这个人是你主人，QQ ' + ownerQQ + '】你叫他「' + ownerName +
               '」。这是固定称呼，别改成别的（也别对别人用）。');
  } else if (isGroup) {
    // 群聊：不管是群友还是主人，都不许用亲属称呼
    const who = speakerQQ ? '正在说话的人是 QQ ' + speakerQQ : '现在是群聊';
    const extra = isOwnerInGroup
      ? '（他是你主人，但**在群里也不要叫爸**，用「你」就行，别让群里其他人看到）'
      : '（**不是**你主人）不要叫他「' + ownerName + '」或任何亲属称呼';
    parts.push('【' + who + '，' + extra + '】正常用「你」就行。');
  }

  if (rec.knownAs && !isOwner) parts.push('你叫对方「' + rec.knownAs + '」。');

  if (rec.facts?.length) {
    parts.push('你知道的关于对方的事：\n' + rec.facts.map((s) => '- ' + s).join('\n'));
  }
  if (rec.topics?.length) {
    parts.push('你们之前聊过：\n' + rec.topics.map((s) => '- ' + s).join('\n'));
  }
  if (rec.attitude && !isOwner) {
    parts.push('你对这个人的态度：' + rec.attitude);
  } else if (isOwner) {
    parts.push('你对他的态度：亲近，可以贫嘴、可以吐槽他，但心里认他。');
  }

  if (parts.length) {
    parts.push('（自然地体现这些了解，别像在背档案。别主动说「我记得你说过」这种话，除非很合适。）');
    return '\n\n【你对当前这个人的了解】\n' + parts.join('\n\n') + renderPunctuation(rec);
  }
  return '\n\n【你对当前这个人的了解】\n你们还不算熟，正常聊就行。' + renderPunctuation(rec);
}

// ---------------------------------------------------------------- 进化

const EVOLVE_PROMPT = `你在维护一个 QQ 角色扮演机器人的「人物档案」。

下面是你（机器人角色）和【某个人】的一段对话记录，以及当前的档案。

请更新档案。只输出 JSON，不要任何解释、不要 markdown 代码块。

要求：
- facts：关于对方的事实（名字、职业、喜好、在做什么）。最多 8 条，每条不超过 25 字。旧的要保留，除非对话里明确说明它已过时。
- topics：你们聊过的话题/共同经历。最多 6 条，每条不超过 20 字。
- tics：从对话里能看出的【对方的】说话习惯或口头禅。最多 4 条。看不出来就留空数组。
- knownAs：你该怎么称呼对方。对话里没明确提到名字就保留原来的值。
- attitude：你对这个人的态度，一句话，不超过 20 字（例：还不太熟，客气点 / 挺聊得来的，可以开玩笑）。
- 不要编造对话里没出现的信息。宁可留空。
- 如果这段对话没有任何有价值的新信息，各字段保持原样。

输出格式：
{"knownAs":"","facts":[],"topics":[],"tics":[],"attitude":""}

--- 当前档案 ---
{ARCHIVE}

--- 对话记录 ---
{CONVO}`;

/** 让模型从对话里提炼档案更新 */
export async function evolve(rec, history, cfg) {
  // 主人档案的称呼和态度由配置固定，不让"进化"把它改掉。
  // 同样不硬编码 QQ 号：从 cfg.bot.owner 读。
  const ownerQQ = cfg?.bot?.owner ? String(cfg.bot.owner) : '';
  const ownerName = cfg?.bot?.ownerName || '主人';
  const isOwner = ownerQQ && rec.key === 'p:' + ownerQQ;

  // 只取文本形式的历史
  const convo = history
    .map((m) => (m.role === 'user' ? '对方' : '你') + '：' + m.content)
    .join('\n')
    .slice(-3000);

  const archive = JSON.stringify(
    {
      knownAs: isOwner ? '(固定：' + ownerName + '，不要改)' : rec.knownAs,
      facts: rec.facts,
      topics: rec.topics,
      tics: rec.tics,
      attitude: isOwner ? '(固定：亲近，可贫嘴)' : rec.attitude,
    },
    null, 2
  );

  const prompt = EVOLVE_PROMPT.replace('{ARCHIVE}', archive).replace('{CONVO}', convo);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let raw;
  try {
    const res = await fetch(cfg.ollama.baseUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: cfg.ollama.model,
        stream: false,
        think: false,
        messages: [{ role: 'user', content: prompt }],
        options: { num_predict: 600, temperature: 0.3, top_p: 0.9 },
      }),
    });
    const j = await res.json();
    raw = (j.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }

  // 从输出里抠出 JSON（模型可能包了 ``` 或加了废话）
  let obj = null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try { obj = JSON.parse(m[0]); } catch {
      // 常见问题：尾逗号
      try { obj = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch {}
    }
  }
  if (!obj) throw new Error('模型没返回合法 JSON: ' + raw.slice(0, 120));

  const clean = (a, n, len) =>
    Array.isArray(a)
      ? a.filter((s) => typeof s === 'string' && s.trim())
          .map((s) => s.trim().slice(0, len))
          .slice(0, n)
      : [];

  const next = {
    ...rec,
    knownAs: typeof obj.knownAs === 'string' ? obj.knownAs.trim().slice(0, 20) : rec.knownAs,
    facts: clean(obj.facts, 8, 25),
    topics: clean(obj.topics, 6, 20),
    tics: clean(obj.tics, 4, 20),
    attitude: typeof obj.attitude === 'string' ? obj.attitude.trim().slice(0, 20) : rec.attitude,
    version: rec.version + 1,
    evolvedTurns: rec.turns,
  };

  // 主人档案：称呼和态度由配置固定，覆盖模型可能给出的任何值
  if (isOwner) {
    next.knownAs = ownerName;
    next.attitude = '亲近，可贫嘴';
  }

  return next;
}