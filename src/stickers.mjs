// 表情包收集与管理
//
// 设计取舍（实测得出）：
//   - llava:7b 能看图，但打标签不准（把蓝色小鲸鱼认成"动漫女孩"）
//   - 所以【不依赖 AI 打标签】，改成「场景学习」：
//     记录每张表情在什么对话情境下出现，用真实使用场景当索引
//   - AI 标签只作为辅助（可选），不作为主要依据

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STICKER_DIR = join(ROOT, 'stickers');
export const INDEX_FILE = join(STICKER_DIR, 'index.json');
export const SEEN_FILE = join(STICKER_DIR, '.seen.json');

if (!existsSync(STICKER_DIR)) mkdirSync(STICKER_DIR, { recursive: true });

// ---------------------------------------------------------------- 视觉标注
//
// 实测结论（llava:7b）：
//   - 中文能力弱：「眼eglasses」这种夹英文、结构化输出会失败
//   - 英文明显更准：能给出 "anime girl with blue hair, pointing"
//   - 但它认不出具体角色（把小鲸鱼认成 anime girl）
// 所以策略：用英文描述拿"画面内容"，用对话场景拿"使用语境"，两者互补。

const VISION_PROMPT = `Look at this sticker and answer in English, one short line only:
What is shown, and what emotion does it express?
Format: <what it shows>, <emotion>
Example: cat giving thumbs up, happy
Do not explain. Do not use markdown.`;

/**
 * 用视觉模型描述一张图。
 *
 * 实测要点：
 *   - qwen2.5vl 不支持 GIF/WebP → 报 "image: unknown format"
 *   - 但对 PNG/JPG 又快又准（中文 0.6s，llava 要 5.7s）
 *   - 所以非 PNG/JPG 一律先用 ffmpeg 转成 PNG
 *
 * @returns {Promise<{visual:string, emotion:string, raw:string}>}
 */
export async function describe(filePath, cfg, timeoutMs = 90000) {
  const model = cfg.vision?.model || 'qwen2.5vl:3b';
  let imgBuf = null;

  const ext = extname(filePath).toLowerCase();
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    imgBuf = readFileSync(filePath);
  } else if (ext === '.gif') {
    imgBuf = gifToPng(filePath);          // 纯 JS 转首帧，无需 ffmpeg
    if (!imgBuf) throw new Error('GIF 解码失败');
  } else {
    throw new Error('不支持的图片格式: ' + ext);
  }

  const b64 = imgBuf.toString('base64');

  // qwen 系用中文提示词；llava 中文很弱，用英文
  const isQwen = /qwen/i.test(model);
  const prompt = isQwen
    ? '用中文简短描述这张表情包：画的是什么？什么情绪？不超过25字，直接说，不要解释。'
    : VISION_PROMPT;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch((cfg.ollama?.baseUrl || 'http://127.0.0.1:11434') + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model,
        prompt,
        images: [b64],
        stream: false,
        options: { num_predict: 80, temperature: 0.2 },
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    const raw = (j.response || '').trim().replace(/\s+/g, ' ');

    if (isQwen) {
      return { visual: raw.slice(0, 80), emotion: guessEmotionCn(raw), raw };
    }
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    let visual = raw.slice(0, 80);
    let emotion = '';
    if (parts.length >= 2) {
      emotion = parts[parts.length - 1].slice(0, 20);
      visual = parts.slice(0, -1).join(', ').slice(0, 80);
    }
    return { visual, emotion, raw };
  } finally {
    clearTimeout(timer);
  }
}

