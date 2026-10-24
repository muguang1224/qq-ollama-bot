// 表情包收集与管理
//
// 设计取舍（实测得出）：
//   - llava:7b 能看图，但打标签不准（把蓝色小鲸鱼认成"动漫女孩"）
//   - 所以【不依赖 AI 打标签】，改成「场景学习」：
//     记录每张表情在什么对话情境下出现，用真实使用场景当索引
//   - AI 标签只作为辅助（可选），不作为主要依据

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// 数据存在项目根目录（src 的上一级），与代码分开
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

  // 关键：用魔数判断真实格式，不能信扩展名。
  // 实测 QQ 的动画表情文件名叫 .jpg，内容却是 GIF。
  const raw = readFileSync(filePath);
  const fmt = sniffFormat(raw);

  if (fmt === 'jpg' || fmt === 'png') {
    imgBuf = raw;
  } else if (fmt === 'gif' || fmt === 'webp' || fmt === 'bmp') {
    // GIF 用内置解码器；webp/bmp 也试着当 GIF 之外处理
    if (fmt === 'gif') {
      imgBuf = gifToPng(filePath);
      if (!imgBuf) throw new Error('GIF 解码失败');
    } else {
      throw new Error('暂不支持 ' + fmt + ' 格式（需要转换）');
    }
  } else {
    // 认不出：退回扩展名
    const ext = extname(filePath).toLowerCase();
    if (ext === '.gif') { imgBuf = gifToPng(filePath); }
    else imgBuf = raw;
    if (!imgBuf) throw new Error('无法识别的图片格式');
  }

  // —— 关键：把图缩到 256px 再送模型 ——
  //
  // 实测（Ollama 0.24.0 + qwen2.5vl:3b）：
  //   原图（148KB JPEG）直接送 → 46~200 秒，甚至 "Failed to create new sequence"
  //   缩到 256px（18KB）        → 4.4 秒，稳定成功
  //   64px 更快（1.5s）但细节丢失，256px 是速度和质量的最佳点
  imgBuf = shrinkForVision(imgBuf, cfg?.vision?.maxPx || 256);

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

/**
 * 存 YOLO 的客观检测结果。
 *
 * 为什么要单独存：YOLO 和大模型是两条独立证据 ——
 *   YOLO 给事实（几个人、什么物体）
 *   大模型给语义（画的是什么、什么情绪）
 * 两者结果都存，选图和展示时可以互相补充。
 *
 * ⚠️ 局限（实测）：YOLO 对卡通/表情包基本无效，会把动漫角色
 * 误判成"时钟"。所以这里的结论只作参考，不能当真相。
 */
export function setYolo(id, yolo, note) {
  const idx = loadIndex();
  const it = idx.items.find((x) => x.id === id);
  if (!it) return false;
  it.yolo = {
    persons: yolo?.pose?.persons ?? null,
    objects: (yolo?.detect?.objects || []).slice(0, 6).map((o) => ({
      n: o.nameCn || o.name,
      c: o.conf,
    })),
    note: String(note || '').slice(0, 120),
    at: new Date().toISOString(),
  };
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

/**
 * 判断文件真实扩展名。
 *
 * ⚠️ 必须用魔数优先，不能信文件名：
 *   实测 QQ 发来的动画表情，file 字段写的是 ".jpg"，
 *   但实际内容是 GIF（GIF89a）。信文件名会导致：
 *     - 存成 .jpg
 *     - describe() 看到 .jpg 就不做 GIF 转换
 *     - 视觉模型报 "image: unknown format"
 */
function guessExt(buf, meta) {
  if (buf && buf.length > 8) {
    const b0 = buf[0], b1 = buf[1];
    if (b0 === 0x47 && b1 === 0x49 && buf[2] === 0x46) return '.gif';      // GIF8
    if (b0 === 0x89 && b1 === 0x50 && buf[2] === 0x4e) return '.png';      // PNG
    if (b0 === 0xff && b1 === 0xd8 && buf[2] === 0xff) return '.jpg';      // JPEG
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
        buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';     // WebP
    if (b0 === 0x42 && b1 === 0x4d) return '.bmp';                          // BMP
  }
  // 魔数认不出时才退回文件名
  const fromName = meta.fileName ? extname(meta.fileName).toLowerCase() : '';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fromName)) return fromName;
  return '.jpg';
}

