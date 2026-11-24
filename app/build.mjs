// Build: bundle src/app.ts, embed hands/*.hand, write dist/index.html
import { build } from 'esbuild';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';

const r = await build({ entryPoints: ['src/app.ts'], bundle: true, format: 'iife', target: 'es2020', minify: false, write: false });
const js = r.outputFiles[0].text;
const hands = readdirSync('hands').filter(f => f.endsWith('.hand')).sort().map(f => ({ file: f, text: readFileSync('hands/' + f, 'utf8') }));
const handsJs = `<script>const BUNDLED_HANDS = ${JSON.stringify(hands).replace(/</g, '\\u003c')};</script>`;
const html = readFileSync('src/index.html', 'utf8')
  .replace('<!--HANDS-->', () => handsJs)
  .replace('<!--APP-->', () => `<script>${js.replace(/<\/script/gi, '<\\/script')}</script>`);
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', html);
console.log('dist/index.html', html.length, 'bytes,', hands.length, 'hands');
