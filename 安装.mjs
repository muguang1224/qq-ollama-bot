#!/usr/bin/env node
/**
 * 一键安装
 * 用法: node 安装.mjs
 *
 * 做四件事：
 *   1. 检查 Node / Ollama
 *   2. 自动拉取所需模型（聊天 + 视觉）
 *   3. 生成 config.json
 *   4. 建好数据目录
 *
 * 不写死任何路径，任何人 clone 下来都能跑。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CHAT_MODEL = 'qwen3.5-4b';
const VISION_MODEL = 'qwen2.5vl:3b';

const OK = (s) => '  ✅ ' + s;
const NO = (s) => '  ❌ ' + s;
const WA = (s) => '  ⚠️  ' + s;
const STEP = (n, s) => '\n[' + n + '] ' + s;

console.log('='.repeat(64));
console.log('  QQ 本地模型机器人 —— 一键安装');
console.log('='.repeat(64));

// 想跳过 YOLO（它要额外下 32MB）：
//   SKIP_YOLO=1 node 安装.mjs         ← 推荐
//   node 安装.mjs -skip-yolo          ← 单横杠也行
//
// 为什么不用 --skip-yolo：
//   Node 会把任何 --xxx 当成自己的选项，直接报 "bad option: --skip-yolo"，
//   参数根本传不到脚本里（实测踩过）。所以只认环境变量和单横杠写法。
const SKIP_YOLO = process.env.SKIP_YOLO === '1'
  || process.env.NO_YOLO === '1'
  || process.argv.includes('-skip-yolo')
  || process.argv.includes('-no-yolo');
if (SKIP_YOLO) console.log('  （跳过 YOLO 模型下载）');

let fatal = 0;

// ---------------------------------------------------------------- 1. Node
console.log(STEP(1, 'Node.js'));
const major = Number(process.version.slice(1).split('.')[0]);
if (major >= 20) console.log(OK('Node ' + process.version));
else {
  console.log(NO('Node ' + process.version + ' 太旧，需要 v20+'));
  console.log('    下载: https://nodejs.org/');
  fatal++;
}

// ---------------------------------------------------------------- 2. Ollama
console.log(STEP(2, 'Ollama'));
let ollamaOk = false;
try {
  const r = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  console.log(OK('Ollama 运行中，版本 ' + j.version));
  ollamaOk = true;
} catch {
  console.log(NO('连不上 Ollama'));
  console.log('    请先安装并启动: https://ollama.com/download');
  console.log('    装好后重新运行本脚本。');
  fatal++;
}

// ---------------------------------------------------------------- 3. 模型
console.log(STEP(3, '拉取模型'));
console.log('  聊天模型: ' + CHAT_MODEL + '   （约 2.7 GB）');
console.log('  视觉模型: ' + VISION_MODEL + '   （约 3.2 GB）');
console.log();

if (ollamaOk) {
  let have = [];
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags');
    have = (( await r.json()).models || []).map((m) => m.name);
  } catch {}

  for (const m of [CHAT_MODEL, VISION_MODEL]) {
    const base = m.split(':')[0];
    const already = have.some((n) => n === m || n.startsWith(base + ':'));
    if (already) { console.log(OK(m + ' 已存在，跳过')); continue; }

    console.log('  正在拉取 ' + m + ' ...');
    try {
      execSync('ollama pull ' + m, { stdio: 'inherit', timeout: 3600000 });
      console.log(OK(m + ' 完成'));
    } catch (e) {
      console.log(WA(m + ' 拉取失败，可以稍后手动执行: ollama pull ' + m));
    }
  }
} else {
  console.log(WA('Ollama 没起来，跳过。装好后手动执行:'));
  console.log('    ollama pull ' + CHAT_MODEL);
  console.log('    ollama pull ' + VISION_MODEL);
}

// ---------------------------------------------------------------- 4. 配置
//
// 注意顺序：配置生成放在 YOLO 之前。
// 原因：YOLO 要下载 32MB 模型，网络不好时可能很慢甚至卡住 ——
// 之前它排在配置前面，导致"卡住了、config.json 还没生成"，
// 用户以为整个安装失败。核心配置必须先落地。
console.log(STEP(4, '生成配置'));

// 数据目录
for (const d of ['memories', 'emotions', 'stickers', 'proactive', 'logs', 'context']) {
  const p = join(ROOT, d);
  if (!existsSync(p)) { mkdirSync(p, { recursive: true }); console.log('  建目录 ' + d + '/'); }
}

// config.json
const cfgPath = join(ROOT, 'config.json');
if (existsSync(cfgPath)) {
  console.log(OK('config.json 已存在，保留（不覆盖你的设置）'));
} else {
  writeFileSync(cfgPath, JSON.stringify(defaultConfig(), null, 2), 'utf8');
  console.log(OK('已生成 config.json'));
  console.log('    → 记得把 bot.adminQQ 改成你的 QQ 号');
}

// persona.mjs（放在 src/ 下，和 bridge.mjs 同目录）
const personaPath = join(ROOT, 'src', 'persona.mjs');
const examplePath = join(ROOT, 'src', 'persona.example.mjs');
if (existsSync(personaPath)) {
  console.log(OK('persona.mjs 已存在，保留（不覆盖你改过的人设）'));
} else if (existsSync(examplePath)) {
  copyFileSync(examplePath, personaPath);
  console.log(OK('已从 persona.example.mjs 生成 persona.mjs'));
  console.log('    → 想改性格就编辑 src/persona.mjs，或运行 node src/人设卡.mjs');
} else if (existsSync(join(ROOT, 'persona.example.mjs'))) {
  // 本地开发布局（代码在根目录）
  copyFileSync(join(ROOT, 'persona.example.mjs'), join(ROOT, 'persona.mjs'));
  console.log(OK('已从 persona.example.mjs 生成 persona.mjs'));
} else {
  console.log(WA('没找到 persona.example.mjs，请确认文件完整'));
}

// ---------------------------------------------------------------- 5. YOLO（可选）
console.log(STEP(5, 'YOLO 目标检测（可选增强）'));
if (SKIP_YOLO) {
  console.log('  已跳过。想补：去掉 SKIP_YOLO 重跑，或手动下载模型放 yolo-models/');
} else {
  console.log('  三个 ONNX 模型共约 32MB，用 ONNX Runtime 跑，不需要 PyTorch。');
  console.log('  对卡通表情识别不准（实测会把动漫角色认成"时钟"），只作为参考信息。');
  console.log('  网络慢的话可以 Ctrl+C 中断 —— 这不影响其他功能。');
  console.log();

  const yoloDir = join(ROOT, 'yolo-models');
  if (!existsSync(yoloDir)) mkdirSync(yoloDir, { recursive: true });

  const YOLO_FILES = [
    { name: 'yolo11n.onnx', id: 327949165, size: 10930182 },
    { name: 'yolo11n-pose.onnx', id: 329009385, size: 11853451 },
    { name: 'yolo11n-cls.onnx', id: 329009500, size: 11293091 },
  ];

  let pyOk = false;
  let pyWhy = '';
  {
    // 分步检测，避免 shell 引号问题。
    // 之前一行 import 三个包会误判（实测：手动能跑，脚本里却报失败）。
    const tries = [
      ['python', ['-c', 'import sys; print(sys.version_info[0])']],
      ['py', ['-c', 'import sys; print(sys.version_info[0])']],
      ['python3', ['-c', 'import sys; print(sys.version_info[0])']],
    ];
    let pyCmd = null;
    for (const [cmd, args] of tries) {
      try {
        const v = execFileSync(cmd, args, { timeout: 15000, encoding: 'utf8' }).trim();
        if (Number(v) >= 3) { pyCmd = cmd; break; }
      } catch { /* 试下一个 */ }
    }

    if (!pyCmd) {
      pyWhy = '没找到 python（试过 python / py / python3）';
    } else {
      try {
        execFileSync(pyCmd, ['-c', 'import onnxruntime, cv2, numpy'], { timeout: 30000, stdio: 'ignore' });
        pyOk = true;
      } catch {
        pyWhy = '缺依赖包（需要 onnxruntime、opencv-python-headless、numpy）';
      }
    }
  }

  if (!pyOk) {
    console.log(WA('YOLO 跳过：' + pyWhy));
    console.log('    装一下依赖再重跑本脚本: pip install onnxruntime opencv-python-headless numpy');
    console.log('    不装也不影响其他功能。');
  } else {
    console.log(OK('Python 环境就绪（onnxruntime + opencv）'));
    for (const f of YOLO_FILES) {
      const p = join(yoloDir, f.name);
      if (existsSync(p) && statSync(p).size === f.size) {
        console.log(OK(f.name + ' 已存在'));
        continue;
      }
      console.log('  下载 ' + f.name + ' (' + (f.size / 1048576).toFixed(1) + 'MB) ...');
      try {
        // 用 GitHub API 的 octet-stream 端点拿签名直链。
        // 为什么不直接下 release 链接：部分网络下 github.com 直连不通，
        // 而 api.github.com 通常通。
        const api = 'https://api.github.com/repos/ultralytics/assets/releases/assets/' + f.id;

        // ★ 必须加超时 ★
        // 之前没加，网络卡住时安装会无限期挂起（实测卡过 10 分钟以上）。
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 120000);   // 单文件 2 分钟

        let buf;
        try {
          const res = await fetch(api, {
            headers: { Accept: 'application/octet-stream', 'User-Agent': 'qq-ollama-bot' },
            redirect: 'follow',
            signal: ctl.signal,
          });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          buf = Buffer.from(await res.arrayBuffer());
        } finally {
          clearTimeout(timer);
        }

        if (buf.length !== f.size) {
          console.log(WA(f.name + ' 大小不对（' + buf.length + '/' + f.size + '），跳过'));
          continue;
        }
        writeFileSync(p, buf);
        console.log(OK(f.name + ' 完成'));
      } catch (e) {
        const msg = String(e.message || e);
        if (/abort/i.test(msg)) console.log(WA(f.name + ' 下载超时（120秒），跳过'));
        else console.log(WA(f.name + ' 下载失败: ' + msg.slice(0, 60)));
        console.log('    YOLO 会自己跳过，不影响其他功能。');
        console.log('    想手动补：去 https://github.com/ultralytics/assets/releases/tag/v8.3.0');
        console.log('    下 ' + f.name + ' 放进 yolo-models/');
      }
    }
  }
}

