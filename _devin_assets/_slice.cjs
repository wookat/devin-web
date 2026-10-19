const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'utf8');
const needle = process.argv[3];
const ctx = parseInt(process.argv[4] || '600');
let i = s.indexOf(needle), n = 0;
while (i >= 0 && n < 8) { console.log('\n=== @' + i + ' ===\n' + s.slice(Math.max(0, i - ctx), i + ctx)); i = s.indexOf(needle, i + 1); n++; }
