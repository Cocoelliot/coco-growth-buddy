/* Coco Desktop (Electron) - main process */

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs/promises');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { AppDB } = require('./db');

let mainWindow;
const dashboardWindows = new Set();
let ltmScannerProcess = null;

// Root folder is hard-limited to ~/Documents/coco_docs
// COCO_DOCS_ROOT: configurable via config.json app.coco_docs_root, falls back to ./workspace
// loadAppConfig() must be called before any fs operations use this
function getCocoDocsRoot() {
  if (appConfig && appConfig.app && appConfig.app.coco_docs_root) {
    return path.resolve(DATA_ROOT, appConfig.app.coco_docs_root);
  }
  return path.join(DATA_ROOT, 'workspace');
}
let COCO_DOCS_ROOT = null;
// Will be set after loadAppConfig() in createWindow()


// === Growth Buddy LLM Config & DB ===
const APP_DIR = __dirname;
// DATA_ROOT: packaged → platform Documents/Coco Growth Buddy; dev → same as APP_DIR
function getDataRoot() {
  if (app.isPackaged) {
    return path.join(app.getPath('documents'), 'Coco Growth Buddy');
  }
  return APP_DIR;
}
let DATA_ROOT = null;
let appConfig = {};
let appDB = null;

function loadAppConfig() {
  try {
    const dir = DATA_ROOT || APP_DIR;
    const configPath = path.join(dir, 'config.json');
    if (fs.existsSync(configPath)) {
      appConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    console.warn('Failed to load config.json:', e.message);
  }
}

function initAppDB() {
  if (appDB) return;
  loadAppConfig();
  const dataDir = appConfig.app?.data_dir || './data';
  const absDataDir = path.resolve(DATA_ROOT, dataDir);
  appDB = new AppDB(absDataDir, appConfig);
  console.log('Growth Buddy DB initialized at', path.join(absDataDir, 'growth-buddy.db'));
}

function assertSafeUnderRoot(root, targetPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
    throw new Error('Forbidden path (path traversal)');
  }
  return resolvedTarget;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(d) {
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function safeSlug(s) {
  return String(s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getChatLogRelPath(userId, ts) {
  const d = ts ? new Date(ts) : new Date();
  const day = formatDate(d);
  const defaultUser = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  const safeUser = safeSlug(userId || defaultUser);
  return path.posix.join('_desktop_chat', `${safeUser}-chat-${day}.md`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Coco Desktop',
    backgroundColor: '#24283b',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),

      // IMPORTANT (regression fix): index.html uses require('electron') directly.
      // If contextIsolation=true, require() in renderer will break unless we refactor
      // the whole renderer to use contextBridge only.
      // So we keep the legacy MVP setup:
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,  // needed: file:// origin blocks CORS to OpenRouter API

    }
  });

  // DATA_ROOT must be set before initAppDB() and COCO_DOCS_ROOT
  if (!DATA_ROOT) {
    DATA_ROOT = getDataRoot();
    console.log('DATA_ROOT set to:', DATA_ROOT);
  }

  initAppDB();

  // 初始化 COCO_DOCS_ROOT（需在 loadAppConfig() 之后）
  if (!COCO_DOCS_ROOT) {
    COCO_DOCS_ROOT = getCocoDocsRoot();
    console.log('COCO_DOCS_ROOT set to:', COCO_DOCS_ROOT);
  }

  // 启动时导出当前 LTM Preload 供用户查看 + 备份
  exportLtmPreload();

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // macOS menu bar
  if (process.platform === 'darwin') {
    const menu = Menu.buildFromTemplate([{
      label: app.name,
      submenu: [
        { label: '偏好设置...', accelerator: 'Cmd+,', click: () => { mainWindow.webContents.send('menu:open-settings'); } },
        { type: 'separator' },
        { role: 'quit', label: '退出 ' + app.name }
      ]
    }, {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    }]);
    Menu.setApplicationMenu(menu);
  }

  createWindow();

  // 启动后台 LTM Scanner（使用 Electron 内置 Node，确保 native 模块版本匹配）
  try {
    const scannerPath = path.join(__dirname, 'ltm-scanner.js');
    ltmScannerProcess = spawn(process.execPath, [scannerPath], {
      cwd: __dirname,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false
    });
    console.log('LTM Scanner started (pid:', ltmScannerProcess.pid, ')');
    ltmScannerProcess.on('error', (err) => {
      console.error('LTM Scanner error:', err.message);
    });
    ltmScannerProcess.on('exit', (code, signal) => {
      console.log('LTM Scanner exited (code:', code, ', signal:', signal, ')');
      ltmScannerProcess = null;
    });
  } catch (e) {
    console.error('Failed to start LTM Scanner:', e.message);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  if (ltmScannerProcess) {
    ltmScannerProcess.kill('SIGTERM');
    ltmScannerProcess = null;
  }
});

app.on('window-all-closed', () => {
  if (ltmScannerProcess) {
    ltmScannerProcess.kill('SIGTERM');
    ltmScannerProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Coco Desktop Bridge (for dashboards) — writes limited to allowlist under coco_docs
// ---------------------------------------------------------------------------

// 发布版：留空，暂不开启桌面文件写入功能
const WRITE_ALLOWLIST_PREFIXES = [
  // Reserved for future use
];

function resolveAndValidateCocoDocsPath(relPath) {
  if (typeof relPath !== 'string') throw new Error('path must be string');

  const cleaned = relPath.replaceAll('\\\\', '/').trim();
  if (!cleaned) throw new Error('path empty');
  if (cleaned.includes('\\0')) throw new Error('path contains null byte');
  if (path.isAbsolute(cleaned)) throw new Error('absolute path not allowed');

  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith('../') || normalized === '..') {
    throw new Error('path traversal not allowed');
  }

  const ok = WRITE_ALLOWLIST_PREFIXES.some(prefix => normalized.startsWith(prefix));
  if (!ok) throw new Error(`path not in allowlist: ${normalized}`);

  const abs = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  return { normalized, abs };
}


// ---------------------------------------------------------------------------
// Growth Buddy LLM — Chat / LTM / Config / State IPC
// ---------------------------------------------------------------------------

ipcMain.handle('chat:add', async (_evt, payload) => {
  const uid = payload.owner_user_id || 'default';
  const role = payload.role;
  const c = payload.content;
  const model = payload.model || null;
  if (!role || !c) throw new Error('role and content required');
  if (!appDB) initAppDB();
  return appDB.chatAdd(uid, role, c, model);
});

ipcMain.handle('chat:get-recent', async (_evt, payload) => {
  const uid = (payload && payload.owner_user_id) || 'default';
  const ws = (payload && payload.window_size) || parseInt(appDB ? appDB.configGet('chat.window_size') || '20' : '20');
  if (!appDB) initAppDB();
  return appDB.chatGetRecent(uid, ws);
});

ipcMain.handle('chat:get-since-round', async (_evt, payload) => {  var uid = (payload && payload.owner_user_id) || 'default';  var since = (payload && payload.since_round) || 0;  if (!appDB) initAppDB();  return appDB.chatGetSinceRound(uid, since);});

ipcMain.handle('chat:get-count', async (_evt, payload) => {
  const uid = (payload && payload.owner_user_id) || 'default';
  if (!appDB) initAppDB();
  return appDB.chatGetCount(uid);
});

// --- LTM ---

ipcMain.handle('ltm:save', async (_evt, record) => {
  if (!appDB) initAppDB();
  // 强制使用当前实例的用户身份，不信任 LLM 填的 owner_user_id
  record.owner_user_id = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  return appDB.ltmSave(record);
});

ipcMain.handle('ltm:search', async (_evt, query) => {
  // 强制使用当前实例的用户身份，不信任前端传的 owner_user_id
  const uid = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  if (!appDB) initAppDB();
  return appDB.ltmSearch({ ...(query || {}), ownerUserId: uid });
});

ipcMain.handle('ltm:get-preload', async (_evt, payload) => {
  // 强制使用当前实例的用户身份，不信任前端传的 owner_user_id
  const uid = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  const mr = (payload && payload.max_records) || parseInt(appDB ? appDB.configGet('ltm.preload_max_records') || '25' : '25');
  if (!appDB) initAppDB();
  return appDB.ltmGetPreload(uid, mr);
});

ipcMain.handle('ltm:get-latest', async (_evt, payload) => {
  const uid = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  if (!appDB) initAppDB();
  return appDB.ltmGetLatest(payload.logical_key, uid);
});

// --- Config ---

ipcMain.handle('config:get', async (_evt, key) => {
  if (!appDB) initAppDB();
  return appDB.configGet(key);
});

ipcMain.handle('config:set', async (_evt, payload) => {
  if (!appDB) initAppDB();
  appDB.configSet(payload.key, payload.value);
  return { ok: true };
});

ipcMain.handle('config:get-all', async () => {
  if (!appDB) initAppDB();
  return appDB.configGetAll();
});

ipcMain.handle('config:write-file', async () => {
  if (!appDB) initAppDB();
  const cfg = appDB.configGetAll();
  const dir = DATA_ROOT || APP_DIR;
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    app: {
      owner_user_id: cfg['app.owner_user_id'] || 'default',
      user_name: cfg['app.user_name'] || 'Learner',
      coco_docs_root: './workspace'
    },
    llm: {
      api_key: cfg['llm.api_key'] || '',
      default_model: cfg['llm.default_model'] || 'deepseek/deepseek-v4-flash',
      vision_model: cfg['llm.vision_model'] || 'xiaomi/mimo-v2.5'
    }
  }, null, 2), 'utf8');
  return { ok: true };
});

