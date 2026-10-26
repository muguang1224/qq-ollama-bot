/**
 * 语音转文字（ASR）—— 让机器人"听懂"视频和语音里说了什么。
 *
 * 为什么重要：视频信息有一半在声音里。之前只抽帧看画面，
 * 它能说出"一个红发女孩"却不知道剧情 —— 因为听不到台词。
 *
 * ## 技术选型（都是实测踩出来的）
 *
 * · 用 faster-whisper，不用 openai-whisper
 *   官方 whisper 要拖一个 2-3GB 的 torch；faster-whisper 基于 CTranslate2，
 *   CPU 上 int8 就够快，装完约 300MB，且不占宝贵的显存（显存要留给视觉模型）。
 *
 * · 用 GPT-SoVITS 自带的 python 环境
 *   它的 runtime 里已经装好 faster-whisper 1.1.1 和 modelscope，
 *   省掉一次几百 MB 的安装。所以这里直接调它的 python.exe。
 *
 * · 模型从 ModelScope 下载，不走 HuggingFace
 *   这台机器上 HF 直连不通（代理关掉后 HTTP 000），
 *   走 hf-mirror 会在 CAS 服务上 401。ModelScope 国内直连可用。
 *
 * · 模型用 medium，不用 base
 *   实测同一段粤语动漫：
 *     base   → "起羞移班約業務"        完全读错
 *     medium → "汽修二班药液目"        大致能懂
 *   代价是模型 1.42GB、CPU 转录 34 秒的音频要 20 秒。
 *
 * ## 已知局限
 *
 * · 方言（粤语等）识别率明显低于普通话
 * · 纯 BGM 无人声时返回空，这是正常的
 * · CPU 转录，长视频会慢（约 0.6x 实时）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

export const ASR_DEFAULTS = {
  enabled: true,
  // GPT-SoVITS 自带的 python（里面已有 faster-whisper 和 modelscope）
  //
  // 用正斜杠写路径：在 JSON 配置里写成 "D:\GPT-..." 时，
  // 其中 "\r" 会被解析成回车符，路径就变成 "...nvidia50untime\python.exe"，
  // 排查起来很费劲。正斜杠在 Windows 上一样能用，且没有转义坑。
  pythonPath: 'D:/GPT-SoVITS/GPT-SoVITS-v2pro-20250604-nvidia50/runtime/python.exe',
  model: 'medium',              // tiny/base/small/medium/large-v3
  modelRepo: 'pengzhendong/faster-whisper-{}',   // ModelScope 仓库模板
  language: 'zh',
  beamSize: 5,
  vadFilter: true,              // 去掉无人声片段，省时间也更准
  // 超时给足：模型 1.42GB，首次下载可能要几分钟；
  // 之后走缓存，34 秒的音频约 20 秒出结果。
  timeoutMs: 900000,
  maxSeconds: 300,              // 超过 5 分钟的视频只转前 5 分钟
  // initial_prompt 不只是"提示"，它会实际影响输出语言。
  // 实测同一段音频：
  //   不传   → 输出繁体（廣東省最終兵器 / 一邊聽年曲）
  //   传这句 → 输出简体（广东省最终兵器 / 一边听年曲）
  // whisper 会顺着 prompt 的语言风格走，所以这里固定用简体的提示。
  initialPrompt: '以下是普通话的内容。',
};

const WORK = join(ROOT, '.asr-work');

/** 找 ffmpeg */
function findFfmpeg() {
  const cands = [
    'ffmpeg',
    join(ROOT, 'ffmpeg.exe'),
    join(ROOT, 'SnowLuma', 'ffmpeg.exe'),
  ];
  for (const c of cands) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore', timeout: 8000 });
      return c;
    } catch {}
  }
  return null;
}

/**
 * 从视频/音频里抽成 16kHz 单声道 wav（whisper 要求）。
 * @returns {string|null} wav 路径
 */
function extractAudio(mediaPath, cfg, log) {
  const a = { ...ASR_DEFAULTS, ...(cfg?.asr || {}) };
  const ff = findFfmpeg();
  if (!ff) {
    log('  🎧 找不到 ffmpeg，无法抽音频');
    return null;
  }
  if (!existsSync(WORK)) mkdirSync(WORK, { recursive: true });
  const out = join(WORK, 'a' + Date.now() + '.wav');

  const args = ['-y', '-v', 'error', '-i', mediaPath];
  if (a.maxSeconds > 0) args.push('-t', String(a.maxSeconds));
  args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out);

  try {
    execFileSync(ff, args, { stdio: 'ignore', timeout: 120000 });
    if (existsSync(out) && statSync(out).size > 1000) return out;
    log('  🎧 抽出的音频太小，可能没有声音');
    return null;
  } catch (e) {
    log('  🎧 抽音频失败: ' + String(e.message).slice(0, 60));
    return null;
  }
}

