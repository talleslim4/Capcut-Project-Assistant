const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findProjectRoot, findPresetRoot, findCapCut } = require('./paths');
const { safeName, uniqueDestination, uniqueEntryDestination, zipDirectory, zipEntry, zipContents, sevenDirectory, sevenEntry, sevenContents, extractArchive, projectPayload, copyDirectory, copyEntry } = require('./archive');
const execFileAsync = promisify(execFile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let projectRoot = null;
let presetRoot = null;
let mainWindow = null;
let lastRevealPath = null;
let driveSyncRunning = new Set();
const driveObservedModified = new Map();

function driveTokenFile() { return path.join(app.getPath('userData'), 'google-drive-token.json'); }
function driveCredentialsFile() {
  const candidates = [
    process.env.GOOGLE_OAUTH_CREDENTIALS_FILE,
    path.join(process.resourcesPath || '', 'google-oauth-desktop.json'),
    path.join(app.getAppPath(), 'secrets', 'google-oauth-desktop.json'),
    path.join(__dirname, '..', 'secrets', 'google-oauth-desktop.json')
  ].filter(Boolean);
  return candidates.find(fs.existsSync) || null;
}
async function driveCredentials() {
  const file = driveCredentialsFile();
  if (!file) throw new Error('Credencial do Google Drive não foi incluída nesta versão do aplicativo.');
  const data = JSON.parse(await fsp.readFile(file, 'utf8'));
  const config = data.installed || data.web;
  if (!config?.client_id || !config?.client_secret) throw new Error('Credencial OAuth do Google inválida.');
  return config;
}
async function readDriveToken() { try { return JSON.parse(await fsp.readFile(driveTokenFile(), 'utf8')); } catch { return null; } }
async function writeDriveToken(token) { await fsp.mkdir(path.dirname(driveTokenFile()), { recursive: true }); await fsp.writeFile(driveTokenFile(), JSON.stringify(token, null, 2), { mode: 0o600 }); }
async function driveAccessToken() {
  let token = await readDriveToken();
  if (!token) throw new Error('Conecte uma conta Google primeiro.');
  if (token.expires_at > Date.now() + 60000) return token.access_token;
  const credentials = await driveCredentials();
  const body = new URLSearchParams({ client_id: credentials.client_id, client_secret: credentials.client_secret, refresh_token: token.refresh_token, grant_type: 'refresh_token' });
  const response = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!response.ok) throw new Error('A autorização do Google expirou. Conecte a conta novamente.');
  const fresh = await response.json(); token = { ...token, ...fresh, expires_at: Date.now() + fresh.expires_in * 1000 }; await writeDriveToken(token); return token.access_token;
}
async function driveRequest(url, options = {}) {
  const token = await driveAccessToken();
  const response = await fetch(url, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (!response.ok) { const detail = await response.text(); throw new Error(`Google Drive recusou a operação (${response.status}). ${detail.slice(0, 180)}`); }
  return response;
}
async function driveState() {
  const token = await readDriveToken(); const library = await readLibrary();
  if (!token) return { connected: false, folder: library.driveFolder || null };
  try {
    const accessToken = await driveAccessToken();
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${accessToken}` } });
    const profile = response.ok ? await response.json() : {};
    return { connected: true, email: profile.email || token.email || '', folder: library.driveFolder || null };
  } catch { return { connected: false, reconnect: true, folder: library.driveFolder || null }; }
}
function driveFolderId(value) { const text = String(value || '').trim(); return text.match(/\/folders\/([\w-]+)/)?.[1] || text.match(/^[\w-]{10,}$/)?.[0] || ''; }

const emptyLibrary = () => ({ version: 3, clients: [], folders: {}, presetFolders: [], items: {} });
function libraryFile() { return path.join(app.getPath('userData'), 'library.json'); }
async function readLibrary() {
  try {
    const data = JSON.parse(await fsp.readFile(libraryFile(), 'utf8'));
    return { ...emptyLibrary(), ...data, clients: Array.isArray(data.clients) ? data.clients : [], folders: data.folders && typeof data.folders === 'object' ? data.folders : {}, presetFolders: Array.isArray(data.presetFolders) ? data.presetFolders : [], items: data.items && typeof data.items === 'object' ? data.items : {} };
  } catch { return emptyLibrary(); }
}
async function writeLibrary(data) {
  const target = libraryFile();
  const temporary = `${target}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(temporary, JSON.stringify(data, null, 2));
  await fsp.rm(target, { force: true });
  await fsp.rename(temporary, target);
}
function itemId(kind, itemPath) { return crypto.createHash('sha256').update(`${kind}\0${path.resolve(itemPath)}`).digest('hex').slice(0, 24); }
function ignoredCapCutEntry(name) {
  const value = String(name || '').toLowerCase();
  return value.startsWith('.') || value === 'combinationpresetvirtualstore.json' || value === 'combinationpresetvirtualstore';
}

async function validateExportDestination(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const sourceStat = await fsp.stat(sourcePath);
  const insideSource = sourceStat.isDirectory() && destinationPath.startsWith(sourcePath + path.sep);
  if (destinationPath === sourcePath || insideSource) {
    throw new Error('Escolha um local fora da pasta que está sendo exportada. Salvar o pacote dentro dela causa uma compactação sem fim.');
  }
}

async function chooseDetectedFonts(source) {
  const { detected, matched } = await detectedInstalledFontFiles(source);
  const missing = detected.filter((font) => !font.installed);
  if (!detected.length) return { canceled: false, files: [], detected: 0, missing: 0 };
  if (!matched.length) {
    await dialog.showMessageBox(mainWindow, { type: 'info', title: 'Fontes não localizadas', message: `${detected.length} fonte(s) foram referenciadas, mas nenhuma foi localizada neste computador.`, detail: 'O item será exportado sem fontes. As referências permanecem preservadas.', buttons: ['Continuar'] });
    return { canceled: false, files: [], detected: detected.length, missing: missing.length };
  }
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning', title: 'Incluir fontes detectadas',
    message: `${matched.length} fonte(s) instalada(s) serão incluídas automaticamente no pacote.`,
    detail: `${missing.length ? `${missing.length} fonte(s) não foram localizadas.\n\n` : ''}Compartilhe somente fontes cuja licença permita redistribuição.`,
    buttons: ['Incluir e exportar', 'Exportar sem fontes', 'Cancelar'], defaultId: 0, cancelId: 2
  });
  if (answer.response === 2) return { canceled: true, files: [], detected: detected.length, missing: missing.length };
  return { canceled: false, files: answer.response === 0 ? matched.map((font) => font.path) : [], detected: detected.length, missing: missing.length };
}

