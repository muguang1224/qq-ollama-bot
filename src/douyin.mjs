#!/usr/bin/env node
/**
 * 抖音链接解析 —— 拿分享链接里的文案
 *
 * ⚠️ 先说清楚能做到什么程度（实测结论）：
 *
 *   ✅ 能做：短链跳转 → 拿到真实地址 → 从分享页提取标题/描述
 *   ❌ 做不到：自动刷抖音、拿推荐流、看视频内容、拿评论
 *
 * 为什么这么受限（都是实测出来的，不是猜的）：
 *   · www.douyin.com/video/xxx  返回的是 JS 混淆的空壳页（_$jsvmprt），
 *     里面没有任何可读数据 —— 抖音的反爬做了字节码级保护
 *   · www.douyin.com/oembed     返回 200 但 body 为空
 *   · 第三方解析 API            大多已失效（实测 code:-404）
 *   · 只有 iesdouyin.com 的分享页还留着 <title>
 *
 * 所以这里的定位是「尽力而为」：能拿到标题就够聊了，
 * 拿不到就老实说拿不到，绝不编内容。
 */

import { request } from 'node:https';
import { URL } from 'node:url';

export const DOUYIN_DEFAULTS = {
  enabled: true,
  timeoutMs: 20000,
  proxy: '',          // 留空直连（抖音国内可直连）
  maxTextLen: 300,    // 提取到的文案最大长度
};

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
                  'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 ' +
                  'Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                   'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** HTTP GET，返回 {status, body, location} */
function httpGet(urlStr, ua, timeoutMs, proxy) {
  const u = new URL(urlStr);
  let target = { hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search };
  if (proxy) {
    try {
      const p = new URL(proxy);
      target = { hostname: p.hostname, port: p.port || 80, path: urlStr };
    } catch {}
  }
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.path,
      method: 'GET',
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...(proxy ? { 'Host': u.hostname } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        location: res.headers.location || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('超时')); });
    req.on('error', reject);
    req.end();
  });
}

/** 从文本里找出所有 http 链接 */
export function extractLinks(text) {
  const s = String(text || '');
  const re = /https?:\/\/[^\s，,。；;）)"'<>]+/g;
  return (s.match(re) || []).map((u) => u.replace(/[.,;、]$/, ''));
}

/** 是不是抖音链接 */
export function isDouyinLink(url) {
  return /(douyin\.com|iesdouyin\.com)/i.test(String(url || ''));
}

/** 从一段话里揪出抖音链接 */
export function findDouyinLink(text) {
  return extractLinks(text).find(isDouyinLink) || '';
}

/** 去掉 HTML 标签和实体 */
function clean(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const c = parseInt(h, 16);
      return (c === 8194 || c === 8195 || c === 160) ? ' ' : (c > 0 && c < 0x110000) ? String.fromCodePoint(c) : ' ';
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const c = parseInt(d, 10);
      return (c === 160 || c === 8194 || c === 8195) ? ' ' : (c > 0 && c < 0x110000) ? String.fromCodePoint(c) : ' ';
    })
    .replace(/[\u00a0\u2000-\u200b\u3000]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析抖音链接
 * @returns {Promise<{ok:boolean, title?:string, url?:string, note?:string, error?:string}>}
 */
export async function parse(link, cfg) {
  const c = { ...DOUYIN_DEFAULTS, ...(cfg?.douyin || {}) };
  if (c.enabled === false) return { ok: false, error: '抖音解析未开启' };

  let url = String(link || '').trim();
  if (!url) return { ok: false, error: '没有链接' };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const to = c.timeoutMs ?? 20000;
  const px = c.proxy || '';

  // 1) 短链跳转 → 真实地址
  let realUrl = url;
  try {
    const r1 = await httpGet(url, MOBILE_UA, to, px);
    if (r1.status >= 300 && r1.status < 400 && r1.location) {
      realUrl = r1.location;
    } else if (r1.status === 200) {
      // 直接就是最终页
      const t = clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r1.body) || [])[1] || '');
      if (t && !/^抖音$/.test(t)) {
        return finish(t, realUrl, c);
      }
    }
  } catch (e) {
    return { ok: false, error: '打不开链接: ' + e.message };
  }

  // 2) 从真实地址里抠出视频 ID，转成分享页
  const m = /(?:video|note|share\/video|share\/note)\/(\d{6,})/.exec(realUrl);
  const id = m ? m[1] : '';
  const isNote = /note|share\/note/.test(realUrl);

  const tries = [];
  if (id) {
    tries.push('https://www.iesdouyin.com/share/video/' + id + '/');
    tries.push('https://www.iesdouyin.com/share/note/' + id + '/');
    tries.push('https://www.douyin.com/video/' + id);
  }
  // 原地址也试一次（有些是用户主页/合集）
  tries.push(realUrl);

  for (const t of tries) {
    try {
      const r = await httpGet(t, MOBILE_UA, to, px);
      if (r.status !== 200) continue;
      const title = clean((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body) || [])[1] || '');
      // 抖音的空壳页标题会含这些特征，说明没拿到真实内容
      const junk = !title || /^(抖音|Douyin)/i.test(title) || /记录美好生活\d*/.test(title);
      if (junk) continue;
      return finish(title, realUrl, c);
    } catch { /* 换下一个 */ }
  }

  return {
    ok: false,
    url: realUrl,
    error: '拿不到文案（抖音的反爬挡住了，只有标题能取，这个没取到）',
    note: '抖音对自动化访问做了字节码级保护，只能尽力而为',
  };
}

function finish(title, url, c) {
  let t = title
    // 分享页标题常带这些尾巴，去掉
    .replace(/[-–—|]\s*抖音\s*$/i, '')
    .replace(/^\s*在抖音记录美好生活\s*[-–—|]?\s*/i, '')
    .replace(/\s*[-–—|]\s*抖音$/i, '')
    .trim();
  if (t.length > (c.maxTextLen ?? 300)) t = t.slice(0, c.maxTextLen);
  return { ok: true, title: t, url };
}