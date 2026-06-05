/**
 * ltm-scanner.js — 异步 LTM 扫描器（后台进程）
 *
 * 功能：定期扫描聊天记录中的新消息，调用 LLM 提取关键信息，
 * 自动沉淀到 LTM（SQLite ltm_records 表）。
 *
 * 运行方式：Node.js 独立进程（非 Electron）
 *   node ltm-scanner.js
 *
 * 依赖：需要 db.js 同目录，以及 DB 实例。
 *
 * 扫描周期：启动后每 N 分钟扫描一次（默认 10 分钟）
 * 扫描窗口：上次扫描轮次到当前轮次之间的全部消息
 */

const path = require('path');
const fs = require('fs');

// 配置
const CONFIG = {
  // 工作目录（含 db.js 和 system-message-ltm-scanner.md）
  baseDir: __dirname,
  // 扫描间隔（毫秒）
  checkIntervalMs: 10 * 60 * 1000,
  // 一次扫描最多处理的轮次数
  maxRoundsPerScan: 50,
  // OpenRouter API 配置
  apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',
};

// 加载 db
const { AppDB } = require(path.join(CONFIG.baseDir, 'db.js'));

// 加载配置
let configJson = {};
try {
  configJson = JSON.parse(fs.readFileSync(path.join(CONFIG.baseDir, 'config.json'), 'utf8'));
} catch (e) {
  console.warn('Failed to load config.json, using defaults');
}

// 从配置或环境变量获取 API Key
function getApiKey() {
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;
  if (configJson.llm && configJson.llm.api_key) return configJson.llm.api_key;
  return null;
}

const API_KEY = getApiKey();
// LTM 扫描轮次阈值：每积累多少轮后触发一次 LLM 提取（默认 20）
const SCAN_INTERVAL_ROUNDS = (configJson.ltm && configJson.ltm.scan_interval_rounds) || 20;
const MODEL = (configJson.llm && configJson.llm.default_model) || 'deepseek/deepseek-v4-flash';

