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
  // 扫描间隔（毫秒）：追平积压后、平时等待新对话的间隔
  checkIntervalMs: 10 * 60 * 1000,
  // 追积压模式下，两批之间的间隔（毫秒）：连续扫描时稍作喘息即可，无需等满 10 分钟
  catchUpIntervalMs: 5 * 1000,
  // 一次扫描最多处理的轮次数
  maxRoundsPerScan: 50,
  // OpenRouter API 配置
  apiEndpoint: 'https://openrouter.ai/api/v1/chat/completions',

  // ---- 防卡死 / 与前端错峰（2026-09 修复：scanner 曾永久卡在同一批轮次反复重试）----
  // 同一批连续失败达此次数后强制推进进度（跳过该批），打破"确定性失败 → 无限重试"死循环
  maxConsecutiveFailures: 3,
  // 一个扫描周期最多处理的批次数（用于追赶积压，但有上限，避免长期独占 API）
  // 追积压时此上限决定一次最多扫多少批；本例 14 批 × 20 轮 = 280 轮足够覆盖大部分积压
  maxBatchesPerCycle: 15,
  // 若最近这段时间内有新消息（说明用户正在聊天），跳过扫描，把 API 让给前端对话
  idleBeforeScanMs: 90 * 1000,
  // 若最近这段时间内一直没有新消息（说明用户早就用完但忘了关应用），scanner 休眠，
  // 直到有新消息才重新工作。避免"用了 10 分钟没关，scanner 空转一整天"。
  sleepAfterIdleMs: 30 * 60 * 1000,
  // 休眠期间的轮询间隔：休眠时不能彻底不唤醒（scanner 是独立子进程，没有外部唤醒信号），
  // 所以改成"低频 + 完全静默"—— 只跑几个 SQLite 查询判断用户回来没，不打任何日志、不调 LLM。
  // 取 5 分钟是为了孩子回来后能较快恢复扫描。
  sleepPollIntervalMs: 5 * 60 * 1000,
  // ---- LTM 全量注入（替代 ltm_get 工具调用）----
  // 实测：工具模式下每轮都要重发整段对话（28KB），7 轮 ≈ 248KB；
  // 全量注入只需 1 次 ≈ 49KB，且彻底没有"工具循环耗尽"的失败模式。
  ltmInject: {
    maxRecords: 120,       // 最多注入多少条记录
    maxContentChars: 1200, // 单条 content 截断长度
    maxTotalChars: 60000,  // 注入文本总上限（约 60KB），防止 LTM 增长后撑爆 prompt
  },
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

/**
 * 记录一次扫描失败，并在连续失败达到阈值后强制推进进度（跳过该批）。
 *
 * 背景：失败路径若在推进进度前 return，由于输入是确定的（同一批对话 + 同一份 LTM 索引），
 * 失败也是确定性的 → 每 checkIntervalMs 重试同一批，形成永久死循环，
 * 持续占用 OpenRouter 并发/配额，导致前端对话变慢。
 * 最坏情况浪费 maxConsecutiveFailures 次调用后即跳过，不再无限重试。
 */
function handleScanFailure(ownerUserId, targetRound, reason, detail) {
  const failKey = `ltm_scanner_fail_${ownerUserId}`;
  const fails = (parseInt(db.stateGet(failKey), 10) || 0) + 1;
  db.stateSet(failKey, String(fails));

  if (fails >= CONFIG.maxConsecutiveFailures) {
    console.warn(
      `[${ownerUserId}] Scan failed ${fails}x on batch ->${targetRound} (${reason}). ` +
      `FORCE advancing past this batch to break the retry loop.`
    );
    if (detail) console.warn(`  last error: ${detail}`);
    db.stateSet(failKey, '0');
    scanState[ownerUserId] = targetRound;
    saveScannerState(ownerUserId, targetRound);
    return { scanned: false, reason, force_skipped: true, consecutive_failures: fails };
  }

  console.warn(`[${ownerUserId}] Scan failed (${fails}/${CONFIG.maxConsecutiveFailures}) on batch ->${targetRound}: ${reason}`);
  if (detail) console.warn(`  error: ${detail}`);
  return { scanned: false, reason, consecutive_failures: fails };
}

/** 重置连续失败计数（扫描成功时调用） */
function resetScanFailures(ownerUserId) {
  const failKey = `ltm_scanner_fail_${ownerUserId}`;
  if (db.stateGet(failKey) !== null) db.stateSet(failKey, '0');
}