/**
 * 把图片缩到指定宽度，减少视觉模型的负担。
 *
 * 为什么必须做（实测数据）：
 *   原图 148KB JPEG → 46~200s，有时直接 "Failed to create new sequence"
 *   缩到 256px/18KB → 4.4s，稳定
 *
 * 实现：JPEG 用内置的最近缩放（只降采样，够用）；
 *      PNG 先解出像素再缩放。因为是给 AI 看的，不需要高质量插值。
 */
function shrinkForVision(buf, maxPx) {
  const fmt = sniffFormat(buf);
  try {
    if (fmt === 'jpg') return shrinkJpegByReencode(buf, maxPx);
    if (fmt === 'png') return shrinkPng(buf, maxPx);
  } catch {
    return buf;   // 缩不了就用原图
  }
  return buf;
}

/** PNG 缩放：解出 RGBA → 最近邻缩放 → 重新编码 */
function shrinkPng(buf, maxPx) {
  // 只处理简单的 8 位真彩 PNG；其它情况原样返回
  const info = parsePng(buf);
  if (!info) return buf;
  const { W, H, rgba } = info;
  if (Math.max(W, H) <= maxPx) return buf;

  const scale = maxPx / Math.max(W, H);
  const nw = Math.max(1, Math.round(W * scale));
  const nh = Math.max(1, Math.round(H * scale));
  const out = Buffer.alloc(nw * nh * 4);

  for (let y = 0; y < nh; y++) {
    const sy = Math.min(H - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(W - 1, Math.floor(x / scale));
      const s = (sy * W + sx) * 4, d = (y * nw + x) * 4;
      out[d] = rgba[s]; out[d + 1] = rgba[s + 1];
      out[d + 2] = rgba[s + 2]; out[d + 3] = rgba[s + 3];
    }
  }
  return rgbaToPng(nw, nh, out);
}

/** 极简 PNG 解析（8 位 RGBA/RGB，非隔行） */
function parsePng(buf) {
  if (buf.length < 33) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  const W = buf.readUInt32BE(16), H = buf.readUInt32BE(20);
  const depth = buf[24], colorType = buf[25], interlace = buf[28];
  if (depth !== 8 || interlace !== 0) return null;
  if (colorType !== 6 && colorType !== 2) return null;   // 只支持 RGBA/RGB

  const bpp = colorType === 6 ? 4 : 3;
  // 收集 IDAT
  let p = 8, idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.slice(p + 4, p + 8).toString('ascii');
    if (type === 'IDAT') idat.push(buf.slice(p + 8, p + 8 + len));
    if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!idat.length) return null;

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * bpp;
  const rgba = Buffer.alloc(W * H * 4, 255);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < H; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < W; x++) {
      const s = x * bpp, d = (y * W + x) * 4;
      rgba[d] = cur[s]; rgba[d + 1] = cur[s + 1]; rgba[d + 2] = cur[s + 2];
      rgba[d + 3] = bpp === 4 ? cur[s + 3] : 255;
    }
    prev = cur;
  }
  return { W, H, rgba };
}

/**
 * JPEG 缩放。
 *
 * 纯 JS 写 JPEG 解码器太重（要处理霍夫曼表、DCT、色度子采样），
 * 所以用系统 ffmpeg —— 它本来就在（视频抽帧也用）。
 * 没有 ffmpeg 就返回原图，靠超时保护兜底。
 *
 * 实测：这一步把 148KB 的 JPEG 变成 18KB 的 256px 图，
 * 视觉模型从 46~200 秒降到 4.4 秒。
 */
