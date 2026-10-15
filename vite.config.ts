import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';
import { signalingPlugin } from './tools/signaling';

// `npm run dev` serves the demo on localhost; `npm run dev:lan` serves it over
// HTTPS on the local network so phones can join as remote cameras (camera
// access needs a secure context); `npm run build` builds the library.
const lan = !!process.env.WEBHANDS_LAN;

export default defineConfig(({ command }) =>
  command === 'serve'
    ? {
        root: 'demo',
        plugins: [signalingPlugin(), ...(lan ? [basicSsl()] : [])],
        server: { host: lan ? true : undefined },
      }
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