function sendProgress(event, operation, percent, phase, processed = 0, total = 0, started = Date.now()) {
  const elapsed = Math.max(.1, (Date.now() - started) / 1000);
  const rate = processed / elapsed;
  const remaining = rate > 0 && total > processed ? Math.ceil((total - processed) / rate) : null;
  event?.sender.send('operation-progress', { operation, percent: Math.max(0, Math.min(100, Math.round(percent))), phase, processed, total, remaining });
}

async function exportWithFonts(source, output, format, kind, fonts, progress) {
  const total = await entrySize(source) + (await Promise.all(fonts.map((font) => fsp.stat(font).then((s) => s.size)))).reduce((a, b) => a + b, 0);
  const report = format === '7z'
    ? (percent) => progress(8 + percent * .9, 'Compactando pacote', total * percent / 100, total)
    : (bytes) => progress(8 + Math.min(90, bytes / Math.max(1, total) * 90), 'Compactando pacote', Math.min(bytes, total), total);
  if (!fonts.length) {
    if (format === '7z') await sevenEntry(source, output, report); else await zipEntry(source, output, report);
    return;
  }
  const staging = path.join(os.tmpdir(), `capcut-package-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(staging, { recursive: true });
    await copyEntry(source, path.join(staging, path.basename(source)));
    const meta = path.join(staging, '.capcut-assistant');
    const fontDir = path.join(meta, 'fonts');
    await fsp.mkdir(fontDir, { recursive: true });
    const records = [];
    for (const font of fonts) {
      const name = path.basename(font);
      const destination = uniqueEntryDestination(fontDir, name, false);
      await fsp.copyFile(font, destination);
      records.push({ file: path.basename(destination), sha256: crypto.createHash('sha256').update(await fsp.readFile(font)).digest('hex') });
    }
    await fsp.writeFile(path.join(meta, 'manifest.json'), JSON.stringify({ format: 'capcut-assistant-package', version: 1, kind, fonts: records }, null, 2));
    if (format === '7z') await sevenContents(staging, output, report); else await zipContents(staging, output, report);
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
}

async function installBundledFonts(extracted) {
  const meta = path.join(extracted, '.capcut-assistant');
  const manifestPath = path.join(meta, 'manifest.json');
  const fontDir = path.join(meta, 'fonts');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(fontDir)) return { found: 0, installed: 0 };
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  const fonts = (manifest.fonts || []).filter((font) => /^[^/\\]+\.(ttf|otf|ttc)$/i.test(font.file) && fs.existsSync(path.join(fontDir, font.file)));
  if (!fonts.length) { await fsp.rm(meta, { recursive: true, force: true }); return { found: 0, installed: 0 }; }
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Fontes incluídas', message: `Este pacote contém ${fonts.length} fonte(s). Deseja instalá-las?`, detail: fonts.map((f) => `• ${f.file}`).join('\n') + '\n\nO CapCut pode precisar ser reiniciado.', buttons: ['Instalar fontes', 'Continuar sem instalar', 'Cancelar importação'], defaultId: 0, cancelId: 2 });
  if (answer.response === 2) throw new Error('Importação cancelada pelo usuário.');
  let installed = 0;
  if (answer.response === 0) {
    const targetRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts') : path.join(os.homedir(), 'Library', 'Fonts');
    await fsp.mkdir(targetRoot, { recursive: true });
    for (const font of fonts) {
      const source = path.join(fontDir, font.file);
      const expected = font.sha256 || crypto.createHash('sha256').update(await fsp.readFile(source)).digest('hex');
      let destination = path.join(targetRoot, font.file);
      if (fs.existsSync(destination)) {
        const actual = crypto.createHash('sha256').update(await fsp.readFile(destination)).digest('hex');
        if (actual === expected) continue;
        destination = uniqueEntryDestination(targetRoot, font.file, false);
      }
      await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      if (process.platform === 'win32') {
        const ext = path.extname(destination).toLowerCase() === '.otf' ? 'OpenType' : 'TrueType';
        await execFileAsync('reg.exe', ['add', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', '/v', `${path.parse(destination).name} (${ext})`, '/t', 'REG_SZ', '/d', destination, '/f'], { windowsHide: true });
      }
      installed++;
    }
  }
  await fsp.rm(meta, { recursive: true, force: true });
  return { found: fonts.length, installed };
}

function window() {
  mainWindow = new BrowserWindow({
    width: 1050, height: 720, minWidth: 820, minHeight: 580,
    backgroundColor: '#0b0c10',
    icon: path.join(__dirname, '..', 'assets', 'app-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  if (process.env.CAPCUT_ASSISTANT_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(() => mainWindow?.close(), 4000));
  }
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

async function folderSize(folder) {
  let total = 0;
  const items = await fsp.readdir(folder, { withFileTypes: true });
  for (const item of items) {
    const target = path.join(folder, item.name);
    if (item.isDirectory()) total += await folderSize(target);
    else if (item.isFile()) total += (await fsp.stat(target)).size;
  }
  return total;
}
async function entrySize(target) { const stat = await fsp.stat(target); return stat.isDirectory() ? folderSize(target) : stat.size; }
async function copyEntryWithProgress(source, destination, callback) {
  const total = await entrySize(source); let copied = 0;
  async function copy(from, to) {
    const stat = await fsp.stat(from);
    if (stat.isDirectory()) {
      await fsp.mkdir(to, { recursive: false });
      for (const entry of await fsp.readdir(from)) await copy(path.join(from, entry), path.join(to, entry));
    } else {
      await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL); copied += stat.size; callback(copied, total);
    }
  }
  await copy(source, destination); callback(total, total);
}

async function listProjects() {
  if (!projectRoot || !fs.existsSync(projectRoot)) return [];
  const entries = await fsp.readdir(projectRoot, { withFileTypes: true });
  const projects = [];
  for (const entry of entries.filter((e) => e.isDirectory() && !ignoredCapCutEntry(e.name))) {
    const full = path.join(projectRoot, entry.name);
    const stat = await fsp.stat(full);
    projects.push({ id: itemId('project', full), name: entry.name, path: full, modified: stat.mtimeMs, thumbnail: await thumbnailFor(full) });
  }
  return projects.sort((a, b) => b.modified - a.modified);
}

async function listRecycleBin() {
  if (!projectRoot) return [];
  const recycleRoot = ['.recyclebin', '.recycle_bin'].map((name) => path.join(projectRoot, name)).find(fs.existsSync);
  if (!recycleRoot) return [];
  const entries = await fsp.readdir(recycleRoot, { withFileTypes: true });
  const recycled = [];
  for (const entry of entries) {
    const full = path.join(recycleRoot, entry.name);
    const stat = await fsp.stat(full);
    recycled.push({ id: itemId('recycle', full), name: entry.name, path: full, modified: stat.mtimeMs, kind: entry.isDirectory() ? 'folder' : 'file', thumbnail: entry.isDirectory() ? await thumbnailFor(full) : null });
  }
  return recycled.sort((a, b) => b.modified - a.modified);
}

async function thumbnailFor(folder) {
  try {
    const candidates = [];
    async function scan(current, depth = 0) {
      if (depth > 3 || candidates.length > 80) return;
      for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) candidates.push(full);
        else if (entry.isDirectory() && !entry.name.startsWith('.')) await scan(full, depth + 1);
      }
    }
    const stat = await fsp.stat(folder);
    if (stat.isDirectory()) await scan(folder);
    else {
      const directory = path.dirname(folder), stem = path.basename(folder, path.extname(folder));
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name) && (entry.name.startsWith(stem) || /(?:cover|thumbnail|thumb|poster|preview)/i.test(entry.name))) candidates.push(path.join(directory, entry.name));
      if (/\.json$/i.test(folder)) try {
        const raw = await fsp.readFile(folder, 'utf8');
        for (const match of raw.matchAll(/"([^"\r\n]+\.(?:png|jpe?g|webp))"/gi)) { const imagePath = path.isAbsolute(match[1]) ? match[1] : path.resolve(directory, match[1]); if (fs.existsSync(imagePath)) candidates.push(imagePath); }
      } catch {}
    }
    const imagePath = candidates.sort((a, b) => Number(/(?:cover|thumbnail|thumb|poster|preview)/i.test(b)) - Number(/(?:cover|thumbnail|thumb|poster|preview)/i.test(a)))[0];
    if (!imagePath) return null;
    if ((await fsp.stat(imagePath)).size > 5 * 1024 * 1024) return null;
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${(await fsp.readFile(imagePath)).toString('base64')}`;
  } catch { return null; }
}

