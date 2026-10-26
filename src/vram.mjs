/**
 * 显存仲裁 —— 视觉模型和语音合成抢 8GB 显存时，自动排队。
 *
 * 背景（实测数据，RTX 5060 Laptop 8GB）：
 *   · qwen2.5vl:3b 加载需要 ~8.5GB 空闲（显存 + 系统内存合计）
 *   · GPT-SoVITS 常驻占约 1.5GB 显存
 *   · 两个同时开着时，Ollama 反复报
 *       "model requires more system memory (9.9 GiB) than is available (9.9 GiB)"
 *     而且它的分层加载从 36 层一路降到 3 层仍然失败
 *   · 关掉 GPT-SoVITS 后：显存空闲 5.5 -> 6.7GB，内存 5.8 -> 8.2GB，识别立刻成功
 *
 * 所以策略是「谁用谁在场」：
 *   · 要识别图片/视频 -> 如果 GPT-SoVITS 在跑，先把它停掉，识别完再拉起来
 *   · 要发语音       -> 如果视觉模型占着，等它自然释放（keep_alive 到点就退）
 *
 * 为什么不常驻两个：8GB 显存物理上放不下，没有别的办法。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

const STATE_FILE = join(ROOT, '.vram-state.json');

/**
 * 找出 GPT-SoVITS 的进程。
 *
 * 它的命令行是：
 *   runtime\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
 * 进程名是 python.exe，靠命令行里的 api_v2.py 认出来。
 *
 * 一开始用 wmic 取 CommandLine，实测在新版 Windows 上 wmic 已被弃用，
 * 输出里拿不到命令行的完整内容（中文路径还会乱码），所以改用 PowerShell。
 */
function findSovitsPids() {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*api_v2.py*' } | " +
      "ForEach-Object { $_.ProcessId }",
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return String(out).split(/\s+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

/** 停掉 GPT-SoVITS，返回被停掉的 pid 列表（供之后恢复） */
export function pauseSovits() {
  const pids = findSovitsPids();
  if (!pids.length) return { stopped: [], pids: [] };
  for (const pid of pids) {
    try {
      execFileSync('taskkill', ['/F', '/PID', String(pid)], {
        stdio: 'ignore', timeout: 8000, windowsHide: true,
      });
    } catch {}
  }
  // 记下来，识别完可以恢复
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ stoppedAt: Date.now(), pids }));
  } catch {}
  return { stopped: pids, pids };
}

/** 释放系统待机内存（不需要管理员权限的变通法） */
export function trimMemory() {
  try {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      'Get-Process | ForEach-Object { try { $_.MinWorkingSet = $_.MinWorkingSet } catch {} }; ' +
      '[System.GC]::Collect(); [System.GC]::WaitForPendingFinalizers()',
    ], { stdio: 'ignore', timeout: 20000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 当前显存空闲（MB），取不到返回 -1 */
export function freeVramMB() {
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=memory.free', '--format=csv,noheader,nounits',
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

/**
 * 为视觉识别做准备：腾出显存和内存。
 *
 * 实测（RTX 5060 Laptop 8GB）三大占用者：
 *   ① 聊天模型 qwen3.5-4b   —— Ollama 常驻，占约 4.5GB 显存
 *   ② GPT-SoVITS            —— 常驻，占约 1.5GB 显存
 *   ③ 桌面图形程序           —— 浏览器/explorer 等，合计约 1-2GB
 * 视觉模型要 ~8.5GB，三者都在时必然加载失败。
 *
 * 所以先请两位 AI 服务让位：
 *   · 聊天模型 -> 让 Ollama 卸载（keep_alive: 0），识别完自然会在下次对话时重载
 *   · GPT-SoVITS -> 停进程（识别完由调用方决定是否拉回）
 *
 * @param {object} cfg
 * @param {function} log
 * @returns {Promise<{paused:number[], unloaded:boolean}>}
 */
export async function prepareForVision(cfg, log = () => {}) {
  const vc = cfg?.vram || {};
  if (vc.autoFree === false) return { paused: [], unloaded: false };

  const needMB = vc.minFreeVramMB ?? 6000;
  let before = freeVramMB();
  let paused = [];
  let unloaded = false;

  // ① 显存不够 -> 先卸聊天模型（它占得最多，也最容易恢复）
  if (before >= 0 && before < needMB) {
    log('  🎬 显存只剩 ' + before + ' MB（需要 ' + needMB + '），先卸掉聊天模型');
    try {
      const r = await fetch((cfg.ollama?.baseUrl || 'http://127.0.0.1:11434') + '/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: cfg.ollama?.model || 'qwen3.5-4b', keep_alive: 0 }),
      });
      await r.json();
      unloaded = true;
    } catch (e) {
      log('  🎬 卸载聊天模型失败: ' + String(e.message).slice(0, 60));
    }
    await new Promise((r) => setTimeout(r, vc.waitMs ?? 3000));
  }

  // ② 还不够 -> 请 GPT-SoVITS 让位
  let mid = freeVramMB();
  if (mid >= 0 && mid < needMB) {
    log('  🎬 显存仍只有 ' + mid + ' MB，让语音合成也让位');
    const r = pauseSovits();
    paused = r.stopped;
    if (paused.length) log('  🎬 已暂停 GPT-SoVITS（PID ' + paused.join(',') + '）');
    await new Promise((r) => setTimeout(r, vc.waitMs ?? 3000));
  }

  // ③ 系统内存也压一压
  trimMemory();
  await new Promise((r) => setTimeout(r, 1200));

  const after = freeVramMB();
  if (before >= 0 && after >= 0) {
    log('  🎬 显存 ' + before + ' -> ' + after + ' MB');
  }
  return { paused, unloaded };
}

/** 是否之前暂停过 GPT-SoVITS */
export function sovitsWasPaused() {
  try {
    if (!existsSync(STATE_FILE)) return false;
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return Date.now() - (j.stoppedAt || 0) < 10 * 60000;
  } catch {
    return false;
  }
}