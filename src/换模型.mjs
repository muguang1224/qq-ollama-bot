#!/usr/bin/env node
/**
 * 切换视觉/聊天模型
 * 用法:
 *   node 换模型.mjs                 查看当前配置和可用模型
 *   node 换模型.mjs qwen3-vl:4b     切换（聊天和视觉都用它）
 *   node 换模型.mjs --chat qwen3.5-4b --vision qwen3-vl:4b   分别指定
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const P = './config.json';
const c = JSON.parse(readFileSync(P, 'utf8'));

// 查 Ollama 里有哪些模型
async function listModels() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags');
    const j = await r.json();
    return (j.models || []).map((m) => m.name);
  } catch {
    return [];
  }
}

const avail = await listModels();
const args = process.argv.slice(2);

if (!args.length) {
  console.log('='.repeat(58));
  console.log('  当前配置');
  console.log('='.repeat(58));
  console.log('  聊天模型 : ' + c.ollama.model);
  console.log('  视觉模型 : ' + (c.vision?.model || 'qwen2.5vl:3b'));
  console.log('  视觉开关 : ' + (c.vision?.enabled !== false));
  console.log();
  console.log('  Ollama 里可用:');
  for (const m of avail) console.log('    ' + m);
  console.log();
  console.log('  用法:');
  console.log('    node 换模型.mjs <模型名>            聊天和视觉都换成它');
  console.log('    node 换模型.mjs --chat <名> --vision <名>');
  process.exit(0);
}

let chat = null, vision = null;
if (args[0] === '--chat' || args[0] === '--vision') {
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--chat') chat = args[i + 1];
    if (args[i] === '--vision') vision = args[i + 1];
  }
} else {
  chat = args[0];
  vision = args[0];
}

// 校验模型存在
const check = (name) => {
  if (!name) return true;
  const base = name.split(':')[0];
  const ok = avail.some((m) => m === name || m.startsWith(base + ':') || m === base);
  if (!ok) {
    console.log('⚠️  Ollama 里没找到「' + name + '」');
    console.log('   请先: ollama pull ' + name);
    return false;
  }
  return true;
};

if (!check(chat) || !check(vision)) process.exit(1);

copyFileSync(P, P + '.bak');
if (chat) c.ollama.model = chat;
if (vision) {
  c.vision = c.vision || {};
  c.vision.model = vision;
}

writeFileSync(P, JSON.stringify(c, null, 2), 'utf8');

console.log('✅ 已切换');
console.log('   聊天模型: ' + c.ollama.model);
console.log('   视觉模型: ' + c.vision?.model);
console.log();
console.log('重启桥接生效：关掉桥接窗口，重新双击「启动.bat」');
console.log('（原配置已备份为 config.json.bak）');