function normalizedFontName(value) { return value.toLowerCase().replace(/\.(ttf|otf|ttc)$/i, '').replace(/[^a-z0-9]/g, ''); }
async function installedFonts() {
  const names = new Set();
  const folders = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')]
    : [path.join(os.homedir(), 'Library', 'Fonts'), '/Library/Fonts', '/System/Library/Fonts'];
  for (const folder of folders) try {
    for (const file of await fsp.readdir(folder)) if (/\.(ttf|otf|ttc)$/i.test(file)) names.add(normalizedFontName(file));
  } catch {}
  if (process.platform === 'win32') try {
    const { stdout } = await execFileAsync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'], { windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) { const match = line.match(/^\s+(.+?)\s+REG_SZ\s+/); if (match) names.add(normalizedFontName(match[1].replace(/\s+\((?:TrueType|OpenType)\)$/i, ''))); }
  } catch {}
  return names;
}
async function installedFontFiles() {
  const files = [];
  const folders = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')]
    : [path.join(os.homedir(), 'Library', 'Fonts'), '/Library/Fonts', '/System/Library/Fonts'];
  for (const folder of folders) try {
    for (const file of await fsp.readdir(folder)) if (/\.(ttf|otf|ttc)$/i.test(file)) files.push({ key: normalizedFontName(file), path: path.join(folder, file) });
  } catch {}
  return files;
}
async function detectedInstalledFontFiles(itemPath) {
  const detected = await detectFonts(itemPath); const catalog = await installedFontFiles(); const matched = [];
  for (const font of detected) {
    const key = normalizedFontName(font.name);
    const file = catalog.find((candidate) => candidate.key === key || (key.length > 4 && (candidate.key.includes(key) || key.includes(candidate.key))));
    if (file && !matched.some((entry) => entry.path === file.path)) matched.push({ name: font.name, path: file.path });
  }
  return { detected, matched };
}
async function jsonFilesFor(itemPath) {
  const stat = await fsp.stat(itemPath);
  if (stat.isFile()) return /\.json$/i.test(itemPath) ? [itemPath] : [];
  const files = [];
  for (const entry of await fsp.readdir(itemPath, { withFileTypes: true })) {
    const full = path.join(itemPath, entry.name);
    if (entry.isFile() && /\.json$/i.test(entry.name)) files.push(full);
    else if (entry.isDirectory() && /(?:preset|draft|resource|meta)/i.test(entry.name)) {
      try { for (const nested of await fsp.readdir(full, { withFileTypes: true })) if (nested.isFile() && /\.json$/i.test(nested.name)) files.push(path.join(full, nested.name)); } catch {}
    }
  }
  return files.slice(0, 30);
}
async function detectFonts(itemPath) {
  const found = new Set();
  for (const file of await jsonFilesFor(itemPath)) try {
    const stat = await fsp.stat(file); if (stat.size > 25 * 1024 * 1024) continue;
    const raw = await fsp.readFile(file, 'utf8');
    const expression = /"[^"\\]*(?:font|family|typeface)[^"\\]*"\s*:\s*"([^"\\]{2,160})"/gi;
    for (const match of raw.matchAll(expression)) {
      let value = match[1].trim();
      if (/[\\/]/.test(value)) value = path.basename(value);
      value = value.replace(/\.(ttf|otf|ttc)$/i, '').trim();
      if (!value || /^\d+$/.test(value) || /^[a-f0-9-]{24,}$/i.test(value) || /^(default|system|none|null)$/i.test(value)) continue;
      found.add(value);
    }
  } catch {}
  const installed = await installedFonts();
  return [...found].sort().map((name) => { const key = normalizedFontName(name); return { name, installed: [...installed].some((candidate) => candidate === key || (key.length > 4 && (candidate.includes(key) || key.includes(candidate)))) }; });
}

