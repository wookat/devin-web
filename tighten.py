import re,sys
sys.stdout.reconfigure(encoding='utf-8')
p='D:/yotal/jobchrome/resume_agent.html'
h=open(p,encoding='utf-8').read()
h=re.sub(r'@page \{[^}]*\}','@page { size: A4; margin: 9mm 11mm; }',h)
h=h.replace('font-size: 9.2pt; line-height: 1.45','font-size: 8.1pt; line-height: 1.3')
h=h.replace('h1 { font-size: 17pt; margin-bottom: 2px; }','h1 { font-size: 14.5pt; margin-bottom: 1px; }')
h=h.replace('h2 { font-size: 10.5pt; border-bottom: 1.2px solid #333; margin: 8px 0 4px; padding-bottom: 1px; letter-spacing:.5px; }',
            'h2 { font-size: 9.4pt; border-bottom: 1px solid #444; margin: 5px 0 2.5px; padding-bottom: 0; letter-spacing:.4px; }')
h=h.replace('p { margin: 1.5px 0; }','p { margin: 0.6px 0; }')
h=h.replace('li { margin: 1.5px 0 1.5px 16px; }','li { margin: 0.5px 0 0.5px 14px; }')
h=h.replace('.row { display:flex; align-items:baseline; gap:8px; margin: 4px 0 0; }',
            '.row { display:flex; align-items:baseline; gap:8px; margin: 2.5px 0 0; }')
h=h.replace('font-size:8.4pt','font-size:7.8pt').replace('font-size:8.2pt','font-size:7.8pt')
open(p,'w',encoding='utf-8').write(h)
print('tightened')