// --- State ---

ipcMain.handle('state:get', async (_evt, key) => {
  if (!appDB) initAppDB();
  return appDB.stateGet(key);
});

ipcMain.handle('state:set', async (_evt, payload) => {
  if (!appDB) initAppDB();
  appDB.stateSet(payload.key, payload.value);
  return { ok: true };
});

ipcMain.handle('coco:ping', async () => {
  return { ok: true, cocoDocsDir: COCO_DOCS_ROOT };
});

ipcMain.handle('app:get-data-root', async () => {
  return { dataRoot: DATA_ROOT };
});

// --- Initial config save (for first-run setup via dmg) ---
ipcMain.handle('init:save-config', async (_evt, config) => {
  const dir = DATA_ROOT || APP_DIR;
  const configPath = path.join(dir, 'config.json');
  const newConfig = {
    app: {
      owner_user_id: (config.owner_user_id || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '_'),
      user_name: config.user_name || 'Learner',
      coco_docs_root: './workspace'
    },
    llm: {
      api_key: config.api_key || '',
      default_model: config.default_model || 'deepseek/deepseek-v4-flash',
      vision_model: config.vision_model || 'xiaomi/mimo-v2.5'
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf8');

  // Reload app config and re-init DB
  appConfig = newConfig;
  appDB = null;
  if (!COCO_DOCS_ROOT) {
    COCO_DOCS_ROOT = getCocoDocsRoot();
  }
  initAppDB();

  return { ok: true };
});

ipcMain.handle('coco:writeText', async (_evt, { path: relPath, text }) => {
  const { abs, normalized } = resolveAndValidateCocoDocsPath(relPath);

  if (typeof text !== 'string') throw new Error('text must be string');
  const bytes = Buffer.byteLength(text, 'utf8');
  const MAX = 5 * 1024 * 1024; // 5MB guard
  if (bytes > MAX) throw new Error(`payload too big: ${bytes} > ${MAX}`);

  await fsPromises.mkdir(path.dirname(abs), { recursive: true });
  await fsPromises.writeFile(abs, text, 'utf8');
  return { ok: true, path: normalized, bytes };
});

ipcMain.handle('coco:readText', async (_evt, { path: relPath }) => {
  // read is limited to coco_docs but not allowlisted (can tighten later if needed)
  if (!relPath) throw new Error('path is required');
  const cleaned = String(relPath).replaceAll('\\\\', '/').trim();
  if (!cleaned || path.isAbsolute(cleaned)) throw new Error('bad path');
  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith('../') || normalized === '..') throw new Error('path traversal');
  const abs = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  const text = await fsPromises.readFile(abs, 'utf8');
  return { ok: true, path: normalized, text };
});

// ---------------------------------------------------------------------------
// LTM Export — 启动时导出当前 LTM Preload 为 Markdown 文件（供用户查看 + 备份）
// ---------------------------------------------------------------------------

/** 导出当前 LTM Preload 到 user/ltm_export/ltm-preload-{timestamp}.md
 *  仅内容有变化时才写入，避免重复。 */
function exportLtmPreload() {
  try {
    const uid = (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
    const records = appDB.ltmGetPreload(uid, 200);

    const now = new Date();
    const ts = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

    let md = '# Growth Buddy LTM Preload Export\n';
    md += `**Exported at**: ${formatDateTime(now)}\n`;
    md += `**User**: ${uid}\n`;
    md += `**Total records**: ${records.length}\n\n`;
    md += '---\n\n';

    // Group by type
    const groups = {};
    const typeOrder = ['principle', 'user_context', 'skill', 'experience', 'entity', 'idea', 'project', 'artifact', 'project_status', 'environment'];

    for (const r of records) {
      const t = r.type || 'other';
      if (!groups[t]) groups[t] = [];
      groups[t].push(r);
    }

    for (const type of typeOrder) {
      const items = groups[type] || [];
      if (items.length === 0) continue;
      md += `## ${type} (${items.length})\n\n`;
      for (const r of items) {
        md += `### ${r.title || '(no title)'}\n`;
        md += `- **logical_key**: \`${r.logical_key}\`\n`;
        if (r.tags) md += `- **tags**: ${r.tags}\n`;
        if (r.description) md += `- **description**: ${r.description}\n`;
        md += '\n';
        if (r.content) {
          const snippet = r.content.length > 2000 ? r.content.slice(0, 2000) + '...' : r.content;
          md += '<details>\n';
          md += `<summary>Content (${r.content.length} chars)</summary>\n\n`;
          md += '```\n' + snippet + '\n```\n\n';
          md += '</details>\n\n';
        }
      }
    }

    // 与最近一次导出做版本比对：内容无变化则跳过
    const absDir = path.join(DATA_ROOT, 'users', uid, 'ltm_exports');
    const bodyForCompare = md.replace(/^\*\*Exported at\*\*: .+\n/m, '');
    let skip = false;
    try {
      const files = fs.readdirSync(absDir)
        .filter(f => f.startsWith('ltm-preload-') && f.endsWith('.md'))
        .sort()
        .reverse();
      if (files.length > 0) {
        const latest = fs.readFileSync(path.join(absDir, files[0]), 'utf8');
        const latestBody = latest.replace(/^\*\*Exported at\*\*: .+\n/m, '');
        if (bodyForCompare === latestBody) skip = true;
      }
    } catch (_) { /* 目录不存在或无法读取，跳过比较，照常写入 */ }

    if (skip) {
      console.log(`LTM preload: no changes since last export, skipping.`);
      return;
    }

    const fileName = `ltm-preload-${ts}.md`;
    const absPath = path.join(absDir, fileName);

    fs.mkdirSync(absDir, { recursive: true });
    fs.writeFileSync(absPath, md, 'utf8');

    console.log(`LTM preload exported: ltm_exports/${fileName} (${records.length} records, full path: ${absPath})`);
  } catch (e) {
    console.warn('LTM export failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Dashboard window (opens local HTML inside Electron so preload/bridge is available)
// ---------------------------------------------------------------------------

// 发布版：留空，暂不开启 Dashboard 功能
const DASH_ALLOWLIST_PREFIXES = [
  // Reserved for future use
];

function resolveAndValidateDashboardHtml(relPath) {
  if (typeof relPath !== 'string') throw new Error('path must be string');
  const cleaned = relPath.replaceAll('\\\\', '/').trim();
  if (!cleaned) throw new Error('path empty');
  if (path.isAbsolute(cleaned)) throw new Error('absolute path not allowed');

  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith('../') || normalized === '..') throw new Error('path traversal');
  if (!normalized.toLowerCase().endsWith('.html')) throw new Error('only .html supported');

  const ok = DASH_ALLOWLIST_PREFIXES.some(prefix => normalized.startsWith(prefix));
  if (!ok) throw new Error(`dashboard not allowlisted: ${normalized}`);

  const abs = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  return { normalized, abs };
}

function openDashboardWindow(relPath) {
  const { abs, normalized } = resolveAndValidateDashboardHtml(relPath);

  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    title: `Coco Dashboard — ${path.basename(normalized)}`,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    }
  });

  dashboardWindows.add(win);
  win.on('closed', () => dashboardWindows.delete(win));

  win.loadFile(abs);
  return { ok: true, path: normalized };
}

ipcMain.handle('dash:open', async (_evt, { path: relPath }) => {
  return openDashboardWindow(relPath);
});

// ---------------------------------------------------------------------------
// Existing IPC APIs: filesystem (coco_docs sandbox)
// ---------------------------------------------------------------------------

function normalizeRelPath(relPath) {
  const cleaned = String(relPath || '').replaceAll('\\\\', '/').trim();
  if (path.isAbsolute(cleaned)) throw new Error('absolute path not allowed');
  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith('../') || normalized === '..') throw new Error('path traversal');
  return normalized === '.' ? '' : normalized;
}