async function connectGoogleDrive() {
  const credentials = await driveCredentials();
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(24).toString('hex');
  return new Promise((resolve, reject) => {
    let completed = false;
    const server = http.createServer(async (request, response) => {
      try {
        const incoming = new URL(request.url, 'http://127.0.0.1');
        if (incoming.pathname !== '/oauth/callback') { response.writeHead(404).end(); return; }
        if (incoming.searchParams.get('state') !== state) throw new Error('Resposta OAuth inválida.');
        const code = incoming.searchParams.get('code');
        if (!code) throw new Error(incoming.searchParams.get('error') || 'O Google não retornou autorização.');
        const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
        const body = new URLSearchParams({ code, client_id: credentials.client_id, client_secret: credentials.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier });
        const tokenResponse = await fetch(credentials.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
        if (!tokenResponse.ok) throw new Error(`Falha ao concluir login (${tokenResponse.status}).`);
        const token = await tokenResponse.json();
        await writeDriveToken({ ...token, expires_at: Date.now() + token.expires_in * 1000 });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><meta charset="utf-8"><title>Conectado</title><style>body{font:18px system-ui;background:#101217;color:#fff;display:grid;place-items:center;height:100vh}main{text-align:center}</style><main><h1>Google Drive conectado</h1><p>Você já pode voltar ao CapCut Project Assistant.</p></main>');
        completed = true; server.close(); resolve(await driveState());
      } catch (error) { response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(error.message); server.close(); reject(error); }
    });
    server.listen(0, '127.0.0.1', async () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
      const params = new URLSearchParams({ client_id: credentials.client_id, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email https://www.googleapis.com/auth/drive.file', access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256' });
      await shell.openExternal(`${credentials.auth_uri || 'https://accounts.google.com/o/oauth2/v2/auth'}?${params}`);
    });
    setTimeout(() => { if (!completed) { server.close(); reject(new Error('O login do Google expirou. Tente novamente.')); } }, 180000);
  });
}

async function ensureDriveFolder(value) {
  const requested = driveFolderId(value);
  let folder;
  if (requested) {
    const response = await driveRequest(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(requested)}?fields=id,name,mimeType,capabilities(canAddChildren)&supportsAllDrives=true`);
    folder = await response.json();
    if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.capabilities?.canAddChildren === false) throw new Error('A pasta não permite uploads para esta conta.');
  } else {
    const query = encodeURIComponent("name='CapCut Project Assistant' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const found = await driveRequest(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive&pageSize=1`);
    folder = (await found.json()).files?.[0];
    if (!folder) {
      const created = await driveRequest('https://www.googleapis.com/drive/v3/files?fields=id,name', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'CapCut Project Assistant', mimeType: 'application/vnd.google-apps.folder' }) });
      folder = await created.json();
    }
  }
  const library = await readLibrary(); library.driveFolder = { id: folder.id, name: folder.name }; await writeLibrary(library); return driveState();
}