/**
 * 返回最近一次用户消息距今多少毫秒；若没有任何消息返回 null。
 * 复用 isUserActive 的本地时间解析逻辑。
 */
function msSinceLastUserMessage(ownerUserId) {
  try {
    const row = db.db.prepare(
      `SELECT MAX(created_at) AS last_at FROM chat_messages WHERE owner_user_id = ?`
    ).get(ownerUserId);
    if (!row || !row.last_at) return null;
    const last = new Date(String(row.last_at).trim().replace(' ', 'T')).getTime();
    if (isNaN(last)) return null;
    return Date.now() - last;
  } catch (e) {
    return null;
  }
}

/**
 * 判断用户是否正在聊天（最近 idleBeforeScanMs 内有新消息）。
 * 若是则跳过扫描 —— scanner 与前端共用同一个 OpenRouter API key，
 * 用户聊天时应把并发/配额让给对话，避免"回复特别慢"。
 */
function isUserActive(ownerUserId) {
  const idleMs = msSinceLastUserMessage(ownerUserId);
  return idleMs !== null && idleMs < CONFIG.idleBeforeScanMs;
}

// 记录 scanner 启动时刻：应用刚启动也算"活跃"，
// 闲置休眠应从启动时刻起算，而不是仅看历史消息时间
const _scannerStartedAt = Date.now();

/**
 * 判断用户是否有"值得扫"的积压（未扫轮次 ≥ SCAN_INTERVAL_ROUNDS）。
 * 与 scanUser 开头的判定完全同一套口径，只是不产生副作用。
 */
function hasScannableBacklog(ownerUserId) {
  try {
    const lastScanned = parseInt(db.stateGet(`ltm_scanner_round_${ownerUserId}`), 10) || 0;
    const currentMaxRound = db.chatGetCount(ownerUserId).count;
    return (currentMaxRound - lastScanned) >= SCAN_INTERVAL_ROUNDS;
  } catch (e) {
    return false;  // 查询失败时不阻塞休眠判断
  }
}

/**
 * 判断用户是否已经长时间闲置（例如用完忘了关应用）。
 * 若是则 scanner 休眠，等下次有新消息时再恢复，避免空转一整天。
 *
 * 闲置的起点取两者较晚者：
 *   - 最近一条消息的时间
 *   - scanner 进程启动时间（应用刚启动也算活跃，不能因为历史消息早就过了一启动就休眠）
 *
 * 【2026-09-06 补充】闲置时长够了但还有未扫积压时【不】休眠：
 * 闲置窗口本来就是留给补扫的（合盖挂起会把 10~30min 的补扫窗口整个跳过，
 * 恢复后若直接休眠，积压要一直压到用户下次发消息才动）。
 * 先补扫 → 扫完再睡。
 */