// Skip scanning big/non-text dirs by default (performance)
const DEFAULT_SKIP_PREFIXES = [
  'meetings/recordings',
  'music',
  'apps/coco_desktop/node_modules',
  'apps/coco_desktop/.git',
  // NOTE: we intentionally do NOT skip '_desktop_chat'.
  // Reason: users often remember "we talked about X" and need to search chat logs
  // to locate the exact day/file quickly.
];

function shouldSkipByPrefix(relPath, prefixes) {
  const p = normalizeRelPath(relPath);
  const list = Array.isArray(prefixes) ? prefixes : DEFAULT_SKIP_PREFIXES;
  if (!p) return false;
  return list.some(prefix => p === prefix || p.startsWith(prefix + '/'));
}

async function latestChildMtimeMs(absDir, relDir, opts = {}) {
  const depthLeft = Number.isFinite(opts.depthLeft) ? opts.depthLeft : 6;
  const maxItems = Number.isFinite(opts.maxItems) ? opts.maxItems : 5000;
  const skipPrefixes = Array.isArray(opts.skipPrefixes) ? opts.skipPrefixes : DEFAULT_SKIP_PREFIXES;
  const counter = opts.counter || { n: 0 };

  let latest = 0;

  if (depthLeft < 0) return latest;
  if (shouldSkipByPrefix(relDir, skipPrefixes)) return latest;

  let entries;
  try {
    entries = await fsPromises.readdir(absDir, { withFileTypes: true });
  } catch (_e) {
    return latest;
  }

  for (const d of entries) {
    if (d.name.startsWith('.')) continue;
    counter.n += 1;
    if (counter.n > maxItems) return latest;

    const abs = path.join(absDir, d.name);
    const rel = normalizeRelPath(path.posix.join(relDir || '', d.name));

    let st;
    try {
      st = await fsPromises.stat(abs);
    } catch (_e) {
      continue;
    }

    if (st.mtimeMs > latest) latest = st.mtimeMs;

    if (d.isDirectory()) {
      const child = await latestChildMtimeMs(abs, rel, {
        depthLeft: depthLeft - 1,
        maxItems,
        skipPrefixes,
        counter,
      });
      if (child > latest) latest = child;
    }
  }

  return latest;
}

