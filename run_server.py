#!/usr/bin/env python3
"""Launch the Terrace server (wraps `pnpm start` in server/), building the
browser client first when needed so one command yields a playable URL.

Tweak CONFIG below. Every env value mirrors the server's own default from
server/src/config.ts - edit a value to change it, or set it to None to fall
back to the server's built-in default. A variable already set in the shell
wins over CONFIG, so one-off overrides still work:
    PORT=2599 python3 run_server.py

Pass --watch to run the stack with file watching on: the server restarts when
its own sources change, and the Vite dev server polls the client's sources for
changes instead of serving whatever it loaded at startup. Off by default.

The server serves client/dist itself (issue #20) and prints
"play at http://localhost:<PORT>" - that is the URL to open in a browser.
ws://<PORT> in the log is the game protocol endpoint, not a page.

WHICH WORLD YOU PLAY IS NO LONGER A LAUNCH DECISION (multi-world, 2026-08-22).
A server holds many worlds, one loaded at a time, and you switch between them
from the Worlds panel in the game. This script starts the process and reports
what came up; it does not choose. The world that loads is the one recorded in
WORLDS_DIR/.active, i.e. whichever you were last in.
"""
import argparse
import contextlib
import os
import signal as signal_module
import sqlite3
import subprocess
import sys
from urllib.request import pathname2url

