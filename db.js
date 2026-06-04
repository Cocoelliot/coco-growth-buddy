/**
 * db.js — Growth Buddy LLM SQLite 数据库模块
 * 
 * 提供聊天记录、LTM、配置、系统状态的持久化存储。
 * 依赖 better-sqlite3（同步 API，Electron 友好）。
 * 
 * 使用方式：
 *   const { AppDB } = require('./db');
 *   const db = new AppDB('./data');   // 会在 ./data/growth-buddy.db 创建
 *   db.chatAdd('user', '你好', 'default');
 *   const msgs = db.chatGetRecent('default', 20);
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

class AppDB {

  /**
   * @param {string} dataDir - 数据库文件存放目录（相对或绝对路径）
   * @param {object} [config] - 外部配置对象（可选，用于覆盖 config 表初始值）
   */
  constructor(dataDir, config) {
    const absDir = path.resolve(dataDir);
    if (!fs.existsSync(absDir)) {
      fs.mkdirSync(absDir, { recursive: true });
    }

    this.db = new Database(path.join(absDir, 'growth-buddy.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this._initSchema();
    this._syncConfigFromJson(config);
  }

  /** 关闭数据库连接 */
  close() {
    this.db.close();
  }

  // ==================================================================
  // Schema
  // ==================================================================

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL DEFAULT 'default',
        role          TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
        content       TEXT NOT NULL,
        round_num     INTEGER NOT NULL DEFAULT 0,
        model         TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_owner_round 
        ON chat_messages(owner_user_id, round_num);

      CREATE TABLE IF NOT EXISTS ltm_records (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_user_id TEXT NOT NULL DEFAULT 'default',
        type          TEXT NOT NULL,
        logical_key   TEXT NOT NULL,
        title         TEXT NOT NULL DEFAULT '',
        tags          TEXT NOT NULL DEFAULT '',
        description   TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'active',
        origin_prompt TEXT NOT NULL DEFAULT '',
        background    TEXT NOT NULL DEFAULT '',
        source_round  INTEGER,
        created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      CREATE INDEX IF NOT EXISTS idx_ltm_owner_type 
        ON ltm_records(owner_user_id, type);
      CREATE INDEX IF NOT EXISTS idx_ltm_owner_key  
        ON ltm_records(owner_user_id, logical_key);

      CREATE TABLE IF NOT EXISTS app_config (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /** 从 config.json 同步初始配置到 app_config 表 */
  _syncConfigFromJson(configJson) {
    if (!configJson) return;
    const flat = this._flattenConfig(configJson, '');
    const upsert = this.db.prepare(`
      INSERT INTO app_config (key, value, updated_at) 
      VALUES (@key, @value, datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    const tx = this.db.transaction(() => {
      for (const { key, value } of flat) {
        upsert.run({ key, value });
      }
    });
    tx();
  }

  /** 把嵌套 JSON 展平为 dot 分隔的 key-value */
  _flattenConfig(obj, prefix) {
    const result = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_')) continue; // 跳过注释
      const key = prefix ? `${prefix}.${k}` : k;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        result.push(...this._flattenConfig(v, key));
      } else {
        result.push({ key, value: String(v) });
      }
    }
    return result;
  }

  // ==================================================================
  // Chat
  // ==================================================================

  /** 追加一条聊天消息，自动递增 round_num */
  chatAdd(ownerUserId, role, content, model) {
    const maxRound = this.db.prepare(
      `SELECT COALESCE(MAX(round_num), 0) AS max_round 
       FROM chat_messages WHERE owner_user_id = ?`
    ).get(ownerUserId);

    const roundNum = role === 'user' ? maxRound.max_round + 1 : maxRound.max_round;

    const stmt = this.db.prepare(
      `INSERT INTO chat_messages (owner_user_id, role, content, round_num, model)
       VALUES (?, ?, ?, ?, ?)`
    );
    const info = stmt.run(ownerUserId, role, content, roundNum, model || null);
    return { id: info.lastInsertRowid, round_num: roundNum };
  }

  /** 获取最近的 N 轮对话（用于 LLM 上下文）
   * 返回格式：{ messages: [], total_rounds: number, owner_user_id: string }
   */
  chatGetRecent(ownerUserId, windowSize) {
    const maxRound = this.db.prepare(
      `SELECT COALESCE(MAX(round_num), 0) AS max_round 
       FROM chat_messages WHERE owner_user_id = ?`
    ).get(ownerUserId);

    const minRound = Math.max(0, maxRound.max_round - windowSize);

    const messages = this.db.prepare(
      `SELECT role, content, round_num, model, created_at
       FROM chat_messages
       WHERE owner_user_id = ? AND round_num > ?
       ORDER BY id ASC`
    ).all(ownerUserId, minRound);

    return {
      messages,
      total_rounds: maxRound.max_round,
      owner_user_id: ownerUserId
    };
  }

  /** 获取总轮次数（以 user 消息计算）
   * 返回格式：{ count: number, owner_user_id: string }
   */
  chatGetCount(ownerUserId) {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(round_num), 0) AS count
       FROM chat_messages WHERE owner_user_id = ? AND role = 'user'`
    ).get(ownerUserId);
    return { count: row.count, owner_user_id: ownerUserId };
  }

  /** 获取指定 round 之后的所有消息（用于 LTM Scanner 增量扫描）
   * 返回格式：{ messages: [], owner_user_id: string }
   */
  chatGetSinceRound(ownerUserId, sinceRound) {
    const messages = this.db.prepare(
      'SELECT role, content, round_num, model, created_at ' +
      'FROM chat_messages ' +
      'WHERE owner_user_id = ? AND round_num > ? ' +
      'ORDER BY id ASC'
    ).all(ownerUserId, sinceRound);
    return { messages, owner_user_id: ownerUserId };
  }

  // ==================================================================
  // LTM
  // ==================================================================

  /** 保存一条 LTM 记录（append-only 版本化） */
  ltmSave(record) {
    const stmt = this.db.prepare(`
      INSERT INTO ltm_records 
        (owner_user_id, type, logical_key, title, tags, description, content, status, 
         origin_prompt, background, source_round)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      record.owner_user_id || 'default',
      record.type,
      record.logical_key,
      record.title || '',
      record.tags || '',
      record.description || '',
      record.content || '',
      record.status || 'active',
      record.origin_prompt || '',
      record.background || '',
      record.source_round || null
    );
    return { id: info.lastInsertRowid };
  }

  /** 搜索 LTM（积分制 + 动态上限）
   *   - 分词后过滤停用词（含 key 前缀）
   *   - 积分规则: key×5 + title×3 + desc×2 + tag×1 + slug×50 + exact×100
   *   - 动态上限: STAT 精确 → 1, slug → 5, 默认 → 30
   */
  ltmSearch({ ownerUserId, title, tags, type }) {
    const uid = ownerUserId || 'default';

    // --- 1. 取候选集（最新版本，宽 LIKE 初筛） ---
    let sql = `SELECT l1.* FROM ltm_records l1
               LEFT JOIN ltm_records l2 ON l1.logical_key = l2.logical_key
                 AND l1.owner_user_id = l2.owner_user_id
                 AND l1.id < l2.id
               WHERE l2.id IS NULL AND l1.owner_user_id = ?`;
    const params = [uid];

    if (type) { sql += ` AND l1.type = ?`; params.push(type); }

    const query = (title || '').trim();
    const rawQuery = query.toLowerCase();

    // 检测 STAT 精确 key 和 slug
    const statKeyMatch = rawQuery.match(/(stat:prj:\d{4}-\d{3})/i);
    const slugMatch   = rawQuery.match(/([a-z0-9]+(?:-[a-z0-9]+){1,})/i);

    // --- 2. 分词（去标点 + 空格拆词 + 过滤停用词） ---
    const stopwords = [
      'on','in','of','the','and','to','for','by','at','as','or',
      'with','from','this','that','into','over',
      'sk','prj','log','art','ent','ctx','env','idea','exp','stat'
    ];
    const tokens = [];
    const raw = query.replace(/[^0-9a-zA-Z\u4e00-\u9fff]+/g, ' ').split(/\s+/).filter(Boolean);
    for (const t of raw) {
      const l = t.toLowerCase();
      if (l.length >= 2 && !stopwords.includes(l)) tokens.push(l);
    }

    // 宽 LIKE 初筛（搜 logical_key + title + description + content）
    if (tokens.length > 0) {
      const conds = tokens.map(() => `(l1.logical_key LIKE ? OR l1.title LIKE ? OR l1.description LIKE ? OR l1.content LIKE ?)`);
      sql += ` AND (${conds.join(' OR ')})`;
      for (const t of tokens) {
        const p = `%${t}%`; params.push(p, p, p, p);
      }
    }

    sql += ` ORDER BY l1.created_at DESC LIMIT 100`;
    const candidates = this.db.prepare(sql).all(...params);

    // --- 3. JS 积分 + 排序 ---
    const tagRaw = (tags || '').toLowerCase();
    const scored = candidates.map(r => {
      const ti = (r.title       || '').toLowerCase();
      const ky = (r.logical_key || '').toLowerCase();
      const tg = (r.tags        || '').toLowerCase();
      const de = (r.description || '').toLowerCase();

      let titleHits = 0, keyHits = 0, tagHits = 0, descHits = 0;
      for (const tok of tokens) {
        if (ti.includes(tok)) titleHits++;
        if (ky.includes(tok)) keyHits++;
        if (tg.includes(tok)) tagHits++;
        if (de.includes(tok)) descHits++;
      }

      const exactKey = (ky === rawQuery);
      const slugHit  = slugMatch ? (ky.includes(slugMatch[1]) || ti.includes(slugMatch[1])) : false;

      const score = (titleHits * 3) + (keyHits * 5) + (descHits * 2) + (tagHits * 1)
                  + (exactKey ? 100 : 0) + (slugHit ? 50 : 0);

      return { ...r, titleHits, keyHits, descHits, tagHits,
               exactKeyMatch: exactKey, slugMatch: slugHit, totalScore: score };
    }).filter(s => s.totalScore > 0);

    // --- 4. 排序 + 动态上限 ---
    scored.sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if ((b.exactKeyMatch ? 1 : 0) !== (a.exactKeyMatch ? 1 : 0)) return (b.exactKeyMatch ? 1 : 0) - (a.exactKeyMatch ? 1 : 0);
      if ((b.slugMatch ? 1 : 0) !== (a.slugMatch ? 1 : 0)) return (b.slugMatch ? 1 : 0) - (a.slugMatch ? 1 : 0);
      if (b.keyHits !== a.keyHits) return b.keyHits - a.keyHits;
      if (b.titleHits !== a.titleHits) return b.titleHits - a.titleHits;
      if (b.descHits !== a.descHits) return b.descHits - a.descHits;
      return new Date(b.created_at) - new Date(a.created_at);
    });

    let limit = 30;
    if (statKeyMatch) limit = 1;
    else if (slugMatch) limit = 5;

    return scored.slice(0, limit);
  }

  /** 获取最新版本的 LTM 记录（按 logical_key 去重） */
  ltmGetLatest(logicalKey, ownerUserId) {
    return this.db.prepare(`
      SELECT l1.* FROM ltm_records l1
      LEFT JOIN ltm_records l2 ON l1.logical_key = l2.logical_key 
        AND l1.owner_user_id = l2.owner_user_id
        AND l1.id < l2.id
      WHERE l2.id IS NULL AND l1.logical_key = ? AND l1.owner_user_id = ?
    `).get(logicalKey, ownerUserId || 'default');
  }

  /** 获取 LTM Preload（按 type 分组，per-type 字段策略：
   *   - principle / user_context: title + description + full content（user_context content 截断 500 字）
   *   - project / experience / skill / idea / entity / environment: title + description + logical_key
   *   - project_status / artifact: title + description + logical_key，仅最近 30 天
   *   优先级：principle > user_context > skill > experience > entity > idea > project > project_status > artifact > environment
   *   不 preload: tags（索引用，system message 中不展示）
   */
  ltmGetPreload(ownerUserId, maxRecords) {
    const uid = ownerUserId || 'default';
    const limit = maxRecords || 25;

    // 取所有 active 最新记录（不做 LIMIT，由 JS 按 type 控制上限）
    const all = this.db.prepare(`
      SELECT l1.logical_key, l1.type, l1.title, l1.tags, l1.description, l1.content, l1.created_at
      FROM ltm_records l1
      LEFT JOIN ltm_records l2 ON l1.logical_key = l2.logical_key
        AND l1.owner_user_id = l2.owner_user_id
        AND l1.id < l2.id
      WHERE l2.id IS NULL AND l1.status = 'active' AND l1.owner_user_id = ?
      ORDER BY l1.id DESC
    `).all(uid);

    const typeConfig = {
      principle:       { fields: {logical_key:1,type:1,title:1,description:1,content:1,created_at:1},          dayLimit: 0 },
      user_context:    { fields: {logical_key:1,type:1,title:1,description:1,content:1,created_at:1},          dayLimit: 0, truncate: 500 },
      skill:           { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
      experience:      { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
      entity:          { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
      idea:            { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
      project:         { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
      project_status:  { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 30 },
      artifact:        { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 30 },
      environment:     { fields: {logical_key:1,type:1,title:1,description:1,created_at:1},                     dayLimit: 0 },
    };

    const typeOrder = ['principle','user_context','skill','experience','entity','idea','project','project_status','artifact','environment'];
    const now = new Date();
    const logCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const result = [];

    for (const type of typeOrder) {
      const cfg = typeConfig[type];
      if (!cfg) continue;

      const items = all.filter(r => r.type === type);

      for (const item of items) {
        if (result.length >= limit) break;

        // 时间窗口过滤（仅对 dayLimit > 0 的 type 生效）
        if (cfg.dayLimit > 0) {
          if (new Date(item.created_at + 'Z') < logCutoff) continue;
        }

        const trimmed = {};
        if (cfg.fields.logical_key) trimmed.logical_key = item.logical_key;
        if (cfg.fields.type)        trimmed.type        = item.type;
        if (cfg.fields.title)       trimmed.title       = item.title;
        if (cfg.fields.description) trimmed.description = item.description;
        if (cfg.fields.created_at)  trimmed.created_at  = item.created_at;
        if (cfg.fields.content) {
          let c = item.content || '';
          if (cfg.truncate && c.length > cfg.truncate) c = c.slice(0, cfg.truncate) + '...';
          trimmed.content = c;
        }

        result.push(trimmed);
      }
    }

    return result;
  }

  // ==================================================================
  // Config
  // ==================================================================

  /** 读取配置值 */
  configGet(key) {
    const row = this.db.prepare(
      `SELECT value FROM app_config WHERE key = ?`
    ).get(key);
    return row ? row.value : null;
  }

  /** 写入配置值 */
  configSet(key, value) {
    this.db.prepare(`
      INSERT INTO app_config (key, value, updated_at)
      VALUES (?, ?, datetime('now','localtime'))
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, String(value));
  }

  /** 获取所有配置（展平键值对） */
  configGetAll() {
    const rows = this.db.prepare(`SELECT key, value FROM app_config`).all();
    const result = {};
    for (const r of rows) {
      result[r.key] = r.value;
    }
    return result;
  }

  // ==================================================================
  // State
  // ==================================================================

  /** 读取系统状态 */
  stateGet(key) {
    const row = this.db.prepare(
      `SELECT value FROM app_state WHERE key = ?`
    ).get(key);
    return row ? row.value : null;
  }

  /** 写入系统状态 */
  stateSet(key, value) {
    this.db.prepare(`
      INSERT INTO app_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, String(value));
  }
}

module.exports = { AppDB };