function shrinkJpegByReencode(buf, maxPx) {
  const ff = process.env.FFMPEG_PATH || 'ffmpeg';
  const tmpIn = join(STICKER_DIR, '.sz_' + Date.now() + '_in.jpg');
  const tmpOut = join(STICKER_DIR, '.sz_' + Date.now() + '_out.jpg');
  try {
    writeFileSync(tmpIn, buf);
    // 同步调用，简单直接（这一步通常只要几十毫秒）
    execFileSync(ff, ['-y', '-v', 'error', '-i', tmpIn,
      '-vf', 'scale=' + maxPx + ':-1', '-q:v', '5', tmpOut],
      { timeout: 15000, windowsHide: true, stdio: 'ignore' });
    if (existsSync(tmpOut)) {
      const out = readFileSync(tmpOut);
      if (out.length > 100) return out;
    }
  } catch {
    // ffmpeg 不在或失败 → 用原图
  } finally {
    try { if (existsSync(tmpIn)) rmFile(tmpIn); } catch {}
    try { if (existsSync(tmpOut)) rmFile(tmpOut); } catch {}
  }
  return buf;
}

/** 读魔数判断真实格式（给 describe 用） */
function sniffFormat(buf) {
  if (!buf || buf.length < 8) return 'unknown';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'unknown';
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
 *
 * YOLO 只在最后做【轻微加权】，不做主导判断：
 *   实测它对卡通表情不准（把动漫角色认成"时钟"），
 *   只有"人形数量"这一项相对可靠，所以只用它做个软偏好。
 */
export function pick({ context = '', exclude = [], random = Math.random, moodHint = '', preferPerson = null } = {}) {
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

  // —— YOLO 软加权（只在这里用，且权重很低）——
  // 实测 YOLO 只对"有没有人形"相对可靠，所以仅当调用方明确要求
  // preferPerson 时才用它微调顺序，不改变候选池。
  if (preferPerson === true || preferPerson === false) {
    const want = preferPerson ? 1 : 0;
    pool = pool.slice().sort((a, b) => {
      const sa = (a.yolo?.persons > 0 ? 1 : 0) === want ? 0 : 1;
      const sb = (b.yolo?.persons > 0 ? 1 : 0) === want ? 0 : 1;
      if (sa !== sb) return sa - sb;              // 先按是否符合偏好
      return (a.lastSent || 0) - (b.lastSent || 0); // 再按最久没发
    });
  }

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

  // YOLO 是可选增强。它是 Python 脚本，通过 execFile 调用。
  // 动态 import 避免在没装 YOLO 的环境里报错。
  let Yolo = null;
  if (cfg?.yolo?.enabled !== false) {
    try { Yolo = await import('./yolo.mjs'); } catch { Yolo = null; }
    if (Yolo && !Yolo.available(cfg)) Yolo = null;
  }

  labeling = true;
  let ok = 0;
  try {
    for (const it of todo) {
      const p = join(STICKER_DIR, it.file);
      if (!existsSync(p)) continue;

      // —— 先跑 YOLO：快（几百毫秒），给客观事实 ——
      if (Yolo) {
        try {
          const y = await Yolo.analyze(p, cfg, 'all');
          if (y?.ok) {
            const note = Yolo.render(y);
            setYolo(it.id, y, note);
            if (log) log('  🔍 YOLO: ' + it.file.slice(0, 20) + ' → ' + (note || '无检出') +
              '  (' + y.ms + 'ms)');
          } else if (log) {
            log('  🔍 YOLO 失败: ' + String(y?.error || '').slice(0, 50));
          }
        } catch (e) {
          if (log) log('  🔍 YOLO 异常: ' + e.message.slice(0, 60));
        }
      }

      // —— 再跑大模型：慢，给语义理解 ——
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