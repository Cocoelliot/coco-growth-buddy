# Coco Growth Buddy (LLM Edition)

本地 Electron 桌面 AI 学习伴侣。直连 OpenRouter API，支持多用户切换，侧栏进度追踪，可视化面板，Quick Notes，以及 SQLite 长期记忆（LTM）系统。

## 快速开始

```bash
cd /path/to/coco_growth_buddy_llm

# 安装依赖
npm install

# 启动主应用（LTM Scanner 自动启动）
npm start
```

## 目录结构

```
{install_dir}/
├── index.html                           ← 前端 UI（含 LTM 工具调用）
├── main.js                              ← Electron 主进程 + IPC handlers
├── preload.js                           ← IPC 安全桥接
├── db.js                                ← SQLite 数据层（LTM + chat + config）
├── ltm-scanner.js                       ← 后台 LTM 异步扫描进程
├── package.json
├── config.example.json                  ← 配置文件模板
├── system-message-core-principles.md    ← 主 Agent 系统消息
├── system-message-ltm-scanner.md        ← Scanner Agent 系统消息
├── install.sh                           ← 安装/配置脚本
├── LICENSE
├── README.md
├── data/                                ← SQLite 数据库（自动生成）
│   └── growth-buddy.db
└── users/                               ← 用户数据（自动生成）
    └── {用户名}/
        ├── quick_notes/                 ← 每日笔记
        ├── visuals/                     ← 可视化面板历史
        ├── ltm_exports/                 ← LTM preload 快照
        └── sidebar_state/               ← 学习进度 & 徽章
```

> ⚠️ 所有用户数据存储在安装目录的 `users/` 和 `data/` 下。**备份只需复制整个安装目录即可。**

## config.json

首次启动时会自动弹出配置向导。你也可以手动复制 `config.example.json` 为 `config.json` 并填写：

```bash
cp config.example.json config.json
```

```json
{
  "app": {
    "owner_user_id": "your_user_name",
    "user_name": "显示名称",
    "coco_docs_root": "./workspace"
  },
  "llm": {
    "api_key": "sk-or-v1-...",
    "default_model": "deepseek/deepseek-v4-flash"
  },
  "ltm": {
    "scan_interval_rounds": 20
  }
}
```

`config.json` 已加入 `.gitignore`，不会被提交到版本管理。

| 字段 | 说明 |
|------|------|
| `app.owner_user_id` | 用户唯一标识（小写英文），用于数据隔离 |
| `app.user_name` | 前端显示名（支持中文） |
| `app.coco_docs_root` | 工作目录（默认 `./workspace`） |
| `llm.api_key` | OpenRouter API Key |
| `llm.default_model` | 默认模型 ID |
| `ltm.scan_interval_rounds` | LTM Scanner 扫描间隔轮数（默认 20） |

## 长期记忆（LTM）系统

LTM 基于 SQLite 存储，支持 append-only 版本化、关键词搜索、preload 自动注入和智能合并更新。

### 核心能力

| 功能 | 说明 |
|------|------|
| **ltm_get(key)** | 按 `logical_key` 精确获取完整记录 |
| **ltm_search(query, type?, limit?)** | 全文搜索（title + description + content），积分排序 |
| **Preload** | 启动时注入 active 记录摘要；principle/user_context 含全文 |
| **合并更新** | 同一主题的新信息合并到已有 key，旧版软删除（parked），新版 active |
| **兜底扫描** | `ltm-scanner.js` 后台进程，定期从对话中自动提取未保存的信息 |

### 记录类型

| type | 用途 | description 要求 |
|------|------|-----------------|
| `principle` | 用户行为要求（如"不要直接给答案"） | — |
| `user_context` | 用户偏好、属性、性格 | — |
| `project` | 学习课题、竞赛、备考等 | 必须含 workspace 路径 |
| `project_status` | 进度快照(STAT)与事件时间线(LOG) | — |
| `experience` | 踩过的坑、积累的经验 | — |
| `skill` | 可复用的工作流程 | 必须含脚本路径、模板目录 |
| `entity` | 人物、知识点等实体 | — |
| `idea` | 孩子初步的想法或灵感 | 涉及文件时含路径 |
| `artifact` | 作业、试卷等档案 | 必须含文件路径 |
| `environment` | 工作环境配置 | 必须含目录路径、工具链 |

### 合并更新流程

当新信息是已有记录的补充时，使用相同 `logical_key` 进行合并：
1. 输出旧版记录，`status: "parked"`（软删除）
2. 输出新版记录，合并后 content，`status: "active"`

preload 只展示 active 最新版本；search 仍可查到 parked 历史版本。

### 数据库表结构

主要表：
- `chat_messages` — 对话记录（round_num, role, content, created_at）
- `ltm_records` — LTM 记录（logical_key, type, title, description, content, status, tags）
- `app_config` — 键值配置
- `app_state` — 应用状态（如 LTM scanner 扫描进度）

## LTM Scanner（后台自动运行）

`ltm-scanner.js` 随主应用自动启动，作为后台守护进程定期从对话中自动提取未保存的 LTM。无需手动操作。

**工作流程**：
1. 每 10 分钟扫描一次
2. 取上次扫描后新产生的对话轮次（默认累积 20 轮触发）
3. 向 LLM 发送：现有 LTM 索引参考（truncated）+ 对话内容
4. 如需合并已有记录，Scanner 调用 `ltm_get` 获取全文后再拼接
5. 输出结构化 JSON，自动写入 SQLite

**进度持久化**：扫描进度存储在 `app_state` 表中，进程重启后不会重复扫描。

## 多用户

同一安装目录支持多个用户：在 `config.json` 中切换 `app.owner_user_id` 即可。每个用户的数据（侧栏进度、笔记、可视化、LTM）自动隔离在 `users/{用户名}/` 下。

## 安装脚本

可使用 `install.sh` 快速配置：

```bash
bash install.sh
```

脚本会提示你：
1. 确认安装目录（默认 `~/Documents/coco_growth_buddy_llm/`）
2. 填写用户名、显示名、API Key
3. 自动创建目录结构和 `config.json`

## 安全说明

本应用为本地桌面应用，使用了以下 Electron 配置以简化开发：

- `nodeIntegration: true` — renderer 进程可直接使用 Node.js API
- `contextIsolation: false` — renderer 可访问 Electron 内部模块
- `webSecurity: false` — 允许 file:// 协议发起跨域请求到 OpenRouter API

> ⚠️ 这些设置是为简化 MVP 架构的选择。生产环境建议迁移到 contextBridge 模式并开启 sandbox。

## 许可

MIT