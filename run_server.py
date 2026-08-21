#!/usr/bin/env python3
"""Launch the Terrace server (wraps `pnpm start` in server/), building the
browser client first when needed so one command yields a playable URL.

Tweak CONFIG below. Every env value mirrors the server's own default from
server/src/config.ts - edit a value to change it, or set it to None to fall
back to the server's built-in default. A variable already set in the shell
wins over CONFIG, so one-off overrides still work:
    PORT=2599 python3 run_server.py

The server serves client/dist itself (issue #20) and prints
"play at http://localhost:<PORT>" - that is the URL to open in a browser.
ws://<PORT> in the log is the game protocol endpoint, not a page.
"""
import os
import signal as signal_module
import subprocess
import sys

# Server configuration - validated at boot by server/src/config.ts.
CONFIG = {
    "PORT": 2567,                 # 1-65535
    "WORLD_SIZE": 512,            # multiple of CHUNK_SIZE (16), max 4096
    "WORLD_DIFFICULTY": 50,       # 1-100 (out of range clamps with a warning)
    "DB_PATH": "./data/world.db", # relative to server/
    "TICK_HZ": 10,                # 1-60
    "SNAPSHOT_INTERVAL_S": 60,    # 1-3600
    "PLUGINS_DIR": None,          # None -> repo-root plugins/
    "CLIENT_DIST_PATH": None,     # None -> client/dist sibling of server/
}

# How the browser client is provided (owner call 2026-08-19: default to just
# running the client alongside the server, no build step):
#   "dev"    - spawn the Vite dev server (`pnpm dev` in client/) alongside the
#              game server; play at http://localhost:5173. Always current -
#              Vite serves sources directly, nothing to rebuild.
#   "static" - build client/dist if missing, let the game server serve it;
#              play at http://localhost:<PORT>. NOTE: does NOT rebuild on
#              source changes - delete client/dist after pulling client code.
#   "none"   - server only.
CLIENT_MODE = "dev"

# Restart the game server whenever its own sources change (2026-08-21, owner
# request: "turn on the watcher for the server and the client"). The client
# half of that lives in client/vite.config.ts's `server.watch`.
#
# POLLING, NOT inotify, AND NOT `node --watch`. This repo sits on /mnt/e, a
# WSL2 drvfs mount that delivers no inotify events whatsoever - measured
# 2026-08-21, `fs.watch(..., {recursive: true})` saw zero events for a write
# made from inside Linux. `node --watch` is built on exactly that, so it would
# start, print nothing, and silently never fire. Stat polling is the only
# mechanism this mount supports.
WATCH = True

# Seconds between passes over the watched tree. One second is well under the
# time it takes to alt-tab to the browser, and the watched set is a few hundred
# .ts files - cheap even at drvfs stat speeds.
WATCH_POLL_INTERVAL_S = 1.0

# Which trees a server restart follows, relative to the repo root. shared/ is
# in the list because it is the SERVER's math too: shipping a shared/ change to
# the client alone desyncs prediction from authority (see the dev-ops note on
# restarting both halves together), and with both watchers on, one edit now
# restarts both by itself.
WATCH_ROOTS = ("server/src", "shared/src", "plugins")

# Paths a restart ignores. A plugin's CLIENT code is Vite's business, not the
# server's; tests, builds and dependencies are nobody's.
WATCH_EXCLUDED_PARTS = ("/client/", "/test/", "/node_modules/", "/dist/")

# Only source files trigger a restart - not the .db, the logs, or an editor's
# swap file.
WATCH_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".json")

# Repo root = directory holding this script; server/client live beside it.
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(REPO_ROOT, "server")
CLIENT_DIR = os.path.join(REPO_ROOT, "client")
CLIENT_INDEX = os.path.join(CLIENT_DIR, "dist", "index.html")


def prepare_static_client() -> bool:
    if os.path.isfile(CLIENT_INDEX):
        return True
    print("[run_server] building client (dist missing)...")
    result = subprocess.call(["pnpm", "build"], cwd=CLIENT_DIR)
    if result != 0:
        print("[run_server] client build failed - fix the build or set "
              "CLIENT_MODE = \"none\" to start the server anyway",
              file=sys.stderr)
        return False
    return True


def watch_snapshot() -> dict:
    """Every watched source file's (size, mtime), keyed by path.

    Compared whole against the previous pass: this catches creations and
    deletions as well as edits, which a "newest mtime" high-water mark would
    miss (deleting a file lowers nothing).
    """
    seen = {}
    for root in WATCH_ROOTS:
        base = os.path.join(REPO_ROOT, root)
        for dirpath, dirnames, filenames in os.walk(base):
            # Prune excluded directories in place so os.walk never descends
            # into node_modules at all - the difference between a few hundred
            # stats per pass and tens of thousands.
            dirnames[:] = [
                d for d in dirnames
                if f"/{d}/" not in WATCH_EXCLUDED_PARTS and d not in ("node_modules", "dist")
            ]
            for name in filenames:
                if not name.endswith(WATCH_SUFFIXES):
                    continue
                path = os.path.join(dirpath, name)
                if any(part in path.replace(os.sep, "/") for part in WATCH_EXCLUDED_PARTS):
                    continue
                try:
                    st = os.stat(path)
                except OSError:
                    # Vanished mid-walk (an editor's atomic rename). Its
                    # absence from this snapshot is itself the change.
                    continue
                seen[path] = (st.st_size, st.st_mtime)
    return seen


