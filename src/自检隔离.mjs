#!/usr/bin/env node
/**
 * 隔离自检 —— 验证机器人 QQ 的数据是否真的独立于日常 QQ
 * 用法: node 自检隔离.mjs
 */
import { existsSync, statSync, readdirSync } from 'node:fs';

const ISO = 'C:\\qq-bot-home';
const ISO_TF = ISO + '\\Documents\\Tencent Files';
const REAL_TF = 'C:\\Users\\34059\\Documents\\Tencent Files';

const OK = (s) => '  ✅ ' + s;
const BAD = (s) => '  ❌ ' + s;
const WARN = (s) => '  ⚠️  ' + s;

console.log('='.repeat(62));
console.log('  QQ 数据隔离自检');
console.log('='.repeat(62));

// 1. 隔离目录存在吗
console.log('\n[1] 隔离目录');
if (!existsSync(ISO)) {
  console.log(BAD('隔离目录不存在: ' + ISO));
  console.log('    → 用「启动NapCat-隔离版.bat」启动一次就会创建');
  process.exit(1);
}
console.log(OK(ISO));
for (const d of ['Documents\\Tencent Files', 'AppData\\Roaming', 'Temp']) {
  console.log(existsSync(ISO + '\\' + d) ? OK('  ' + d) : WARN('  ' + d + ' 不存在'));
}

// 2. 隔离目录里有 QQ 数据吗（证明真的在用）
console.log('\n[2] 隔离目录里是否有机器人数据');
if (!existsSync(ISO_TF)) {
  console.log(BAD('隔离的 Tencent Files 不存在'));
} else {
  const items = readdirSync(ISO_TF);
  if (!items.length) {
    console.log(WARN('隔离的 Tencent Files 是空的 —— 可能还没登录过'));
  } else {
    console.log(OK('有 ' + items.length + ' 项：' + items.join(', ')));
    const account = items.find((x) => /^\d{6,}$/.test(x));
    if (account) console.log(OK('机器人账号数据目录: ' + account));
  }
}

// 3. 关键：日常 QQ 的目录有没有被机器人写
console.log('\n[3] 日常 QQ 目录是否被隔离');
let isoTime = 0, realTime = 0;
try { isoTime = statSync(ISO_TF).mtimeMs; } catch {}
try { realTime = statSync(REAL_TF).mtimeMs; } catch {}

if (!realTime) {
  console.log(WARN('找不到日常 QQ 目录: ' + REAL_TF));
} else {
  console.log('    隔离目录最后修改: ' + new Date(isoTime).toLocaleString('zh-CN'));
  console.log('    日常目录最后修改: ' + new Date(realTime).toLocaleString('zh-CN'));
  if (isoTime > realTime) {
    const diffMin = Math.round((isoTime - realTime) / 60000);
    console.log(OK('隔离目录更新（比日常目录新 ' + diffMin + ' 分钟）→ 机器人写的是隔离目录'));
  } else {
    console.log(WARN('日常目录更新更近 —— 请确认机器人用的是隔离版启动器'));
  }
}

// 4. 运行中的 QQ 进程用的是哪个数据目录
console.log('\n[4] 运行中的副本 QQ');
import('node:child_process').then(({ execSync }) => {
  let out = '';
  try {
    out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'QQ.exe\'\\" -EA SilentlyContinue | ForEach-Object { $_.ProcessId.ToString() + \'|\' + $_.ExecutablePath }"',
      { encoding: 'utf8', timeout: 30000 }
    );
  } catch {}

  const lines = out.split('\n').map((s) => s.trim()).filter((s) => s.includes('|'));
  const copy = lines.filter((l) => l.includes('qq-local-model'));
  const real = lines.filter((l) => l.includes('QQ.exe') && !l.includes('qq-local-model'));

  if (!copy.length) {
    console.log('  · 没有运行中的副本 QQ（机器人未启动）');
  } else {
    console.log(OK('副本 QQ 运行中：' + copy.map((l) => l.split('|')[0]).join(', ')));
    console.log('    注意：仅凭进程无法直接读出它的 USERPROFILE，');
    console.log('    请以上面 [3] 的时间戳为准。');
  }
  console.log('  · 日常 QQ 进程数: ' + real.length);

  // 5. 结论
  console.log('\n[5] 结论');
  const good = isoTime > realTime && existsSync(ISO_TF);
  if (good) {
    console.log(OK('隔离生效：机器人数据独立，日常 QQ 不受影响'));
    console.log('    要撤销：删掉 ' + ISO + ' 即可');
  } else {
    console.log(WARN('隔离可能未生效，请用「启动NapCat-隔离版.bat」启动'));
  }
  console.log();
});