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


def main() -> int:
    env = os.environ.copy()
    for name, value in CONFIG.items():
        if value is not None:
            # setdefault: an override exported in the shell beats CONFIG.
            env.setdefault(name, str(value))

    children = []  # (name, Popen) - every child gets its own process group

    def reap(proc, sig):
        # pnpm spawns node as a child; signalling pnpm alone orphans it, so
        # each child runs in its own session and is killed as a whole group.
        import signal as signals
        if proc.poll() is None:
            os.killpg(proc.pid, sig)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signals.SIGKILL)

    try:
        if CLIENT_MODE == "static" and not prepare_static_client():
            return 1
        if CLIENT_MODE == "dev":
            vite = subprocess.Popen(["pnpm", "dev"], cwd=CLIENT_DIR, start_new_session=True)
            children.append(vite)
            print("[run_server] client dev server starting - "
                  "play at http://localhost:5173 once Vite is ready")
        server = subprocess.Popen(["pnpm", "start"], cwd=SERVER_DIR, env=env,
                                  start_new_session=True)
        children.append(server)
        return server.wait()
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
        import signal
        for proc in reversed(children):
            reap(proc, signal.SIGINT)


if __name__ == "__main__":
    return_code = main()
    sys.exit(return_code)
