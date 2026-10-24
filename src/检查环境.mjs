#!/usr/bin/env node
/**
 * 环境自检 —— 检查本机是否装好了运行所需的东西
 * 用法: node src/检查环境.mjs
 *
 * 这个脚本不写死任何路径，全部自动检测，任何人 clone 下来都能跑。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const OK = (s) => '  ✅ ' + s;
const NO = (s) => '  ❌ ' + s;
const WA = (s) => '  ⚠️  ' + s;

let problems = 0;

console.log('='.repeat(62));
console.log('  环境自检');
console.log('='.repeat(62));

// ---- 1. Node.js ----
console.log('\n[1] Node.js');
try {
  const v = process.version;
  const major = Number(v.slice(1).split('.')[0]);
  if (major >= 20) console.log(OK('Node ' + v));
  else { console.log(NO('Node ' + v + ' 太旧，需要 v20 或更新')); problems++; }
} catch { console.log(NO('读不到 Node 版本')); problems++; }

// ---- 2. Ollama ----
console.log('\n[2] Ollama');
let ollamaUp = false;
try {
  const r = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(4000) });
  const j = await r.json();
  console.log(OK('Ollama 服务运行中，版本 ' + j.version));
  ollamaUp = true;
} catch {
  console.log(NO('连不上 Ollama（http://127.0.0.1:11434）'));
  console.log('      → 请先安装并启动 Ollama: https://ollama.com/download');
  problems++;
}

// ---- 3. 模型 ----
console.log('\n[3] 模型');
if (ollamaUp) {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags');
    const j = await r.json();
    const names = (j.models || []).map((m) => m.name);
    if (!names.length) {
      console.log(NO('一个模型都没有'));
      console.log('      → 运行: ollama pull qwen3.5-4b');
      console.log('      → 运行: ollama pull qwen2.5vl:3b');
      problems++;
    } else {
      for (const m of names) console.log('  · ' + m);
      const hasChat = names.some((n) => /qwen3\.5|qwen2\.5|llama|gemma|qwen3:/i.test(n));
      const hasVision = names.some((n) => /vl|vision|llava|minicpm/i.test(n));
      if (hasChat) console.log(OK('有可用的聊天模型'));
      else { console.log(WA('没找到明显可用的聊天模型，建议 ollama pull qwen3.5-4b')); }
      if (hasVision) console.log(OK('有可用的视觉模型'));
      else { console.log(WA('没找到视觉模型，看图功能会不可用（ollama pull qwen2.5vl:3b）')); }
    }
  } catch { console.log(WA('读取模型列表失败')); }
} else {
  console.log(WA('Ollama 没起来，跳过'));
}

// ---- 4. ffmpeg（可选，GIF 转换已内置纯 JS 实现）----
console.log('\n[4] ffmpeg（可选）');
try {
  execSync('ffmpeg -version', { stdio: 'ignore', timeout: 8000 });
  console.log(OK('已安装（不装也行，GIF 转换是内置的）'));
} catch {
  console.log('  · 没装。不影响使用 —— GIF 转 PNG 是纯 JS 实现的。');
}

// ---- 5. NapCat ----
console.log('\n[5] NapCat');
const here = process.cwd();
const candidates = [];
// 在几个常见位置找 NapCat.Shell*
const searchDirs = [here, join(here, '..'), join(homedir(), 'Desktop'), join(homedir(), 'Downloads')];
for (const d of searchDirs) {
  if (!existsSync(d)) continue;
  try {
    for (const e of readdirSync(d)) {
      if (/^NapCat/i.test(e)) candidates.push(join(d, e));
    }
  } catch {}
}
if (candidates.length) {
  for (const c of candidates) console.log('  · ' + c);
  console.log(OK('找到 NapCat 相关目录'));
} else {
  console.log(WA('没找到 NapCat'));
  console.log('      → 需要它才能连 QQ: https://github.com/NapNeko/NapCatQQ/releases');
  console.log('      → 用一键安装里的一键安装器，或手动装 Shell 版');
}

// ---- 6. OneBot 连接 ----
console.log('\n[6] OneBot 连接');
try {
  const cfg = JSON.parse((await import('node:fs')).readFileSync(join(here, 'config.json'), 'utf8'));
  const url = cfg.onebot?.url || '(未配置)';
  console.log('  · 配置的地址: ' + url);
  const port = Number(String(url).match(/:(\d+)/)?.[1] || 3001);
  try {
    const r = await fetch('http://127.0.0.1:' + port, { signal: AbortSignal.timeout(3000) }).catch(() => null);
    console.log(OK('端口 ' + port + ' 有服务在响应'));
  } catch {
    console.log(WA('端口 ' + port + ' 没响应 —— NapCat 可能还没启动或还没登录'));
  }
} catch {
  console.log(WA('还没有 config.json —— 第一次运行桥接会自动生成'));
}

// ---- 汇总 ----
console.log('\n' + '='.repeat(62));
if (problems === 0) {
  console.log('  ✅ 环境看起来没问题，可以启动了');
  console.log('     运行: node src/bridge.mjs        （或双击 启动.bat）');
} else {
  console.log('  ❌ 有 ' + problems + ' 个必须解决的问题，见上面标红项');
}
console.log('='.repeat(62));