const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { zipDirectory, zipEntry, zipContents, sevenContents, sevenDirectory, extractArchive, projectPayload, safeName, sevenZipExecutable } = require('../src/archive');

const base = path.join(__dirname, '..', 'work', 'archive-tests');

test('higieniza nomes de projeto', () => {
  assert.equal(safeName('meu:projeto? '), 'meu_projeto_');
});

test('redireciona o 7-Zip para fora do ASAR no aplicativo empacotado', () => {
  const fake = path.join('C:', 'app', 'resources', 'app.asar', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  assert.equal(sevenZipExecutable(fake), path.join('C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'));
});

for (const format of ['zip', '7z']) test(`exporta e importa ${format}`, async () => {
  const root = path.join(base, format);
  const source = path.join(root, 'Meu Projeto');
  const output = path.join(root, `pacote.${format}`);
  const extracted = path.join(root, 'extraido');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(source, 'media'), { recursive: true });
  await fs.writeFile(path.join(source, 'draft_content.json'), '{"ok":true}');
  await fs.writeFile(path.join(source, 'media', 'video.txt'), 'mídia');
  if (format === 'zip') await zipDirectory(source, output); else await sevenDirectory(source, output);
  await extractArchive(output, extracted);
  const payload = await projectPayload(extracted);
  assert.equal(await fs.readFile(path.join(payload, 'draft_content.json'), 'utf8'), '{"ok":true}');
});

test('exporta uma predefinição armazenada como arquivo', async () => {
  const root = path.join(base, 'preset-file');
  const source = path.join(root, 'preset.json');
  const output = path.join(root, 'preset.zip');
  const extracted = path.join(root, 'extraido');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(source, '{"preset":true}');
  await zipEntry(source, output);
  await extractArchive(output, extracted);
  assert.equal(await fs.readFile(path.join(extracted, 'preset.json'), 'utf8'), '{"preset":true}');
});

for (const format of ['zip', '7z']) test(`preserva fontes e manifesto no pacote ${format}`, async () => {
  const root = path.join(base, `font-package-${format}`);
  const staging = path.join(root, 'staging');
  const output = path.join(root, `pacote.${format}`);
  const extracted = path.join(root, 'extraido');
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(staging, '.capcut-assistant', 'fonts'), { recursive: true });
  await fs.mkdir(path.join(staging, 'Projeto'), { recursive: true });
  await fs.writeFile(path.join(staging, '.capcut-assistant', 'manifest.json'), '{"fonts":[]}');
  await fs.writeFile(path.join(staging, '.capcut-assistant', 'fonts', 'Teste.ttf'), 'font');
  if (format === 'zip') await zipContents(staging, output); else await sevenContents(staging, output);
  await extractArchive(output, extracted);
  assert.equal(await fs.readFile(path.join(extracted, '.capcut-assistant', 'fonts', 'Teste.ttf'), 'utf8'), 'font');
});
