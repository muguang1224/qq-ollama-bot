#!/usr/bin/env node
/**
 * TTS 语音合成 —— 让机器人能"说话"
 *
 * 用 edge-tts（微软 Edge 的在线语音，免费、音质好）把文字转成 mp3，
 * 再交给 NapCat 的 record 段发送 —— NapCat 内部会自动转成 QQ 需要的 SILK 格式。
 *
 * 为什么走 Python edge-tts：
 *   · 免费、无需 API Key
 *   · 中文女声自然（本机已装 edge-tts 7.3.1）
 *   · 项目已有 Node→Python 的调用模式（见 yolo.mjs），保持一致
 *
 * 格式链路：
 *   文字 → edge-tts → mp3 → NapCat createValidSendPttElement → SILK → QQ
 *
 * 局限（实测）：
 *   · 需要联网（edge-tts 是微软在线服务）
 *   · 单次合成约 1-3 秒，比纯文字慢，所以只适合偶尔发
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { which, execOpts } from './platform.mjs';

export const TTS_DEFAULTS = {
  enabled: false,                 // 总开关，默认关
  voice: 'zh-CN-XiaoyiNeural',    // 中文女声，Lively 风格，适合温柔人设
  rate: '+0%',                    // 语速：+10% 更快，-10% 更慢
  pitch: '+0Hz',                  // 音调
  volume: '+0%',
  chance: 0.15,                   // 随机发语音的概率
  minChars: 2,                    // 太短的不发语音
  maxChars: 60,                   // 太长的（转语音会很慢）不发
  cooldownMin: 30,                // 同一个人多久内不重复发语音（分钟）
  timeoutMs: 60000,
  python: '',                     // 留空自动找
};

/** 语音输出目录 */
const OUT_DIR = join(ROOT, '.tts-cache');
function ensureOut() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/** 找可用的 python */
function pythonExe(cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  if (c.python && existsSync(c.python)) return c.python;
  for (const p of ['python', 'python3', 'py']) {
    const w = which(p);
    if (w) return p;
  }
  return null;
}

/** edge-tts 是否可用 */
export function available(cfg) {
  const py = pythonExe(cfg);
  if (!py) return false;
  try {
    execFileSync(py, ['-c', 'import edge_tts'], execOpts({ timeout: 8000, stdio: 'ignore' }));
    return true;
  } catch {
    return false;
  }
}

/** 不可用的原因 */
export function unavailableReason(cfg) {
  if (!pythonExe(cfg)) return '找不到 python';
  try {
    execFileSync(pythonExe(cfg), ['-c', 'import edge_tts'], execOpts({ timeout: 8000, stdio: 'ignore' }));
    return '';
  } catch {
    return 'python 里没有 edge_tts，装一下：pip install edge-tts';
  }
}

/**
 * 合成语音
 * @param {string} text 要说的话
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, path?:string, fileUrl?:string, error?:string}>}
 */
export function synthesize(text, cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  return new Promise((resolve) => {
    const py = pythonExe(cfg);
    if (!py) return resolve({ ok: false, error: '找不到 python' });

    const s = String(text || '').trim();
    if (!s) return resolve({ ok: false, error: '文本为空' });
    if (s.length < c.minChars) return resolve({ ok: false, error: '文本太短' });
    if (s.length > c.maxChars) return resolve({ ok: false, error: '文本太长（' + s.length + ' > ' + c.maxChars + '）' });

    const out = join(ensureOut(), 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.mp3');

    const args = [
      '-m', 'edge_tts',
      '--voice', c.voice,
      '--rate', c.rate,
      '--pitch', c.pitch,
      '--volume', c.volume,
      '--text', s,
      '--write-media', out,
    ];

    execFile(py, args, execOpts({
      timeout: c.timeoutMs,
      maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }), (err, stdout, stderr) => {
      if (err) {
        return resolve({
          ok: false,
          error: ((err.message || '') + (stderr ? ' | ' + String(stderr).slice(0, 150) : '')).slice(0, 200),
        });
      }
      // 确认文件真的生成了
      try {
        const st = statSync(out);
        if (!st.size) {
          try { unlinkSync(out); } catch {}
          return resolve({ ok: false, error: '生成的文件是空的' });
        }
      } catch {
        return resolve({ ok: false, error: '没找到生成的音频文件' });
      }
      resolve({
        ok: true,
        path: out,
        // OneBot 的 record.file 接受 file:// URL 或本地路径
        fileUrl: 'file:///' + out.replace(/\\/g, '/'),
      });
    });
  });
}

/** 清理旧缓存（保留最近 N 个） */
export function cleanupCache(keep = 30) {
  try {
    const dir = ensureOut();
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => ({ f, p: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) {
      try { unlinkSync(x.p); } catch {}
    }
  } catch {}
}