/** 用纯 JS 把 GIF 首帧转成 PNG（不依赖 ffmpeg —— 沙箱里 spawn 会 EPERM） */
function gifToPng(gifPath) {
  const buf = readFileSync(gifPath);
  if (buf.slice(0, 3).toString('ascii') !== 'GIF') return null;

  const W = buf.readUInt16LE(6);
  const H = buf.readUInt16LE(8);
  const flags = buf[10];
  const gctSize = (flags & 0x80) ? 3 * Math.pow(2, (flags & 7) + 1) : 0;
  let p = 13;

  let palette = null;
  if (gctSize) { palette = buf.slice(p, p + gctSize); p += gctSize; }

  const rgba = Buffer.alloc(W * H * 4, 255);
  const canvas = new Int16Array(W * H).fill(-1);

  function lzwDecode(data, minCodeSize) {
    const out = [];
    const clear = 1 << minCodeSize;
    const end = clear + 1;
    let dict = [];
    const resetDict = () => {
      dict = [];
      for (let i = 0; i < clear; i++) dict.push([i]);
      dict.push([], []);
    };
    resetDict();
    let codeSize = minCodeSize + 1;
    let bitBuf = 0, bitCnt = 0, prev = null;
    for (let i = 0; i < data.length; i++) {
      bitBuf |= data[i] << bitCnt; bitCnt += 8;
      while (bitCnt >= codeSize) {
        const code = bitBuf & ((1 << codeSize) - 1);
        bitBuf >>= codeSize; bitCnt -= codeSize;
        if (code === clear) { resetDict(); codeSize = minCodeSize + 1; prev = null; continue; }
        if (code === end) return out;
        let entry;
        if (code < dict.length && dict[code]) entry = dict[code];
        else if (prev) entry = prev.concat([prev[0]]);
        else break;
        out.push(...entry);
        if (prev) {
          dict.push(prev.concat([entry[0]]));
          if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
        }
        prev = entry;
      }
    }
    return out;
  }

  let frame = 0;
  while (p < buf.length) {
    const blk = buf[p];
    if (blk === 0x21) { p += 2; while (p < buf.length && buf[p] !== 0) p += buf[p] + 1; p++; continue; }
    if (blk === 0x2c) {
      const left = buf.readUInt16LE(p + 1), top = buf.readUInt16LE(p + 3);
      const w = buf.readUInt16LE(p + 5), h = buf.readUInt16LE(p + 7);
      const iflags = buf[p + 9];
      let q = p + 10;
      let localPal = palette;
      if (iflags & 0x80) {
        const sz = 3 * Math.pow(2, (iflags & 7) + 1);
        localPal = buf.slice(q, q + sz); q += sz;
      }
      const interlaced = !!(iflags & 0x40);
      const minCode = buf[q]; q++;
      const parts = [];
      while (q < buf.length && buf[q] !== 0) {
        const len = buf[q]; parts.push(buf.slice(q + 1, q + 1 + len)); q += len + 1;
      }
      q++; p = q;
      if (!localPal) return null;

      const idxs = lzwDecode(Buffer.concat(parts), minCode);
      const rows = [];
      if (interlaced) {
        for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < h; y += st) rows.push(y);
      } else for (let y = 0; y < h; y++) rows.push(y);

      for (let i = 0; i < idxs.length; i++) {
        const row = Math.floor(i / w), col = i % w;
        if (row >= rows.length) break;
        const x = left + col, y = top + rows[row];
        if (x >= W || y >= H) continue;
        if (canvas[y * W + x] >= frame) continue;
        const ci = idxs[i] * 3, o = (y * W + x) * 4;
        rgba[o] = localPal[ci]; rgba[o + 1] = localPal[ci + 1];
        rgba[o + 2] = localPal[ci + 2]; rgba[o + 3] = 255;
        canvas[y * W + x] = frame;
      }
      frame++;
      if (frame >= 1) break;   // 只要首帧
      continue;
    }
    if (blk === 0x3b) break;
    p++;
  }

  return rgbaToPng(W, H, rgba);
}

