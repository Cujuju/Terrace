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
import threading
import signal as signal_module
import sqlite3
import subprocess
import sys
import time
from urllib.request import pathname2url

# Server configuration - validated at boot by server/src/config.ts.
CONFIG = {
    "PORT": 2567,                 # 1-65535
    # THE SIZE *NEW* WORLDS ARE CREATED AT - not the size of the world that
    # loads (multi-world, 2026-08-22). Every world keeps whatever size it was
    # made with, and a server can hold worlds of several sizes at once, so this
    # no longer describes what you are about to play. 2048 cells is 512 world
    # units after the quarter-cell re-sample (issue #75); 512 cells would be a
    # sixteenth of that area.
    "WORLD_SIZE": 2048,           # cells (4 per world unit); multiple of 16, 448-4096
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
    "WORLD_ADMIN_KEY": None,      # None -> "terrace"        (creates/archives worlds)
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

# Seconds between checks of the control flags and (when watching) the source
# tree while the stack is up. Short enough that a keypress feels immediate.
CONTROL_POLL_INTERVAL_S = 0.25

# THE EXIT CODE THAT MEANS "RESTART ME", not "I crashed".
#
# The in-game Restart button (world-admin `serverRestart`) writes the final
# snapshot and then exits with this code; a supervisor is expected to bring the
# process straight back, which is how new plugin/core code becomes live (Node's
# ESM module map has no eviction, so the process is the unit of code identity).
# docker (`restart: unless-stopped`) and systemd (`Restart=always`) already do
# that for any exit; this script did not restart on ANY code, so the branch
# below is new rather than a reclassification.
#
# THE SOURCE OF TRUTH IS server/src/restart.ts's TERRACE_RESTART_EXIT_CODE.
# It is restated here rather than imported because this is Python and that is
# TypeScript; 75 is EX_TEMPFAIL from sysexits.h ("temporary failure, retry"),
# chosen because it collides with nothing a supervisor already reads - 0 clean,
# 1 boot failure, 2 shell misuse, 128+N a signalled death.
TERRACE_RESTART_EXIT_CODE = 75

# LOOP GUARD for the branch above. A plugin that throws at import exits 1, not
# 75, so it does not spin here - but a plugin that throws AFTER the restart
# service is reachable, or an operator holding the button, can. Three restarts
# inside one minute means each process lived under ~20 seconds on average,
# which is not a dev loop: it is something failing immediately, and the honest
# response is to stop and hand the code back so a human sees it.
TERRACE_RESTART_MAX_BURST = 3
TERRACE_RESTART_BURST_WINDOW_S = 60

# Repo root = directory holding this script; server/client live beside it.
REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.join(REPO_ROOT, "server")
CLIENT_DIR = os.path.join(REPO_ROOT, "client")
CLIENT_INDEX = os.path.join(CLIENT_DIR, "dist", "index.html")

# Everything that ends up INSIDE the client bundle, relative to the repo root.
# Not the same set as WATCH_ROOTS: that one is what a SERVER restart follows
# (and deliberately excludes client code), while this is what a client BUILD is
# made of - the client itself, the shared math it compiles against, and both
# halves of every plugin, whose client code Vite pulls in.
CLIENT_SOURCE_ROOTS = ("client/src", "shared/src", "plugins")

# Single files outside those trees that still change the bundle.
CLIENT_SOURCE_FILES = ("client/index.html", "client/vite.config.ts")

# Suffixes that can change what the bundle renders. CSS is here and not in
# WATCH_SUFFIXES because a stylesheet changes the client and never the server.
CLIENT_SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".json", ".css", ".html")


def newest_client_source_mtime() -> float:
    """Most recent mtime across everything the client bundle is built from."""
    newest = 0.0
    for root in CLIENT_SOURCE_ROOTS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(REPO_ROOT, root)):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", "dist", "test")]
            for name in filenames:
                if not name.endswith(CLIENT_SOURCE_SUFFIXES):
                    continue
                try:
                    newest = max(newest, os.stat(os.path.join(dirpath, name)).st_mtime)
                except OSError:
                    continue  # vanished mid-walk; the next launch will see it
    for rel in CLIENT_SOURCE_FILES:
        try:
            newest = max(newest, os.stat(os.path.join(REPO_ROOT, rel)).st_mtime)
        except OSError:
            continue
    return newest


def static_client_is_stale() -> bool:
    """True when client/dist is older than something it was built from.

    THE BUG THIS EXISTS TO KILL. This used to be `if os.path.isfile(index)`,
    i.e. "a build exists" was taken to mean "the build is current". It does not:
    nothing here ever rebuilds, so a dist built days ago is served forever, with
    no warning and no visible difference from a fresh one. The symptom is that
    your changes - and everyone else's - are simply ABSENT from the page, which
    reads as "the server is loading an old snapshot" rather than as a build
    problem. Reported exactly that way, 2026-08-22.

    An mtime comparison, not a content hash: it is one stat per source file
    against one stat on the build, it costs milliseconds, and being WRONG in
    the conservative direction (rebuilding when nothing meaningful changed)
    costs a few seconds while being wrong the other way costs an afternoon of
    debugging a UI that is not the one on disk.
    """
    try:
        built = os.stat(CLIENT_INDEX).st_mtime
    except OSError:
        return True  # no build at all
    return newest_client_source_mtime() > built


