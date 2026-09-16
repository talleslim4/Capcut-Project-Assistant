const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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

const emptyLibrary = () => ({ version: 1, clients: [], items: {} });
function libraryFile() { return path.join(app.getPath('userData'), 'library.json'); }
async function readLibrary() {
  try {
    const data = JSON.parse(await fsp.readFile(libraryFile(), 'utf8'));
    return { ...emptyLibrary(), ...data, clients: Array.isArray(data.clients) ? data.clients : [], items: data.items && typeof data.items === 'object' ? data.items : {} };
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

async function validateExportDestination(source, destination) {
  const sourcePath = path.resolve(source);
  const destinationPath = path.resolve(destination);
  const sourceStat = await fsp.stat(sourcePath);
  const insideSource = sourceStat.isDirectory() && destinationPath.startsWith(sourcePath + path.sep);
  if (destinationPath === sourcePath || insideSource) {
    throw new Error('Escolha um local fora da pasta que está sendo exportada. Salvar o pacote dentro dela causa uma compactação sem fim.');
  }
}

async function chooseFonts() {
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', title: 'Incluir fontes', message: 'Deseja incluir fontes neste pacote?', detail: 'Use somente fontes cuja licença permita o compartilhamento.', buttons: ['Selecionar fontes', 'Continuar sem fontes', 'Cancelar'], defaultId: 0, cancelId: 2 });
  if (answer.response === 2) return null;
  if (answer.response === 1) return [];
  const picked = await dialog.showOpenDialog(mainWindow, { title: 'Selecione as fontes usadas', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Fontes', extensions: ['ttf', 'otf', 'ttc'] }] });
  return picked.canceled ? null : picked.filePaths;
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
  for (const entry of entries.filter((e) => e.isDirectory() && e.name !== '.recyclebin')) {
    const full = path.join(projectRoot, entry.name);
    const stat = await fsp.stat(full);
    projects.push({ id: itemId('project', full), name: entry.name, path: full, modified: stat.mtimeMs, thumbnail: await thumbnailFor(full) });
  }
  return projects.sort((a, b) => b.modified - a.modified);
}

async function listRecycleBin() {
  if (!projectRoot) return [];
  const recycleRoot = path.join(projectRoot, '.recyclebin');
  if (!fs.existsSync(recycleRoot)) return [];
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
    const entries = await fsp.readdir(folder, { withFileTypes: true });
    const image = entries.find((entry) => entry.isFile() && /(?:cover|thumbnail|thumb|poster)/i.test(entry.name) && /\.(png|jpe?g|webp)$/i.test(entry.name));
    if (!image) return null;
    const imagePath = path.join(folder, image.name);
    if ((await fsp.stat(imagePath)).size > 5 * 1024 * 1024) return null;
    const ext = path.extname(image.name).toLowerCase();
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

async function listPresets() {
  if (!presetRoot || !fs.existsSync(presetRoot)) return [];
  const entries = await fsp.readdir(presetRoot, { withFileTypes: true });
  const presets = [];
  for (const entry of entries.filter((e) => e.isDirectory() || e.isFile())) {
    const full = path.join(presetRoot, entry.name);
    const stat = await fsp.stat(full);
    presets.push({ id: itemId('preset', full), name: entry.name, path: full, modified: stat.mtimeMs, kind: entry.isDirectory() ? 'folder' : 'file', thumbnail: entry.isDirectory() ? await thumbnailFor(full) : null });
  }
  return presets.sort((a, b) => b.modified - a.modified);
}

ipcMain.handle('status', async () => {
  projectRoot ||= findProjectRoot();
  presetRoot ||= findPresetRoot();
  return { projectRoot, presetRoot, capcut: findCapCut(), projects: await listProjects(), presets: await listPresets(), recycle: await listRecycleBin() };
});

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
  for (const item of Object.values(library.items)) if (item.clientId === clientId) { item.clientId = ''; item.folder = ''; }
  await writeLibrary(library); return library;
});
ipcMain.handle('library-delete-folder', async (_event, clientId, folder) => {
  const library = await readLibrary();
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
    library.items[id] = { ...current, clientId: String(patch?.clientId || '').slice(0, 80), folder: String(patch?.folder || '').trim().replace(/[\\]+/g, '/').slice(0, 160), tags: [...new Set([...(current.tags || []), ...tags])] };
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
  if (process.platform === 'win32') { try { await execFileAsync('taskkill.exe', ['/IM', 'CapCut.exe', '/T', '/F'], { windowsHide: true }); } catch {} }
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
  const recycleRoot = path.resolve(projectRoot, '.recyclebin');
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

ipcMain.handle('export-project', async (event, name, format) => {
  if (!projectRoot) throw new Error('Selecione a pasta de projetos primeiro.');
  const root = path.resolve(projectRoot);
  const source = path.resolve(root, name);
  if (!fs.existsSync(source) || path.dirname(source) !== root) throw new Error('Projeto inválido.');
  const fonts = await chooseFonts();
  if (fonts === null) return { canceled: true };
  const ext = format === '7z' ? '7z' : 'zip';
  const result = await dialog.showSaveDialog({ title: 'Exportar projeto', defaultPath: `${name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await validateExportDestination(source, result.filePath);
  const started = Date.now(); sendProgress(event, 'export', 3, 'Analisando arquivos', 0, 0, started);
  await exportWithFonts(source, result.filePath, ext, 'project', fonts, (p, phase, done, total) => sendProgress(event, 'export', p, phase, done, total, started));
  sendProgress(event, 'export', 100, 'Pacote concluído', 1, 1, started);
  lastRevealPath = result.filePath;
  return { canceled: false, filePath: result.filePath, fonts: fonts.length };
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
  const fonts = await chooseFonts();
  if (fonts === null) return { canceled: true };
  const ext = format === '7z' ? '7z' : 'zip';
  const result = await dialog.showSaveDialog({ title: 'Exportar predefinição', defaultPath: `${path.parse(name).name}.${ext}`, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  await validateExportDestination(source, result.filePath);
  const started = Date.now(); sendProgress(event, 'export', 3, 'Analisando arquivos', 0, 0, started);
  await exportWithFonts(source, result.filePath, ext, 'preset', fonts, (p, phase, done, total) => sendProgress(event, 'export', p, phase, done, total, started));
  sendProgress(event, 'export', 100, 'Pacote concluído', 1, 1, started);
  lastRevealPath = result.filePath;
  return { canceled: false, filePath: result.filePath, fonts: fonts.length };
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

app.whenReady().then(() => { app.setAppUserModelId('com.capcut.projectassistant'); Menu.setApplicationMenu(null); window(); app.on('activate', () => BrowserWindow.getAllWindows().length || window()); });
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
