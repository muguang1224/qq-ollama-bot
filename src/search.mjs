#!/usr/bin/env node
/**
 * 联网搜索 —— 让机器人能"查东西"
 *
 * 为什么不接官方搜索 API：
 *   · Bing / Google 的官方 API 都要付费或有额度限制
 *   · DuckDuckGo 在本机（国内网络）直连不通，实测 HTTP 000
 *   · 百度 / 必应中国 直连可用（实测 HTTP 200），所以走网页解析
 *
 * 用哪个源：
 *   默认 cn.bing.com。它对爬虫相对宽松、结果里带摘要、中英文都行。
 *   百度作为备选（结果页结构更乱，但对中文长尾更全）。
 *
 * 代价与限制（说清楚，免得期待过高）：
 *   · 抓网页解析，搜索引擎改版就会失效 —— 所以解析失败要能优雅降级
 *   · 频繁请求可能被临时限流，所以有冷却 + 缓存
 *   · 数据是 HTML 里的文本，不是结构化 JSON，脏字符要清理
 */

import { request } from 'node:https';
import { URL } from 'node:url';

export const SEARCH_DEFAULTS = {
  enabled: false,              // 总开关，默认关（联网属于敏感操作）
  engine: 'bing',              // 'bing' | 'baidu'
  maxResults: 5,               // 取几条结果喂给模型
  timeoutMs: 15000,
  cooldownSec: 10,             // 两次搜索最短间隔（防连点被限流）
  cacheMin: 30,                // 同样关键词多久内复用缓存（分钟）
  autoSearch: true,            // 让模型自己判断什么时候需要搜
  proxy: '',                   // 留空直连；填 http://127.0.0.1:7897 走代理
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---------- 冷却与缓存 ----------
let lastSearchAt = 0;
const cache = new Map();   // 关键词 -> { at, results }

/** 简单 HTTP GET，返回文本。支持走 HTTP 代理。 */
function httpGet(urlStr, opts = {}) {
  const c = { ...SEARCH_DEFAULTS, ...(opts.cfg?.search || {}) };
  const u = new URL(urlStr);

  // 走代理：向代理发绝对 URI（标准 HTTP 代理方式）
  const proxy = (c.proxy || '').trim();
  let target;
  if (proxy) {
    try {
      const p = new URL(proxy);
      target = {
        hostname: p.hostname,
        port: p.port || 80,
        path: urlStr,
      };
    } catch {
      target = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search };
    }
  } else {
    target = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search };
  }

  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(proxy ? { 'Host': u.hostname } : {}),
      },
      timeout: c.timeoutMs,
    }, (res) => {
      // 跟随重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, urlStr).toString(); }
        catch { return reject(new Error('重定向地址无效')); }
        return httpGet(next, opts).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
    req.end();
  });
}

