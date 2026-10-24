#!/usr/bin/env bash
# QQ 本地模型机器人 —— 一键安装（Linux / macOS）
#
# 做什么：
#   1. 检查 Node / Ollama / Docker
#   2. 拉取模型（聊天 + 视觉）
#   3. 下载 YOLO 模型（可选）
#   4. 生成 config.json、建数据目录
#
# 用法:
#   ./安装.sh              正常安装
#   ./安装.sh --skip-yolo    跳过 YOLO（少下 32MB，也能用 SKIP_YOLO=1）

set -uo pipefail
cd "$(dirname "$0")"

if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
else
  G=''; R=''; Y=''; N=''
fi
ok()   { printf "  ${G}✅${N} %s\n" "$1"; }
bad()  { printf "  ${R}❌${N} %s\n" "$1"; }
warn() { printf "  ${Y}⚠️ ${N} %s\n" "$1"; }
step() { printf "\n[%s] %s\n" "$1" "$2"; }

SKIP_YOLO=0
for a in "$@"; do
  # 用 --skip-yolo 而不是 --no-yolo：后者会被 Node 当成自己的参数吃掉
  [ "$a" = "--skip-yolo" ] && SKIP_YOLO=1
  [ "$a" = "--no-yolo" ] && SKIP_YOLO=1
done

echo "============================================================"
echo "  QQ 本地模型机器人 —— 安装"
echo "============================================================"

FAIL=0

