// 视频 / 语音处理
//
// 实测结论（重要）：
//   - QQ 视频消息的类型是 "file" 而不是 "video"，靠扩展名判断
//   - get_file 能拿到视频文件（实测 24 MB 的 mp4 下载成功）
//   - ffmpeg 抽帧必须缩到 256px，512px 会因内存不足失败
//     （实测报 "model requires more system memory (9.3 GiB)"）
//   - 抽帧后逐帧交给视觉模型，拼成描述
//
// 注意这不是"理解视频"，而是"看几张截图"。要在 prompt 里说清楚。

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './paths.mjs';
import { which, execOpts, ffprobeFrom } from './platform.mjs';

const WORK = join(ROOT, '.video-work');
if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });

export const VIDEO_DEFAULTS = {
  enabled: true,
  frames: 3,            // 抽几帧
  width: 256,           // 抽帧宽度（超过 384 容易内存不足）
  ffmpeg: '',           // 留空则从 PATH 找
  maxMB: 80,            // 超过这个大小的视频不处理
  timeoutMs: 120000,
};

/** 视频扩展名 */
const VIDEO_EXT = ['.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.webm', '.m4v', '.ts', '.3gp'];

/** 判断一个消息段是不是视频 */
export function isVideoSeg(seg) {
  if (!seg) return false;
  const f = seg.data?.file || seg.data?.file_id || seg.data?.url || '';
  const ext = extname(String(f)).toLowerCase();
  if (VIDEO_EXT.includes(ext)) return true;
  // 有些实现会正确标成 video
  return seg.type === 'video';
}

/** 判断是不是语音 */
export function isVoiceSeg(seg) {
  if (!seg) return false;
  if (seg.type === 'record') return true;
  const f = seg.data?.file || '';
  return /\.(amr|silk|slk|mp3|wav|m4a|ogg|aac)$/i.test(String(f));
}

/** 找 ffmpeg：配置 > PATH（跨平台，Windows 上会找 ffmpeg.exe） */
function findFfmpeg(cfg) {
  if (cfg?.video?.ffmpeg && existsSync(cfg.video.ffmpeg)) return cfg.video.ffmpeg;
  const found = which('ffmpeg');
  return found || 'ffmpeg';
}

/** 跑外部命令，分开返回 stdout / stderr */
function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, execOpts({ timeout, maxBuffer: 1024 * 1024 * 8 }),
      (err, stdout, stderr) => resolve({
        ok: !err,
        err: err?.message || '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      }));
  });
}

/**
 * 用 ffprobe 读时长（秒），失败返回 0。
 *
 * 注意：ffprobe 的结果输出到 **stdout**，不是 stderr。
 * （一开始读错了，导致时长总是 0，抽帧位置全错，一帧都抽不到。）
 */
async function probeDuration(file, cfg) {
  const ffprobe = findFfprobe(cfg);
  if (!ffprobe) return 0;
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file], 30000);
  if (!r.ok) return 0;
  const n = parseFloat(r.stdout.trim()) || 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 找 ffprobe：和 ffmpeg 同目录（跨平台处理 .exe 后缀） */
function findFfprobe(cfg) {
  const configured = cfg?.video?.ffprobe;
  if (configured && existsSync(configured)) return configured;

  const ff = findFfmpeg(cfg);
  const guess = ffprobeFrom(ff);
  // 配置里给了明确路径时，从它推同目录的 ffprobe
  if (ff && ff !== 'ffmpeg' && existsSync(guess)) return guess;

  const found = which('ffprobe');
  return found || guess;
}

/**
 * 把视频抽成几帧图片。
 * @returns {Promise<{frames:string[], duration:number, error?:string}>}
 */
export async function extractFrames(videoPath, cfg) {
  const v = { ...VIDEO_DEFAULTS, ...(cfg?.video || {}) };
  if (!existsSync(videoPath)) return { frames: [], duration: 0, error: '文件不存在' };

  const sizeMB = statSync(videoPath).size / 1048576;
  if (v.maxMB > 0 && sizeMB > v.maxMB) {
    return { frames: [], duration: 0, error: '视频太大（' + sizeMB.toFixed(0) + 'MB > ' + v.maxMB + 'MB）' };
  }

  const ff = findFfmpeg(cfg);

  // 先探时长，决定抽帧位置
  const dur = await probeDuration(videoPath, cfg);

  const n = Math.max(1, Math.min(8, v.frames || 3));
  const tag = 'v' + Date.now();

  /** 在某个时间点抽一帧，成功返回路径 */
  const grab = async (t, idx) => {
    const out = join(WORK, tag + '_' + idx + '.jpg');
    const r = await run(ff, [
      '-y', '-v', 'error',
      '-ss', Math.max(0, t).toFixed(2),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=' + (v.width || 256) + ':-1',
      '-q:v', '6',
      out,
    ], v.timeoutMs || 120000);
    return (existsSync(out)) ? out : null;
  };

  const frames = [];

  if (dur > 0) {
    // 知道时长：均匀分布（避开开头结尾）
    const times = [];
    for (let i = 0; i < n; i++) {
      times.push(n === 1 ? dur * 0.5 : dur * (0.1 + 0.8 * (i / (n - 1))));
    }
    for (let i = 0; i < times.length; i++) {
      const f = await grab(times[i], i);
      if (f) frames.push(f);
    }
  } else {
    // 探不到时长：先在前几秒密集尝试，找到有画面的位置再往外扩
    const probeTimes = [0.5, 1, 2, 3, 5, 8, 12, 20, 30];
    for (let i = 0; i < probeTimes.length && frames.length < n; i++) {
      const f = await grab(probeTimes[i], i);
      if (f) frames.push(f);
    }
    if (!frames.length) {
      // 全都失败 → 试试只抽第一帧（有些格式只能从头解）
      const f = await grab(0, 99);
      if (f) frames.push(f);
    }
  }

  return { frames, duration: dur, tag };
}

