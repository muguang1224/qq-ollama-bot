#!/usr/bin/env node
/**
 * NapCat 状态检查（跨平台）
 * 用法: node src/检查NapCat.mjs [NapCat所在目录]
 *
 * 三种部署方式都能检查：
 *   · Linux + Docker（推荐）—— 查容器
 *   · Linux/macOS 本地安装     —— 查目录
 *   · Windows OneKey          —— 查目录
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { ROOT } from './paths.mjs';
import { listenCmd, IS_LINUX, platformLabel } from './platform.mjs';

const OK = (s) => '  ✅ ' + s;
const NO = (s) => '  ❌ ' + s;

/** 自动定位本地 NapCat 目录 */
function findNapCat() {
  if (process.argv[2]) return process.argv[2];

  const dirs = [
    ROOT, dirname(ROOT),
    join(homedir(), 'Desktop'), join(homedir(), 'Downloads'),
    join(homedir(), 'Napcat'), join(homedir(), 'NapCat'),
    '/opt/NapCat', '/opt/napcat',
    process.cwd(),
  ];

  for (const d of dirs) {
    if (!existsSync(d)) continue;
    let entries = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (!/^napcat/i.test(e)) continue;
      const p = join(d, e);
      if (existsSync(join(p, 'versions'))) return p;
      // 里面还有一层（Windows OneKey 的布局）
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

/** 检测 Docker 里的 NapCat 容器 */
function dockerStatus() {
  const out = { hasDocker: false, containerExists: false, containerRunning: false, name: '' };
  try {
    execSync('docker --version', { stdio: 'ignore', timeout: 10000 });
    out.hasDocker = true;
  } catch { return out; }

  try {
    const ps = execSync('docker ps -a --format "{{.Names}}|{{.Status}}"',
      { encoding: 'utf8', timeout: 15000 });
    for (const line of ps.split('\n')) {
      const [name, status] = line.split('|');
      if (!name || !/napcat/i.test(name)) continue;
      out.containerExists = true;
      out.name = name;
      out.containerRunning = /Up/i.test(status || '');
      break;
    }
  } catch { /* docker 有问题就跳过 */ }
  return out;
}

/** 打印 6099 / 3001 的监听状态（跨平台：netstat / ss / lsof） */
function printPorts() {
  let net = '';
  try {
    const { cmd, args } = listenCmd(0);
    net = execSync([cmd, ...args].join(' '), { encoding: 'utf8', timeout: 20000 });
  } catch { /* 命令不存在 */ }

  for (const [name, port] of [['NapCat WebUI', 6099], ['OneBot', 3001]]) {
    const on = net.split('\n').some((l) => l.includes(':' + port) && /LISTEN/i.test(l));
    console.log(on ? OK(name + ' :' + port + ' 监听中') : '  · ' + name + ' :' + port + ' 未监听');
  }
}

console.log('='.repeat(62));
console.log('  NapCat 检查');
console.log('='.repeat(62));
console.log('  平台: ' + platformLabel());

// ---- Linux 上多半用 Docker，先看这个 ----
let dockerOk = false;
if (IS_LINUX) {
  const dc = dockerStatus();
  if (dc.hasDocker) {
    console.log('\n[0] Docker');
    if (dc.containerRunning) {
      console.log(OK('NapCat 容器在运行: ' + dc.name));
      dockerOk = true;
    } else if (dc.containerExists) {
      console.log('  · 容器存在但没运行: ' + dc.name);
      console.log('    → 启动: docker compose up -d');
    } else {
      console.log('  · 没找到 NapCat 容器（可以用仓库里的 docker-compose.yml 起一个）');
    }
  }
}

const shell = findNapCat();

if (!shell) {
  console.log('\n' + NO('没找到本地 NapCat 目录'));
  if (IS_LINUX) {
    console.log('\n  Linux 上推荐用 Docker（仓库里带 docker-compose.yml）：');
    console.log('    docker compose up -d');
    console.log('    docker compose logs -f napcat    # 看日志，找扫码/Token');
    console.log('\n  不想用 Docker 的话，官方也有一键脚本：');
    console.log('    curl -fL -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh');
    console.log('    bash napcat.sh --docker n --cli y --github-proxy 0');
  } else {
    console.log('  可以手动指定:  node src/检查NapCat.mjs "你的 NapCat 目录"');
    console.log('  下载: https://github.com/NapNeko/NapCatQQ/releases');
  }
} else {
  console.log('\n  NapCat 目录: ' + shell);

  console.log('\n[1] 目录布局');
  const hasQQ = ['QQ.exe', 'QQ', 'qq'].some((f) => existsSync(join(shell, f)));
  console.log(hasQQ ? OK('找到 QQ 可执行文件') : '  · 没看到 QQ 可执行文件（Docker 模式正常）');

  const versRoot = join(shell, 'versions');
  if (existsSync(versRoot)) {
    const vers = readdirSync(versRoot).filter((e) => {
      try { return statSync(join(versRoot, e)).isDirectory(); } catch { return false; }
    });
    if (vers.length) {
      const ver = vers[0];
      console.log(OK('QQ 版本: ' + ver));

      const napdir = join(versRoot, ver, 'resources', 'app', 'napcat');
      if (existsSync(napdir)) {
        console.log(OK('注入目录存在'));

        console.log('\n[2] 核心文件');
        for (const f of ['napcat.mjs', 'loadNapCat.js', 'qqnt.json']) {
          console.log(existsSync(join(napdir, f)) ? OK(f) : '  · ' + f + '（没有，可能不是这个版本）');
        }

        console.log('\n[3] 注入组件（关键）');
        const pkt = join(napdir, 'native', 'packet');
        if (!existsSync(pkt)) {
          console.log('  · 没有 native/packet（Docker 或半自动安装模式下正常）');
        } else {
          const files = readdirSync(pkt);
          for (const f of files) console.log('    · ' + f);
          const plat = process.platform === 'win32' ? /win32/i : /linux/i;
          if (files.find((f) => plat.test(f))) console.log(OK('当前平台的组件齐全'));
          else console.log('  · 没找到当前平台的组件（' + platformLabel() + '）');
        }
      } else {
        console.log(NO('缺 napcat 注入目录 —— 包没解压完整'));
      }
    }
  } else {
    console.log('\n[1] 目录布局');
    console.log('  · 没有 versions/ 目录（Docker 或其它安装方式下正常）');
  }
}

console.log('\n[4] 运行状态');
printPorts();
console.log('\n  未监听说明还没登录，启动后扫码即可。');
console.log('='.repeat(62));