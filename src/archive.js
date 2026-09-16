const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { spawn } = require('node:child_process');
const archiver = require('archiver');
const sevenBin = require('7zip-bin');

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim() || 'Projeto importado';
}

function uniqueDestination(root, desired) {
  const base = safeName(desired);
  let dest = path.join(root, base);
  let i = 2;
  while (fs.existsSync(dest)) dest = path.join(root, `${base} (${i++})`);
  return dest;
}

async function zipDirectory(source, output) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(output);
    const archive = archiver('zip', { zlib: { level: 9 } });
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.pipe(stream);
    archive.directory(source, path.basename(source));
    archive.finalize();
  });
}

async function zipEntry(source, output, onProgress) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const stat = await fsp.stat(source);
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(output);
    const archive = archiver('zip', { zlib: { level: 9 } });
    stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject);
    archive.pipe(stream);
    if (onProgress) archive.on('progress', (value) => onProgress(value.fs.processedBytes || 0));
    if (stat.isDirectory()) archive.directory(source, path.basename(source));
    else archive.file(source, { name: path.basename(source) });
    archive.finalize();
  });
}

async function zipContents(source, output, onProgress) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(output);
    const archive = archiver('zip', { zlib: { level: 9 } });
    stream.on('close', resolve); stream.on('error', reject); archive.on('error', reject);
    archive.pipe(stream); if (onProgress) archive.on('progress', (value) => onProgress(value.fs.processedBytes || 0)); archive.directory(source, false); archive.finalize();
  });
}

function sevenZipExecutable(rawPath = sevenBin.path7za) {
  // Executáveis não podem rodar de dentro do ASAR. O electron-builder os
  // coloca em app.asar.unpacked por causa da regra asarUnpack.
  return rawPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function run7z(args, options = {}, onProgress) {
  const bin = sevenZipExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, onProgress ? [...args, '-bsp1'] : args, { windowsHide: true, ...options });
    let output = '';
    let error = '';
    const track = (d) => { const text = String(d); for (const match of text.matchAll(/(\d{1,3})%/g)) onProgress?.(Math.min(100, Number(match[1]))); };
    child.stdout.on('data', (d) => { output += d; track(d); });
    child.stderr.on('data', (d) => { error += d; track(d); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error || `7-Zip terminou com código ${code}`)));
  });
}

async function sevenDirectory(source, output) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await run7z(['a', '-t7z', '-mx=7', output, path.basename(source)], { cwd: path.dirname(source) });
}

async function sevenEntry(source, output, onProgress) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await run7z(['a', '-t7z', '-mx=7', output, path.basename(source)], { cwd: path.dirname(source) }, onProgress);
}

async function sevenContents(source, output, onProgress) {
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const entries = await fsp.readdir(source);
  if (!entries.length) throw new Error('Não há conteúdo para exportar.');
  await run7z(['a', '-t7z', '-mx=7', output, ...entries], { cwd: source }, onProgress);
}

async function extractArchive(archivePath, tempDir, onProgress) {
  await fsp.mkdir(tempDir, { recursive: true });
  const listing = await run7z(['l', '-slt', archivePath]);
  const records = listing.split(/\r?\n\r?\n/).map((block) => Object.fromEntries(
    block.split(/\r?\n/).map((line) => line.match(/^([^=]+) = (.*)$/)).filter(Boolean).map((m) => [m[1].trim(), m[2]])
  ));
  for (const record of records) {
    const entry = record.Path;
    if (!entry || entry === archivePath) continue;
    const normalized = entry.replace(/\\/g, '/');
    const unsafe = normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || normalized.split('/').includes('..');
    const link = /\bL\b/.test(record.Attributes || '') || record['Symbolic Link'];
    if (unsafe || link) throw new Error(`O pacote contém uma entrada insegura: ${entry}`);
  }
  await run7z(['x', archivePath, `-o${tempDir}`, '-y', '-snl-'], {}, onProgress);
}

async function projectPayload(tempDir) {
  const entries = await fsp.readdir(tempDir, { withFileTypes: true });
  const visible = entries.filter((e) => e.name !== '__MACOSX' && e.name !== '.DS_Store');
  if (visible.length === 1 && visible[0].isDirectory()) return path.join(tempDir, visible[0].name);
  return tempDir;
}

async function copyDirectory(source, destination) {
  await fsp.cp(source, destination, { recursive: true, errorOnExist: true, force: false });
}

function uniqueEntryDestination(root, desired, isDirectory) {
  if (isDirectory) return uniqueDestination(root, desired);
  const parsed = path.parse(safeName(desired));
  let dest = path.join(root, parsed.base);
  let i = 2;
  while (fs.existsSync(dest)) dest = path.join(root, `${parsed.name} (${i++})${parsed.ext}`);
  return dest;
}

async function copyEntry(source, destination) {
  const stat = await fsp.stat(source);
  if (stat.isDirectory()) await copyDirectory(source, destination);
  else await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

module.exports = { safeName, uniqueDestination, uniqueEntryDestination, zipDirectory, zipEntry, zipContents, sevenDirectory, sevenEntry, sevenContents, extractArchive, projectPayload, copyDirectory, copyEntry, sevenZipExecutable };