def prepare_static_client() -> bool:
    if os.path.isfile(CLIENT_INDEX) and not static_client_is_stale():
        return True
    reason = "dist missing" if not os.path.isfile(CLIENT_INDEX) else "sources are newer than dist"
    print(f"[run_server] building client ({reason})...")
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


def start_control_reader(state) -> threading.Thread:
    """Continuously read single characters from stdin into `state`.

    Keys (case-insensitive):
      q / k - quit the whole stack
      r     - restart the client and the server

    OVERLAPS WITH THE IN-GAME RESTART BUTTON, deliberately. This key restarts
    BOTH halves from the terminal; the button (world-admin `serverRestart`,
    exit code TERRACE_RESTART_EXIT_CODE) restarts the SERVER only and is
    reachable by an admin who is not at this terminal, gives connected players
    a countdown notice first, and works in docker and systemd where there is no
    terminal at all. Neither replaces the other.

    Runs as a daemon thread so it can never keep the interpreter alive after
    main returns; EOF (stdin closed, e.g. nohup) just ends the thread and
    leaves keyboard control off, exactly as before this existed.

    Terminal mode belongs to main(), not this thread: main puts stdin in
    cbreak mode (single keypress, no Enter) before starting this reader and
    restores it in its own `finally`, which runs on every exit path.
    Restoring here instead misses whenever main returns while this thread is
    still blocked in read() - Ctrl-C, a server crash, SIGTERM - because the
    interpreter kills a daemon thread abruptly without running its `finally`,
    leaving the shell with -ECHO -ICANON. This thread only reads.
    """
    def read_keys():
        try:
            while not state["stop"]:
                key = sys.stdin.read(1)
                if not key:  # EOF - no more input is coming
                    return
                key = key.strip().lower()
                if key in ("q", "k"):
                    state["stop"] = True
                    return
                if key == "r":
                    state["restart"] = True
        except Exception:  # noqa: BLE001 - stdin closed under us, or anything unexpected;
            # keyboard control just ends (Ctrl-C still works); never fail the run from here
            return
    reader = threading.Thread(target=read_keys, name="control-keys", daemon=True)
    reader.start()
    return reader


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

    # IN DEV MODE, DO NOT LET THE GAME SERVER SERVE client/dist.
    #
    # The server serves a built client on its own port when client/dist exists
    # (issue #20), and NOTHING in dev mode ever rebuilds it. So a stack started
    # this way offers two clients: Vite on 5173, always current, and a frozen
    # bundle on <PORT> that is as old as whenever somebody last ran
    # `pnpm --dir client build`. Worse, the server's own boot line says
    # "play at http://localhost:<PORT>" - pointing at the stale one. Open that
    # URL and you are looking at a build from hours or days ago, with no
    # indication anything is wrong: your changes are simply absent, and so is
    # everybody else's. Reported 2026-08-22 as "it is loading an old snapshot".
    #
    # Pointing CLIENT_DIST_PATH at a path that does not exist makes the server
    # say "no built client to serve - browse the Vite dev server instead",
    # which is the truth in dev mode. client/dist is left alone on disk; it is
    # simply not served, so there is exactly ONE client URL and it is the live
    # one.
    if CLIENT_MODE == "dev":
        env["CLIENT_DIST_PATH"] = os.path.join(SERVER_DIR, "no-dist-in-dev-mode")
        if os.path.exists(CLIENT_INDEX):
            print("[run_server] note     : client/dist exists but is NOT being served "
                  "(dev mode serves live sources; that build may be stale)")

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

    # Keyboard control. One daemon thread scans stdin for the whole run; the
    # main loop below polls these flags between wait timeouts.
    state = {"stop": False, "restart": False}
    print("[run_server] keys     : q/K quit | r restart client+server | Ctrl-C also works",
          flush=True)
    # CBREAK LIVES HERE, IN MAIN. Single-keypress control needs ECHO|ICANON
    # off for the duration, and only main's `finally` runs on every exit path:
    # a daemon reader blocked in read() is killed abruptly at shutdown without
    # its `finally` (Ctrl-C, server crash, SIGTERM all exited this way),
    # which left the shell with -ECHO -ICANON and invisible typing.
    termios_mod = None
    termios_saved = None

    def restore_terminal():
        # Idempotent: restoring the same saved attrs twice is harmless, so
        # the setup-failure path below and the main `finally` can share it.
        if termios_saved is not None:
            try:
                termios_mod.tcsetattr(sys.stdin.fileno(), termios_mod.TCSADRAIN, termios_saved)
            except Exception:  # noqa: BLE001 - terminal already gone
                pass

    try:
        if sys.stdin.isatty():
            try:
                import termios
                import tty
                termios_mod = termios
                termios_saved = termios.tcgetattr(sys.stdin.fileno())
                tty.setcbreak(sys.stdin.fileno())
            except (OSError, ValueError, ImportError):
                termios_mod = None
                termios_saved = None
        start_control_reader(state)
    except Exception:
        # Thread-start itself threw: never leave cbreak behind without
        # entering the main loop (and its restoring `finally`).
        restore_terminal()
        raise

    def launch_stack():
        """Bring up the client (dev mode) and the game server; append to children."""
        if CLIENT_MODE == "static" and not prepare_static_client():
            return None
        if CLIENT_MODE == "dev":
            vite = subprocess.Popen(["pnpm", "dev"], cwd=CLIENT_DIR, env=env,
                                    start_new_session=True)
            children.append(vite)
            print("[run_server] client dev server starting - "
                  "open the Local: URL Vite prints below")
        proc = spawn_server(env)
        children.append(proc)
        return proc

    try:
        server = launch_stack()
        if server is None:
            return 1

        if watch:
            print(f"[run_server] watching {', '.join(WATCH_ROOTS)} "
                  f"(poll every {WATCH_POLL_INTERVAL_S}s) - server restarts on change",
                  flush=True)
        snapshot = watch_snapshot() if watch else None
        # Monotonic timestamps of the restarts honoured so far, newest last.
        # time.monotonic() rather than time.time(): a wall-clock jump (NTP,
        # a laptop waking) must not widen or collapse the burst window.
        restart_times = []

        # ONE loop for watched and unwatched runs alike: either way we sit in a
        # short wait timeout and wake to check the keyboard flags, so q/r work
        # whether or not --watch was passed.
        while True:
            if state["stop"]:
                print("[run_server] quit requested - shutting down", flush=True)
                return 0
            try:
                code = server.wait(timeout=CONTROL_POLL_INTERVAL_S)
                if code == TERRACE_RESTART_EXIT_CODE:
                    # ASKED FOR, not a crash. The server has already written
                    # its final snapshot and released the port; relaunch it and
                    # leave the client alone - Vite is a separate process whose
                    # sources did not change, and reaping it would cost the
                    # operator their browser session for nothing.
                    children.remove(server)
                    now = time.monotonic()
                    restart_times = [
                        t for t in restart_times
                        if now - t < TERRACE_RESTART_BURST_WINDOW_S
                    ]
                    if len(restart_times) >= TERRACE_RESTART_MAX_BURST:
                        print(f"[run_server] server asked to restart "
                              f"{len(restart_times) + 1} times in under "
                              f"{TERRACE_RESTART_BURST_WINDOW_S}s - giving up so the "
                              f"failure is visible instead of spinning", flush=True)
                        return code
                    restart_times.append(now)
                    print("[run_server] server asked to restart (exit "
                          f"{TERRACE_RESTART_EXIT_CODE}) - relaunching it; "
                          "the client dev server is left running", flush=True)
                    # Re-snapshot AFTER the shutdown, for the --watch path's
                    # reason: the shutdown snapshot's own file writes belong to
                    # the run about to start, not to another restart.
                    snapshot = watch_snapshot() if watch else None
                    server = spawn_server(env)
                    children.append(server)
                    continue
                # The server exited on its own (crash, pnpm failure). Do not
                # outlive it pretending nothing happened.
                return code
            except subprocess.TimeoutExpired:
                pass  # still running - that is the normal path

            if watch:
                current = watch_snapshot()
                if current != snapshot:
                    changed = sorted(
                        set(current) ^ set(snapshot)
                        | {p for p in set(current) & set(snapshot) if current[p] != snapshot[p]}
                    )
                    print(f"[run_server] source change ({len(changed)} file(s), e.g. "
                          f"{os.path.relpath(changed[0], REPO_ROOT)}) - restarting server",
                          flush=True)
                    # SIGINT, exactly as the shutdown path below does: it is the
                    # signal whose handler writes the clean-shutdown snapshot, so
                    # a restart never costs the world its unsaved terrain.
                    reap(server, signal_module.SIGINT)
                    children.remove(server)
                    # Re-snapshot AFTER the shutdown, not before: a save that
                    # lands while the old process is still winding down belongs
                    # to the run that is about to start, not another restart.
                    snapshot = watch_snapshot()
                    server = spawn_server(env)
                    children.append(server)

            if state["restart"]:
                state["restart"] = False
                print("[run_server] restart requested - stopping client and server",
                      flush=True)
                reap(server, signal_module.SIGINT)
                children.remove(server)
                # In dev mode Vite is the client; stop it too so it re-reads its
                # config and env (e.g. TERRACE_WATCH, VITE_SERVER_URL) fresh.
                for proc in [c for c in children]:
                    reap(proc, signal_module.SIGINT)
                    children.remove(proc)
                server = launch_stack()
                if server is None:
                    return 1
                snapshot = watch_snapshot() if watch else None
                print("[run_server] restarted client and server", flush=True)
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
        # Restore the terminal FIRST, so it is sane even if reaping hangs:
        # this is the authoritative (and only) restore - the reader thread
        # never touches terminal mode (see the cbreak comment above).
        # Telling the reader to stop is best-effort: it may be blocked in
        # read(), in which case teardown just leaves it behind (daemon).
        state["stop"] = True
        restore_terminal()
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
