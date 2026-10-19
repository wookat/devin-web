const fs = require('fs');
const s = fs.readFileSync(process.argv[2], 'utf8');
const out = new Set();
for (const m of s.matchAll(/className:\s*[`"'][^`"']{10,300}[`"']/g)) out.add(m[0]);
for (const m of s.matchAll(/className:"[^"]{10,300}"/g)) out.add(m[0]);
console.log([...out].slice(0, 80).join('\n'));
