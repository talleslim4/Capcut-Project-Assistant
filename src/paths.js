const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function candidateProjectRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft')];
  }
  if (platform === 'darwin') {
    return [
      path.join(home, 'Movies', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'),
      path.join(home, 'Library', 'Application Support', 'CapCut', 'User Data', 'Projects', 'com.lveditor.draft'),
      path.join(home, 'Library', 'Application Support', 'com.lemon.lvoverseas', 'User Data', 'Projects', 'com.lveditor.draft')
    ];
  }
  return [];
}

function findProjectRoot() {
  return candidateProjectRoots().find((p) => fs.existsSync(p)) || null;
}

function candidatePresetRoots(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(local, 'CapCut', 'User Data', 'Presets', 'Combination', 'Presets')];
  }
  if (platform === 'darwin') {
    return [
      path.join(home, 'Movies', 'CapCut', 'User Data', 'Presets', 'Combination', 'Presets'),
      path.join(home, 'Library', 'Application Support', 'CapCut', 'User Data', 'Presets', 'Combination', 'Presets'),
      path.join(home, 'Library', 'Application Support', 'com.lemon.lvoverseas', 'User Data', 'Presets', 'Combination', 'Presets')
    ];
  }
  return [];
}

function findPresetRoot() {
  return candidatePresetRoots().find((p) => fs.existsSync(p)) || null;
}

function candidateExecutables(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = env.ProgramFiles || 'C:\\Program Files';
    return [path.join(local, 'CapCut', 'Apps', 'CapCut.exe'), path.join(local, 'CapCut', 'CapCut.exe'), path.join(pf, 'CapCut', 'CapCut.exe')];
  }
  if (platform === 'darwin') return ['/Applications/CapCut.app', path.join(home, 'Applications', 'CapCut.app')];
  return [];
}

function findCapCut() {
  return candidateExecutables().find((p) => fs.existsSync(p)) || null;
}

module.exports = { candidateProjectRoots, findProjectRoot, candidatePresetRoots, findPresetRoot, candidateExecutables, findCapCut };
