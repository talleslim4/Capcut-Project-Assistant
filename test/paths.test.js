const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { candidateProjectRoots, candidatePresetRoots } = require('../src/paths');

test('gera o caminho padrão do Windows', () => {
  const roots = candidateProjectRoots('win32', { LOCALAPPDATA: 'C:\\Users\\Teste\\AppData\\Local' }, 'C:\\Users\\Teste');
  assert.equal(roots[0], path.join('C:\\Users\\Teste\\AppData\\Local', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'));
});

test('inclui alternativas do macOS', () => {
  const roots = candidateProjectRoots('darwin', {}, '/Users/teste');
  assert.ok(roots.some((root) => root.includes('Library')));
  assert.ok(roots.every((root) => root.endsWith('com.lveditor.draft')));
});

test('gera o caminho de predefinições do Windows', () => {
  const roots = candidatePresetRoots('win32', { LOCALAPPDATA: 'C:\\Users\\Teste\\AppData\\Local' }, 'C:\\Users\\Teste');
  assert.ok(roots[0].endsWith(path.join('Presets', 'Combination', 'Presets')));
});
