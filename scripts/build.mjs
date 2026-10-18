import { build } from 'esbuild';
await build({ entryPoints: ['src/app.js'], bundle: true, minify: true, outfile: 'public/app.js', format: 'esm', target: ['es2022'], legalComments: 'none' });
console.log('Knovera browser bundle ready.');