// 加载 LTM Scanner 系统提示
function loadScannerPrompt() {
  try {
    const p = path.join(CONFIG.baseDir, 'system-message-ltm-scanner.md');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (e) {
    console.warn('Failed to load scanner prompt:', e.message);
  }
  // 默认提示（保底）
  return `你是一个 LTM（长期记忆）信息提取器。

你的任务是从用户和 AI 的对话中，提取值得长期记住的信息。

输出格式：
{
  "items": [
    {
      "type": "principle|project|idea|skill|experience|entity|user_context",
      "logical_key": "唯一标识符（如 PRINC:xxx, SK:/xxx）",
      "title": "标题",
      "tags": "标签，逗号分隔",
      "description": "简短摘要（1-2句话）",
      "content": "详细内容",
      "reason": "为什么要保存这条记录"
    }
  ]
}

规则：
- 只提取有长期价值的信息（知识、偏好、决策、项目进展、经验教训）
- 日常闲聊不需要保存
- type 必须是上述列表中之一
- 如果没有值得保存的内容，返回 { "items": [] }`;
}

const SCANNER_PROMPT = loadScannerPrompt();

// 状态：上次扫描的 round_num（每个用户独立，持久化到 app_state 表）
const scanState = {};

/** 从 app_state 加载持久化的扫描进度 */
function loadScannerState() {
  const users = getUsersToScan();
  for (const uid of users) {
    const v = db.stateGet(`ltm_scanner_round_${uid}`);
    if (v !== null) {
      scanState[uid] = parseInt(v, 10);
      console.log(`[${uid}] Restored scan state at round ${scanState[uid]}`);
    }
  }
}

/** 持久化扫描进度到 app_state */
function saveScannerState(ownerUserId, roundNum) {
  db.stateSet(`ltm_scanner_round_${ownerUserId}`, String(roundNum));
}

// 初始化数据库
let db;
try {
  const dataDir = configJson.data_dir || path.join(CONFIG.baseDir, 'data');
  db = new AppDB(dataDir, configJson);
  console.log(`DB initialized at ${dataDir}/growth-buddy.db`);
  loadScannerState();
} catch (e) {
  console.error('Failed to initialize DB:', e.message);
  process.exit(1);
}

/**
 * 获取需扫描的用户列表
 */
function getUsersToScan() {
  const rows = db.db.prepare(
    `SELECT DISTINCT owner_user_id FROM chat_messages ORDER BY owner_user_id`
  ).all();
  return rows.map(r => r.owner_user_id).filter(Boolean);
}

/**
 * 获取 LTM 索引参考（供 scanner 注入 prompt，按 type 分组）
 * 只含 key + title + description — 足够判断是否合并，合并时通过 ltm_get 获取全文。
 * LOG 类记录（project_status）限制 10 条；其他 type 不限制。
 * 返回: { type: [{ logical_key, title, description }] }
 */
function getLtmReference(ownerUserId) {
  const uid = ownerUserId || 'default';
  const rows = db.db.prepare(`
    SELECT l1.logical_key, l1.type, l1.title, l1.description
    FROM ltm_records l1
    LEFT JOIN ltm_records l2 ON l1.logical_key = l2.logical_key
      AND l1.owner_user_id = l2.owner_user_id
      AND l1.id < l2.id
    WHERE l2.id IS NULL AND l1.status = 'active' AND l1.owner_user_id = ?
    ORDER BY l1.id DESC
  `).all(uid);

  const byType = {};
  const LOG_LIMIT = 10;  // project_status LOG 数量可很多，限制 10 条防止 token 膨胀
  for (const r of rows) {
    if (!byType[r.type]) byType[r.type] = [];
    if (r.type === 'project_status' && r.logical_key.startsWith('LOG:')) {
      if (byType[r.type].length >= LOG_LIMIT) continue;
    }
    byType[r.type].push(r);
  }
  return byType;
}

/** ltm_get 工具定义（供 scanner 查询完整 content） */
const LTM_GET_TOOL = {
  type: 'function',
  function: {
    name: 'ltm_get',
    description: '获取指定 logical_key 的 LTM 记录完整内容。从索引中看到截断的 content 后，如需合并更新，调用此工具获取全文以准确拼接。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'LTM 记录的 logical_key，如 CTX:emmy-profile' }
      },
      required: ['key']
    }
  }
};

/** 将 LTM 索引参考格式化为 prompt 文本（仅 key + title + description，无 content） */
function formatLtmReference(ltmRef) {
  if (!ltmRef || Object.keys(ltmRef).length === 0) return '（暂无已有记录）';
  let text = '';
  for (const [type, items] of Object.entries(ltmRef)) {
    text += `\n## ${type}（${items.length} 条）\n`;
    for (const item of items) {
      text += `- [${item.logical_key}] ${item.title}\n  description: ${item.description || '（无）'}\n`;
    }
  }
  return text;
}

/** 执行 scanner 工具调用 */
function executeScannerTool(tc, ownerUserId) {
  if (tc.function.name === 'ltm_get') {
    const args = JSON.parse(tc.function.arguments || '{}');
    const record = db.ltmGetLatest(args.key, ownerUserId);
    if (!record) return JSON.stringify({ error: `record not found: ${args.key}` });
    return JSON.stringify({
      logical_key: record.logical_key,
      type: record.type,
      title: record.title,
      description: record.description,
      content: record.content,
      tags: record.tags
    });
  }
  return JSON.stringify({ error: `unknown tool: ${tc.function.name}` });
}

