#!/usr/bin/env node
/**
 * NapCat 状态检查
 * 用法: node 检查NapCat.mjs [NapCat所在目录]
 *
 * 不写死路径：不给参数时自动在常见位置找。
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from './paths.mjs';

const OK = (s) => '  ✅ ' + s;
const NO = (s) => '  ❌ ' + s;

/** 自动定位 NapCat：在项目目录、桌面、下载目录里找 NapCat* */
function findNapCat() {
  if (process.argv[2]) return process.argv[2];

  const dirs = [ROOT, dirname(ROOT), join(homedir(), 'Desktop'), join(homedir(), 'Downloads'), process.cwd()];

  for (const d of dirs) {
    if (!existsSync(d)) continue;
    let entries = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (!/^NapCat/i.test(e)) continue;
      const p = join(d, e);
      // 可能就是 Shell 目录
      if (existsSync(join(p, 'versions'))) return p;
      // 或者里面还有一层（如 NapCat.Shell.Windows.OneKey/NapCat.xxx.Shell）
      try {
        for (const sub of readdirSync(p)) {
          const sp = join(p, sub);
          if (/Shell/i.test(sub) && existsSync(join(sp, 'versions'))) return sp;
        }
      } catch {}
      return p;
    }
  }
  return null;
}

const shell = findNapCat();

console.log('='.repeat(62));
console.log('  NapCat 检查');
console.log('='.repeat(62));

if (!shell) {
  console.log('\n' + NO('没找到 NapCat'));
  console.log('  可以手动指定:  node 检查NapCat.mjs "你的 NapCat 目录"');
  console.log('  下载: https://github.com/NapNeko/NapCatQQ/releases');
  process.exit(1);
}

console.log('\n  NapCat 目录: ' + shell);

console.log('\n[1] 目录布局');
console.log(existsSync(join(shell, 'QQ.exe')) ? OK('QQ.exe（自带的 QQ）') : NO('缺 QQ.exe'));

const versRoot = join(shell, 'versions');
if (!existsSync(versRoot)) {
  console.log(NO('缺 versions 目录 —— 可能还没跑过安装器'));
  process.exit(1);
}
const vers = readdirSync(versRoot).filter((e) => {
  try { return statSync(join(versRoot, e)).isDirectory(); } catch { return false; }
});
if (!vers.length) { console.log(NO('versions 下没有版本目录')); process.exit(1); }
const ver = vers[0];
console.log(OK('QQ 版本: ' + ver));

const napdir = join(versRoot, ver, 'resources', 'app', 'napcat');
if (!existsSync(napdir)) {
  console.log(NO('缺 napcat 注入目录 —— Shell 包没解压完整'));
  console.log('    → 重新下载完整的 NapCat.Shell.zip（约 36MB）');
  process.exit(1);
}
console.log(OK('注入目录存在'));

console.log('\n[2] 核心文件');
for (const f of ['napcat.mjs', 'loadNapCat.js', 'qqnt.json', 'NapCatWinBootMain.exe', 'NapCatWinBootHook.dll']) {
  console.log(existsSync(join(napdir, f)) ? OK(f) : NO(f + '（缺失）'));
}

console.log('\n[3] 注入组件（关键）');
const pkt = join(napdir, 'native', 'packet');
if (!existsSync(pkt)) {
  console.log(NO('缺 native/packet —— 无法注入'));
} else {
  const files = readdirSync(pkt);
  for (const f of files) console.log('  · ' + f);
  if (files.find((f) => /win32/i.test(f))) console.log(OK('Windows 组件齐全，可以启动'));
  else {
    console.log(NO('缺 Windows 组件（MoeHoo.win32.x64.node）'));
    console.log('    → NapCat.Shell.zip 下载不完整，需重新下载');
  }
}

console.log('\n[4] 运行状态');
const { execSync } = await import('node:child_process');
let net = '';
try { net = execSync('netstat -ano', { encoding: 'utf8', timeout: 20000 }); } catch {}
for (const [name, port] of [['NapCat WebUI', 6099], ['OneBot', 3001]]) {
  const on = net.split('\n').some((l) => l.includes(':' + port) && l.includes('LISTENING'));
  console.log(on ? OK(name + ' :' + port + ' 监听中') : '  · ' + name + ' :' + port + ' 未监听');
}
console.log('\n  未监听说明还没登录，启动后扫码即可。');
console.log('='.repeat(62));