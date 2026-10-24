#!/usr/bin/env bash
# QQ 本地模型机器人 —— 启动脚本（Linux / macOS）
#
# 用法:
#   ./启动.sh              正常启动
#   ./启动.sh --check      只做环境检查，不启动

set -uo pipefail
cd "$(dirname "$0")"

# ---- 颜色（没终端支持时自动忽略）----
if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; N='\033[0m'
else
  G=''; R=''; Y=''; N=''
fi
ok()   { printf "  ${G}✅${N} %s\n" "$1"; }
bad()  { printf "  ${R}❌${N} %s\n" "$1"; }
warn() { printf "  ${Y}⚠️ ${N} %s\n" "$1"; }

echo "============================================================"
echo "  QQ 本地模型机器人"
echo "============================================================"
echo

# ---- Node ----
echo "[1] Node.js"
if ! command -v node >/dev/null 2>&1; then
  bad "没装 Node.js"
  echo "    Ubuntu/Debian: sudo apt install nodejs npm"
  echo "    或用 nvm:      https://github.com/nvm-sh/nvm"
  exit 1
fi
NODE_V=$(node --version)
NODE_MAJOR=$(echo "$NODE_V" | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -ge 20 ]; then
  ok "Node $NODE_V"
else
  bad "Node $NODE_V 太旧，需要 v20+"
  exit 1
fi

# ---- 项目文件 ----
echo
echo "[2] 项目文件"
# 代码可能在根目录（本地开发）或 src/ 下（发布版）
if [ -f "src/bridge.mjs" ]; then
  BRIDGE="src/bridge.mjs"
elif [ -f "bridge.mjs" ]; then
  BRIDGE="bridge.mjs"
else
  bad "找不到 bridge.mjs"
  exit 1
fi
ok "主程序: $BRIDGE"

if [ ! -f "config.json" ]; then
  warn "还没有 config.json，先跑一次安装"
  node 安装.mjs || exit 1
fi
ok "config.json 就绪"

# ---- Ollama ----
echo
echo "[3] Ollama"
if ! curl -s -m 5 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  warn "Ollama 没在跑，尝试启动…"
  if command -v ollama >/dev/null 2>&1; then
    # 有 systemd 就用 systemd，否则后台拉起
    if systemctl --user list-units --type=service 2>/dev/null | grep -q ollama; then
      systemctl --user start ollama 2>/dev/null || true
    elif systemctl list-units --type=service 2>/dev/null | grep -q ollama; then
      sudo systemctl start ollama 2>/dev/null || true
    else
      nohup ollama serve >/dev/null 2>&1 &
    fi
    for _ in $(seq 1 20); do
      sleep 1
      curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    done
  fi
fi

if curl -s -m 5 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  ok "Ollama: $(curl -s -m 5 http://127.0.0.1:11434/api/version)"
else
  bad "Ollama 起不来"
  echo "    手动启动: ollama serve"
  echo "    安装:     curl -fsSL https://ollama.com/install.sh | sh"
  exit 1
fi

# ---- NapCat（Docker 或本地）----
echo
echo "[4] NapCat"
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qi napcat; then
  ok "NapCat 容器在运行"
elif curl -s -m 3 http://127.0.0.1:3001 >/dev/null 2>&1 || ss -lnt 2>/dev/null | grep -q ':3001'; then
  ok "OneBot 端口 3001 在监听"
else
  warn "没检测到 NapCat / OneBot"
  echo "    Docker 方式:  docker compose up -d"
  echo "    检查详情:     node src/检查环境.mjs"
fi

if [ "${1:-}" = "--check" ]; then
  echo
  echo "============================================================"
  echo "  只检查不启动（--check）"
  echo "============================================================"
  exit 0
fi

# ---- 启动 ----
echo
echo "============================================================"
echo "  启动中…  按 Ctrl+C 停止"
echo "============================================================"
echo

exec node "$BRIDGE"