const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', 'src');

test('não instala um observador recursivo na interface do Electron', () => {
  const index = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  const driveUi = fs.readFileSync(path.join(src, 'drive-mirror-ui.js'), 'utf8');

  assert.doesNotMatch(index, /drive-mirror-ui\.js/);
  assert.doesNotMatch(driveUi, /new\s+MutationObserver/);
});
