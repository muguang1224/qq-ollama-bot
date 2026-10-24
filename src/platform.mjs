// 平台相关的小工具 —— 让同一套代码在 Windows / Linux / macOS 都能跑。
//
// 背景：项目原来只在 Windows 上跑过，代码里散落着一些平台假设：
//   · execFile 的 windowsHide 选项（Linux 上无意义）
//   · 推断 ffprobe 路径时只考虑 .exe
//   · 用 netstat 查端口（Linux 上是 ss）
//   · 硬编码反斜杠拼路径
// 集中到这里，各模块按需引用。

import { platform } from 'node:process';
import { delimiter, join } from 'node:path';
import { existsSync } from 'node:fs';

export const IS_WINDOWS = platform === 'win32';
export const IS_LINUX = platform === 'linux';
export const IS_MAC = platform === 'darwin';

/**
 * execFile / execFileSync 的通用选项。
 * windowsHide 只在 Windows 有意义，其它平台传了也无害，
 * 但集中处理更方便（以后要加别的平台选项也只改这里）。
 */
export function execOpts(extra = {}) {
  const o = { ...extra };
  if (IS_WINDOWS) o.windowsHide = true;
  return o;
}

/**
 * 在 PATH 里找一个可执行文件，返回可用路径。
 * Windows 上会尝试 .exe/.cmd/.bat 后缀。
 */
export function which(cmd) {
  const paths = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = IS_WINDOWS ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of paths) {
    for (const e of exts) {
      const p = join(dir, cmd + e);
      try { if (existsSync(p)) return p; } catch {}
    }
  }
  return null;
}

/**
 * 从 ffmpeg 的路径推出 ffprobe 的路径。
 *
 * Windows 上名字是 ffmpeg.exe / ffprobe.exe；
 * Linux 上是 ffmpeg / ffprobe。之前只处理了 .exe，
 * 在 Linux 上会把 "ffmpeg" 换成 "ffprobe" 失败后回退到 PATH，
 * 大部分情况也能用，但显式处理更稳。
 */
export function ffprobeFrom(ffmpegPath) {
  if (!ffmpegPath || ffmpegPath === 'ffmpeg') return 'ffprobe';
  // 按路径本身的形态决定加不加 .exe，而不是按当前平台 ——
  // 这样即使配置里写的是另一种平台的路径，结果也合理
  const isExe = /\.exe$/i.test(ffmpegPath);
  const base = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, '');
  return base + (isExe ? 'ffprobe.exe' : 'ffprobe');
}

/** 查端口是否在监听：Windows 用 netstat，Linux 用 ss，macOS 用 lsof */
export function listenCmd(port) {
  if (IS_WINDOWS) {
    return { cmd: 'netstat', args: ['-ano'], match: ':' + port, needle: 'LISTENING' };
  }
  if (IS_MAC) {
    return { cmd: 'lsof', args: ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], match: ':' + port, needle: 'LISTEN' };
  }
  // Linux
  return { cmd: 'ss', args: ['-lntp'], match: ':' + port, needle: 'LISTEN' };
}

/**
 * 把绝对路径转成 OneBot 的 file:// URL。
 * Windows: C:\a\b.jpg → file:///C:/a/b.jpg
 * Linux:   /a/b.jpg   → file:///a/b.jpg
 * 关键是把反斜杠统一成正斜杠，并保证有三个斜杠。
 */
export function fileUrl(absPath) {
  const p = String(absPath).replace(/\\/g, '/');
  if (p.startsWith('/')) return 'file://' + p;
  return 'file:///' + p;
}

/** 把路径拼成 OneBot 能认的形式（统一正斜杠） */
export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** 描述当前平台，用于启动日志 */
export function platformLabel() {
  if (IS_WINDOWS) return 'Windows';
  if (IS_LINUX) return 'Linux';
  if (IS_MAC) return 'macOS';
  return platform;
}