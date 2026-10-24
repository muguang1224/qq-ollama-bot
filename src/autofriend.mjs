// 好友/入群申请自动处理
//
// 背景（实测得出）：
//   - NapCat 没有 add_friend，不能主动加人
//   - 也没有 get_friend_add_request，列不出待处理申请
//   - flag 只能从【实时事件】里拿，所以本模块必须挂事件监听
//   - 批准用 set_friend_add_request / set_group_add_request

/**
 * 事件里取出申请的关键字段。
 * 不同 OneBot 实现字段名略有差异，这里做兼容。
 */
function parseRequest(ev) {
  const isFriend = ev.request_type === 'friend';
  const isGroup = ev.request_type === 'group';

  return {
    kind: isFriend ? 'friend' : isGroup ? 'group' : 'unknown',
    flag: ev.flag || '',
    // 申请人 QQ
    userId: String(ev.user_id ?? ''),
    // 群号（入群申请才有）
    groupId: String(ev.group_id ?? ''),
    subType: ev.sub_type || '',           // add / invite
    comment: ev.comment || '',            // 验证消息
    nickname: ev.nickname || '',
  };
}

/**
 * 判断是否放行。
 * 返回 { pass: boolean, reason: string }
 */
export function decide(req, cfg) {
  const ac = cfg.autoAccept || {};

  if (!ac.enabled) return { pass: false, reason: '自动处理未开启' };

  if (req.kind === 'friend') {
    if (!ac.friend) return { pass: false, reason: '未开启自动加好友' };
  } else if (req.kind === 'group') {
    // 入群申请分两种：别人申请进群(add) / 邀请机器人进群(invite)
    if (req.subType === 'invite' && !ac.groupInvite) {
      return { pass: false, reason: '未开启自动接受群邀请' };
    }
    if (req.subType === 'add' && !ac.groupJoin) {
      return { pass: false, reason: '未开启自动批准入群' };
    }
  } else {
    return { pass: false, reason: '未知申请类型' };
  }

  // —— 白名单 ——
  const wl = ac.whitelist?.map(String).filter(Boolean) || [];
  const bl = ac.blacklist?.map(String).filter(Boolean) || [];

  if (bl.includes(req.userId)) {
    return { pass: false, reason: '在黑名单里 (' + req.userId + ')' };
  }

  if (wl.length) {
    if (!wl.includes(req.userId)) {
      return { pass: false, reason: '不在白名单 (' + req.userId + ')' };
    }
  } else if (!ac.acceptAnyone) {
    // 没配白名单，又没明确说「谁都可以」→ 拒绝
    return { pass: false, reason: '未配置白名单且 acceptAnyone=false' };
  }

  // —— 答案校验（可选）：验证消息必须包含指定关键词 ——
  // 注意：只对「好友申请」和「别人申请入群」生效。
  //       群邀请（sub_type=invite）通常没有附言，对它校验关键词会导致永远通不过。
  const isInvite = req.kind === 'group' && req.subType === 'invite';
  if (ac.requireKeyword && !isInvite) {
    const kw = ac.requireKeyword;
    if (!req.comment.includes(kw)) {
      return { pass: false, reason: '验证消息不含关键词「' + kw + '」' };
    }
  }

  // —— 频率限制：单位时间内最多通过几个 ——
  return { pass: true, reason: '符合条件' };
}

/**
 * 处理申请事件。
 * 返回 { handled: boolean, approved: boolean, reason: string }
 */
export async function handleRequest(ev, cfg, bot, log) {
  if (ev.post_type !== 'request') return { handled: false };

  const req = parseRequest(ev);
  if (req.kind === 'unknown') return { handled: false };

  const label = req.kind === 'friend'
    ? '好友申请'
    : (req.subType === 'invite' ? '群邀请' : '入群申请');

  log('📨 收到' + label + '：来自 ' + req.userId +
      (req.groupId ? ' 群' + req.groupId : '') +
      (req.comment ? ' 附言「' + req.comment.slice(0, 40) + '」' : ''));

  const d = decide(req, cfg);

  // —— 频率限制 ——
  if (d.pass && (cfg.autoAccept?.maxPerHour ?? 0) > 0) {
    const now = Date.now();
    rateLog.times = rateLog.times.filter((t) => now - t < 3600000);
    if (rateLog.times.length >= cfg.autoAccept.maxPerHour) {
      log('  ⏸ 已达每小时上限 (' + cfg.autoAccept.maxPerHour + ' 个)，本次不处理');
      return { handled: true, approved: false, reason: '频率超限' };
    }
  }

  if (!d.pass) {
    log('  ⏭ 不通过：' + d.reason);
    return { handled: true, approved: false, reason: d.reason };
  }

  // —— 执行批准 ——
  try {
    if (req.kind === 'friend') {
      await bot.call('set_friend_add_request', { flag: req.flag, approve: true });
    } else {
      await bot.call('set_group_add_request', {
        flag: req.flag,
        sub_type: req.subType,
        approve: true,
      });
    }
    if (cfg.autoAccept?.maxPerHour > 0) rateLog.times.push(Date.now());
    log('  ✅ 已通过（' + req.userId + '）');
    return { handled: true, approved: true, reason: '已通过' };
  } catch (e) {
    log('  ❌ 批准失败：' + e.message);
    return { handled: true, approved: false, reason: '调用失败: ' + e.message };
  }
}

/** 频率记录（内存） */
export const rateLog = { times: [] };

export const AUTO_ACCEPT_DEFAULTS = {
  enabled: false,        // 总开关，默认关
  friend: false,         // 自动同意好友申请
  groupJoin: false,      // 自动批准别人入群
  groupInvite: false,    // 自动接受别人邀请机器人入群
  acceptAnyone: false,   // 无白名单时是否放行所有人（危险，默认关）
  whitelist: [],         // 只通过这些 QQ 号
  blacklist: [],         // 永不通过
  requireKeyword: '',    // 验证消息必须包含这个词（例如「小鲸鱼」）
  maxPerHour: 5,         // 每小时最多通过几个
};