import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const rawBase = process.env.VITE_BASE || './';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

export default defineConfig({
  base,
  server: {
    port: 5173,
    open: false
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  plugins: [
    {
      name: 'copy-commons-data',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.endsWith('/data/commons.json')) {
            const dataPath = path.resolve(__dirname, 'data/commons.json');
            if (fs.existsSync(dataPath)) {
              res.setHeader('Content-Type', 'application/json');
              return res.end(fs.readFileSync(dataPath));
            }
          }
          next();
        });
      },
      closeBundle() {
        const src = path.resolve(__dirname, 'data/commons.json');
        const destDir = path.resolve(__dirname, 'dist/data');
        if (fs.existsSync(src)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(src, path.resolve(destDir, 'commons.json'));
        }
      }
    }
  ]
});