/**
 * 默认配置。Windows 和 Linux 用同一份，避免两边默认值不一致。
 * 已经被 bash 脚本或其他代码引用，改这里就够。
 */
function defaultConfig() {
  return {
    _说明: '配置。none of these are secrets except onebot.accessToken — keep that private.',
    onebot: {
      _说明: 'NapCat 的 OneBot 连接方式。正向 WS 用 url；反向 WS 用 reversePort。',
      url: 'ws://127.0.0.1:3001',
      accessToken: '',
      reversePort: 0,
    },
    ollama: { baseUrl: 'http://127.0.0.1:11434', model: CHAT_MODEL },
    bot: {
      name: '小助手',
      adminQQ: 0,
      _adminQQ说明: '你自己的 QQ 号，填了之后只有你能用管理命令（如 /reset）。',
    },
    reply: {
      privateReply: true,
      groupReply: false,
      replyOnAt: true,
      groupPrefixes: ['小助手'],
      contextTurns: 10,
      evolveEvery: 4,
      maxTokens: 200,
      temperature: 0.85,
      timeoutMs: 60000,
      cooldownMs: 1500,
    },
    autoAccept: {
      _说明: '自动处理加好友/入群申请。默认全关。',
      enabled: false, friend: false, groupJoin: false, groupInvite: false,
      acceptAnyone: false, whitelist: [], blacklist: [], requireKeyword: '', maxPerHour: 5,
    },
    proactive: {
      _说明: '主动聊天。想让它偶尔主动找人说话就改成 true。',
      enabled: false, targets: [], allFriends: false,
      minGapMin: 40, maxGapMin: 80, maxPerHour: 1,
      quietStart: 1, quietEnd: 8, thinkBeforeSend: true,
      skipIfIgnored: 2, cooldownAfterColdMin: 360,
    },
    emotion: {
      enabled: true,
      moodUpOnPraise: 6, moodUpOnCare: 3, moodDownOnInsult: 8, moodDownOnCold: 2,
      moodDriftTo: 55, moodDriftRate: 0.05,
      intimacyUpPerMsg: 1.2, intimacyDecayPerDay: 4,
      nightStart: 23, nightEnd: 7, energyDrainNight: 6, energyRecoverDay: 3,
    },
    stickers: {
      _说明: '表情包收集与发送。',
      enabled: true, chance: 0.25, cooldownMin: 20,
    },
    vision: {
      _说明: '用视觉模型"看"图片。maxPx 是送模型前缩到的最大边 —— 实测 256 是速度/质量最佳点，调大会慢很多倍。',
      enabled: true, model: VISION_MODEL, maxPx: 256, batch: 3, gapMs: 5000,
    },
    video: {
      _说明: '视频抽帧识别。不是真的理解视频，只是看几张截图。',
      enabled: true, frames: 3, width: 256, maxMB: 80,
    },
    audio: {
      _说明: '语音转文字（用 QQ 自带能力）。',
      enabled: true,
    },
    yolo: {
      _说明: 'YOLO 目标检测（ONNX CPU）。和大模型独立跑，结果都存。对卡通表情不准，只作参考。python 留空则自动找 python3/python。',
      enabled: true, python: '', timeoutMs: 30000,
    },
    followUp: {
      _说明: '会话内追问：回复后有时再补一句，避免一问一答就结束。',
      enabled: true, chance: 0.3,
    },
  };
}