/**
 * 转录一段音频。
 * @returns {Promise<{ok:boolean, text?:string, segments?:Array, error?:string}>}
 */
export async function transcribe(mediaPath, cfg, log = () => {}) {
  const a = { ...ASR_DEFAULTS, ...(cfg?.asr || {}) };
  if (a.enabled === false) return { ok: false, error: 'ASR 未开启' };
  if (!existsSync(mediaPath)) return { ok: false, error: '文件不存在' };
  if (!existsSync(a.pythonPath)) {
    return { ok: false, error: '找不到 python: ' + a.pythonPath };
  }

  const wav = extractAudio(mediaPath, cfg, log);
  if (!wav) return { ok: false, error: '没有可用音频' };

  // 生成一次性脚本（避免把长脚本塞进命令行）
  const script = join(WORK, 'run_' + Date.now() + '.py');
  const outJson = join(WORK, 'out_' + Date.now() + '.json');

  const py = `
import json, sys, os
# 模型缓存放在用户目录，跨次运行复用。
# 踩过的坑：第一次跑时 snapshot_download 会重新走一遍下载/校验，
# 34 秒的音频等了 300 秒还没结果就超时了 —— 其实是模型 1.42GB 在重下。
# 所以：先看缓存里有没有，有就直接用，没有才联网。
from modelscope import snapshot_download
from faster_whisper import WhisperModel

cfg = json.loads(open(r"""${join(WORK, 'cfg.json')}""", encoding='utf-8').read())

def local_path(repo):
    """ModelScope 的默认缓存位置"""
    base = os.path.expanduser('~/.cache/modelscope/hub/models')
    p = os.path.join(base, *repo.split('/'))
    return p if os.path.isdir(p) and os.path.exists(os.path.join(p, 'model.bin')) else None

d = local_path(cfg['repo'])
if not d:
    try:
        d = snapshot_download(cfg['repo'])
    except Exception as e:
        print(json.dumps({'ok': False, 'error': 'model download failed: ' + str(e)[:150]}))
        sys.exit(0)

try:
    m = WhisperModel(d, device='cpu', compute_type='int8')
    segs, info = m.transcribe(
        cfg['wav'], language=cfg['language'], beam_size=cfg['beam'],
        vad_filter=cfg['vad'],
        initial_prompt=cfg['prompt'] or None,
    )
    out = []
    for s in segs:
        t = s.text.strip()
        if t:
            out.append({'start': round(s.start, 1), 'end': round(s.end, 1), 'text': t})
    print(json.dumps({'ok': True, 'segments': out, 'language': info.language,
                      'duration': round(info.duration, 1)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)[:150]}))
`;

  try {
    const repo = String(a.modelRepo).replace('{}', a.model);
    writeFileSync(join(WORK, 'cfg.json'), JSON.stringify({
      repo, wav, language: a.language, beam: a.beamSize,
      vad: a.vadFilter, prompt: a.initialPrompt || '',
    }));
    writeFileSync(script, py, 'utf8');

    const out = execFileSync(a.pythonPath, [script], {
      encoding: 'utf8',
      timeout: a.timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    // 取最后一行 JSON（前面可能有下载进度条）
    const lines = String(out).split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
    if (!lines.length) return { ok: false, error: '没拿到结果' };
    const j = JSON.parse(lines[lines.length - 1]);
    if (!j.ok) return { ok: false, error: j.error || '未知错误' };

    if (!j.segments?.length) {
      return { ok: true, text: '', segments: [], empty: true };
    }
    // 拼成带时间的话；太长就只给文本
    const text = j.segments.map((s) => s.text).join(' ');
    return { ok: true, text, segments: j.segments, duration: j.duration };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 150) };
  } finally {
    for (const f of [script, outJson]) {
      try { if (existsSync(f)) unlinkSync(f); } catch {}
    }
    try { if (existsSync(wav)) unlinkSync(wav); } catch {}
  }
}

/** 生成给模型看的台词文本 */
export function renderTranscript(asr) {
  if (!asr || !asr.ok || !asr.segments?.length) return '';
  const lines = asr.segments.slice(0, 40).map((s) =>
    s.start + 's: ' + s.text
  );
  return '\n【视频里说的话（语音转文字）】\n' + lines.join('\n') +
    '\n（这是机器转写的，方言和口音可能听错。可以引用台词，' +
    '但别把听错的部分当事实。）';
}