async function resumableDriveUpload(filePath, name, folderId, event) {
  const stat = await fsp.stat(filePath); const metadata = { name, parents: [folderId] };
  const session = await driveRequest('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink', { method: 'POST', headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': 'application/octet-stream', 'x-upload-content-length': String(stat.size) }, body: JSON.stringify(metadata) });
  const location = session.headers.get('location'); if (!location) throw new Error('O Google não iniciou o upload.');
  const handle = await fsp.open(filePath, 'r'); const chunkSize = 8 * 1024 * 1024; let offset = 0, result = null, started = Date.now();
  try {
    while (offset < stat.size) {
      const length = Math.min(chunkSize, stat.size - offset), buffer = Buffer.allocUnsafe(length); const { bytesRead } = await handle.read(buffer, 0, length, offset); const end = offset + bytesRead - 1;
      const response = await fetch(location, { method: 'PUT', headers: { 'content-length': String(bytesRead), 'content-range': `bytes ${offset}-${end}/${stat.size}` }, body: buffer.subarray(0, bytesRead) });
      if (![200, 201, 308].includes(response.status)) throw new Error(`Upload interrompido pelo Google (${response.status}).`);
      offset += bytesRead; sendProgress(event, 'drive', offset / stat.size * 100, 'Enviando ao Google Drive', offset, stat.size, started);
      if (response.status !== 308) result = await response.json();
    }
  } finally { await handle.close(); }
  return result;
}

async function syncItemToDrive(event, mode, id, automatic = false) {
  if (driveSyncRunning.has(id)) return { busy: true };
  const library = await readLibrary(); if (!library.driveFolder?.id) throw new Error('Escolha primeiro uma pasta do Google Drive.');
  const entries = mode === 'presets' ? await listPresets() : await listProjects(); const item = entries.find((entry) => entry.id === id); if (!item) throw new Error('Item não encontrado.');
  const meta = library.items[id] || {}; const format = meta.driveFormat === 'zip' ? 'zip' : '7z'; const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 13); const displayName = safeName(meta.alias || path.parse(item.name).name); const fileName = `${displayName}_${stamp}.${format}`; const temporary = path.join(os.tmpdir(), `capcut-drive-${crypto.randomUUID()}.${format}`);
  driveSyncRunning.add(id);
  try {
    sendProgress(event, 'drive', 2, 'Detectando fontes', 0, 0, Date.now()); const { matched } = await detectedInstalledFontFiles(item.path);
    await exportWithFonts(item.path, temporary, format, mode === 'presets' ? 'preset' : 'project', matched.map((font) => font.path), (p, phase, done, total) => sendProgress(event, 'drive', p * .45, phase, done, total));
    const uploaded = await resumableDriveUpload(temporary, fileName, library.driveFolder.id, event);
    const current = (await readLibrary()); current.items[id] = { ...(current.items[id] || {}), driveSync: true, driveFormat: format, driveLastSynced: item.modified, driveLastFileId: uploaded?.id || '', driveLastName: fileName }; await writeLibrary(current);
    mainWindow?.webContents.send('drive-sync-complete', { id, automatic, fileName, library: current }); return { fileName, uploaded, library: current };
  } finally { driveSyncRunning.delete(id); await fsp.rm(temporary, { force: true }); }
}
async function checkAutomaticDriveSync() {
  try {
    const status = await driveState(); if (!status.connected || !status.folder?.id) return;
    const library = await readLibrary();
    for (const [mode, entries] of [['projects', await listProjects()], ['presets', await listPresets()]]) for (const item of entries) {
      const meta = library.items[item.id]; if (!meta?.driveSync || item.modified <= Number(meta.driveLastSynced || 0) || driveSyncRunning.has(item.id)) continue;
      const previous = driveObservedModified.get(item.id); driveObservedModified.set(item.id, item.modified);
      if (previous !== item.modified) continue;
      syncItemToDrive(null, mode, item.id, true).catch((error) => mainWindow?.webContents.send('drive-sync-error', { id: item.id, message: error.message }));
    }
  } catch {}
}

async function listPresets() {
  if (!presetRoot || !fs.existsSync(presetRoot)) return [];
  const entries = await fsp.readdir(presetRoot, { withFileTypes: true });
  const presets = [];
  for (const entry of entries.filter((e) => (e.isDirectory() || e.isFile()) && !ignoredCapCutEntry(e.name))) {
    const full = path.join(presetRoot, entry.name);
    const stat = await fsp.stat(full);
    presets.push({ id: itemId('preset', full), name: entry.name, path: full, modified: stat.mtimeMs, kind: entry.isDirectory() ? 'folder' : 'file', thumbnail: await thumbnailFor(full) });
  }
  return presets.sort((a, b) => b.modified - a.modified);
}

ipcMain.handle('status', async () => {
  projectRoot ||= findProjectRoot();
  presetRoot ||= findPresetRoot();
  return { projectRoot, presetRoot, capcut: findCapCut(), projects: await listProjects(), presets: await listPresets(), recycle: await listRecycleBin() };
});
ipcMain.handle('drive-status', async () => driveState());
ipcMain.handle('drive-connect', async () => connectGoogleDrive());
ipcMain.handle('drive-disconnect', async () => { await fsp.rm(driveTokenFile(), { force: true }); return driveState(); });
ipcMain.handle('drive-set-folder', async (_event, value) => ensureDriveFolder(value));
ipcMain.handle('drive-sync-set', async (event, mode, id, enabled, format = '7z') => {
  const library = await readLibrary(); const current = library.items[id] || {}; library.items[id] = { ...current, driveSync: Boolean(enabled), driveFormat: format === 'zip' ? 'zip' : '7z' }; await writeLibrary(library);
  if (enabled) return { enabled: true, ...(await syncItemToDrive(event, mode, id)), library: await readLibrary() };
  return { enabled: false, library };
});
ipcMain.handle('drive-sync-now', async (event, mode, id) => syncItemToDrive(event, mode, id));
ipcMain.handle('drive-open-file', async (_event, id) => { if (!id) return; await shell.openExternal(`https://drive.google.com/open?id=${encodeURIComponent(id)}`); });

ipcMain.handle('choose-root', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Selecione a pasta com.lveditor.draft' });
  if (!result.canceled) projectRoot = result.filePaths[0];
  return { projectRoot, projects: await listProjects() };
});

