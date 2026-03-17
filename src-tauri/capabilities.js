import fs from 'fs';
const data = JSON.parse(fs.readFileSync('node_modules/@tauri-apps/api/package.json', 'utf8'));
console.log(data.version);
