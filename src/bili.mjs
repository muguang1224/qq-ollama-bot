#!/usr/bin/env node
/**
 * B 站内容获取 —— 让机器人"刷 B 站"
 *
 * 和抖音完全不同：B 站有正规的开放 Web API，直连可用（实测 code:0）。
 * 所以这个模块是"真的能拿到数据"，不是尽力而为。
 *
 * ⚠️ 一个本机特有的坑：
 *   Windows 下 curl / node 的 TLS 会去检查证书吊销列表（CRL），
 *   而那个地址在国内网络经常连不上 —— 表现为握手卡死、HTTP 000。
 *   实测加 --ssl-no-revoke 就通了。
 *   这里用 Node 的 https 时对应的是设置 rejectUnauthorized 之外还要
 *   用 NODE_TLS_REJECT_UNAUTHORIZED 或者干脆用 curl 子进程。
 *   为了稳，这里直接走 curl 子进程 + --ssl-no-revoke。
 *
 * 能拿到的（都是公开数据）：
 *   · 热门视频列表（标题/UP主/播放量/时长）
 *   · 排行榜
 *   · 单个视频详情（简介）
 *   · 按关键词搜视频
 */

import { execFile } from 'node:child_process';
import { which, execOpts } from './platform.mjs';

export const BILI_DEFAULTS = {
  enabled: false,             // 默认关（联网行为，用户显式开启）
  // —— 主动分享 ——
  proactiveShare: false,      // 是否定期自己看，看到有意思的主动说
  checkEveryMin: 120,         // 多久看一次
  shareChance: 0.25,          // 每次看的分享概率（避免每次都发）
  maxSharePerDay: 2,          // 每天最多主动分享几条
  minGapHours: 6,             // 两次分享最短间隔
  quietStart: 1,
  quietEnd: 8,
  // —— 获取 ——
  timeoutMs: 20000,
  topN: 5,                    // 取前几条
  fetchDesc: true,            // 是否连简介一起取（多一次请求）
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 用 curl 取 JSON（--ssl-no-revoke 是这个环境能连通的关键） */
function curlJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const curl = which('curl') || 'curl';
    execFile(curl, [
      '-s', '--ssl-no-revoke', '--compressed',
      '-H', 'User-Agent: ' + UA,
      '-H', 'Referer: https://www.bilibili.com/',
      '--max-time', String(Math.ceil((timeoutMs || 20000) / 1000)),
      url,
    ], execOpts({ timeout: (timeoutMs || 20000) + 5000, maxBuffer: 1024 * 1024 * 8 }),
    (err, stdout) => {
      if (err && !stdout) return reject(new Error((err.message || 'curl 失败').slice(0, 120)));
      const t = String(stdout || '').trim();
      if (!t) return reject(new Error('空响应'));
      try { resolve(JSON.parse(t)); }
      catch { reject(new Error('不是 JSON: ' + t.slice(0, 80))); }
    });
  });
}

/** 秒 -> 分:秒 */
function fmtDur(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分' + (s % 60 ? (s % 60) + '秒' : '');
  return Math.floor(m / 60) + '小时' + (m % 60) + '分';
}