// ---------------------------------------------------------------- 完成
console.log('\n' + '='.repeat(64));
if (fatal) {
  console.log('  ❌ 有 ' + fatal + ' 个必须先解决的问题，见上面');
  console.log('='.repeat(64));
  process.exit(1);
}

console.log('  ✅ 安装完成');
console.log('='.repeat(64));
console.log();

if (process.platform === 'win32') {
  console.log('接下来:');
  console.log('  1. 装 NapCat 并登录 QQ（下载 NapCat.Shell.Windows.OneKey.zip）');
  console.log('  2. 在 NapCat WebUI 里开 WebSocket 客户端 → ws://127.0.0.1:3001');
  console.log('  3. 改 config.json 的 bot.adminQQ');
  console.log('  4. 双击 启动.bat');
} else {
  console.log('接下来:');
  console.log('  1. 起 NapCat（Linux 推荐 Docker）:');
  console.log('       改一下 docker-compose.yml 里的 WEBUI_TOKEN');
  console.log('       docker compose up -d');
  console.log('       docker compose logs -f napcat    # 扫码登录');
  console.log('  2. 确认 NapCat 里开了 WebSocket 客户端 → ws://127.0.0.1:3001');
  console.log('  3. 改 config.json 的 bot.adminQQ');
  console.log('  4. ./启动.sh');
}
console.log();
console.log('先自检一下: node src/检查环境.mjs');
console.log();