/** 解析 LLM 输出的 JSON 并保存 LTM 记录 */
function parseAndSaveLtm(llmContent, ownerUserId, targetRound) {
  let items = [];
  try {
    const jsonMatch = llmContent.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : llmContent.trim();
    const parsed = JSON.parse(jsonStr);
    items = parsed.items || parsed;  // 兼容旧格式 { items: [...] } 和裸 [...]
    if (!Array.isArray(items)) items = [];
  } catch (e) {
    console.error(`[${ownerUserId}] Failed to parse LLM response as JSON:`, e.message);
    return { success: false, reason: 'parse_error', error: e.message };
  }

  if (items.length > 0) {
    console.log(`[${ownerUserId}] LLM extracted ${items.length} items:`);
    var parkedCount = 0;
    for (const item of items) {
      try {
        db.ltmSave({ ...item, owner_user_id: ownerUserId, source_round: targetRound });
        if (item.status === 'parked') {
          parkedCount++;
        } else {
          console.log(`  - [${item.type}] ${item.title}`);
        }
      } catch (e) {
        console.error(`[${ownerUserId}] Failed to save LTM item "${item.title}":`, e.message);
      }
    }
    if (parkedCount > 0) {
      console.log(`  (${parkedCount} old versions archived)`);
    }
  } else {
    console.log(`[${ownerUserId}] LLM found nothing worth saving this round`);
  }

  return { success: true, items_saved: items.length };
}

/**
 * 对指定用户执行一次扫描（持久化轮次）
 *
 * 逻辑：从 app_state 读上次扫描到的轮次 n，获取当前 max round N，
 * 若 N - n >= SCAN_INTERVAL_ROUNDS，则扫描 n+1 到 n+20 这 20 轮，
 * 然后更新 n = n + SCAN_INTERVAL_ROUNDS 并持久化。
 *
 * 轮次是累积的：今天聊 10 轮退出、明天又聊 10 轮，则累积 20 轮触发。
 * 进程重启后从 app_state 恢复进度，不会重复扫描。
 */
