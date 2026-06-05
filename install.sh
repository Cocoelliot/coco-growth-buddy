#!/bin/bash
# ============================================
# Coco Growth Buddy LLM — 安装配置脚本
# ============================================
# 使用方法：
#   1. 把整个文件夹放到你想安装的位置
#   2. cd 到该目录下
#   3. bash install.sh
# ============================================
set -e

INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$INSTALL_DIR"

echo ""
echo "  🐻  Coco Growth Buddy (LLM Edition)"
echo "  ==================================="
echo "  $(basename "$INSTALL_DIR")"
echo "  $INSTALL_DIR"
echo ""

# --- 1. 检查必需文件 ---
MISSING=""
for f in index.html main.js preload.js db.js package.json system-message-core-principles.md; do
  if [ ! -f "$f" ]; then
    MISSING="$MISSING  $f\n"
  fi
done

if [ -n "$MISSING" ]; then
    echo "  ⚠ 缺少以下文件，请确认目录完整："
    printf "$MISSING"
    echo ""
    echo "  请把整个文件夹放到目标位置后重新运行。"
    exit 1
fi

echo "  ✓ 文件完整性检查通过"
echo "  ✓ Node.js $(node -v 2>/dev/null || echo '未安装')"
echo "  ✓ npm $(npm -v 2>/dev/null || echo '未安装')"
echo ""

# --- 2. 用户配置 ---
echo "  请填写以下信息："
echo ""
read -p "  用户标识 (小写英文, 如 emmy): " OWNER_ID
read -p "  显示名称 (如 小雨): " DISPLAY_NAME
read -p "  OpenRouter API Key: " API_KEY
DEFAULT_MODEL="deepseek/deepseek-v4-flash"
read -p "  默认模型 [$DEFAULT_MODEL]: " MODEL
MODEL="${MODEL:-$DEFAULT_MODEL}"
DEFAULT_VISION="xiaomi/mimo-v2.5"
read -p "  图像识别模型 [$DEFAULT_VISION]: " VISION_MODEL
VISION_MODEL="${VISION_MODEL:-$DEFAULT_VISION}"

# --- 3. 创建用户数据目录 ---
mkdir -p "users/${OWNER_ID}/quick_notes"
mkdir -p "users/${OWNER_ID}/visuals"
mkdir -p "users/${OWNER_ID}/sidebar_state"
echo ""
echo "  ✓ 数据目录已创建: users/${OWNER_ID}/"

# --- 4. 生成 config.json ---
cat > config.json <<EOF
{
  "app": {
    "owner_user_id": "${OWNER_ID}",
    "user_name": "${DISPLAY_NAME}",
    "coco_docs_root": "./workspace"
  },
  "llm": {
    "api_key": "${API_KEY}",
    "default_model": "${MODEL}",
    "vision_model": "${VISION_MODEL}"
  }
}
EOF
echo "  ✓ config.json 已创建"
echo ""

# --- 5. 检查 Node.js ---
if ! command -v node &> /dev/null; then
    echo "  ⚠ 未检测到 Node.js。请先安装 Node.js (>=18)："
    echo "     https://nodejs.org"
    exit 1
fi

# --- 6. npm install ---
echo "  是否现在安装依赖 (npm install)？"
echo "    - 首次使用请选 y"
echo "    - 已安装过选 n"
read -p "  (y/n): " DO_NPM
if [ "$DO_NPM" = "y" ]; then
    echo ""
    echo "  → 正在安装依赖，请稍候..."
    npm install
    echo "  ✓ npm install 完成"
fi

echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │  ✅ 配置完成！                            │"
echo "  │                                          │"
echo "  │  启动:  npm start                        │"
echo "  │  打包:  npm run build                    │"
echo "  │  数据:  users/${OWNER_ID}/                │"
echo "  └──────────────────────────────────────────┘"
echo ""

# --- 7. 是否启动 ---
read -p "  是否现在启动？(y/n): " DO_START
if [ "$DO_START" = "y" ]; then
    echo "  → 正在启动..."
    echo ""
    npm start
fi