ipcMain.handle('fs:listDir', async (_event, relPath = '', opts = {}) => {
  const normalizedRel = normalizeRelPath(relPath);
  const sortMode = (opts && typeof opts.sort === 'string') ? String(opts.sort) : 'name';

  const targetDir = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalizedRel));
  const items = await fsPromises.readdir(targetDir, { withFileTypes: true });

  const out = [];
  for (const d of items) {
    if (d.name.startsWith('.')) continue;
    const abs = path.join(targetDir, d.name);
    const rel = path.relative(COCO_DOCS_ROOT, abs).replace(/\\\\/g, '/');

    let st;
    try {
      st = await fsPromises.stat(abs);
    } catch (_e) {
      st = null;
    }

    const base = {
      name: d.name,
      isDir: d.isDirectory(),
      relPath: rel,
      mtime: st ? st.mtimeMs : 0,
    };

    if (base.isDir && sortMode === 'recent') {
      base.latestChildMtime = await latestChildMtimeMs(abs, rel, {
        depthLeft: 6,
        maxItems: 5000,
        skipPrefixes: DEFAULT_SKIP_PREFIXES,
      });
    }

    out.push(base);
  }

  if (sortMode === 'recent') {
    const dirs = out.filter(x => x.isDir);
    const files = out.filter(x => !x.isDir);

    dirs.sort((a, b) => {
      const am = a.latestChildMtime || a.mtime || 0;
      const bm = b.latestChildMtime || b.mtime || 0;
      if (bm !== am) return bm - am;
      return a.name.localeCompare(b.name);
    });

    files.sort((a, b) => {
      if ((b.mtime || 0) !== (a.mtime || 0)) return (b.mtime || 0) - (a.mtime || 0);
      return a.name.localeCompare(b.name);
    });

    return [...dirs, ...files];
  }

  // default name sort (legacy)
  return out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
});

