import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

// `npm run dev` serves the demo on localhost; `npm run dev:lan` serves it over
// HTTPS on the local network so phones can join as remote cameras (camera
// access needs a secure context); `npm run build` builds the library.
const lan = !!process.env.WEBHANDS_LAN;

/** Dev only: /webhands-info → this server's LAN addresses, so the QR code works when the page is opened on localhost. */
function lanInfo(): Plugin {
  return {
    name: 'webhands-lan-info',
    configureServer(server) {
      server.middlewares.use('/webhands-info', (_req, res) => {
        const address = server.httpServer?.address();
        const port = address && typeof address === 'object' ? address.port : server.config.server.port;
        const protocol = server.config.server.https ? 'https' : 'http';
        const urls = Object.values(networkInterfaces())
          .flat()
          .filter((a) => a && a.family === 'IPv4' && !a.internal)
          .map((a) => `${protocol}://${a!.address}:${port}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ urls }));
      });
    },
  };
}

const demoPages = ['index', 'cameras', 'remote', 'xr', 'pattern'];

export default defineConfig(({ command, mode }) =>
  // `npm run build:demo`: the demo pages as a static site (e.g. GitHub Pages), relative paths.
  mode === 'demo'
    ? {
        root: 'demo',
        base: './',
        build: {
          outDir: '../dist-demo',
          emptyOutDir: true,
          rollupOptions: {
            input: Object.fromEntries(demoPages.map((p) => [p, fileURLToPath(new URL(`demo/${p}.html`, import.meta.url))])),
          },
        },
      }
    : command === 'serve'
    ? {
        root: 'demo',
        plugins: [lanInfo(), ...(lan ? [basicSsl()] : [])],
        server: { host: lan ? true : undefined },
      }
    : {
        build: {
          lib: {
            entry: fileURLToPath(new URL('src/index.ts', import.meta.url)),
            formats: ['es'],
            fileName: 'webhands',
          },
          rollupOptions: { external: ['@mediapipe/tasks-vision', 'peerjs'] },
        },
      },
);
