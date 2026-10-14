import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// `npm run dev` serves the demo; `npm run build` builds the library.
export default defineConfig(({ command }) =>
  command === 'serve'
    ? { root: 'demo' }
    : {
        build: {
          lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            formats: ['es'],
            fileName: 'webhands',
          },
          rollupOptions: { external: ['@mediapipe/tasks-vision'] },
        },
      },
);