ipcMain.handle('fs:readFileText', async (_event, relPath) => {
  if (!relPath) throw new Error('relPath is required');
  const normalized = normalizeRelPath(relPath);
  const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  return fs.readFileSync(target, 'utf8');
});

ipcMain.handle('fs:stat', async (_event, relPath) => {
  if (!relPath) throw new Error('relPath is required');
  const normalized = normalizeRelPath(relPath);
  const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  if (!fs.existsSync(target)) {
    return { exists: false };
  }
  const st = fs.statSync(target);
  return {
    exists: true,
    isFile: st.isFile(),
    isDir: st.isDirectory(),
    bytes: st.size,
    mtime: st.mtimeMs,
  };
});

ipcMain.handle('fs:writeFileText', async (_event, relPath, text) => {
  if (!relPath) throw new Error('relPath is required');
  const normalized = normalizeRelPath(relPath);
  const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, String(text ?? ''), 'utf8');
  return { ok: true, relPath: normalized.replace(/\\\\/g, '/') };
});

ipcMain.handle('fs:appendFileText', async (_event, relPath, text) => {
  if (!relPath) throw new Error('relPath is required');
  const normalized = normalizeRelPath(relPath);
  const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(target, String(text ?? ''), 'utf8');
  return { ok: true, relPath: normalized.replace(/\\\\/g, '/') };
});

