#!/bin/bash
# Kill by port-owner pid (Vite's launcher pid is not the listener), never pkill -f.
for p in 2699 5299; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid" && echo "killed $p ($pid)"
done
