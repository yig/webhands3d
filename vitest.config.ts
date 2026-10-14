import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose dev root is demo/.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