ipcMain.handle('fs:getFileUrl', async (_event, relPath) => {
  if (!relPath) throw new Error('relPath is required');
  const normalized = normalizeRelPath(relPath);
  const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
  return pathToFileURL(target).toString();
});

ipcMain.on('fs:openInSystem', (_event, relPath) => {
  if (!relPath) return;
  try {
    const normalized = normalizeRelPath(relPath);
    const target = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, normalized));
    shell.openPath(target);
  } catch (_e) {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Search (filename + content) — scan on demand (no persistent index)
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_EXTS = ['.md', '.txt', '.json', '.js', '.html', '.csv'];
const SEARCH_MAX_FILE_BYTES_DEFAULT = 2 * 1024 * 1024; // 2MB

function toLowerSafe(s) {
  try { return String(s || '').toLowerCase(); } catch (_e) { return ''; }
}

function splitTokens(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  return q.split(/\\s+/g).map(x => x.trim()).filter(Boolean);
}

function countOccurrences(haystackLower, needleLower) {
  if (!needleLower) return 0;
  let c = 0;
  let idx = 0;
  while (true) {
    idx = haystackLower.indexOf(needleLower, idx);
    if (idx === -1) break;
    c += 1;
    idx += needleLower.length;
  }
  return c;
}

function makeSnippet(text, idx, needleLen) {
  const R = 64;
  const start = Math.max(0, idx - R);
  const end = Math.min(text.length, idx + needleLen + R);
  const raw = text.slice(start, end);
  return raw.replace(/\\s+/g, ' ').trim();
}

async function walkForSearch(absDir, relDir, opts, results, counter) {
  const { tokens, exts, includeContent, limit, maxFileBytes, skipPrefixes, depthLeft, maxEntries } = opts;

  if (results.length >= limit) return;
  if (depthLeft < 0) return;
  if (shouldSkipByPrefix(relDir, skipPrefixes)) return;

  let entries;
  try {
    entries = await fsPromises.readdir(absDir, { withFileTypes: true });
  } catch (_e) {
    return;
  }

  for (const d of entries) {
    if (results.length >= limit) return;
    if (d.name.startsWith('.')) continue;

    counter.n += 1;
    if (counter.n > maxEntries) return;

    const abs = path.join(absDir, d.name);
    const rel = normalizeRelPath(path.posix.join(relDir || '', d.name));

    if (d.isDirectory()) {
      await walkForSearch(abs, rel, { ...opts, depthLeft: depthLeft - 1 }, results, counter);
      continue;
    }

    // file
    const ext = path.extname(d.name).toLowerCase();
    if (!exts.includes(ext)) continue;

    let st;
    try {
      st = await fsPromises.stat(abs);
    } catch (_e) {
      continue;
    }

    if (!st.isFile()) continue;
    if (st.size > maxFileBytes) continue;

    const nameLower = toLowerSafe(d.name);

    // score from filename
    let score = 0;
    let nameHits = 0;
    for (const t of tokens) {
      const tl = toLowerSafe(t);
      const c = countOccurrences(nameLower, tl);
      if (c > 0) {
        nameHits += c;
        score += 50 + c * 10;
      }
    }

    let contentHits = 0;
    let snippet = '';

    if (includeContent) {
      let text;
      try {
        text = await fsPromises.readFile(abs, 'utf8');
      } catch (_e) {
        text = null;
      }

      if (text) {
        const tlower = toLowerSafe(text);
        for (const t of tokens) {
          const needle = toLowerSafe(t);
          const c = countOccurrences(tlower, needle);
          if (c > 0) {
            contentHits += c;
            score += c;

            if (!snippet) {
              const idx = tlower.indexOf(needle);
              if (idx >= 0) snippet = makeSnippet(text, idx, needle.length);
            }
          }
        }
      }
    }

    if (score <= 0) continue;

    results.push({
      relPath: rel,
      name: d.name,
      isDir: false,
      mtime: st.mtimeMs,
      bytes: st.size,
      score,
      nameHits,
      contentHits,
      snippet,
    });
  }
}

ipcMain.handle('fs:search', async (_event, payload = {}) => {
  const query = String(payload.query || '').trim();
  if (!query) return [];

  const baseRelPath = normalizeRelPath(payload.baseRelPath || '');
  const baseAbs = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, baseRelPath));

  const tokens = splitTokens(query);
  if (!tokens.length) return [];

  const exts = Array.isArray(payload.exts) && payload.exts.length
    ? payload.exts.map(x => String(x || '').toLowerCase()).filter(Boolean)
    : SEARCH_DEFAULT_EXTS;

  const includeContent = (payload.includeContent !== false);
  const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(500, payload.limit)) : 200;
  const maxFileBytes = Number.isFinite(payload.maxFileBytes) ? payload.maxFileBytes : SEARCH_MAX_FILE_BYTES_DEFAULT;
  const skipPrefixes = Array.isArray(payload.skipPrefixes) && payload.skipPrefixes.length
    ? payload.skipPrefixes.map(x => normalizeRelPath(x))
    : DEFAULT_SKIP_PREFIXES;

  const depthLeft = Number.isFinite(payload.depthLeft) ? payload.depthLeft : 10;
  const maxEntries = Number.isFinite(payload.maxEntries) ? payload.maxEntries : 20000;

  const results = [];
  const counter = { n: 0 };

  await walkForSearch(baseAbs, baseRelPath, {
    tokens,
    exts,
    includeContent,
    limit,
    maxFileBytes,
    skipPrefixes,
    depthLeft,
    maxEntries,
  }, results, counter);

  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((b.mtime || 0) !== (a.mtime || 0)) return (b.mtime || 0) - (a.mtime || 0);
    return String(a.relPath).localeCompare(String(b.relPath));
  });

  return results.slice(0, limit);
});