/** 去掉 HTML 标签、实体、多余空白 */
function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    // 命名实体
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    // 数字实体：&#0183; &#x2002; 之类（必应摘要里大量出现）
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const code = parseInt(h, 16);
      return (code === 8194 || code === 8195 || code === 160 || code === 8201) ? ' '
           : (code > 0 && code < 0x110000) ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const code = parseInt(d, 10);
      return (code === 160 || code === 8194 || code === 8195) ? ' '
           : (code > 0 && code < 0x110000) ? String.fromCodePoint(code) : ' ';
    })
    // 漏网的空格类字符
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析必应中国的结果页 */
function parseBing(html, max) {
  const out = [];
  // 结果块：<li class="b_algo"> ... <h2><a href="...">标题</a></h2> ... <p>摘要</p>
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const b of blocks) {
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = a[1];
    const title = clean(a[2]);
    // 摘要：优先 <p>，退而求其次找带 b_lineclamp 的 div
    let snippet = '';
    const p = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(b);
    if (p) snippet = clean(p[1]);
    if (!snippet) {
      const d = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
      if (d) snippet = clean(d[1]);
    }
    if (!title) continue;
    out.push({ title, url, snippet: snippet.slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

/** 解析百度结果页 */
function parseBaidu(html, max) {
  const out = [];
  const blocks = html.split(/<div[^>]+class="result[^"]*"/i).slice(1);
  for (const b of blocks) {
    const a = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const title = clean(a[2]);
    if (!title || title.length < 3) continue;
    let snippet = '';
    const s = /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(b)
           || /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(b);
    if (s) snippet = clean(s[1]);
    out.push({ title, url: a[1], snippet: snippet.slice(0, 300) });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 搜索
 * @returns {Promise<{ok:boolean, results?:Array, cached?:boolean, error?:string}>}
 */
export async function search(query, cfg) {
  const c = { ...SEARCH_DEFAULTS, ...(cfg?.search || {}) };
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '关键词为空' };
  if (c.enabled !== true) return { ok: false, error: '搜索未开启' };

  // 冷却
  const now = Date.now();
  if (now - lastSearchAt < (c.cooldownSec ?? 10) * 1000) {
    return { ok: false, error: '刚搜过，等几秒' };
  }

  // 缓存
  const ck = c.engine + '|' + q;
  const hit = cache.get(ck);
  if (hit && now - hit.at < (c.cacheMin ?? 30) * 60000) {
    return { ok: true, results: hit.results, cached: true };
  }

  const enc = encodeURIComponent(q);
  const url = c.engine === 'baidu'
    ? 'https://www.baidu.com/s?wd=' + enc
    : 'https://cn.bing.com/search?q=' + enc + '&ensearch=0';

  let html;
  try {
    html = await httpGet(url, { cfg });
  } catch (e) {
    return { ok: false, error: '请求失败: ' + e.message };
  }

  const max = c.maxResults ?? 5;
  const results = c.engine === 'baidu' ? parseBaidu(html, max) : parseBing(html, max);

  if (!results.length) {
    return { ok: false, error: '没解析出结果（搜索页结构可能变了）' };
  }

  lastSearchAt = Date.now();
  cache.set(ck, { at: Date.now(), results });
  // 缓存别无限涨
  if (cache.size > 100) cache.delete(cache.keys().next().value);

  return { ok: true, results, cached: false };
}

/** 把搜索结果格式化成给模型看的一段文字 */
export function format(results) {
  return results.map((r, i) =>
    (i + 1) + '. ' + r.title + (r.snippet ? '\n   ' + r.snippet : '')
  ).join('\n');
}

/**
 * 判断这句话是不是在要求搜索
 * 用于「明确要求」的快速路径；模型自主判断走 searchNeedPrompt。
 */
export function isSearchRequest(text) {
  const s = String(text || '');
  if (/(搜一下|搜索|查一下|查查|帮我查|网上|百度一下|谷歌)/.test(s)) return true;
  return false;
}

/** 从「搜一下XXX」里抠出关键词 */
export function extractQuery(text) {
  let s = String(text || '');
  s = s.replace(/^(帮我|给我|你|能不能|可以)?\s*(搜一下|搜索一下|搜索|查一下|查查|百度一下|谷歌一下|网上搜)\s*/,'');
  s = s.replace(/[，,。！!？?]+$/g, '').trim();
  return s;
}

/**
 * 让模型判断「要不要联网搜」。返回 {need, query}
 * 单独问一次模型，比在回复里塞搜索指令更可控。
 */
export function needSearchPrompt(userText, persona) {
  return [
    { role: 'system', content:
      '你是一个判断器。判断用户这句话是否需要【联网搜索实时信息】才能回答好。\n' +
      '需要搜的情况：问新闻、天气、股价、比赛结果、某个不知道的东西、' +
      '某个人/事的最新情况、明确要求搜索。\n' +
      '不需要搜的情况：日常闲聊、情绪交流、问你自己、' +
      '你本来就会的常识、对方只是在感慨。\n' +
      '只输出 JSON：{"need":true/false,"query":"搜索关键词"}。query 要短（2-15 字），' +
      '不要带"搜一下"这种指令词。' },
    { role: 'user', content: userText },
  ];
}