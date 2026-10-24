#!/usr/bin/env node
/**
 * YOLO 桥接 —— 让 Node 调用 Python YOLO 推理
 *
 * 实测数据（本机 RTX 5060 + Ultra 7 255HX，ONNX CPU 推理）：
 *   YOLO11n 单张 ~500-1000ms，模型仅 10MB
 *   qwen2.5vl:3b 单张 1-200 秒（内存不足时跑 CPU），模型 3.2GB
 *
 * 定位：
 *   YOLO 给【客观事实】—— 有几个人、什么物体、什么构图
 *   大模型给【语义理解】—— 画的是什么、什么情绪
 *   两者独立跑，结果都存，互相补充
 *
 * 局限（实测）：
 *   YOLO 对卡通/表情包基本无效 —— COCO 全是真实照片，
 *   会把动漫角色误判成"时钟"。所以它的结果只作参考，不能当结论。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 本文件可能放在项目根目录（本地开发）或 src/ 下（发布版），
// 两种情况都要能找到 yolo-models/，所以把两级目录都作为候选。
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOTS = [HERE, dirname(HERE)];

export const YOLO_DEFAULTS = {
  enabled: true,
  python: 'python',
  script: '',          // 留空则自动找
  modelDir: '',        // 留空则自动找 <root>/yolo-models
  timeoutMs: 30000,
  confThres: 0.35,
};

/** yolo.py 的位置 */
function scriptPath(cfg) {
  const c = { ...YOLO_DEFAULTS, ...(cfg?.yolo || {}) };
  if (c.script && existsSync(c.script)) return c.script;

  // 依次找几个常见位置
  const cands = [];
  for (const r of ROOTS) {
    cands.push(join(r, 'yolo-models', 'yolo.py'));
    cands.push(join(r, 'yolo', 'yolo.py'));
    cands.push(join(r, 'src', 'yolo', 'yolo.py'));
  }
  for (const p of cands) if (existsSync(p)) return p;
  return null;
}

/** 模型目录 */
function modelDir(cfg) {
  const c = { ...YOLO_DEFAULTS, ...(cfg?.yolo || {}) };
  if (c.modelDir && existsSync(c.modelDir)) return c.modelDir;
  for (const r of ROOTS) {
    for (const name of ['yolo-models', 'yolo', 'models']) {
      const d = join(r, name);
      if (existsSync(join(d, 'yolo11n.onnx'))) return d;
    }
  }
  return null;
}

/** YOLO 是否可用 */
export function available(cfg) {
  return !!(scriptPath(cfg) && modelDir(cfg));
}

/** 不可用的原因 */
export function unavailableReason(cfg) {
  if (!scriptPath(cfg)) return '找不到 yolo.py';
  if (!modelDir(cfg)) return '找不到 onnx 模型（需要在 yolo-models/ 下放 yolo11n.onnx 等）';
  return '';
}

/** 跑一次推理 */
function run(py, script, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(py, [script, ...args], {
      cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 * 4,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return resolve({ ok: false, error: (err.message || '').slice(0, 150) + (stderr ? ' | ' + String(stderr).slice(0, 150) : '') });
      }
      const t = String(stdout || '').trim();
      const m = t.match(/\{[\s\S]*\}/);
      if (!m) return resolve({ ok: false, error: '没有 JSON 输出: ' + t.slice(0, 100) });
      try { resolve(JSON.parse(m[0])); }
      catch { resolve({ ok: false, error: 'JSON 解析失败' }); }
    });
  });
}

/**
 * 对一张图跑 YOLO。
 * @returns {Promise<{ok:boolean, persons?:number, objects?:Array, top5?:Array, ms?:number, error?:string}>}
 */
export async function analyze(imagePath, cfg, mode = 'all') {
  const c = { ...YOLO_DEFAULTS, ...(cfg?.yolo || {}) };
  if (c.enabled === false) return { ok: false, error: 'YOLO 已关闭' };

  const script = scriptPath(cfg);
  const dir = modelDir(cfg);
  if (!script || !dir) return { ok: false, error: unavailableReason(cfg) };

  // Python 在 modelDir 下运行，相对路径会失效 → 必须用绝对路径
  const abs = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath);
  if (!existsSync(abs)) return { ok: false, error: '图片不存在: ' + abs };

  return run(c.python, script, [mode, abs], dir, c.timeoutMs);
}

/**
 * 把 YOLO 结果转成一句人话，用于喂给大模型 / 存进索引。
 *
 * 注意措辞：YOLO 对卡通图不准，所以说"检测到"而不是断言。
 */
export function render(yolo) {
  if (!yolo || !yolo.ok) return '';

  const bits = [];

  // 物体检测
  const det = yolo.detect || yolo;
  if (det.objects && det.objects.length) {
    // 合并同类，统计个数
    const count = {};
    for (const o of det.objects) {
      const k = o.nameCn || o.name;
      count[k] = (count[k] || 0) + 1;
    }
    const parts = Object.entries(count)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, n]) => (n > 1 ? k + '×' + n : k));
    bits.push('检测到 ' + parts.join('、'));
  }

  // 姿态：人数
  const pose = yolo.pose;
  if (pose && pose.ok && typeof pose.persons === 'number') {
    if (pose.persons > 0) bits.push(pose.persons + ' 个人形');
    else bits.push('没有清晰人形');
  }

  // 分类 top1
  const cls = yolo.cls;
  if (cls && cls.ok && cls.top5 && cls.top5.length) {
    const t = cls.top5[0];
    if (t.prob > 0.15) bits.push('最像类别#' + t.id + '(' + (t.prob * 100).toFixed(0) + '%)');
  }

  return bits.join('，');
}