# Server configuration - validated at boot by server/src/config.ts.
CONFIG = {
    "PORT": 2567,                 # 1-65535
    # THE SIZE *NEW* WORLDS ARE CREATED AT - not the size of the world that
    # loads (multi-world, 2026-08-22). Every world keeps whatever size it was
    # made with, and a server can hold worlds of several sizes at once, so this
    # no longer describes what you are about to play. See issue #75 for whether
    # 512 is still the right default after the quarter-cell re-sample.
    "WORLD_SIZE": 512,            # multiple of CHUNK_SIZE (16), max 4096
    "WORLD_DIFFICULTY": 50,       # 1-100 (out of range clamps with a warning)
    # WHERE THE WORLDS LIVE - one SQLite file per world, plus .trash/ and the
    # .active pointer. Replaces DB_PATH, which named a single world file back
    # when a deployment had exactly one. DB_PATH still exists in the server's
    # config as the LEGACY path it copies a pre-2026-08-22 world in from; it is
    # deliberately not set here, because naming it would suggest the world
    # lives there, and it does not.
    "WORLDS_DIR": "./data/worlds", # relative to server/
    "TICK_HZ": 10,                # 1-60
    "SNAPSHOT_INTERVAL_S": 60,    # 1-3600
    # OPERATOR KEYS. None means "use the server's built-in default", which for
    # both of these is a PUBLIC value from the source - fine on a laptop, not
    # fine on anything reachable. The server warns at boot when either is on
    # its default. Set them here (or export them) to silence that honestly.
    "ROLLBACK_KEY": None,         # None -> "terrace"        (rewinds the world)
    "WORLD_ADMIN_KEY": None,      # None -> "terrace-worlds"  (creates/archives worlds)
    # Seconds a world switch is announced for when somebody other than the
    # operator is connected; skipped entirely when they are alone. 0 = never.
    "WORLD_SWITCH_COUNTDOWN_S": None,  # None -> server default (10)
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

# Source watching is OFF by default and turned on per launch with --watch
# (2026-08-21, owner request: "add an option to the run server script to turn
# on the watcher for the server and the client"). One flag drives BOTH halves:
# this script restarts the game server on its own source changes, and it
# exports TERRACE_WATCH to Vite, whose config turns file polling on only when
# it is set (client/vite.config.ts). They are deliberately not separable -
# the dev-ops rule is that server and client are never refreshed alone, since
# a shared/ change that reaches one half and not the other desyncs client
# prediction from server authority.
#
# POLLING, NOT inotify, AND NOT `node --watch`. This repo sits on /mnt/e, a
# WSL2 drvfs mount that delivers no inotify events whatsoever - measured
# 2026-08-21, `fs.watch(..., {recursive: true})` saw zero events for a write
# made from inside Linux. `node --watch` is built on exactly that, so it would
# start, print nothing, and silently never fire. Stat polling is the only
# mechanism this mount supports, and it is not free on drvfs - which is why it
# is opt-in rather than always on.
WATCH_DEFAULT = False

# Environment variable the client half reads. Set to "1" for a watched launch
# and left unset otherwise; client/vite.config.ts enables `server.watch.usePolling`
# on exactly this signal.
WATCH_ENV_VAR = "TERRACE_WATCH"

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


def describe_worlds(worlds_dir):
    """Every world on disk, as (name, size, points, is_active) - newest first.

    READ-ONLY AND DEFENSIVE, because this runs before the server does and must
    never be the reason a launch fails. Each file is opened through a
    `mode=ro` URI so this cannot create, migrate or lock anything, and any file
    that will not open is reported as unreadable rather than skipped: a world
    you can see and cannot open is a bug report, while one that quietly
    vanished from the list looks exactly like a world that was deleted.

    Returns (worlds, active_id). `worlds` is empty when the folder does not
    exist yet - a first run, which the banner states rather than treating as a
    fault.
    """
    if not os.path.isdir(worlds_dir):
        return [], None

    active = None
    try:
        with open(os.path.join(worlds_dir, ".active"), encoding="utf-8") as handle:
            active = handle.read().strip() or None
    except OSError:
        pass  # no pointer yet, or unreadable: the server says so at boot

    worlds = []
    for entry in sorted(os.listdir(worlds_dir)):
        if not entry.endswith(".db") or entry.startswith("."):
            continue
        world_id = entry[: -len(".db")]
        path = os.path.join(worlds_dir, entry)
        try:
            uri = "file:" + pathname2url(path) + "?mode=ro"
            with contextlib.closing(sqlite3.connect(uri, uri=True)) as db:
                row = db.execute(
                    "SELECT world_name, world_size FROM snapshots ORDER BY id DESC LIMIT 1"
                ).fetchone()
                points = db.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
                newest = db.execute("SELECT MAX(created_at) FROM snapshots").fetchone()[0]
            name = (row[0] if row and row[0] else world_id)
            worlds.append({
                "id": world_id, "name": name, "size": row[1] if row else 0,
                "points": points, "newest": newest or 0,
                "active": world_id == active, "problem": None,
            })
        except Exception as error:  # noqa: BLE001 - see the doc comment
            worlds.append({
                "id": world_id, "name": world_id, "size": 0, "points": 0,
                "newest": 0, "active": world_id == active, "problem": str(error),
            })

    worlds.sort(key=lambda world: world["newest"], reverse=True)
    return worlds, active


def spawn_server(env) -> subprocess.Popen:
    """Start the game server in its own session, so it can be killed as a group."""
    return subprocess.Popen(["pnpm", "start"], cwd=SERVER_DIR, env=env,
                            start_new_session=True)


def main(watch: bool) -> int:
    env = os.environ.copy()
    # Both halves see the same flag: the server watcher below reads `watch`,
    # and Vite reads this variable out of the environment it inherits.
    if watch:
        env[WATCH_ENV_VAR] = "1"
    else:
        env.pop(WATCH_ENV_VAR, None)
    for name, value in CONFIG.items():
        if value is not None:
            # setdefault: an override exported in the shell beats CONFIG.
            env.setdefault(name, str(value))

    # POINT THE DEV CLIENT AT THE PORT THIS LAUNCH IS ACTUALLY USING.
    #
    # The client only derives the server's port from the page it was served
    # from in a BUILT bundle. Under `vite dev` the page is on 5173-ish and the
    # server is not, so client/src/config.ts falls back to the compiled-in
    # DEFAULT_SERVER_PORT (2567) - which is right only while PORT is 2567.
    # Launch with PORT=2570 and the dev client cheerfully dials 2567: if
    # nothing is there it sits on "offline" forever, and if something IS there
    # (another checkout, another branch) it connects to the WRONG SERVER and
    # nothing says so. Observed 2026-08-22.
    #
    # VITE_SERVER_URL is the documented override, so this sets it from the same
    # PORT the server is being handed. setdefault, so an explicit
    # VITE_SERVER_URL in the shell still wins - the Docker Compose path relies
    # on that.
    env.setdefault("VITE_SERVER_URL", f"ws://localhost:{env.get('PORT', 2567)}")

    # Boot details up front (owner request 2026-08-19): one block naming every
    # port and URL this launch uses, before the two processes start talking.
    resolved = {name: env.get(name, "(server default)") for name in CONFIG}
    port = resolved["PORT"]
    print("[run_server] -- boot details ------------------------------")
    print(f"[run_server] new worlds: {resolved['WORLD_SIZE']}^2 x difficulty {resolved['WORLD_DIFFICULTY']}"
          f" | tick {resolved['TICK_HZ']}Hz | snapshot {resolved['SNAPSHOT_INTERVAL_S']}s")
    worlds_dir = os.path.join(SERVER_DIR, resolved["WORLDS_DIR"])
    print(f"[run_server] worlds   : {resolved['WORLDS_DIR']} (relative to server/)")

    # WHAT IS ACTUALLY ABOUT TO LOAD. The point of this block is that a launch
    # answers "which world am I in" without opening the game - and, since a
    # server now holds several, "what else is here" without opening the panel.
    worlds, active = describe_worlds(worlds_dir)
    if not worlds:
        print("[run_server]            (no worlds yet - the server will create one)")
    else:
        for world in worlds:
            mark = "->" if world["active"] else "  "
            if world["problem"]:
                print(f"[run_server]          {mark} {world['name']}  UNREADABLE: {world['problem']}")
            else:
                print(f"[run_server]          {mark} {world['name']} "
                      f"({world['size']}^2, {world['points']} restore points)")
        if active is None:
            print("[run_server]            no active world recorded - the server will pick the newest")
        elif not any(world["active"] for world in worlds):
            # Stated loudly: the server refuses to invent a replacement, so
            # this is the difference between "it loaded something else" and
            # "it loaded nothing at all".
            print(f"[run_server]            WARNING: .active names '{active}', which is not here."
                  " No world will load; pick one in the Worlds panel.")
        print("[run_server]            switch worlds in-game (Worlds panel), not here")
    print(f"[run_server] server   : ws://localhost:{port} (game protocol endpoint)")
    if CLIENT_MODE == "dev":
        # NOT a hardcoded 5173: Vite takes the next free port when 5173 is
        # busy (another checkout, another worktree) and says so in its own
        # startup line. Claiming a number here that Vite then ignores sends
        # you to somebody else's client, so the URL is quoted from Vite.
        print("[run_server] client   : Vite prints its URL below "
              "(5173 unless that port is taken)  <- PLAY THERE")
    elif CLIENT_MODE == "static":
        print(f"[run_server] client   : http://localhost:{port}  <- PLAY HERE (served by the game server)")
    else:
        print('[run_server] client   : none (CLIENT_MODE = "none")')
    print(f"[run_server] watch    : {'on (--watch)' if watch else 'off (pass --watch to enable)'}")
    # flush: when stdout is a pipe (nohup, a wrapper script) python
    # block-buffers and the details would otherwise sit invisible until exit.
    print("[run_server] ---------------------------------------------", flush=True)

    # MAKE A SIGNALLED DEATH UNWIND, so the `finally` below actually runs.
    #
    # The cleanup at the end of this function is the thing that stops orphans
    # holding ports, and it is a `finally` - which Python runs for a clean
    # return, an exception, and Ctrl-C (KeyboardInterrupt is an exception), but
    # NOT for SIGTERM. The default SIGTERM disposition kills the interpreter
    # outright, no unwinding, so `kill <this pid>` left the game server and
    # Vite running and holding their ports. The next launch then died with
    # EADDRINUSE, or - worse - came up on a shifted port beside the corpse of
    # the last one. Observed 2026-08-22, twice in a row.
    #
    # Raising SystemExit from the handler turns the signal into an ordinary
    # unwind, so one code path cleans up after every way this script can end.
    # SIGHUP gets the same treatment: closing the terminal is not a reason to
    # leave a server running.
    def _exit_on_signal(signum, _frame):
        raise SystemExit(128 + signum)

    for _signal_name in ("SIGTERM", "SIGHUP"):
        _signal = getattr(signal_module, _signal_name, None)
        if _signal is None:
            continue  # SIGHUP does not exist on Windows
        # RESPECT AN INHERITED "IGNORE". `nohup` runs its child with SIGHUP set
        # to SIG_IGN, and that is the entire point of nohup: the stack survives
        # the terminal that started it. Installing a handler unconditionally
        # overrides that, so `nohup python3 run_server.py &` shut the whole
        # stack down the moment its shell exited - which this script did to
        # itself on 2026-08-22, one commit after the SIGTERM fix above.
        #
        # Checking the current disposition keeps both properties: a signal the
        # launcher told us to ignore stays ignored, and every other signal
        # unwinds through the cleanup.
        if signal_module.getsignal(_signal) is signal_module.SIG_IGN:
            continue
        signal_module.signal(_signal, _exit_on_signal)

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
            vite = subprocess.Popen(["pnpm", "dev"], cwd=CLIENT_DIR, env=env,
                                    start_new_session=True)
            children.append(vite)
            print("[run_server] client dev server starting - "
                  "open the Local: URL Vite prints below")
        server = spawn_server(env)
        children.append(server)
        if not watch:
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
    except SystemExit:
        # SIGTERM/SIGHUP, via the handler installed above. Not an error, and
        # the finally below still runs - which is the whole point of raising.
        return 0
    finally:
        # Whatever ends this script (Ctrl-C, SIGTERM, SIGHUP, crash, clean
        # exit) also ends every child it started - never leave an orphan
        # holding a port. SIGINT for the server so its clean-shutdown snapshot
        # path runs; the same for vite, which exits on it just as readily.
        for proc in reversed(children):
            reap(proc, signal_module.SIGINT)


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    # A matching --no-watch exists so a launch can state its intent explicitly
    # even while the default is off, and keeps working if the default flips.
    watching = parser.add_mutually_exclusive_group()
    watching.add_argument("--watch", dest="watch", action="store_true",
                          help="restart the server on server/shared/plugin source "
                               "changes and make Vite poll the client's sources")
    watching.add_argument("--no-watch", dest="watch", action="store_false",
                          help="run without any file watching")
    parser.set_defaults(watch=WATCH_DEFAULT)
    return parser.parse_args(argv)


if __name__ == "__main__":
    return_code = main(parse_args().watch)
    sys.exit(return_code)
