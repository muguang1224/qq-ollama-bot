#!/usr/bin/env node
/**
 * TTS 语音合成 —— 让机器人能"说话"
 *
 * 支持两种引擎：
 *
 *  1. sovits —— GPT-SoVITS 声音克隆（默认，音色是自定义的）
 *     · 需要本地跑一个 API 服务：D:\GPT-SoVITS\...\runtime\python.exe api_v2.py
 *     · 监听 127.0.0.1:9880
 *     · 用一段参考音频 + 参考文本克隆音色，首次约 20s，之后约 3s
 *     · 服务没起来时自动回退到 edge-tts
 *
 *  2. edge —— 微软 Edge 在线语音（备选）
 *     · 免费、无需 API Key、不吃显存
 *     · 需要联网
 *
 * 格式链路：
 *   文字 → (sovits wav | edge mp3) → OneBot record 段 → SILK → QQ
 *   SILK 转换由 OneBot 后端（SnowLuma/NapCat）内部完成
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';
import { which, execOpts } from './platform.mjs';

export const TTS_DEFAULTS = {
  enabled: false,                 // 总开关，默认关

  // —— 引擎选择 ——
  engine: 'sovits',               // 'sovits'（克隆音色）| 'edge'（微软在线）

  // —— GPT-SoVITS（engine=sovits 时生效）——
  sovitsUrl: 'http://127.0.0.1:9880/tts',
  sovitsRef: '',                  // 参考音频绝对路径；留空则用 refDir/ref_b.wav
  sovitsRefDir: '',               // 参考音频目录；留空则用 <项目根>/voice-ref
  sovitsPrompt: '',               // 参考音频对应的文字（必须准确，否则不像）
  sovitsPromptLang: 'zh',
  sovitsSpeed: 1.0,               // 语速
  sovitsTemperature: 0.8,         // 采样温度（调低更稳，调高更活）
  sovitsTopK: 6,                  // 采样范围（调低更贴参考音色）
  sovitsTopP: 0.85,
  sovitsTimeoutMs: 120000,        // 克隆比较慢，给足时间

  // —— edge-tts（engine=edge，或 sovits 不可用时回退）——
  voice: 'zh-CN-XiaoyiNeural',    // 中文女声
  rate: '+0%',                    // 语速：+10% 更快，-10% 更慢
  pitch: '+0Hz',                  // 音调
  volume: '+0%',
  python: '',                     // 留空自动找

  // —— 通用 ——
  chance: 0.15,                   // 随机发语音的概率
  minChars: 2,                    // 太短的不发语音
  maxChars: 60,                   // 太长的（合成慢）不发
  cooldownMin: 30,                // 同一个人多久内不重复发语音（分钟）
  timeoutMs: 60000,
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

/** GPT-SoVITS 是否可用（探测它的 HTTP 服务） */
export async function sovitsAvailable(cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  const base = String(c.sovitsUrl || '').replace(/\/tts\/?$/, '');
  if (!base) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(base + '/', { signal: ctl.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch {
    return false;
  }
}

/** 参考音频路径 */
function sovitsRefPath(cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  if (c.sovitsRef && existsSync(c.sovitsRef)) return c.sovitsRef;
  const dir = c.sovitsRefDir && existsSync(c.sovitsRefDir)
    ? c.sovitsRefDir
    : join(ROOT, 'voice-ref');
  for (const name of ['ref_b.wav', 'ref.wav', 'ref_a.wav']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
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

/** 用 GPT-SoVITS 克隆音色合成 */
async function synthSovits(text, cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  const ref = sovitsRefPath(cfg);
  if (!ref) return { ok: false, error: '找不到参考音频（voice-ref/ 下放 ref_b.wav）' };
  if (!c.sovitsPrompt) return { ok: false, error: '没配 sovitsPrompt（参考音频对应的文字）' };

  const out = join(ensureOut(), 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.wav');

  const body = {
    text,
    text_lang: 'zh',
    ref_audio_path: ref,
    prompt_text: c.sovitsPrompt,
    prompt_lang: c.sovitsPromptLang || 'zh',
    text_split_method: 'cut5',
    batch_size: 1,
    media_type: 'wav',
    streaming_mode: false,
    speed_factor: c.sovitsSpeed ?? 1.0,
    temperature: c.sovitsTemperature ?? 0.8,
    top_k: c.sovitsTopK ?? 6,
    top_p: c.sovitsTopP ?? 0.85,
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.sovitsTimeoutMs ?? 120000);
  try {
    const r = await fetch(c.sovitsUrl || 'http://127.0.0.1:9880/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { ok: false, error: 'GPT-SoVITS HTTP ' + r.status + ' ' + txt.slice(0, 120) };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return { ok: false, error: 'GPT-SoVITS 返回空音频' };
    writeFileSync(out, buf);
    return { ok: true, path: out, fileUrl: 'file:///' + out.replace(/\\/g, '/'), engine: 'sovits' };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: 'GPT-SoVITS 请求失败: ' + (e.message || e.name) };
  }
}

/** 用 edge-tts 合成 */
function synthEdge(text, cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  return new Promise((resolve) => {
    const py = pythonExe(cfg);
    if (!py) return resolve({ ok: false, error: '找不到 python' });

    const out = join(ensureOut(), 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.mp3');

    const args = [
      '-m', 'edge_tts',
      '--voice', c.voice,
      // 必须用 --opt=值 的写法。
      // 写成 ['--rate', '-10%'] 时，argparse 会把以 - 开头的值当成选项，
      // 报 "argument --rate: expected one argument"。
      '--rate=' + c.rate,
      '--pitch=' + c.pitch,
      '--volume=' + c.volume,
      '--text', text,
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
      try {
        const st = statSync(out);
        if (!st.size) {
          try { unlinkSync(out); } catch {}
          return resolve({ ok: false, error: '生成的文件是空的' });
        }
      } catch {
        return resolve({ ok: false, error: '没找到生成的音频文件' });
      }
      resolve({ ok: true, path: out, fileUrl: 'file:///' + out.replace(/\\/g, '/'), engine: 'edge' });
    });
  });
}

/**
 * 合成语音（自动选引擎）
 *
 * engine=sovits 时优先用 GPT-SoVITS；失败则回退 edge-tts，
 * 这样克隆服务没启动时语音功能仍然可用。
 *
 * @param {string} text 要说的话
 * @param {object} cfg
 * @returns {Promise<{ok:boolean, path?:string, fileUrl?:string, engine?:string, error?:string}>}
 */
export async function synthesize(text, cfg) {
  const c = { ...TTS_DEFAULTS, ...(cfg?.tts || {}) };
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: '文本为空' };
  if (s.length < c.minChars) return { ok: false, error: '文本太短' };
  if (s.length > c.maxChars) return { ok: false, error: '文本太长（' + s.length + ' > ' + c.maxChars + '）' };

  if (c.engine === 'sovits') {
    const r = await synthSovits(s, cfg);
    if (r.ok) return r;
    // 回退
    const e = await synthEdge(s, cfg);
    if (e.ok) {
      e.fellBackFrom = 'sovits: ' + r.error;
      return e;
    }
    return { ok: false, error: 'sovits 失败(' + r.error + ')，edge 也失败(' + e.error + ')' };
  }

  return synthEdge(s, cfg);
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