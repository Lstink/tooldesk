import sharp from 'sharp';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const svgPath = join(root, 'src-tauri', 'app-icon.svg');
const outPath = join(root, 'src-tauri', 'app-icon.png');

const svg = readFileSync(svgPath);
await sharp(svg)
  .resize(1024, 1024)
  .png()
  .toFile(outPath);
console.log('Generated src-tauri/app-icon.png (1024x1024)');