function isUserIdleForLong(ownerUserId) {
  const idleMs = msSinceLastUserMessage(ownerUserId);
  // 从未有消息 → 不算闲置（可能刚开始用）
  if (idleMs === null) return false;
  const sinceStart = Date.now() - _scannerStartedAt;
  // 两者取较小者（更接近"活跃"的那个时间点）
  const effectiveIdleMs = Math.min(idleMs, sinceStart);
  if (effectiveIdleMs < CONFIG.sleepAfterIdleMs) return false;
  return !hasScannableBacklog(ownerUserId);
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
 * 获取 LTM 参考（供 scanner 注入 prompt，按 type 分组）
 *
 * 直接携带 content 全文（不再让 LLM 通过 ltm_get 工具按需取）：
 * 工具模式下每轮请求都要重发整段对话，实测 7 轮 ≈ 248KB；全量注入 1 次 ≈ 49KB，
 * 更省且彻底没有"工具循环耗尽"的失败模式。
 *
 * 体积护栏：LOG 流水限 10 条；单条 content 截断；总条数与总字符数设上限。
 * 返回: { type: [{ logical_key, title, description, content }] }
 */
function getLtmReference(ownerUserId) {
  const uid = ownerUserId || 'default';
  const rows = db.db.prepare(`
    SELECT l1.logical_key, l1.type, l1.title, l1.description, l1.content
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

  // 护栏：截断 + 总条数/总字符数上限（优先保留最近更新的记录）
  const L = CONFIG.ltmInject;
  let totalChars = 0;
  let kept = 0;
  for (const type of Object.keys(byType)) {
    const capped = [];
    for (const it of byType[type]) {
      if (kept >= L.maxRecords) break;
      let content = it.content || '';
      if (content.length > L.maxContentChars) {
        content = content.slice(0, L.maxContentChars) + '…(已截断)';
      }
      const size = content.length + (it.description || '').length + (it.title || '').length;
      if (totalChars + size > L.maxTotalChars) break;
      totalChars += size;
      kept++;
      capped.push({ ...it, content });
    }
    // 上面是按 id DESC 遍历（最新在前）以保证截断时优先保留新记录；
    // 这里反转为 id ASC（老 → 新）再输出：新增记录会追加到本组末尾，
    // 前面的内容保持字节级不变 → KV 缓存可命中。
    byType[type] = capped.reverse();
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

/**
 * LTM 注入时的 type 排列顺序（固定不变，服务于 KV 缓存前缀稳定）。
 *
 * 原则：越稳定、越少更新的 type 越靠前，最易变/更新最频繁的沉到最后。
 * 这个顺序一旦确定就不再变动 —— 若让"刚更新的 type"动态前移或后移，
 * 会造成整段 LTM 重排，前缀全部失效（缓存只能命中 system）。
 * 未列出的 type 按字母序排在所有已知 type 之后。
 */
const TYPE_STABLE_ORDER = [
  'principle',       // 原则：几乎不变
  'environment',     // 环境信息
  'project',         // 项目
  'skill',           // 技能
  'user_context',    // 用户画像：偶尔更新
  'entity',          // 实体
  'idea',            // 想法
  'experience',      // 经验：较常新增
  'artifact',        // 产出物
  'project_status',  // 项目状态 / LOG 流水：更新最频繁 → 放最后
];

/** 将 LTM 参考格式化为 prompt 文本（含 content 全文，供 LLM 直接判断合并，无需工具）
 *
 * 缓存友好设计：
 * - type 顺序固定（TYPE_STABLE_ORDER），不随更新而重排
 * - 组内记录按 id ASC（老 → 新），新增记录追加到末尾
 * - 标题不显示条数（条数会变，会破坏前缀）
 * → 除新增/更新的那条记录之外，前面全部保持字节级一致，可命中 KV 缓存。
 */
function formatLtmReference(ltmRef) {
  if (!ltmRef || Object.keys(ltmRef).length === 0) return '（暂无已有记录）';
  const types = Object.keys(ltmRef).sort((a, b) => {
    const ia = TYPE_STABLE_ORDER.indexOf(a);
    const ib = TYPE_STABLE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
  let text = '';
  for (const type of types) {
    const items = ltmRef[type];
    text += `\n## ${type}\n`;
    for (const item of items) {
      text += `- [${item.logical_key}] ${item.title}\n`;
      text += `  description: ${item.description || '（无）'}\n`;
      text += `  content: ${item.content || '（无）'}\n`;
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

  // 守卫：单次扫描最多处理 maxRoundsPerScan 轮，避免极端积压时把整段历史塞进一个 prompt
  const remaining = currentMaxRound - lastScanned;
  if (remaining > CONFIG.maxRoundsPerScan * 4) {
    console.log(`[${ownerUserId}] Backlog is large (${remaining} rounds behind). Will catch up in batches of ${SCAN_INTERVAL_ROUNDS}.`);
  }

  // 计算本次扫描的目标轮次：lastScanned + SCAN_INTERVAL_ROUNDS
  const targetRound = lastScanned + SCAN_INTERVAL_ROUNDS;

  // 获取 lastScanned 之后的所有消息
  const result = db.chatGetSinceRound(ownerUserId, lastScanned);
  if (!result || !result.messages || result.messages.length === 0) {
    // 轮次计数与实际消息不一致时，若在此 return 而不推进，会永久卡死 → 直接推进游标
    console.log(`[${ownerUserId}] No messages found since round ${lastScanned}. Advancing cursor to ${targetRound} to avoid stalling.`);
    scanState[ownerUserId] = targetRound;
    saveScannerState(ownerUserId, targetRound);
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

  // 调用 LLM（单次请求：LTM 全文已直接注入，无需 ltm_get 工具）
  const messages = [
    { role: 'system', content: SCANNER_PROMPT },
    { role: 'user', content: `【已有 LTM 记忆（按 type 分组，仅 active 最新版本，已含完整内容）】${ltmRefText}

【需要扫描的对话】
以下是最新 ${SCAN_INTERVAL_ROUNDS} 轮对话内容。

【工作方式 —— 不使用任何工具】
- 上方已给出每条记忆的完整内容，直接阅读即可判断是否属于同一主题，不需要查询任何东西。
- 若要把新信息【合并进已有记录】，基于上方全文拼接后，输出更新后的完整 content。
- 若是一条原本不存在的新记忆，直接新增即可。
- 请一次性输出最终 JSON 结果，不要请求额外信息。

${contextMessages}` }
  ];

  /**
   * 发起一次 LLM 请求。
   * LTM 全文已直接注入 prompt，因此默认不携带任何工具（useTools=false）：
   * 单次请求即可拿到最终 JSON，不存在"工具循环耗尽"的失败模式。
   * 保留 useTools 参数仅作兼容：若将来 LTM 过大需改回按需取用，可传 true。
   */
  async function callLlm(useTools) {
    const payload = {
      model: MODEL,
      messages: messages,
      // 不设 max_tokens（由 provider 用模型默认上限，避免推理模型的 reasoning 耗光预算）
      // 不设 temperature（由 provider 用默认值）—— 只传最小必要参数，除非明确要求
    };
    if (useTools) {
      payload.tools = [LTM_GET_TOOL];
      payload.tool_choice = 'auto';
    }

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
      return { error: 'llm_error', detail: `${response.status} ${errText}` };
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    if (!msg) {
      console.error(`[${ownerUserId}] LLM returned empty message`);
      return { error: 'empty_llm_response', detail: 'empty message' };
    }

    // ---- 可观测性：正文为空时，打日志区分是哪种"空" ----
    // 推理模型常见情况：max_tokens 被 reasoning 耗尽 → content 空 + finish_reason=length
    const finishReason = choice?.finish_reason;
    const reasoningLen = (msg.reasoning || '').length;
    const usage = data.usage || {};
    if (!msg.content) {
      console.warn(
        `[${ownerUserId}] LLM content is empty | finish_reason=${finishReason}` +
        ` | completion_tokens=${usage.completion_tokens ?? '?'}` +
        ` | reasoning_chars=${reasoningLen}` +
        ` | prompt_chars=${(messages.reduce((s, m) => s + (m.content || '').length, 0) / 1024).toFixed(1)}KB`
      );
      // 诊断日志：正文为空时把原始响应（截断）打印出来，便于排查 provider/模型异常
      try {
        console.warn(`[${ownerUserId}] empty-content raw response (truncated): ${JSON.stringify(data).slice(0, 600)}`);
      } catch (_) {}
    }

    // ---- 缓存命中可观测：每批都打，便于直接验证前缀稳定性改造的效果 ----
    // OpenRouter 在 usage.prompt_tokens_details.cached_tokens 返回被复用的 prompt token 数。
    // LTM 已按「固定 type 顺序 + 组内 id ASC(老→新)」排列，连续 batch 之间除新增点外应高度命中；
    // 若这里长期只有 system 那 2~3K token 命中，说明前缀里还有会变的东西，需要继续排查。
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
    const promptTokens = usage.prompt_tokens ?? 0;
    console.log(
      `[${ownerUserId}] LLM ok | finish=${finishReason}` +
      ` | prompt=${promptTokens}tok cached=${cachedTokens}tok (${promptTokens ? Math.round(cachedTokens / promptTokens * 100) : 0}%)` +
      ` | completion=${usage.completion_tokens ?? '?'}tok | reasoning_chars=${reasoningLen}`
    );

    return { msg, finishReason, reasoning: msg.reasoning || '' };
  }

  try {
    // 单次请求即可完成：LTM 全文已注入，且不向模型提供任何工具
    const r = await callLlm(false);
    if (r.error) return handleScanFailure(ownerUserId, targetRound, r.error, r.detail);

    // 取最终 JSON：优先正文；正文为空时，推理模型可能把结果写进了 reasoning → 兜底提取
    let llmContent = r.msg.content || '';
    if (!llmContent && r.reasoning) {
      const m = r.reasoning.match(/```(?:json)?\s*(\{[\s\S]*?items[\s\S]*?\})\s*```/) ||
                r.reasoning.match(/(\{[\s\S]*"items"[\s\S]*\})/);
      if (m) {
        llmContent = m[1];
        console.log(`[${ownerUserId}] content empty; recovered JSON from reasoning (${llmContent.length} chars)`);
      }
    }
    if (!llmContent) {
      // 诊断已在上层打了 finish_reason / reasoning / usage，这里只做失败计数
      return handleScanFailure(ownerUserId, targetRound, 'empty_llm_response', 'empty content (see finish_reason/usage log above)');
    }

    // 解析并保存
    const saveResult = parseAndSaveLtm(llmContent, ownerUserId, targetRound);
    if (!saveResult.success) return handleScanFailure(ownerUserId, targetRound, 'parse_error', saveResult.error);

    // 更新扫描进度（成功 → 清空连续失败计数）
    resetScanFailures(ownerUserId);
    scanState[ownerUserId] = targetRound;
    saveScannerState(ownerUserId, targetRound);

    return { scanned: true, items_saved: saveResult.items_saved };

  } catch (e) {
    console.error(`[${ownerUserId}] LLM call failed:`, e.message);
    return handleScanFailure(ownerUserId, targetRound, 'llm_exception', e.message);
  }
}

// ==================================================================
// 跨进程互斥锁
// 场景：同时开着开发版（npm start）和打包版 app 时，会有两个 scanner 进程
// 指向同一个 DB —— 它们读到同一个游标、重复调用 LLM、并写入重复 LTM 记录。
// 单进程内已有 _scanInFlight 锁，这里再挡住「跨进程」的并发。
// ==================================================================
const LOCK_FILE = path.join(
  configJson.data_dir || path.join(CONFIG.baseDir, 'data'),
  '.ltm-scanner.lock'
);
let _lockHeld = false;

/** 进程是否存活（signal 0 仅探测，不真正发送信号） */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';  // 存在但无权限 → 视为存活
  }
}

/** 获取扫描锁；持锁进程仍存活时返回 false，本实例应保持 idle */
function acquireScannerLock() {
  try {
    const holder = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (holder && holder !== process.pid && pidAlive(holder)) {
      console.log(`[lock] Another scanner is active (pid ${holder}); this instance stays idle.`);
      return false;
    }
    if (holder) console.log(`[lock] Taking over stale lock from dead pid ${holder}.`);
  } catch (e) {
    // 锁文件不存在 → 正常，继续获取
  }
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    _lockHeld = true;
    console.log(`[lock] Acquired scanner lock (pid ${process.pid}).`);
    return true;
  } catch (e) {
    console.warn('[lock] Failed to write lock file:', e.message);
    return false;
  }
}

function releaseScannerLock() {
  if (!_lockHeld) return;
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 已删除则忽略 */ }
  _lockHeld = false;
}

