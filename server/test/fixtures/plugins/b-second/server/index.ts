// Discovery fixture: sorts after a-first by directory name, not by plugin name.
import type { TerracePlugin } from '../../../../../src/plugins/types.ts';

export const plugin: TerracePlugin = {
  name: 'second',
};