/** RGBA 像素 → PNG 字节 */
function rgbaToPng(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  const crcT = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 从中文描述里抽情绪词 */
function guessEmotionCn(text) {
  const t = String(text);
  const words = ['开心', '高兴', '笑', '难过', '哭', '委屈', '生气', '愤怒', '无语', '尴尬',
    '惊讶', '震惊', '累', '困', '可爱', '萌', '喜欢', '爱', '搞笑', '得意', '害羞', '害怕', '困惑'];
  return words.filter((w) => t.includes(w)).slice(0, 3).join(' ');
}

/** 哪些图还没标注 */
export function pendingDescription() {
  const idx = loadIndex();
  return idx.items.filter((x) => !x.visual);
}

/**
 * 给一张图存下描述。
 * 同时也把英文情绪词转成中文关键词，方便按情境匹配。
 */
export function setDescription(id, { visual, emotion }) {
  const idx = loadIndex();
  const it = idx.items.find((x) => x.id === id);
  if (!it) return false;
  it.visual = String(visual || '').slice(0, 100);
  it.emotion = String(emotion || '').slice(0, 30);
  it.emotionCn = translateEmotion(it.emotion);
  it.describedAt = new Date().toISOString();
  saveIndex(idx);
  return true;
}

/** 英文情绪 → 中文关键词（用于和中文对话匹配） */
function translateEmotion(e) {
  const s = String(e || '').toLowerCase();
  const map = [
    [/happy|joy|smil|cheer|glad|pleased/, '开心 高兴 笑',],
    [/sad|cry|tear|upset|sorrow/, '难过 哭 委屈'],
    [/angry|mad|rage|annoy|furious/, '生气 愤怒 火大'],
    [/confus|puzzle|unsure|doubt/, '困惑 迷茫'],
    [/surprise|shock|amaze/, '惊讶 震惊'],
    [/tired|sleep|exhaust|weary/, '累 困 疲惫'],
    [/love|heart|adore|affection/, '喜欢 爱 心动'],
    [/cute|kawaii|adorable/, '可爱 萌'],
    [/funny|laugh|humor|amuse/, '搞笑 笑死'],
    [/thumbs up|approv|ok|agree|good/, '赞同 可以 点赞'],
    [/no|disagree|refus|reject|deny/, '拒绝 不行'],
    [/scared|afraid|fear|terrif/, '害怕 恐怖'],
    [/speechless|awkward|blank|silent/, '无语 尴尬'],
  ];
  for (const [re, cn] of map) if (re.test(s)) return cn;
  return '';
}

/** 待标注统计 */
export function describeStats() {
  const idx = loadIndex();
  const total = idx.items.length;
  const done = idx.items.filter((x) => x.visual).length;
  return { total, done, pending: total - done };
}

// ---------------------------------------------------------------- 读取索引
export function loadIndex() {
  if (!existsSync(INDEX_FILE)) return { version: 1, items: [] };
  try {
    const j = JSON.parse(readFileSync(INDEX_FILE, 'utf8'));
    if (!Array.isArray(j.items)) j.items = [];
    return j;
  } catch {
    return { version: 1, items: [] };
  }
}

export function saveIndex(idx) {
  writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8');
}

/** 用文件内容算 hash，避免重复存同一张图 */
function hashOf(buf) {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

/**
 * 收集一张表情。
 * @param {Buffer} buf   图片数据
 * @param {object} meta  { summary, from, kind, context }  可选的来源信息
 * @returns {{added:boolean, id:string, item:object}}
 */
export function collect(buf, meta = {}) {
  const idx = loadIndex();
  const h = hashOf(buf);

  // 注意：条目里存的是 id（= hash），没有单独的 hash 字段。
  // 之前写成 x.hash 导致永远匹配不到，同一张图会被重复收录。
  const exist = idx.items.find((x) => x.id === h);
  if (exist) {
    // 已存在：累加出现次数和场景
    exist.seen = (exist.seen || 1) + 1;
    if (meta.context) addContext(exist, meta.context);
    if (meta.summary && !exist.summary) exist.summary = meta.summary;
    saveIndex(idx);
    return { added: false, id: exist.id, item: exist };
  }

  // 新图：存文件
  const ext = guessExt(buf, meta);
  const fileName = 's_' + h + ext;
  const path = join(STICKER_DIR, fileName);
  try {
    writeFileSync(path, buf);
  } catch (e) {
    return { added: false, id: '', item: null, error: e.message };
  }

  const item = {
    id: h,
    hash: h,
    file: fileName,
    bytes: buf.length,
    ext,
    summary: meta.summary || '',
    kind: meta.kind || 'unknown',       // image / face / mface
    from: meta.from || '',               // 来源：friend:xxx / group:xxx
    seen: 1,
    // 场景学习：这些是判断"什么时候该发"的依据
    contexts: [],                        // 出现过的对话情境（短文本）
    sent: 0,                             // 被主动发出过几次
    createdAt: new Date().toISOString(),
  };
  if (meta.context) addContext(item, meta.context);

  idx.items.push(item);
  saveIndex(idx);
  return { added: true, id: h, item };
}

/** 记一条使用场景（去重、限长、限量） */
function addContext(item, ctx) {
  const c = String(ctx).trim().slice(0, 40);
  if (!c) return;
  item.contexts = item.contexts || [];
  if (item.contexts.includes(c)) return;
  item.contexts.push(c);
  if (item.contexts.length > 12) item.contexts.shift();  // 只留最近 12 条
}

/** 猜扩展名 */
function guessExt(buf, meta) {
  const fromName = meta.fileName ? extname(meta.fileName).toLowerCase() : '';
  if (fromName && ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fromName)) return fromName;
  // 用魔数判断
  if (buf.length > 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') return '.webp';
  }
  return '.jpg';
}

/** 已收集的统计 */
export function stats() {
  const idx = loadIndex();
  let bytes = 0, withCtx = 0;
  for (const it of idx.items) {
    bytes += it.bytes || 0;
    if (it.contexts?.length) withCtx++;
  }
  return {
    count: idx.items.length,
    bytes,
    withContext: withCtx,
    top: idx.items.slice().sort((a, b) => (b.seen || 0) - (a.seen || 0)).slice(0, 5),
  };
}

/**
 * 按当前情境挑一张表情。
 *
 * 匹配优先级（从准到宽）：
 *   1. 场景文本命中（对方的话曾和这张图一起出现）
 *   2. 情绪关键词命中（AI 描述的情绪 vs 当前对话）
 *   3. 都没有 → 挑最久没发的
 */
export function pick({ context = '', exclude = [], random = Math.random, moodHint = '' } = {}) {
  const idx = loadIndex();
  if (!idx.items.length) return null;

  let pool = idx.items.filter((x) => !exclude.includes(x.id));
  if (!pool.length) pool = idx.items.slice();

  const q = (context + ' ' + moodHint).slice(0, 60);

  if (q.trim()) {
    // 1. 场景命中
    const byScene = pool.filter((x) => (x.contexts || []).some((c) => similar(c, q)));
    if (byScene.length) pool = byScene;
    else {
      // 2. 情绪关键词命中
      const byEmo = pool.filter((x) => {
        const keys = (x.emotionCn || '').split(/\s+/).filter(Boolean);
        return keys.some((k) => q.includes(k));
      });
      if (byEmo.length) pool = byEmo;
    }
  }

  // 挑最久没发的，前几个里随机
  pool.sort((a, b) => (a.lastSent || 0) - (b.lastSent || 0));
  const top = pool.slice(0, Math.min(5, pool.length));
  return top[Math.floor(random() * top.length)];
}

/** 两段中文文本是否相似（有共同 2-gram） */
function similar(a, b) {
  const s = String(a), t = String(b);
  for (let i = 0; i < s.length - 1; i++) {
    if (t.includes(s.slice(i, i + 2))) return true;
  }
  return false;
}

/** 标记已发送 */
export function markSent(id) {
  const idx = loadIndex();
  const it = idx.items.find((x) => x.id === id);
  if (it) {
    it.sent = (it.sent || 0) + 1;
    it.lastSent = Date.now();
    saveIndex(idx);
  }
  return it;
}

/** 清理重复项（按 id 去重，合并 seen 和 contexts） */
export function dedupe() {
  const idx = loadIndex();
  const map = new Map();
  let removed = 0;
  for (const it of idx.items) {
    const k = it.id || it.hash;
    if (!k) { removed++; continue; }
    if (map.has(k)) {
      const keep = map.get(k);
      keep.seen = (keep.seen || 1) + (it.seen || 1);
      for (const c of (it.contexts || [])) addContext(keep, c);
      if (!keep.summary && it.summary) keep.summary = it.summary;
      removed++;
    } else {
      map.set(k, it);
    }
  }
  idx.items = [...map.values()];
  saveIndex(idx);
  return { removed, remaining: idx.items.length };
}

/** 删掉一张 */
export function remove(id) {
  const idx = loadIndex();
  const i = idx.items.findIndex((x) => x.id === id);
  if (i === -1) return false;
  const it = idx.items[i];
  try {
    const p = join(STICKER_DIR, it.file);
    if (existsSync(p)) rmFile(p);
  } catch {}
  idx.items.splice(i, 1);
  saveIndex(idx);
  return true;
}

function rmFile(p) {
  try { require('node:fs').unlinkSync(p); } catch {}
}

// ---------------------------------------------------------------- 后台标注

let labeling = false;

/**
 * 后台批量标注未描述的图。
 * 一次只处理一张，间隔一段时间，避免抢显存影响聊天。
 * @param {object} cfg      配置（需要 cfg.ollama.baseUrl、cfg.vision.model）
 * @param {function} log    日志函数
 * @param {object} opt      { maxPerRound, gapMs }
 */
export async function labelPending(cfg, log, opt = {}) {
  if (labeling) return { skipped: true };
  const max = opt.maxPerRound ?? 3;
  const gap = opt.gapMs ?? 4000;

  const todo = pendingDescription().slice(0, max);
  if (!todo.length) return { done: 0, pending: 0 };

  labeling = true;
  let ok = 0;
  try {
    for (const it of todo) {
      const p = join(STICKER_DIR, it.file);
      if (!existsSync(p)) continue;
      try {
        const d = await describe(p, cfg);
        setDescription(it.id, d);
        ok++;
        if (log) log('  👁 标注: ' + it.file.slice(0, 20) + ' → ' + d.visual.slice(0, 40) +
          (d.emotion ? '  [' + d.emotion + ']' : ''));
      } catch (e) {
        if (log) log('  👁 标注失败(' + it.file.slice(0, 16) + '): ' + e.message);
      }
      await new Promise((r) => setTimeout(r, gap));
    }
  } finally {
    labeling = false;
  }
  const st = describeStats();
  return { done: ok, pending: st.pending };
}

/** 是否正在标注 */
export function isLabeling() { return labeling; }