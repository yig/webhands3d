import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose dev root is demo/.
// Calibration tests take ~1 s locally and several times that on CI runners.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30000 } });
