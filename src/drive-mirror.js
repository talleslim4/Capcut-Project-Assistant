const crypto = require('node:crypto');

function ignoredMirrorEntry(name) {
  const value = String(name || '').toLowerCase();
  return value.startsWith('.') || value === 'combinationpresetvirtualstore.json' || value === 'combinationpresetvirtualstore' || value === '.tmp.driveupload';
}

function mirrorSignature(files) {
  const hash = crypto.createHash('sha256');
  for (const file of [...files].sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(`${file.relative}\0${file.size}\0${Math.floor(Number(file.modified || 0))}\n`);
  }
  return hash.digest('hex');
}

function mirrorFileUnchanged(previous, file) {
  return Boolean(previous?.id)
    && Number(previous.size) === Number(file.size)
    && Math.floor(Number(previous.modified || 0)) === Math.floor(Number(file.modified || 0));
}

module.exports = { ignoredMirrorEntry, mirrorSignature, mirrorFileUnchanged };
