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

# When to `pnpm --dir client build` before starting the server:
#   "auto"   - only if client/dist/index.html is missing (first run, or after
#              a clean); NOTE: it does NOT rebuild on source changes - after
#              pulling client changes, use "always" once or delete client/dist.
#   "always" - every launch (slower start, never stale)
#   "never"  - skip; the server falls back to its unbuilt-client notice
BUILD_CLIENT = "auto"

# Repo root = directory holding this script; server/client live beside it.
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(REPO_ROOT, "server")
CLIENT_DIR = os.path.join(REPO_ROOT, "client")
CLIENT_INDEX = os.path.join(CLIENT_DIR, "dist", "index.html")


def build_client_if_needed() -> bool:
    if BUILD_CLIENT == "never":
        return True
    if BUILD_CLIENT == "auto" and os.path.isfile(CLIENT_INDEX):
        return True
    print(f"[run_server] building client ({BUILD_CLIENT}: dist "
          f"{'present' if os.path.isfile(CLIENT_INDEX) else 'missing'})...")
    result = subprocess.call(["pnpm", "build"], cwd=CLIENT_DIR)
    if result != 0:
        print("[run_server] client build failed - fix the build or set "
              "BUILD_CLIENT = \"never\" to start the server anyway",
              file=sys.stderr)
        return False
    return True


def main() -> int:
    env = os.environ.copy()
    for name, value in CONFIG.items():
        if value is not None:
            # setdefault: an override exported in the shell beats CONFIG.
            env.setdefault(name, str(value))
    try:
        if not build_client_if_needed():
            return 1
        return subprocess.call(["pnpm", "start"], cwd=SERVER_DIR, env=env)
    except KeyboardInterrupt:
        # Ctrl-C: pnpm/node receive the same SIGINT and shut down; not an error.
        return 0
    except FileNotFoundError:
        print("pnpm not found on PATH - install pnpm (or run: corepack enable)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    return_code = main()
    sys.exit(return_code)
