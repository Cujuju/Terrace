// Builds tools/tailcat-bridge. Run directly, it builds this machine's helper for dev runs (electron/appEnv.ts bridgePath).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const bridgeSource = path.join(repoRoot, 'tools', 'tailcat-bridge');
export const devBridgeDir = path.join(bridgeSource, 'bin');

/** Go's names for Node's platforms and architectures. */
const GOOS = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const GOARCH = { x64: 'amd64', arm64: 'arm64' };

export const bridgeFileName = (platform) => (platform === 'win32' ? 'tailcat-bridge.exe' : 'tailcat-bridge');

/** Builds the helper for one Node platform/arch into `outDir`. CGO off: cross-builds need no C toolchain. */
export function buildBridge(platform, arch, outDir) {
  const goos = GOOS[platform];
  const goarch = GOARCH[arch];
  if (goos === undefined || goarch === undefined) throw new Error(`No tailcat-bridge build for ${platform}-${arch}.`);
  const out = path.join(outDir, bridgeFileName(platform));
  console.log(`[bridge] ${goos}/${goarch} → ${out}`);
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, '.'], {
    cwd: bridgeSource,
    stdio: 'inherit',
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  buildBridge(process.platform, process.arch, devBridgeDir);
}
