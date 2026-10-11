/** What the server and a supervising parent (run_server.py, the desktop app) agree on. Dependency-free: the desktop main process bundles it. */

/** Exit code asking the supervisor to relaunch the server. */
export const TERRACE_RESTART_EXIT_CODE = 75;

/** Exit code asking the supervisor to relaunch the server and the client dev server. */
export const TERRACE_STACK_RESTART_EXIT_CODE = 76;

/** IPC message from a parent asking for the graceful stop a signal gives; Windows cannot deliver SIGTERM to a child. */
export const SUPERVISOR_SHUTDOWN_MESSAGE = 'terrace:shutdown';
