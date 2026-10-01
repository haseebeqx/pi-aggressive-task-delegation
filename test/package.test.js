import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('release manifest declares public access and host-provided peers', () => {
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.engines.node, '>=22');
  assert.equal(manifest.license, 'MIT');
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.deepEqual(manifest.pi.extensions, ['./src/extension.js']);
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.peerDependencies[name], '*');
    assert.equal(manifest.dependencies?.[name], undefined);
  }
});

test('npm tarball contains only runtime sources, metadata, README, and license', () => {
  // Skip lifecycle scripts to avoid recursively running prepack's test suite.
  const output = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const [archive] = JSON.parse(output);
  assert.equal(archive.name, manifest.name);
  assert.equal(archive.version, manifest.version);
  assert.deepEqual(archive.files.map(({ path }) => path).sort(), [
    'LICENSE',
    'README.md',
    'package.json',
    'src/delegation-footer.js',
    'src/delegation-renderer.js',
    'src/delegation-transcript.js',
    'src/delegation-view.js',
    'src/extension.js',
    'src/log-storage.js',
    'src/workflow.js',
  ]);
});
