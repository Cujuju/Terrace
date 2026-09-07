import { defineConfig } from 'vitest/config';
import base from '../../vitest.base.config.ts';

// The shared settings, wrapped where `vitest/config` actually resolves —
// see vitest.base.config.ts for why the import cannot live there.
export default defineConfig(base);