process.on('exit', releaseScannerLock);
process.on('SIGTERM', () => { releaseScannerLock(); process.exit(0); });
process.on('SIGINT', () => { releaseScannerLock(); process.exit(0); });

// 防止 setInterval 在上一次扫描未结束时叠加触发（会造成并发的重复 LLM 调用）
let _scanInFlight = false;

// 休眠模式开关。注意「休眠」= 不调 LLM + 不打日志 + 低频轮询，
// 不是彻底停掉定时器 —— scanner 是独立子进程，没有外部唤醒信号，只能自己轮询探测用户是否回来。
// 状态切换（进入/退出休眠）各打一条日志，休眠期间全程静默。
let _sleepMode = false;

/**
 * 启动扫描循环
 */
/**
 * 启动一次扫描。
 * @returns {{madeProgress: boolean, allSleeping: boolean}}
 *   madeProgress 本周期是否至少推进了一批；allSleeping 所有用户是否都在闲置休眠中
 */
async function startScanner() {
  if (_scanInFlight) {
    console.log('Scan cycle skipped: previous cycle still running (prevents overlapping LLM calls).');
    return { madeProgress: false };
  }
  // 跨进程互斥：已有实例在扫描，则本实例 idle（避免并发重复调用 LLM / 写入重复记录）
  if (!_lockHeld && !acquireScannerLock()) {
    console.log('Scan cycle skipped: another scanner instance holds the lock.');
    return { madeProgress: false };
  }
  _scanInFlight = true;
  let madeProgress = false;
  try {
    const users = getUsersToScan();

    // ---- 休眠状态机：只在"进入"和"退出"两个瞬间各打一条，其余时间全程静默 ----
    // 放在循环【之前】判定，这样唤醒那一个周期也会正常打印 Starting/Complete，
    // 不会出现"只打印 Complete 却没有 Starting"的错位日志。
    let allSleeping;
    if (users.length === 0) {
      allSleeping = _sleepMode;   // 无用户：维持当前状态，不触发切换日志
    } else {
      allSleeping = users.every(u => isUserIdleForLong(u));
    }

    if (allSleeping && !_sleepMode) {
      const idleMin = Math.round(Math.max(...users.map(u => msSinceLastUserMessage(u) || 0)) / 60000);
      console.log(`😴 [sleep] All user(s) idle ~${idleMin}min (≥ ${Math.round(CONFIG.sleepAfterIdleMs / 60000)}min) — ` +
                  `scanner sleeping: no LLM calls, no logs, polling every ${Math.round(CONFIG.sleepPollIntervalMs / 60000)}min until next message.`);
      _sleepMode = true;
    } else if (!allSleeping && _sleepMode) {
      console.log(`👋 [wake] Scanner resumed — user active again or unscanned backlog ready (normal interval ${Math.round(CONFIG.checkIntervalMs / 60000)}min).`);
      _sleepMode = false;
    }

    // 休眠期间这两行框架日志也不打：否则闲置一晚上会滚出上百行无用的 Starting/Complete
    if (!_sleepMode) console.log(`Starting scan cycle for ${users.length} users...`);

    for (const uid of users) {
      try {
        // 长时间闲置（例如用完忘了关应用）→ 该用户跳过，等下次有新消息再恢复
        if (isUserIdleForLong(uid)) continue;

        // 一个周期最多处理 maxBatchesPerCycle 批：可追赶积压，但有上限
        for (let batch = 0; batch < CONFIG.maxBatchesPerCycle; batch++) {
          // 用户正在聊天 → 让路，等空闲再扫（scanner 与前端共用同一个 OpenRouter API key）
          if (isUserActive(uid)) {
            console.log(`  [${uid}] User is chatting (recent activity) — deferring scan to keep chat responsive.`);
            break;
          }

          const r = await scanUser(uid);

          if (r.reason === 'need_more_rounds') {
            console.log(`  [${uid}] Scan deferred: ${r.new_rounds}/${r.threshold} rounds`);
            break;
          }
          if (r.reason === 'no_new_messages') break;

          if (r.scanned) {
            console.log(`  [${uid}] ✅ Batch ${batch + 1}: scanned, saved ${r.items_saved} items`);
            madeProgress = true;  // 本周期至少推进了一批
            continue;  // 成功 → 继续追赶下一批
          }

          if (r.force_skipped) {
            console.log(`  [${uid}] ⏭️ Batch force-skipped after ${r.consecutive_failures} failures (${r.reason})`);
            continue;  // 已跳过该批，可尝试下一批
          }

          console.log(`  [${uid}] ⚠️ Scan failed: ${r.reason} (${r.consecutive_failures}/${CONFIG.maxConsecutiveFailures}) — retry next cycle`);
          break;  // 尚有重试机会，本周期停止，把 API 留给前端对话
        }
      } catch (e) {
        console.error(`[${uid}] Scan error:`, e.message);
      }
    }

    if (!_sleepMode) console.log('Scan cycle complete.');
    return { madeProgress, allSleeping };
  } finally {
    _scanInFlight = false;
  }
}