async function scanUser(ownerUserId) {
  // 从持久化状态读取上次扫描到的轮次
  const lastScanned = parseInt(db.stateGet(`ltm_scanner_round_${ownerUserId}`), 10) || 0;
  scanState[ownerUserId] = lastScanned;

  // 获取当前总轮次
  const countResult = db.chatGetCount(ownerUserId);
  const currentMaxRound = countResult.count;
  const newRounds = currentMaxRound - lastScanned;

  if (newRounds < SCAN_INTERVAL_ROUNDS) {
    console.log(`[${ownerUserId}] Only ${newRounds} new rounds since scan at round ${lastScanned} (need ${SCAN_INTERVAL_ROUNDS}). Deferring.`);
    return { scanned: false, reason: 'need_more_rounds', new_rounds: newRounds, threshold: SCAN_INTERVAL_ROUNDS };
  }

  // 计算本次扫描的目标轮次：lastScanned + SCAN_INTERVAL_ROUNDS
  const targetRound = lastScanned + SCAN_INTERVAL_ROUNDS;

  // 获取 lastScanned 之后的所有消息
  const result = db.chatGetSinceRound(ownerUserId, lastScanned);
  if (!result || !result.messages || result.messages.length === 0) {
    console.log(`[${ownerUserId}] No messages found since round ${lastScanned}.`);
    return { scanned: false, reason: 'no_new_messages' };
  }

  // 只取 targetRound 以内的消息（正好 SCAN_INTERVAL_ROUNDS 轮）
  const scanMessages = result.messages.filter(msg => msg.round_num <= targetRound);

  console.log(`[${ownerUserId}] Scanning rounds ${lastScanned + 1}-${targetRound} (${scanMessages.length} messages, ${result.messages.length} total since last scan)`);

  // 构建 LLM 输入的对话上下文
  const contextMessages = scanMessages.map(msg => {
    const role = msg.role === 'user' ? 'User' : 'Assistant';
    return `${role} (round ${msg.round_num}):\n${msg.content || ''}`;
  }).join('\n\n');

  // 获取现有 LTM 索引参考
  const ltmRef = getLtmReference(ownerUserId);
  const ltmRefText = formatLtmReference(ltmRef);
  console.log(`[${ownerUserId}] LTM reference: ${Object.keys(ltmRef).length} types, ${Object.values(ltmRef).reduce((sum, items) => sum + items.length, 0)} records`);

  // 调用 LLM（支持 ltm_get 工具循环）
  const messages = [
    { role: 'system', content: SCANNER_PROMPT },
    { role: 'user', content: `【现有 LTM 索引参考（按 type 分组，仅 active 最新版本，key + title + description）】${ltmRefText}

【需要扫描的对话】
以下是最新 ${SCAN_INTERVAL_ROUNDS} 轮对话内容。参考上方索引，对同一主题的补充信息应合并更新。
合并时先调用 ltm_get 获取完整 content，再准确拼接：

${contextMessages}` }
  ];

  const MAX_TOOL_ROUNDS = 5;
  try {
    let llmContent = null;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const payload = {
        model: MODEL,
        messages: messages,
        tools: [LTM_GET_TOOL],
        tool_choice: 'auto',
        temperature: 0.1,
        max_tokens: 4096,
      };

      const response = await fetch(CONFIG.apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
          'HTTP-Referer': 'https://github.com/coco-growth-buddy',
          'X-Title': 'Coco LTM Scanner',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[${ownerUserId}] LLM API error: ${response.status} ${errText}`);
        return { scanned: false, reason: 'llm_error', error: errText };
      }

      const data = await response.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) {
        console.error(`[${ownerUserId}] LLM returned empty message`);
        return { scanned: false, reason: 'empty_llm_response' };
      }

      // No tool calls — final output reached
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        llmContent = msg.content;
        break;
      }

      // Execute tool calls and continue
      console.log(`[${ownerUserId}] Tool calls in round ${round + 1}: ${msg.tool_calls.map(tc => tc.function.name + '(' + tc.function.arguments + ')').join(', ')}`);
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        const result = executeScannerTool(tc, ownerUserId);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    if (!llmContent) {
      console.error(`[${ownerUserId}] Max tool-call rounds (${MAX_TOOL_ROUNDS}) exceeded without final output`);
      return { scanned: false, reason: 'max_rounds_exceeded' };
    }

    // 解析并保存
    const saveResult = parseAndSaveLtm(llmContent, ownerUserId, targetRound);
    if (!saveResult.success) return { scanned: false, reason: 'parse_error', error: saveResult.error };

    // 更新扫描进度
    scanState[ownerUserId] = targetRound;
    saveScannerState(ownerUserId, targetRound);

    return { scanned: true, items_saved: saveResult.items_saved };

  } catch (e) {
    console.error(`[${ownerUserId}] LLM call failed:`, e.message);
    return { scanned: false, reason: 'llm_exception', error: e.message };
  }
}

/**
 * 启动扫描循环
 */
async function startScanner() {
  const users = getUsersToScan();
  console.log(`Starting scan cycle for ${users.length} users...`);

  for (const uid of users) {
    try {
      const r = await scanUser(uid);
      if (r.reason === 'no_new_messages') continue;
      if (r.reason === 'need_more_rounds') {
        console.log(`  [${uid}] Scan deferred: ${r.new_rounds}/${r.threshold} rounds`);
        continue;
      }
      if (r.scanned) {
        console.log(`  [${uid}] ✅ Scanned, saved ${r.items_saved} items`);
      } else {
        console.log(`  [${uid}] ⚠️ Scan returned: ${r.reason}`);
      }
    } catch (e) {
      console.error(`[${uid}] Scan error:`, e.message);
    }
  }

  console.log('Scan cycle complete.');
}

// 启动一次性扫描，然后每 checkIntervalMs 扫描一次
console.log('LTM Scanner started. Interval:', CONFIG.checkIntervalMs, 'ms');
startScanner().then(() => {
  setInterval(() => {
    startScanner().catch(e => console.error('Scanner cycle error:', e.message));
  }, CONFIG.checkIntervalMs);
}).catch(e => {
  console.error('Initial scan failed:', e.message);
  // 即使初始扫描失败，也启动定时器
  setInterval(() => {
    startScanner().catch(e => console.error('Scanner cycle error:', e.message));
  }, CONFIG.checkIntervalMs);
});