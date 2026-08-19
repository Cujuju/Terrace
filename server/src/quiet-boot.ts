// Import-order-sensitive: this module must be imported BEFORE any Colyseus
// import. Defensive guard: we import @colyseus/core directly, which runs no
// dotenv, but the colyseus meta-package (via @colyseus/tools) calls
// dotenv.config() at import time and dotenv 17 prints an "injected env … //
// tip: …" ad line unless DOTENV_CONFIG_QUIET is set. If that meta-package (or
// any other dotenv caller) ever returns to the dependency graph, this keeps
// the boot log clean rather than regressing silently.
process.env.DOTENV_CONFIG_QUIET = 'true';
