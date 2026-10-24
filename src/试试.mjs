#!/usr/bin/env node
/**
 * 试说话方式 —— 改完 persona.mjs 立刻看效果，不用重启桥接
 * 用法:
 *   node 试试.mjs                    用默认测试句
 *   node 试试.mjs "你吃饭了吗"         测一句
 *   node 试试.mjs -i                 交互模式（连续对话）
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ROOT } from './paths.mjs';

const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const { PERSONA } = await import('./persona.mjs');

async function say(text, history = []) {
  const msgs = [{ role: 'system', content: PERSONA }, ...history, { role: 'user', content: text }];
  const t0 = Date.now();
  const r = await fetch(cfg.ollama.baseUrl + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.ollama.model, stream: false, think: false, messages: msgs,
      options: { num_predict: cfg.reply?.maxTokens ?? 200, temperature: cfg.reply?.temperature ?? 0.85, top_p: 0.9 },
    }),
  });
  const j = await r.json();
  return { text: (j.message?.content || '').trim(), ms: Date.now() - t0 };
}

const args = process.argv.slice(2);

console.log('模型: ' + cfg.ollama.model);
console.log('人设字数: ' + PERSONA.length);
console.log('='.repeat(58));

if (args[0] === '-i') {
  // 交互模式
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  console.log('交互模式。输入内容回车发送，输入 exit 退出。\n');
  const hist = [];
  while (true) {
    const t = (await ask('你: ')).trim();
    if (!t || t === 'exit') break;
    const { text, ms } = await say(t, hist);
    console.log('小鲸鱼: ' + text + '   (' + ms + 'ms)\n');
    hist.push({ role: 'user', content: t }, { role: 'assistant', content: text });
    if (hist.length > 20) hist.splice(0, 2);
  }
  rl.close();
  process.exit(0);
}

const tests = args.length ? [args.join(' ')] : [
  '在吗',
  '我电脑好卡 是不是内存不够',
  '今天加班到现在 累死了',
  '帮我写个python爬虫',
  '推荐几本好看的书',
  '你是不是机器人',
];

for (const t of tests) {
  const { text, ms } = await say(t);
  const len = text.length;
  const flag = len > 60 ? ' ⚠️偏长' : (/^\s*[-*\d#]|\*\*/.test(text) ? ' ⚠️有格式' : '');
  console.log('\n用户: ' + t);
  console.log('回复: ' + text + '   (' + len + '字, ' + ms + 'ms)' + flag);
}