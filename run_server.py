#!/usr/bin/env python3
"""Launch the Terrace server (wraps `pnpm start` in server/).

Tweak CONFIG below. Every value mirrors the server's own default from
server/src/config.ts — edit a value to change it, or set it to None to fall
back to the server's built-in default. A variable already set in the shell
wins over CONFIG, so one-off overrides still work:
    PORT=2599 python3 run_server.py
"""
import os
import subprocess
import sys

# Server configuration — validated at boot by server/src/config.ts.
CONFIG = {
    "PORT": 2567,                 # 1–65535
    "WORLD_SIZE": 512,            # multiple of CHUNK_SIZE (16), max 4096
    "WORLD_DIFFICULTY": 50,       # 1–100 (out of range clamps with a warning)
    "DB_PATH": "./data/world.db", # relative to server/
    "TICK_HZ": 10,                # 1–60
    "SNAPSHOT_INTERVAL_S": 60,    # 1–3600
    "PLUGINS_DIR": None,          # None → repo-root plugins/
}

# Repo root = directory holding this script; server lives beside it.
SERVER_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server")


def main() -> int:
    env = os.environ.copy()
    for name, value in CONFIG.items():
        if value is not None:
            # setdefault: an override exported in the shell beats CONFIG.
            env.setdefault(name, str(value))
    try:
        return subprocess.call(["pnpm", "start"], cwd=SERVER_DIR, env=env)
    except KeyboardInterrupt:
        # Ctrl-C: pnpm/node receive the same SIGINT and shut down; not an error.
        return 0
    except FileNotFoundError:
        print("pnpm not found on PATH — install pnpm (or run: corepack enable)", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