/** 清掉抽帧产生的临时文件 */
export function cleanupFrames(frames) {
  for (const f of frames || []) {
    try { if (existsSync(f)) rmSync(f); } catch {}
  }
}

/** 清掉所有残留（启动时调用，避免堆积） */
export function cleanupWork() {
  try {
    for (const f of readdirSync(WORK)) {
      try { rmSync(join(WORK, f), { force: true }); } catch {}
    }
  } catch {}
}

/**
 * 把多个帧交给视觉模型，拼成一段描述。
 * @param {string[]} frames   帧文件路径
 * @param {object} cfg        配置（用 cfg.vision.model）
 * @param {function} describeFrame  单帧识别函数（由 stickers.describe 提供）
 * @returns {Promise<{summary:string, parts:string[]}>}
 */
export async function describeVideo(frames, cfg, describeFrame, log, duration) {
  const parts = [];
  for (let i = 0; i < frames.length; i++) {
    try {
      const d = await describeFrame(frames[i], cfg, 90000);
      const t = (d.visual || '').trim();
      if (t) parts.push({ i, text: t });
    } catch (e) {
      if (log) log('    帧识别失败: ' + e.message.slice(0, 50));
    }
  }
  if (!parts.length) return { summary: '', parts: [] };

  // 去重：只在完全相同、或一个是另一个的子串时才合并。
  //
  // 原来写的是 `p.includes(u.slice(0, 6))` —— 取前 6 个字比较，
  // 结果「一个红发少女」和「一个红发女孩」前 6 字相同就被当成重复丢掉了，
  // 可它们描述的是不同画面。现在收紧到"完整包含"才算重复。
  const uniq = [];
  for (const p of parts) {
    const dup = uniq.some((u) =>
      u.text === p.text ||
      (p.text.length >= 8 && u.text.includes(p.text)) ||
      (u.text.length >= 8 && p.text.includes(u.text))
    );
    if (!dup) uniq.push(p);
  }

  // 带时间线：让模型知道画面的先后，才能讲出"发生了什么"。
  // 抽帧位置和 extractFrames 保持一致（时长已知时按 10%~90% 均匀分布）。
  const n = frames.length;
  const dur = Number(duration) || 0;
  let summary;

  if (dur > 0 && n > 1) {
    summary = uniq.map((u) => {
      const ratio = 0.1 + 0.8 * (u.i / (n - 1));
      return Math.round(dur * ratio) + 's: ' + u.text;
    }).join('  ');
  } else {
    summary = uniq.map((u) => u.text).join('；');
  }

  return { summary, parts: uniq.map((u) => u.text) };
}

/**
 * 生成给模型看的描述文本。
 *
 * ⚠️ 这里踩过一个坑，值得记下来：
 *
 * 原来结尾固定写「中间的过程、人物说的话、以及声音你都没有听到」。
 * 本意是提醒它别编剧情，但**当 ASR 已经给出台词时，这句话变成了自我否定** ——
 * 上下文里前面刚列出「【视频里说的话】0s: 广东省最终兵器...」，
 * 后面紧接着说「人物说的话你没听到」，模型直接懵了，
 * 于是回复变成「发文件过来了吗？我看看里面是什么呀」——
 * 明明有一整套画面和台词，它却当成没收到。
 *
 * 现在分两种情况写，措辞必须和实际给了什么数据一致：
 *   · 只有画面（ASR 没跑或没识别人声）→ 说明过程、声音都没有
 *   · 有台词 → 说明可以引用台词，只是转写可能有错
 *
 * @param {object} video { duration, summary }
 * @param {boolean} hasTranscript 是否附带了台词
 */
export function renderVideoNote(video, hasTranscript = false) {
  if (!video) return '';
  const bits = [];
  if (video.duration) bits.push('时长约 ' + Math.round(video.duration) + ' 秒');
  if (video.summary) {
    // 去掉 summary 结尾的标点，免得和拼接时的句号撞在一起（"。。"）
    bits.push('画面按时间抽样：' + String(video.summary).replace(/[。；;，,、\s]+$/, ''));
  }
  if (!bits.length) return '';

  const tail = hasTranscript
    ? '。这是每隔几秒抽一帧看到的画面，台词是机器转写的（方言口音可能听错）。' +
      '画面和台词里出现的东西都可以聊，但别编造中间没抽到的过程。'
    : '。这是每隔几秒抽一帧看到的画面，中间的过程和声音你都没有 —— ' +
      '所以可以聊画面里出现的东西，但别断言"剧情讲了什么"。';

  return '\n（对方发了一段视频：' + bits.join('，') + tail + '）';
}