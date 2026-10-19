import sys
sys.stdout.reconfigure(encoding='utf-8')
p='D:/yotal/jobchrome/resume_agent.html'
h=open(p,encoding='utf-8').read()
h=h.replace('@page { size: A4; margin: 9mm 11mm; }','@page { size: A4; margin: 7.5mm 10mm; }')
h=h.replace('font-size: 8.1pt; line-height: 1.3','font-size: 7.9pt; line-height: 1.26')
h=h.replace('h1 { font-size: 14.5pt; margin-bottom: 1px; }','h1 { font-size: 13.5pt; margin-bottom: 0; }')
h=h.replace('h2 { font-size: 9.4pt; border-bottom: 1px solid #444; margin: 5px 0 2.5px; padding-bottom: 0; letter-spacing:.4px; }',
            'h2 { font-size: 9pt; border-bottom: 1px solid #444; margin: 4px 0 2px; padding-bottom: 0; letter-spacing:.4px; }')
h=h.replace('li { margin: 0.5px 0 0.5px 14px; }','li { margin: 0.3px 0 0.3px 13px; }')
h=h.replace('.row { display:flex; align-items:baseline; gap:8px; margin: 2.5px 0 0; }',
            '.row { display:flex; align-items:baseline; gap:8px; margin: 2px 0 0; }')
h=h.replace('font-size:7.8pt','font-size:7.5pt')
open(p,'w',encoding='utf-8').write(h)
print('tightened v2')
