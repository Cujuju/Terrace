// Discovery fixture: no export called `plugin`, but exactly one plugin-shaped
// export — the loader falls back to it rather than failing.
import type { TerracePlugin } from '../../../../../src/plugins/types.ts';

export const revealPlugin: TerracePlugin = {
  name: 'named-differently',
};
