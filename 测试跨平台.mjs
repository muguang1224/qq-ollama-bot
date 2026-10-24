#!/usr/bin/env node
// 跨平台工具测试
// 用法: node 测试跨平台.mjs
import { existsSync } from 'node:fs';

// 模块可能在 src/ 下（发布版）
const P = await import('./src/platform.mjs');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log('  ' + (ok ? '✅' : '❌') + ' ' + n + (extra ? '  ' + extra : ''));
  ok ? pass++ : fail++;
};

console.log('='.repeat(64));
console.log('  跨平台工具测试');
console.log('='.repeat(64));
console.log('  当前平台: ' + P.platformLabel());

console.log('\n[1] 平台判断');
check('至少认出一个平台', P.IS_WINDOWS || P.IS_LINUX || P.IS_MAC,
  [P.IS_WINDOWS && 'Windows', P.IS_LINUX && 'Linux', P.IS_MAC && 'macOS'].filter(Boolean).join(', '));

console.log('\n[2] fileUrl —— 路径转 OneBot 格式');
{
  // 关键：不能出现反斜杠，必须三个斜杠
  const win = P.fileUrl('C:\\a\\b\\test.gif');
  const lin = P.fileUrl('/home/user/stickers/test.gif');
  console.log('    Windows: ' + win);
  console.log('    Linux  : ' + lin);
  check('Windows 路径无反斜杠', !win.includes('\\'), win);
  check('Windows 以 file:/// 开头', win.startsWith('file:///'), win);
  check('Linux 路径正确', lin === 'file:///home/user/stickers/test.gif', lin);
  check('Linux 无多余斜杠', !lin.startsWith('file:////'), lin);
}

console.log('\n[3] execOpts —— 平台相关选项');
{
  const o = P.execOpts({ timeout: 5000 });
  check('保留传入的选项', o.timeout === 5000);
  if (P.IS_WINDOWS) check('Windows 上带 windowsHide', o.windowsHide === true);
  else check('非 Windows 不加 windowsHide', o.windowsHide === undefined);
}

console.log('\n[4] ffprobeFrom —— 从 ffmpeg 推 ffprobe');
{
  const a = P.ffprobeFrom('C:\\ffmpeg\\bin\\ffmpeg.exe');
  const b = P.ffprobeFrom('/usr/bin/ffmpeg');
  const c = P.ffprobeFrom('ffmpeg');
  console.log('    ' + a);
  console.log('    ' + b);
  console.log('    ' + c);
  // 按路径形态判断，与当前平台无关
  check('Windows 风格路径 → .exe', a === 'C:\\ffmpeg\\bin\\ffprobe.exe', a);
  check('Linux 风格路径 → 无后缀', b === '/usr/bin/ffprobe', b);
  check('裸 ffmpeg 返回 ffprobe', c === 'ffprobe', c);
}

console.log('\n[5] which —— 找可执行文件');
{
  const node = P.which('node');
  check('能找到 node', !!node, node || '没找到');
  const nope = P.which('这个命令肯定不存在_xyz123');
  check('找不到时返回 null', nope === null);
}

console.log('\n[6] listenCmd —— 查端口命令');
{
  const l = P.listenCmd(3001);
  console.log('    ' + l.cmd + ' ' + l.args.join(' '));
  if (P.IS_WINDOWS) check('Windows 用 netstat', l.cmd === 'netstat');
  else if (P.IS_MAC) check('macOS 用 lsof', l.cmd === 'lsof');
  else check('Linux 用 ss', l.cmd === 'ss');
  check('命令名非空', !!l.cmd);
}

console.log('\n[7] toPosix');
{
  check('反斜杠转正斜杠', P.toPosix('a\\b\\c') === 'a/b/c', P.toPosix('a\\b\\c'));
  check('已经是正斜杠的不变', P.toPosix('a/b/c') === 'a/b/c');
}

console.log('\n' + '='.repeat(56));
console.log('  通过 ' + pass + ' / 失败 ' + fail);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);