/**
 * 调度器：追积压模式（catch-up）与正常模式。
 * - 有积压（本周期推进过）→ 立刻再扫一批，间隔 catchUpIntervalMs，直到追平
 * - 追平 / 无积压 → 回到 checkIntervalMs 的常规周期
 */
function runScheduler() {
  // 休眠中：先做一次轻量探测（几个 SQLite 查询，不抢锁、不建 prompt、不调 LLM）。
  // 用户还没回来就直接再睡，整个周期完全跳过 —— 这才是真正的"睡"，而不是空转。
  if (_sleepMode) {
    let stillAsleep = true;
    try {
      stillAsleep = !getUsersToScan().some(uid => !isUserIdleForLong(uid));
    } catch (e) { /* 探测失败按继续休眠处理，下次再试 */ }
    if (stillAsleep) {
      setTimeout(runScheduler, CONFIG.sleepPollIntervalMs);
      return;
    }
  }

  startScanner()
    .then(({ madeProgress, allSleeping }) => {
      if (madeProgress) {
        console.log(`Backlog mode: next batch in ${CONFIG.catchUpIntervalMs / 1000}s`);
        setTimeout(runScheduler, CONFIG.catchUpIntervalMs);
      } else if (allSleeping) {
        setTimeout(runScheduler, CONFIG.sleepPollIntervalMs);
      } else {
        setTimeout(runScheduler, CONFIG.checkIntervalMs);
      }
    })
    .catch(e => {
      console.error('Scanner cycle error:', e.message);
      setTimeout(runScheduler, CONFIG.checkIntervalMs);
    });
}

console.log('LTM Scanner started. Normal interval:', CONFIG.checkIntervalMs, 'ms; catch-up interval:', CONFIG.catchUpIntervalMs, 'ms');
runScheduler();