/** 播放量简写 */
function fmtViews(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

/** 归一化一条视频 */
function norm(v) {
  return {
    bvid: v.bvid || '',
    title: String(v.title || '').trim().slice(0, 80),
    up: v.owner?.name || v.author || '',
    views: fmtViews(v.stat?.view ?? v.play),
    duration: fmtDur(v.duration),
    desc: String(v.desc || '').trim().slice(0, 200),
    url: v.bvid ? 'https://www.bilibili.com/video/' + v.bvid : (v.arcurl || ''),
    pubdate: v.pubdate || 0,
  };
}

/** 热门视频 */
export async function popular(cfg) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  if (c.enabled === false) return { ok: false, error: 'B 站功能未开启' };
  try {
    const j = await curlJson(
      'https://api.bilibili.com/x/web-interface/popular?ps=' + Math.min(c.topN || 5, 20) + '&pn=1',
      c.timeoutMs
    );
    if (j.code !== 0) return { ok: false, error: 'API 返回 code=' + j.code + ' ' + (j.message || '') };
    const list = (j.data?.list || []).map(norm).filter((x) => x.title);
    return { ok: true, videos: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 排行榜 */
export async function ranking(cfg, rid = 0) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  if (c.enabled === false) return { ok: false, error: 'B 站功能未开启' };
  try {
    const j = await curlJson(
      'https://api.bilibili.com/x/web-interface/ranking/v2?rid=' + rid + '&type=all',
      c.timeoutMs
    );
    if (j.code !== 0) return { ok: false, error: 'API code=' + j.code };
    const list = (j.data?.list || []).slice(0, c.topN || 5).map(norm).filter((x) => x.title);
    return { ok: true, videos: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 搜视频 */
export async function searchVideo(kw, cfg) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  if (c.enabled === false) return { ok: false, error: 'B 站功能未开启' };
  const q = String(kw || '').trim();
  if (!q) return { ok: false, error: '关键词为空' };
  try {
    const j = await curlJson(
      'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' +
      encodeURIComponent(q) + '&page=1',
      c.timeoutMs
    );
    if (j.code !== 0) return { ok: false, error: 'API code=' + j.code };
    const list = (j.data?.result || []).slice(0, c.topN || 5)
      .map((v) => norm({
        bvid: v.bvid, title: String(v.title || '').replace(/<[^>]*>/g, ''),
        author: v.author, play: v.play, duration: v.duration, desc: v.description,
      }))
      .filter((x) => x.title);
    if (!list.length) return { ok: false, error: '没搜到' };
    return { ok: true, videos: list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 单个视频详情（含简介） */
export async function videoInfo(bvid, cfg) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  if (!/^BV[0-9A-Za-z]+$/.test(String(bvid || ''))) return { ok: false, error: '不是有效 BV 号' };
  try {
    const j = await curlJson(
      'https://api.bilibili.com/x/web-interface/view?bvid=' + bvid, c.timeoutMs
    );
    if (j.code !== 0) return { ok: false, error: 'API code=' + j.code };
    const d = j.data || {};
    return { ok: true, video: norm({ ...d, bvid: d.bvid }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 从消息里找 BV 号 / B 站链接 */
export function findBiliLink(text) {
  const s = String(text || '');
  const bv = /(BV[0-9A-Za-z]{10})/.exec(s);
  if (bv) return { type: 'bvid', id: bv[1] };
  const av = /(?:^|\/)(av\d+)/i.exec(s);
  if (av) return { type: 'avid', id: av[1].toLowerCase() };
  const b23 = /(https?:\/\/b23\.tv\/[0-9A-Za-z]+)/.exec(s);
  if (b23) return { type: 'short', id: b23[1] };
  return null;
}

/** 短链跳转拿真实地址（b23.tv → bilibili.com/video/BVxxx） */
export async function resolveShort(shortUrl, cfg) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  return new Promise((resolve) => {
    const curl = which('curl') || 'curl';
    // -I 只取响应头；--ssl-no-revoke 同理（国内必须）
    execFile(curl, [
      '-s', '-I', '-L', '--ssl-no-revoke',
      '-H', 'User-Agent: ' + UA,
      '--max-time', String(Math.ceil((c.timeoutMs || 20000) / 1000)),
      '-o', '-', '-w', '%{url_effective}',
      shortUrl,
    ], execOpts({ timeout: (c.timeoutMs || 20000) + 5000 }), (err, stdout) => {
      const t = String(stdout || '').trim();
      if (!t) return resolve(null);
      // -w 输出的是最后一行的最终 URL
      const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
      const finalUrl = lines[lines.length - 1] || '';
      const m = /(BV[0-9A-Za-z]{10})/.exec(finalUrl);
      resolve(m ? m[1] : (finalUrl || null));
    });
  });
}

/** 判断是不是在要求看 B 站 */
export function isBiliRequest(text) {
  const s = String(text || '');
  if (/(b站|哔哩|B站|bilibili)/i.test(s) && /(有|看|热门|排行|什么|推荐|搜)/.test(s)) return true;
  if (findBiliLink(s)) return true;
  return false;
}

/** 格式化给模型看 */
export function formatVideos(videos) {
  return videos.map((v, i) =>
    (i + 1) + '. 《' + v.title + '》 UP:' + (v.up || '未知') +
    ' 播放:' + v.views + ' 时长:' + v.duration +
    (v.desc ? '\n   ' + v.desc : '')
  ).join('\n');
}

/**
 * 从热门里挑一个，并生成一句"想跟你说"的话。
 *
 * 要点：这是「刷到了想分享」，不是「汇报热门榜」。
 * 所以要求它像真人一样——挑一个自己觉得有意思的，说一句随口的感想。
 *
 * @param {object} opt { persona, videos, history, chat }
 * @returns {Promise<{bvid?:string, message?:string, reason?:string}|null>}
 */
export async function thinkShare({ persona, videos, history, chat }, cfg) {
  const c = { ...BILI_DEFAULTS, ...(cfg?.bili || {}) };
  const list = formatVideos(videos);
  const past = (history || []).map((h) => '· ' + (h.title || '')).join('\n') || '（还没分享过）';

  const sys = (persona || '') + `

【当前任务】
你刚在 B 站首页刷到一些视频，想挑一个跟人聊聊。

【刷到的视频】
${list}

【你之前已经分享过的（别再挑这些）】
${past}

要求：
- 挑**一个**你觉得最有意思/最想吐槽/最想问一句的。
- 说一句简短自然的话，10~35 字。像真人随口发的那种：
  「欸 B站有个XX 看着好离谱」「刚刷到个XX 有点想看」。
- **不要说"我查了一下""根据数据""播放量显示"**这种话，像自己刷到的一样。
- **只看到了标题和播放量，没看过视频内容** —— 所以别编里面讲了什么。
- message 里**不要**包含链接，链接由程序单独拼。
- 你必须原样输出你挑中的那个视频的**编号**和**BV号**（照抄，别改），
  因为程序要用它去对应链接 —— 抄错的话就会配错链接。
- 只输出 JSON：
  {"index":1,"bvid":"BV...","title":"原样抄的标题","message":"要说的话","reason":"为什么挑这个"}`;

  // 由调用方注入了 chat 就用它，否则用 cfg 里的 ollamaChat（如果传了）
  const caller = chat || cfg?.__chat;
  if (typeof caller !== 'function') return null;

  try {
    const out = await caller(
      [{ role: 'system', content: sys }, { role: 'user', content: '挑一个说说' }],
      { numPredict: 200, temperature: 0.9 }
    );
    const m = String(out || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const msg = String(j.message || '').trim().slice(0, 100);
    if (!msg) return null;
    return {
      bvid: String(j.bvid || '').trim(),
      index: Number.isInteger(j.index) ? j.index - 1 : null,   // 模型给的是 1-based
      title: String(j.title || '').trim().slice(0, 80),
      message: msg,
      reason: String(j.reason || '').slice(0, 60),
    };
  } catch {
    return null;
  }
}