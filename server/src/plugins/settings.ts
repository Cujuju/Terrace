import type { PluginSettingDeclaration } from './types.ts';

export type StoredSettings = Readonly<Record<string, string>>;

// A row under the current key wins; otherwise the first former key with a row.
// Rows under undeclared keys pass through untouched.
export function resolveDeclaredSettings(
  declarations: readonly PluginSettingDeclaration[],
  stored: StoredSettings,
): Record<string, string> {
  const resolved: Record<string, string> = { ...stored };
  for (const declaration of declarations) {
    if (Object.hasOwn(stored, declaration.key)) continue;
    for (const former of declaration.formerKeys ?? []) {
      if (!Object.hasOwn(stored, former)) continue;
      resolved[declaration.key] = stored[former]!;
      break;
    }
  }
  return resolved;
}
