export const DEV_FORCE_ENV_SUFFIX = '_DEV_FORCE';

export function devForceEnvName(pluginName: string): string {
  return `${pluginName.toUpperCase()}${DEV_FORCE_ENV_SUFFIX}`;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function readDevForce(envName: string, env: Record<string, string | undefined>): boolean {
  const raw = env[envName]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return false;
  return TRUTHY.has(raw);
}