# ---- 1. Node ----
step 1 "Node.js"
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node --version)
  NODE_MAJOR=$(echo "$NODE_V" | sed 's/^v//' | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node $NODE_V"
  else
    bad "Node $NODE_V 太旧，需要 v20+"
    FAIL=1
  fi
else
  bad "没装 Node.js"
  echo "    Ubuntu/Debian: sudo apt install nodejs npm"
  echo "    Fedora:        sudo dnf install nodejs npm"
  echo "    或用 nvm:      https://github.com/nvm-sh/nvm"
  FAIL=1
fi

# ---- 2. Ollama ----
step 2 "Ollama"
OLLAMA_OK=0
if curl -s -m 5 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  ok "Ollama 运行中: $(curl -s -m 5 http://127.0.0.1:11434/api/version)"
  OLLAMA_OK=1
elif command -v ollama >/dev/null 2>&1; then
  warn "Ollama 装了但没在跑"
  echo "    → 启动: ollama serve"
  echo "      或:   sudo systemctl start ollama"
else
  bad "没装 Ollama"
  echo "    → 一键安装: curl -fsSL https://ollama.com/install.sh | sh"
  echo "    → 或看官网:  https://ollama.com/download"
  FAIL=1
fi

# ---- 3. Docker（Linux 上 NapCat 的推荐方式）----
step 3 "Docker（Linux 上跑 NapCat 用）"
if command -v docker >/dev/null 2>&1; then
  ok "Docker 已装: $(docker --version 2>/dev/null | head -1)"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose 可用"
  else
    warn "没有 docker compose 插件（可能装的是 docker-compose 老版本）"
  fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qi napcat; then
    ok "NapCat 容器已在运行"
  else
    echo "    → 起一个 NapCat:  docker compose up -d"
    echo "      （记得先改 docker-compose.yml 里的 WEBUI_TOKEN）"
  fi
else
  warn "没装 Docker —— Linux 上推荐用它跑 NapCat（QQ 环境隔离最省事）"
  echo "    → 装: https://docs.docker.com/engine/install/"
  echo "    → 不用 Docker 也行，用官方脚本: "
  echo "      curl -fL -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh"
  echo "      bash napcat.sh --docker n --cli y --github-proxy 0"
fi

# ---- 4. 模型 ----
step 4 "拉取模型"
CHAT_MODEL="qwen3.5-4b"
VISION_MODEL="qwen2.5vl:3b"
echo "  聊天: $CHAT_MODEL（约 2.7 GB）"
echo "  视觉: $VISION_MODEL（约 3.2 GB）"
echo

if [ "$OLLAMA_OK" = "1" ]; then
  HAVE=$(curl -s -m 10 http://127.0.0.1:11434/api/tags 2>/dev/null || echo '{"models":[]}')
  for M in "$CHAT_MODEL" "$VISION_MODEL"; do
    BASE=$(echo "$M" | cut -d: -f1)
    if echo "$HAVE" | grep -q "\"$BASE"; then
      ok "$M 已存在"
    else
      echo "  正在拉取 $M …"
      if ollama pull "$M"; then
        ok "$M 完成"
      else
        warn "$M 拉取失败，稍后手动: ollama pull $M"
      fi
    fi
  done
else
  warn "Ollama 没起来，跳过。装好后手动执行："
  echo "    ollama pull $CHAT_MODEL"
  echo "    ollama pull $VISION_MODEL"
fi

# ---- 5. 配置 ----
step 5 "生成配置"

# 数据目录
for d in memories emotions stickers proactive logs context; do
  if [ ! -d "$d" ]; then mkdir -p "$d"; echo "  建目录 $d/"; fi
done

if [ -f config.json ]; then
  ok "config.json 已存在，保留（不覆盖你的设置）"
else
  # 用 Node 生成默认配置（和 Windows 版完全一致）
  # SKIP_YOLO=1 避免在这里又下 32MB 模型（YOLO 那步在下面单独处理）
  if SKIP_YOLO=1 node 安装.mjs >/dev/null 2>&1; then
    if [ -f config.json ]; then
      ok "已生成 config.json"
    else
      warn "生成失败，请手动跑: node 安装.mjs"
    fi
  else
    warn "生成失败，请手动跑: node 安装.mjs"
  fi
fi

# persona
if [ -f src/persona.mjs ]; then
  ok "src/persona.mjs 已存在"
elif [ -f src/persona.example.mjs ]; then
  cp src/persona.example.mjs src/persona.mjs
  ok "已从示例生成 src/persona.mjs"
else
  warn "没找到 persona.example.mjs"
fi

# ---- 6. YOLO（可选）----
step 6 "YOLO 目标检测（可选）"
if [ "$SKIP_YOLO" = "1" ]; then
  echo "  已用 --skip-yolo 跳过"
else
  PY=""
  for c in python3 python; do
    command -v "$c" >/dev/null 2>&1 && PY="$c" && break
  done

  if [ -z "$PY" ]; then
    warn "没找到 python3，跳过 YOLO"
    echo "    → 想启用: sudo apt install python3 python3-pip"
  elif ! "$PY" -c "import onnxruntime, cv2, numpy" >/dev/null 2>&1; then
    warn "Python 缺依赖，跳过 YOLO"
    echo "    → 想启用: $PY -m pip install onnxruntime opencv-python-headless numpy"
  else
    ok "Python 环境就绪（$PY）"

    # 下载模型（install.mjs 里已实现，交给它）
    if [ -f 安装.mjs ]; then
      # 安装脚本会自己判断哪些已存在
      echo "  下载 ONNX 模型（共约 32MB）…"
      node -e "
        const { existsSync, mkdirSync, statSync, writeFileSync } = require('node:fs');
        const { join } = require('node:path');
        const dir = 'yolo-models';
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const FILES = [
          { name: 'yolo11n.onnx',      id: 327949165, size: 10930182 },
          { name: 'yolo11n-pose.onnx', id: 329009385, size: 11853451 },
          { name: 'yolo11n-cls.onnx',  id: 329009500, size: 11293091 },
        ];
        (async () => {
          for (const f of FILES) {
            const p = join(dir, f.name);
            if (existsSync(p) && statSync(p).size === f.size) { console.log('  ✅ ' + f.name + ' 已存在'); continue; }
            try {
              const r = await fetch('https://api.github.com/repos/ultralytics/assets/releases/assets/' + f.id,
                { headers: { Accept: 'application/octet-stream', 'User-Agent': 'qq-ollama-bot' }, redirect: 'follow' });
              if (!r.ok) throw new Error('HTTP ' + r.status);
              const buf = Buffer.from(await r.arrayBuffer());
              if (buf.length !== f.size) { console.log('  ⚠️  ' + f.name + ' 大小不对'); continue; }
              writeFileSync(p, buf);
              console.log('  ✅ ' + f.name);
            } catch (e) {
              console.log('  ⚠️  ' + f.name + ' 失败: ' + String(e.message).slice(0, 50));
              console.log('      手动下载: https://github.com/ultralytics/assets/releases/tag/v8.3.0');
            }
          }
        })();
      " || warn "模型下载出错（不影响其它功能）"
    fi
  fi
fi

# ---- 完成 ----
echo
echo "============================================================"
if [ "$FAIL" = "1" ]; then
  echo -e "  ${R}❌ 有必须先解决的问题，见上面${N}"
  echo "============================================================"
  exit 1
fi

echo -e "  ${G}✅ 安装完成${N}"
echo "============================================================"
echo
echo "接下来:"
echo "  1. 起 NapCat:   docker compose up -d"
echo "  2. 看日志扫码:  docker compose logs -f napcat"
echo "  3. 改 config.json 里的 bot.adminQQ"
echo "  4. 启动机器人:  ./启动.sh"
echo
echo "自检: node src/检查环境.mjs"
echo