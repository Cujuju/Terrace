#!/bin/bash
# GLB war-boat eyes-on stack: server + Vite from the glb-accessors WORKTREE.
# Ports 2699 / 5299, throwaway world copy, DB_PATH at a nonexistent file so no
# legacy world is adopted. Owner's stack is never touched.
WT=/mnt/e/Development/Projects/Terrace/.claude/worktrees/glb-accessors
ST=/mnt/e/Development/Projects/Terrace/.glb-eyes-on
cd $WT/server && PORT=2699 WORLDS_DIR=$ST/worlds DB_PATH=$ST/no-legacy.db WORLD_SIZE=512 \
  node src/index.ts >$ST/server.log 2>&1 &
echo $! > $ST/server.pid
cd $WT/client && VITE_SERVER_URL=ws://localhost:2699 npx vite --port 5299 --strictPort >$ST/vite.log 2>&1 &
echo $! > $ST/vite.pid
echo "server $(cat $ST/server.pid) vite $(cat $ST/vite.pid)"