// ---- IPC APIs: chat log (append-only Markdown under coco_docs) ----
ipcMain.handle('chatlog:append', async (_event, payload) => {
  const userId = payload?.userId || (appConfig && appConfig.app && appConfig.app.owner_user_id) || 'default';
  const role = payload?.role || 'user';
  const text = payload?.text == null ? '' : String(payload.text);
  const mode = payload?.mode ? String(payload.mode) : '';
  const ts = payload?.ts || Date.now();

  const relPath = getChatLogRelPath(userId, ts);
  const absPath = assertSafeUnderRoot(COCO_DOCS_ROOT, path.join(COCO_DOCS_ROOT, relPath));
  const absDir = path.dirname(absPath);

  fs.mkdirSync(absDir, { recursive: true });

  const d = new Date(ts);
  const day = formatDate(d);
  const headerIfNew = `# Coco Desktop Chat Log — ${safeSlug(userId)} — ${day}\n\n`;

  const entryHeader = `## ${formatDateTime(d)}${mode ? ` (${mode})` : ''}\n`;
  const entryBody = `**${role}**: ${text.replace(/\r\n/g, '\n')}\n\n`;

  if (!fs.existsSync(absPath)) {
    fs.writeFileSync(absPath, headerIfNew, 'utf8');
  }
  fs.appendFileSync(absPath, entryHeader + entryBody, 'utf8');

  return { ok: true, relPath: relPath.replace(/\\\\/g, '/') };
});