def spawn_server(env) -> subprocess.Popen:
    """Start the game server in its own session, so it can be killed as a group."""
    return subprocess.Popen(["pnpm", "start"], cwd=SERVER_DIR, env=env,
                            start_new_session=True)


def main() -> int:
    env = os.environ.copy()
    for name, value in CONFIG.items():
        if value is not None:
            # setdefault: an override exported in the shell beats CONFIG.
            env.setdefault(name, str(value))

    # Boot details up front (owner request 2026-08-19): one block naming every
    # port and URL this launch uses, before the two processes start talking.
    resolved = {name: env.get(name, "(server default)") for name in CONFIG}
    port = resolved["PORT"]
    print("[run_server] -- boot details ------------------------------")
    print(f"[run_server] world    : {resolved['WORLD_SIZE']}^2 x difficulty {resolved['WORLD_DIFFICULTY']}"
          f" | tick {resolved['TICK_HZ']}Hz | snapshot {resolved['SNAPSHOT_INTERVAL_S']}s")
    print(f"[run_server] database : {resolved['DB_PATH']} (relative to server/)")
    print(f"[run_server] server   : ws://localhost:{port} (game protocol endpoint)")
    if CLIENT_MODE == "dev":
        print("[run_server] client   : http://localhost:5173  <- PLAY HERE (Vite dev)")
    elif CLIENT_MODE == "static":
        print(f"[run_server] client   : http://localhost:{port}  <- PLAY HERE (served by the game server)")
    else:
        print('[run_server] client   : none (CLIENT_MODE = "none")')
    # flush: when stdout is a pipe (nohup, a wrapper script) python
    # block-buffers and the details would otherwise sit invisible until exit.
    print("[run_server] ---------------------------------------------", flush=True)

    children = []  # (name, Popen) - every child gets its own process group

    def reap(proc, sig):
        # pnpm spawns node as a child; signalling pnpm alone orphans it, so
        # each child runs in its own session and is killed as a whole group.
        if proc.poll() is None:
            os.killpg(proc.pid, sig)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal_module.SIGKILL)

    try:
        if CLIENT_MODE == "static" and not prepare_static_client():
            return 1
        if CLIENT_MODE == "dev":
            vite = subprocess.Popen(["pnpm", "dev"], cwd=CLIENT_DIR, start_new_session=True)
            children.append(vite)
            print("[run_server] client dev server starting - "
                  "play at http://localhost:5173 once Vite is ready")
        server = spawn_server(env)
        children.append(server)
        if not WATCH:
            return server.wait()

        print(f"[run_server] watching {', '.join(WATCH_ROOTS)} "
              f"(poll every {WATCH_POLL_INTERVAL_S}s) - server restarts on change",
              flush=True)
        snapshot = watch_snapshot()
        while True:
            try:
                return server.wait(timeout=WATCH_POLL_INTERVAL_S)
            except subprocess.TimeoutExpired:
                pass  # still running - that is the normal path
            current = watch_snapshot()
            if current == snapshot:
                continue
            changed = sorted(
                set(current) ^ set(snapshot)
                | {p for p in set(current) & set(snapshot) if current[p] != snapshot[p]}
            )
            print(f"[run_server] source change ({len(changed)} file(s), e.g. "
                  f"{os.path.relpath(changed[0], REPO_ROOT)}) - restarting server",
                  flush=True)
            # SIGINT, exactly as the shutdown path below does: it is the signal
            # whose handler writes the clean-shutdown snapshot, so a restart
            # never costs the world its unsaved terrain.
            reap(server, signal_module.SIGINT)
            children.remove(server)
            # Re-snapshot AFTER the shutdown, not before: a save that lands
            # while the old process is still winding down belongs to the run
            # that is about to start, not to another restart after it.
            snapshot = watch_snapshot()
            server = spawn_server(env)
            children.append(server)
    except KeyboardInterrupt:
        # Ctrl-C: the finally below shuts every child down; not an error.
        return 0
    except FileNotFoundError:
        print("pnpm not found on PATH - install pnpm (or run: corepack enable)", file=sys.stderr)
        return 1
    finally:
        # Whatever ends this script (Ctrl-C, crash, clean exit) also ends every
        # child it started - never leave an orphan holding a port. SIGINT for
        # the server so its clean-shutdown snapshot path runs; SIGTERM for vite.
        for proc in reversed(children):
            reap(proc, signal_module.SIGINT)


if __name__ == "__main__":
    return_code = main()
    sys.exit(return_code)
