import sys
sys.stdout.reconfigure(encoding='utf-8')
from playwright.sync_api import sync_playwright
pw=sync_playwright().start()
b=pw.chromium.connect_over_cdp('http://localhost:9222')
ctx=b.contexts[0]
for p in ctx.pages:
    if '.pdf' in p.url:
        p.screenshot(path='D:/yotal/jobchrome/pdfview.png')
        print('shot', p.url[:80])
        break
pw.stop()