ipcMain.handle('open-root', async () => projectRoot && shell.openPath(projectRoot));
ipcMain.handle('choose-preset-root', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Selecione a pasta Presets/Combination/Presets' });
  if (!result.canceled) presetRoot = result.filePaths[0];
  return { presetRoot, presets: await listPresets() };
});
ipcMain.handle('open-preset-root', async () => presetRoot && shell.openPath(presetRoot));
ipcMain.handle('reveal-last', async () => {
  if (!lastRevealPath || !fs.existsSync(lastRevealPath)) throw new Error('O local não está mais disponível.');
  shell.showItemInFolder(lastRevealPath);
});

ipcMain.handle('library-get', async () => readLibrary());
ipcMain.handle('library-add-client', async (_event, input) => {
  const name = String(input?.name || '').replace(/[<>]/g, '').trim().slice(0, 80);
  if (!name) throw new Error('Informe o nome do cliente.');
  const library = await readLibrary();
  const existing = library.clients.find((client) => client.name.toLowerCase() === name.toLowerCase());
  if (existing) return library;
  library.clients.push({ id: crypto.randomUUID(), name, color: /^#[0-9a-f]{6}$/i.test(input?.color) ? input.color : '#70e1f5' });
  await writeLibrary(library);
  return library;
});
ipcMain.handle('library-delete-client', async (_event, clientId) => {
  const library = await readLibrary();
  library.clients = library.clients.filter((client) => client.id !== clientId);
  delete library.folders[clientId];
  for (const item of Object.values(library.items)) if (item.clientId === clientId) { item.clientId = ''; item.folder = ''; }
  await writeLibrary(library); return library;
});
ipcMain.handle('library-add-folder', async (_event, clientId, input) => {
  const folder = String(input || '').trim().replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 160);
  const library = await readLibrary();
  if (!library.clients.some((client) => client.id === clientId)) throw new Error('Cliente inválido.');
  if (!folder) throw new Error('Informe o nome da pasta.');
  library.folders[clientId] = [...new Set([...(library.folders[clientId] || []), folder])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  await writeLibrary(library); return library;
});
ipcMain.handle('library-add-preset-folder', async (_event, input) => {
  const folder = String(input || '').trim().replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, '').slice(0, 160);
  if (!folder) throw new Error('Informe o nome da pasta.');
  const library = await readLibrary(); library.presetFolders = [...new Set([...library.presetFolders, folder])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  await writeLibrary(library); return library;
});
ipcMain.handle('library-delete-preset-folder', async (_event, folder) => {
  const library = await readLibrary(); library.presetFolders = library.presetFolders.filter((value) => value !== folder && !value.startsWith(`${folder}/`));
  for (const [id, item] of Object.entries(library.items)) if (id && (item.presetFolder === folder || item.presetFolder?.startsWith(`${folder}/`))) item.presetFolder = '';
  await writeLibrary(library); return library;
});
ipcMain.handle('library-delete-folder', async (_event, clientId, folder) => {
  const library = await readLibrary();
  library.folders[clientId] = (library.folders[clientId] || []).filter((value) => value !== folder && !value.startsWith(`${folder}/`));
  for (const item of Object.values(library.items)) if (item.clientId === clientId && (item.folder === folder || item.folder?.startsWith(`${folder}/`))) item.folder = '';
  await writeLibrary(library); return library;
});
ipcMain.handle('library-update-item', async (_event, id, patch) => {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Item inválido.');
  const library = await readLibrary();
  const tags = Array.isArray(patch?.tags) ? patch.tags.map((tag) => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 12) : [];
  library.items[id] = {
    alias: String(patch?.alias || '').trim().slice(0, 120),
    clientId: String(patch?.clientId || '').slice(0, 80),
    folder: String(patch?.folder || '').trim().replace(/[\\]+/g, '/').slice(0, 160),
    presetFolder: String(patch?.presetFolder || '').trim().replace(/[\\]+/g, '/').slice(0, 160),
    tags,
    favorite: Boolean(patch?.favorite)
  };
  await writeLibrary(library);
  return library;
});
ipcMain.handle('library-update-items', async (_event, ids, patch) => {
  const validIds = Array.isArray(ids) ? ids.filter((id) => /^[a-f0-9]{24}$/.test(id)).slice(0, 500) : [];
  if (!validIds.length) throw new Error('Selecione ao menos um item.');
  const library = await readLibrary();
  const tags = Array.isArray(patch?.tags) ? patch.tags.map((tag) => String(tag).trim().slice(0, 30)).filter(Boolean).slice(0, 12) : [];
  for (const id of validIds) {
    const current = library.items[id] || {};
    library.items[id] = { ...current, clientId: String(patch?.clientId || '').slice(0, 80), folder: String(patch?.folder || '').trim().replace(/[\\]+/g, '/').slice(0, 160), presetFolder: String(patch?.presetFolder || '').trim().replace(/[\\]+/g, '/').slice(0, 160), tags: [...new Set([...(current.tags || []), ...tags])] };
  }
  await writeLibrary(library); return library;
});
ipcMain.handle('rename-project', async (_event, id, desired) => {
  const projects = await listProjects(); const item = projects.find((candidate) => candidate.id === id);
  if (!item) throw new Error('Projeto não encontrado.');
  const requestedName = String(desired || '').trim();
  if (!requestedName) throw new Error('Informe o novo nome do projeto.');
  const newName = safeName(requestedName);
  if (!newName || newName === item.name) return { projects, library: await readLibrary(), name: item.name };
  const destination = path.join(projectRoot, newName);
  if (fs.existsSync(destination)) throw new Error('Já existe um projeto com esse nome.');
  await fsp.rename(item.path, destination);
  const newId = itemId('project', destination); const library = await readLibrary();
  if (library.items[id]) { library.items[newId] = library.items[id]; delete library.items[id]; await writeLibrary(library); }
  return { projects: await listProjects(), library, name: newName, newId };
});
ipcMain.handle('restart-capcut', async () => {
  const executable = findCapCut(); if (!executable) throw new Error('CapCut não localizado.');
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Reiniciar CapCut', message: 'Salvar e reiniciar o CapCut agora?', detail: 'Salve qualquer edição aberta. O CapCut será fechado para reconhecer os projetos importados.', buttons: ['Reiniciar agora', 'Cancelar'], defaultId: 1, cancelId: 1 });
  if (answer.response !== 0) return { canceled: true };
  if (process.platform === 'win32') {
    const running = async () => { try { const { stdout } = await execFileAsync('tasklist.exe', ['/FI', 'IMAGENAME eq CapCut.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }); return /"CapCut\.exe"/i.test(stdout); } catch { return false; } };
    if (await running()) { try { await execFileAsync('taskkill.exe', ['/IM', 'CapCut.exe', '/T', '/F'], { windowsHide: true }); } catch {} }
    const deadline = Date.now() + 10000;
    while (await running()) { if (Date.now() >= deadline) throw new Error('O CapCut não pôde ser encerrado. Salve o projeto, feche o CapCut manualmente e tente novamente.'); await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  else { try { await execFileAsync('pkill', ['-x', 'CapCut']); } catch {} }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  if (process.platform === 'darwin') {
    await execFileAsync('open', [executable]);
  } else if (process.platform === 'win32') {
    const launchError = await shell.openPath(executable);
    if (launchError) throw new Error(`O Windows não conseguiu abrir o CapCut: ${launchError}`);
  } else {
    const launchError = await shell.openPath(executable);
    if (launchError) throw new Error(`Não foi possível abrir o CapCut: ${launchError}`);
  }
  return { canceled: false };
});
ipcMain.handle('recycle-delete', async (_event, id) => {
  if (!projectRoot) throw new Error('Pasta de projetos não localizada.');
  const recyclePath = ['.recyclebin', '.recycle_bin'].map((name) => path.join(projectRoot, name)).find(fs.existsSync);
  if (!recyclePath) throw new Error('Lixeira do CapCut não encontrada.');
  const recycleRoot = path.resolve(recyclePath);
  const items = await listRecycleBin();
  const item = items.find((candidate) => candidate.id === id);
  if (!item || path.dirname(path.resolve(item.path)) !== recycleRoot) throw new Error('Item da lixeira inválido.');
  await fsp.rm(item.path, { recursive: true, force: false });
  return listRecycleBin();
});
ipcMain.handle('font-info', async (_event, mode, id) => {
  const items = mode === 'presets' ? await listPresets() : await listProjects();
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new Error('Item não encontrado.');
  return detectFonts(item.path);
});
ipcMain.handle('export-detected-fonts', async (_event, mode, id) => {
  const entries = mode === 'presets' ? await listPresets() : await listProjects();
  const item = entries.find((candidate) => candidate.id === id); if (!item) throw new Error('Item não encontrado.');
  const { detected, matched } = await detectedInstalledFontFiles(item.path);
  if (!matched.length) throw new Error('Nenhuma das fontes detectadas foi localizada neste computador.');
  const answer = await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Exportar fontes detectadas', message: `Foram localizadas ${matched.length} fonte(s).`, detail: 'Compartilhe somente fontes cuja licença permita redistribuição.', buttons: ['Exportar pacote ZIP', 'Cancelar'], defaultId: 1, cancelId: 1 });
  if (answer.response !== 0) return { canceled: true };
  const result = await dialog.showSaveDialog(mainWindow, { title: 'Exportar fontes detectadas', defaultPath: `${safeName(item.name)}-fontes.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const staging = path.join(os.tmpdir(), `capcut-fonts-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(staging, { recursive: true }); const records = [];
    for (const font of matched) { const destination = uniqueEntryDestination(staging, path.basename(font.path), false); await fsp.copyFile(font.path, destination); records.push({ detectedName: font.name, file: path.basename(destination) }); }
    await fsp.writeFile(path.join(staging, 'LEIA-ME.txt'), 'Pacote de fontes detectadas pelo CapCut Project Assistant.\nVerifique a licença de cada fonte antes de compartilhar ou instalar.\n');
    await fsp.writeFile(path.join(staging, 'manifest.json'), JSON.stringify({ source: item.name, fonts: records, missing: detected.filter((font) => !font.installed).map((font) => font.name) }, null, 2));
    await zipContents(staging, result.filePath); lastRevealPath = result.filePath;
    return { canceled: false, filePath: result.filePath, exported: records.length, missing: detected.length - records.length };
  } finally { await fsp.rm(staging, { recursive: true, force: true }); }
});

ipcMain.handle('export-project', async (event, name, format) => {
  if (!projectRoot) throw new Error('Selecione a pasta de projetos primeiro.');
  const root = path.resolve(projectRoot);
  const source = path.resolve(root, name);
  if (!fs.existsSync(source) || path.dirname(source) !== root) throw new Error('Projeto inválido.');
  sendProgress(event, 'export', 1, 'Detectando fontes usadas');
  const fontSelection = await chooseDetectedFonts(source);
  if (fontSelection.canceled) return { canceled: true };
  const fonts = fontSelection.files;
  const ext = format === '7z' ? '7z' : 'zip';
  const result = await dialog.showSaveDialog({ title: 'Exportar projeto', defaultPath: `${name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await validateExportDestination(source, result.filePath);
  const started = Date.now(); sendProgress(event, 'export', 3, 'Analisando arquivos', 0, 0, started);
  await exportWithFonts(source, result.filePath, ext, 'project', fonts, (p, phase, done, total) => sendProgress(event, 'export', p, phase, done, total, started));
  sendProgress(event, 'export', 100, 'Pacote concluído', 1, 1, started);
  lastRevealPath = result.filePath;
  return { canceled: false, filePath: result.filePath, fonts: fonts.length, detectedFonts: fontSelection.detected, missingFonts: fontSelection.missing };
});

ipcMain.handle('import-project', async (event) => {
  if (!projectRoot) throw new Error('Selecione a pasta de projetos primeiro.');
  const result = await dialog.showOpenDialog({ title: 'Importar projeto', properties: ['openFile'], filters: [{ name: 'Pacotes de projeto', extensions: ['zip', '7z'] }] });
  if (result.canceled) return { canceled: true };
  await fsp.mkdir(projectRoot, { recursive: true });
  const temp = path.join(os.tmpdir(), `capcut-import-${crypto.randomUUID()}`);
  const started = Date.now(); sendProgress(event, 'import', 2, 'Validando pacote', 0, 0, started);
  try {
    await extractArchive(result.filePaths[0], temp, (p) => sendProgress(event, 'import', 5 + p * .65, 'Extraindo arquivos', p, 100, started));
    const fontResult = await installBundledFonts(temp);
    const payload = await projectPayload(temp);
    const suggested = payload === temp
      ? path.basename(result.filePaths[0], path.extname(result.filePaths[0]))
      : path.basename(payload);
    const destination = uniqueDestination(projectRoot, suggested);
    await copyEntryWithProgress(payload, destination, (done, total) => sendProgress(event, 'import', 72 + done / Math.max(1, total) * 27, 'Instalando no CapCut', done, total, started));
    sendProgress(event, 'import', 100, 'Importação concluída', 1, 1, started);
    lastRevealPath = destination;
    return { canceled: false, name: path.basename(destination), destination, fontResult, projects: await listProjects() };
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
});

ipcMain.handle('export-preset', async (event, name, format) => {
  if (!presetRoot) throw new Error('Selecione a pasta de predefinições primeiro.');
  const root = path.resolve(presetRoot);
  const source = path.resolve(root, name);
  if (!fs.existsSync(source) || path.dirname(source) !== root) throw new Error('Predefinição inválida.');
  sendProgress(event, 'export', 1, 'Detectando fontes usadas');
  const fontSelection = await chooseDetectedFonts(source);
  if (fontSelection.canceled) return { canceled: true };
  const fonts = fontSelection.files;
  const ext = format === '7z' ? '7z' : 'zip';
  const result = await dialog.showSaveDialog({ title: 'Exportar predefinição', defaultPath: `${path.parse(name).name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await validateExportDestination(source, result.filePath);
  const started = Date.now(); sendProgress(event, 'export', 3, 'Analisando arquivos', 0, 0, started);
  await exportWithFonts(source, result.filePath, ext, 'preset', fonts, (p, phase, done, total) => sendProgress(event, 'export', p, phase, done, total, started));
  sendProgress(event, 'export', 100, 'Pacote concluído', 1, 1, started);
  lastRevealPath = result.filePath;
  return { canceled: false, filePath: result.filePath, fonts: fonts.length, detectedFonts: fontSelection.detected, missingFonts: fontSelection.missing };
});

ipcMain.handle('import-preset', async (event) => {
  if (!presetRoot) throw new Error('Selecione a pasta de predefinições primeiro.');
  const result = await dialog.showOpenDialog({ title: 'Importar predefinições', properties: ['openFile'], filters: [{ name: 'Pacotes de predefinições', extensions: ['zip', '7z'] }] });
  if (result.canceled) return { canceled: true };
  await fsp.mkdir(presetRoot, { recursive: true });
  const temp = path.join(os.tmpdir(), `capcut-preset-import-${crypto.randomUUID()}`);
  const started = Date.now(); sendProgress(event, 'import', 2, 'Validando pacote', 0, 0, started);
  try {
    await extractArchive(result.filePaths[0], temp, (p) => sendProgress(event, 'import', 5 + p * .65, 'Extraindo arquivos', p, 100, started));
    const fontResult = await installBundledFonts(temp);
    const entries = (await fsp.readdir(temp, { withFileTypes: true })).filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store');
    if (!entries.length) throw new Error('O pacote está vazio.');
    const installed = [];
    let completed = 0;
    for (const entry of entries) {
      const source = path.join(temp, entry.name);
      const destination = uniqueEntryDestination(presetRoot, entry.name, entry.isDirectory());
      await copyEntry(source, destination);
      installed.push(path.basename(destination));
      completed++; sendProgress(event, 'import', 72 + completed / entries.length * 27, 'Instalando predefinições', completed, entries.length, started);
    }
    sendProgress(event, 'import', 100, 'Importação concluída', 1, 1, started);
    lastRevealPath = path.join(presetRoot, installed[0]);
    return { canceled: false, installed, destination: presetRoot, fontResult, presets: await listPresets() };
  } finally { await fsp.rm(temp, { recursive: true, force: true }); }
});

app.whenReady().then(() => { app.setAppUserModelId('com.capcut.projectassistant'); Menu.setApplicationMenu(null); window(); setInterval(checkAutomaticDriveSync, 45000); app.on('activate', () => BrowserWindow.getAllWindows().length || window()); });
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
