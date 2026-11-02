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
          if (req.url && req.url.includes('/data/')) {
            const fileName = req.url.split('/data/')[1].split('?')[0];
            const dataPath = path.resolve(__dirname, 'data', fileName);
            if (fs.existsSync(dataPath)) {
              res.setHeader('Content-Type', 'application/json');
              return res.end(fs.readFileSync(dataPath));
            }
          }
          next();
        });
      },
      closeBundle() {
        const dataDir = path.resolve(__dirname, 'data');
        const destDir = path.resolve(__dirname, 'dist/data');
        if (fs.existsSync(dataDir)) {
          fs.mkdirSync(destDir, { recursive: true });
          for (const file of fs.readdirSync(dataDir)) {
            fs.copyFileSync(path.resolve(dataDir, file), path.resolve(destDir, file));
          }
        }
      }
    }
  ]
});
