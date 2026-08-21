// `vitest/config` re-exports Vite's defineConfig with the `test` block typed,
// so one file configures both the dev/build pipeline and the test runner.
import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';
import { execSync, type ExecSyncOptions } from 'node:child_process';

/**
 * Build identity stamped into the bundle as `__CLIENT_VERSION__` (rendered by
 * ui/VersionWatermark.tsx): `<commit count>.<short hash>` derived from git, so
 * it bumps on every commit with no hand-maintained number to forget.
 *
 * Computed ONCE, when this config loads — i.e. at dev-server or build start.
 * That is the honest scope: Vite on this mount never watches (dev-ops note),
 * so "the source as of Vite start" and "what this process serves" are the
 * same thing, and a commit made under a running Vite is exactly the skew the
 * watermark exists to expose. The server derives its stamp the same way at
 * boot (server/src/version.ts — keep the format in sync; the two derivations
 * live in their own build contexts because one runs inside Vite's node
 * process and one at server boot). TERRACE_VERSION overrides for git-less
 * environments (docker, issue #8); no git degrades to 'unversioned'.
 */
function buildVersion(): string {
  const fromEnv = process.env['TERRACE_VERSION'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  try {
    const opts: ExecSyncOptions = { stdio: ['ignore', 'pipe', 'ignore'] };
    const count = execSync('git rev-list --count HEAD', opts).toString().trim();
    const hash = execSync('git rev-parse --short HEAD', opts).toString().trim();
    if (/^\d+$/.test(count) && /^[0-9a-f]+$/.test(hash)) return `${count}.${hash}`;
  } catch {
    // No git here — fall through to the sentinel.
  }
  return 'unversioned';
}

/**
 * Whether this dev server should watch files, set by the launcher's --watch
 * flag (see run_server.py, which owns the flag for both halves of the stack).
 * Any non-empty value other than "0" counts as on, so `TERRACE_WATCH=1 pnpm dev`
 * works for a hand-started Vite too.
 */
function watchEnabled(): boolean {
  const raw = process.env['TERRACE_WATCH'];
  return raw !== undefined && raw.trim() !== '' && raw.trim() !== '0';
}

export default defineConfig({
  plugins: [solid()],
  define: {
    __CLIENT_VERSION__: JSON.stringify(buildVersion()),
  },
  server: {
    // Colyseus owns 2567 (design doc §8 "Configuration"); keep the dev server
    // clear of it so both can run side by side.
    port: 5173,
    // Listen on all interfaces: this is a multiplayer project, and "a friend
    // on the LAN opens http://<dev-box>:5173" is a first-class dev workflow.
    // The client derives its ws endpoint from the page hostname (config.ts),
    // so a LAN visitor automatically dials this machine's server too.
    host: true,
    // Vite's DNS-rebinding guard rejects hostnames it does not know. Raw LAN
    // IPs pass by default; the leading-dot entry allows any mDNS name
    // (amd.local today, whatever the machine is renamed to tomorrow) while
    // still refusing arbitrary public domains pointed at this address.
    allowedHosts: ['.local'],
    // File watching is opt-in per launch, driven by the launcher's --watch
    // flag (run_server.py sets TERRACE_WATCH=1 for the Vite it spawns). Left
    // unset, Vite serves the modules it loaded at startup and a restart is
    // what picks up an edit — the behaviour this checkout had before watching
    // existed.
    watch: watchEnabled()
      ? {
          // POLLING IS MANDATORY ON THIS CHECKOUT, not a preference. The repo
          // lives on /mnt/e — a WSL2 drvfs mount that delivers NO inotify
          // events at all, not even for writes made from inside Linux
          // (measured 2026-08-21: `fs.watch('shared/src', {recursive:true})`
          // saw zero events for an append AND a rewrite over 8 s). Chokidar's
          // native backend therefore sees nothing, which is why an edit
          // otherwise requires a full Vite restart before it is visible.
          usePolling: true,
          // How often each watched file is stat()ed, in milliseconds. 300 ms
          // is under the threshold where a save feels like it did not take,
          // and the watched set here is the module graph of one app (hundreds
          // of files, not the whole tree), so the stat storm is small. Lower
          // values buy nothing a human can perceive and multiply drvfs stat
          // cost, which is an order slower than a native mount.
          interval: 300,
        }
      : null,
  },
  test: {
    // Every client test is pure logic (see test/ — picking math, terrain mirror
    // diffs, chunk seams, colour ramp). Rendering is verified manually per
    // design doc §8 "Testing": no headless GL rig. So a plain node environment
    // is correct here — nothing under test touches the DOM or WebGL.
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
