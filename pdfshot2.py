import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright

pw=sync_playwright().start()
b=pw.chromium.connect_over_cdp('http://localhost:9222')
ctx=b.contexts[0]
target=None
for p in ctx.pages:
    if '.pdf' in p.url or 'resume' in p.url: target=p
if target is None:
    target=ctx.pages[0]
target.goto('file:///D:/yotal/Documents/Projects/Resume/彭明-AI-Agent工程师-2027校招.pdf')
target.wait_for_timeout(2500)
target.screenshot(path='D:/yotal/jobchrome/pdfview.png')
print('reshot', target.url)
pw.stop()
