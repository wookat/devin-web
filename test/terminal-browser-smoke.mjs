// Reusable LOCAL browser verification. Load with mcp-playwright's
// browser_run_code_unsafe({filename: "<absolute path to this file>"}).
// No npm dependency/install needed. Real keyboard + real /ws/term shell;
// term-agent HTTP and the explicitly labelled PTY scenario are deterministic mocks.
// Only harmless Write-Output/Start-Sleep/exit commands are sent to local shells.
async (page) => {
  // Fresh page each invocation: Playwright addInitScript registrations persist
  // across reloads, so reusing the caller page would stack WS wrappers/counts.
  const reportPage = page
  page = await page.context().newPage()
  const origin = 'http://localhost:7791'
  const round = await reportPage.evaluate(() => (window.__terminalFinalReports?.length ?? 0) + 1)
  const results = []
  const agentRequests = []
  const errors = []
  const consoleMessages = []
  const requestFailures = []
  const deniedNonlocal = []
  const screenshots = {}
  const assert = (ok, message) => { if (!ok) throw new Error(message) }
  const stamp = Date.now()
  const prefix = `.playwright-mcp/terminal-final-round-${round}-${stamp}`
  let command = 'Write-Output "MOCK_AGENT_ONCE"'
  let holdAgent = false
  let releaseAgent
  const instrument = () => {
    if (window.__termSmoke?.installed) return
    window.__termSmoke = { installed: true, sockets: [], sent: [], received: [] }
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url, protocols) {
        super(url, protocols)
        if (!String(url).includes('/ws/term')) return
        const n = window.__termSmoke.sockets.push(this) - 1
        this.addEventListener('message', (event) => {
          try { window.__termSmoke.received.push({ n, ...JSON.parse(event.data), at: Date.now() }) } catch {}
        })
        const send = this.send.bind(this)
        this.send = (data) => {
          try { window.__termSmoke.sent.push({ n, ...JSON.parse(data), at: Date.now() }) } catch {}
          return send(data)
        }
      }
    }
    window.__termInspect = () => {
      const root = [...document.querySelectorAll('.xterm')].find((el) => el.getBoundingClientRect().width > 0)
      if (!root) return { text: '', editor: null, cols: 0 }
      const host = root.parentElement
      let fiber = host[Object.keys(host).find((k) => k.startsWith('__reactFiber$'))]
      let term, editor, handle
      for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
        for (let hook = fiber.memoizedState, i = 0; hook && i < 100; i++, hook = hook.next) {
          const value = hook.memoizedState?.current
          if (value?.buffer?.active && typeof value.write === 'function') term = value
          if (value && typeof value.buf === 'string' && typeof value.cur === 'number') editor = value
          if (value instanceof Map && typeof value.values().next().value?.isLive === 'function') handle = value.values().next().value
        }
      }
      if (!term) return { text: root.innerText, editor, cols: 0 }
      window.__termSmoke.term = term
      const b = term.buffer.active
      const lines = Array.from({ length: b.length }, (_, i) => b.getLine(i)?.translateToString(true) ?? '')
      window.__termSmoke.handleIds ??= new WeakMap()
      if (handle && !window.__termSmoke.handleIds.has(handle)) window.__termSmoke.handleIds.set(handle, ++window.__termSmoke.handleCounter || (window.__termSmoke.handleCounter = 1))
      return { text: lines.join('\n'), lines, cols: term.cols, handleId: handle ? window.__termSmoke.handleIds.get(handle) : null,
        cursor: { x: b.cursorX, y: b.cursorY, absoluteY: b.baseY + b.cursorY },
        editor: editor ? { buf: editor.buf, cur: editor.cur, shell: editor.shell, live: editor.live,
          agent: editor.agent, awaitingAgent: editor.awaitingAgent, fromAgent: editor.fromAgent } : null }
    }
  }
  await page.addInitScript(instrument)
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      deniedNonlocal.push(url.origin)
      return route.abort('blockedbyclient')
    }
    if (url.pathname.endsWith('/term-agent')) {
      agentRequests.push({ url: url.pathname, body: route.request().postDataJSON() })
      if (holdAgent) await new Promise((resolve) => { releaseAgent = resolve })
      try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, command }) }) } catch {}
      return
    }
    return route.continue()
  })
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('requestfailed', (request) => requestFailures.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on('console', (message) => {
    if (['error', 'warning'].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text(), location: message.location() })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${origin}/admin/glorious-pupil?tab=term`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__termSmoke?.received.some((m) => m.ready === true)
    && window.__termInspect().editor?.live === true, undefined, { timeout: 20000 })
  const assets = await page.evaluate(() => [...new Set(performance.getEntriesByType('resource').map((r) => r.name)
    .filter((name) => name.includes('/assets/') && /\.js(?:\?|$)/.test(name)))])
  const inspect = () => page.evaluate(() => window.__termInspect())
  const wire = () => page.evaluate(() => ({ sent: window.__termSmoke.sent, received: window.__termSmoke.received, sockets: window.__termSmoke.sockets.length }))
  const focus = async () => {
    const inputs = page.locator('.xterm-helper-textarea')
    for (let i = 0; i < await inputs.count(); i++) {
      if (await inputs.nth(i).evaluate((el) => el.closest('.xterm').getBoundingClientRect().width > 0)) {
        await inputs.nth(i).focus(); return
      }
    }
    throw new Error('No visible xterm textarea')
  }
  const key = async (name) => { await focus(); await page.keyboard.press(name) }
  const type = async (value) => { await focus(); await page.keyboard.type(value) }
  const output = async (marker, timeout = 7000) => {
    await page.waitForFunction((m) => window.__termSmoke.received.some((r) => typeof r.d === 'string' && r.d.includes(m)), marker, { timeout })
  }
  const observe = async (ms) => {
    const until = Date.now() + ms
    while (Date.now() < until) await page.waitForTimeout(Math.min(100, until - Date.now()))
  }
  const shot = async (name, target = page) => {
    const path = `${prefix}-${name}.png`
    await target.screenshot({ path })
    screenshots[name] = path
    return path
  }
  const compact = (state) => state?.text ? { ...state, lineCount: state.lines?.length, lines: undefined, text: state.text.slice(-3500) } : state
  const test = async (name, action) => {
    try { const evidence = await action(); results.push({ name, status: 'PASS', evidence: compact(evidence) }) }
    catch (error) {
      const screenshot = `${prefix}-failure-${results.length + 1}.png`
      await page.screenshot({ path: screenshot }).catch(() => {})
      results.push({ name, status: 'FAIL', error: String(error), state: compact(await inspect().catch(() => null)), screenshot })
    }
  }
  await test('real WS: immediate ASCII echo and command output', async () => {
    await type('Write-Output "SMOKE_ECHO"')
    await page.waitForFunction(() => window.__termInspect().text.includes('Write-Output "SMOKE_ECHO"'))
    const draft = await inspect()
    await key('Enter'); await output('SMOKE_ECHO')
    return { draft, output: await inspect() }
  })
  await test('real WS: Chinese input/output through actual browser input insertion', async () => {
    await focus(); await page.keyboard.insertText('Write-Output "中文输入输出"')
    await page.waitForFunction(() => window.__termInspect().text.includes('中文输入输出'))
    await key('Enter'); await output('中文输入输出')
    await shot('chinese')
    return await inspect()
  })
  await test('real keyboard: Home, Delete, End and cursor editing', async () => {
    await type('XWrite-Output "CURSOR_O"')
    await key('Home'); await key('Delete'); await key('End'); await key('ArrowLeft')
    await type('K'); await key('Enter'); await output('CURSOR_OK')
    return await inspect()
  })
  await test('real keyboard: history restores current draft', async () => {
    await type('Write-Output "HISTORY_DRAFT"')
    await key('ArrowUp')
    const previous = await inspect()
    await key('ArrowDown')
    const restored = await inspect()
    assert(restored.editor?.buf === 'Write-Output "HISTORY_DRAFT"', 'History Down did not restore draft')
    await key('Enter'); await output('HISTORY_DRAFT')
    return { previous, restored }
  })
  await test('real keyboard: wrapped line redraw has no duplicated fragments', async () => {
    const long = `Write-Output "WRAP_${'x'.repeat(160)}_END"`
    const before = await inspect()
    await type(long)
    await key('Home'); await key('Delete'); await type('W'); await key('End')
    await page.waitForFunction((value) => window.__termInspect().editor?.buf === value, long)
    await observe(150)
    const draft = await inspect()
    const rendered = draft.text.replace(/\n/g, '')
    assert(rendered.includes(long), 'Wrapped input is corrupted or duplicated on screen')
    const repeated = (draft.text.match(/❯ Write-Output "WRAP_/g) ?? []).length
    assert(repeated === 1, `Wrapped edit duplicated the prompt prefix ${repeated} times (before ${before.lines.length} lines, after ${draft.lines.length})`)
    await shot('long-line')
    await key('Enter'); await output(`WRAP_${'x'.repeat(160)}_END`)
    return draft
  })
  await test('real clipboard: multiline paste never submits before Enter', async () => {
    await key('Control+u')
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
    await page.evaluate(() => navigator.clipboard.writeText('Write-Output "PASTE_A";\r\nWrite-Output "PASTE_B"'))
    const before = (await wire()).sent.filter((m) => typeof m.d === 'string').length
    // xterm consumes Ctrl+V on this Windows browser; Shift+Insert generates
    // the real trusted clipboard paste event, verified in baseline probing.
    await focus(); await page.keyboard.press('Shift+Insert')
    await observe(150)
    const after = (await wire()).sent.filter((m) => typeof m.d === 'string').length
    const draft = await inspect()
    assert(before === after, `Paste submitted ${after - before} WS frame(s) before Enter`)
    assert(draft.editor?.buf.includes('PASTE_A') && draft.editor?.buf.includes('PASTE_B'), 'Real clipboard paste lost text')
    await key('Enter'); await output('PASTE_B')
    return { before, after, draft }
  })
  await key('Control+u')
  await test('LABELLED xterm onData chunk mock: bracketed paste state survives chunk boundaries', async () => {
    const before = (await wire()).sent.filter((m) => typeof m.d === 'string').length
    await inspect()
    await page.evaluate(() => {
      const service = window.__termSmoke.term._core.coreService
      for (const chunk of ['\x1b[20', '0~', 'Write-Output "CHUNK_A";\n', 'Write-Output "CHUNK_B"', '\x1b[201', '~']) {
        service.triggerDataEvent(chunk, true)
      }
    })
    const after = (await wire()).sent.filter((m) => typeof m.d === 'string').length
    const draft = await inspect()
    assert(before === after, `Chunked bracketed paste submitted ${after - before} WS frame(s) before Enter`)
    assert(draft.editor?.buf.includes('CHUNK_A') && draft.editor?.buf.includes('CHUNK_B'), 'Chunked bracketed paste lost text')
    await key('Enter'); await output('CHUNK_B')
    return { before, after, draft: compact(draft) }
  })
  await key('Control+u')
  await test('real WS: async command output preserves visible draft', async () => {
    await type('Start-Sleep -Milliseconds 800; Write-Output "ASYNC_OUTPUT"')
    await key('Enter'); await type('Write-Output "ASYNC_DRAFT"')
    await output('ASYNC_OUTPUT')
    // Output redraw is intentionally debounced by the implementation. Poll
    // the actual current cursor row rather than taking an early stale frame.
    await page.waitForFunction(() => {
      const state = window.__termInspect()
      return state.lines?.[state.cursor.absoluteY]?.includes('ASYNC_DRAFT')
    }, undefined, { timeout: 2000 })
    const draft = await inspect()
    assert(draft.editor?.buf === 'Write-Output "ASYNC_DRAFT"', 'Async output discarded editor buffer')
    assert(draft.lines?.[draft.cursor.absoluteY]?.includes('ASYNC_DRAFT')
      || draft.text.trimEnd().endsWith('Write-Output "ASYNC_DRAFT"'), 'Async output did not restore draft on current line')
    assert(!draft.text.includes('"ASYNC_DRAFT"ASYNC_OUTPUT'), 'Async output was appended to the editable draft')
    await shot('async-preserved-draft')
    await key('Enter'); await output('ASYNC_DRAFT')
    return draft
  })
  await key('Control+u')
  await test('real WS policy: nonempty Ctrl+C cancels draft without resetting shell', async () => {
    const before = await wire()
    await type('Write-Output "DRAFT_MUST_NOT_EXECUTE"')
    await key('Control+c')
    await page.waitForFunction(() => window.__termInspect().editor?.buf === '')
    const after = await wire()
    assert(after.sockets === before.sockets, 'Draft Ctrl+C unexpectedly replaced shell')
    assert(after.sent.length === before.sent.length, 'Draft Ctrl+C sent data/interrupt to the child')
    await page.waitForFunction(() => {
      const text = window.__termInspect().text
      return /Ctrl\+C/.test(text) && /重置|reset|restart/i.test(text)
    }, undefined, { timeout: 2000 })
    const state = await inspect()
    assert(/Ctrl\+C/.test(state.text) && /重置|reset|restart/i.test(state.text), 'Draft cancellation did not explain second Ctrl+C resets shell')
    await shot('draft-cancel-policy')
    return { before: before.sockets, after: after.sockets, state: compact(state) }
  })
  await test('real WS: Ctrl+C interrupts command; no late marker', async () => {
    const before = await wire()
    await type('Write-Output "INTERRUPT_STARTED"; Start-Sleep -Seconds 3; Write-Output "FORBIDDEN_LATE_MARKER"')
    await key('Enter'); await output('INTERRUPT_STARTED')
    await key('Control+c')
    await page.waitForFunction((n) => window.__termSmoke.sockets.length === n + 1
      && window.__termSmoke.received.some((m) => m.n === n && m.ready === true)
      && window.__termInspect().editor?.live, before.sockets, { timeout: 12000 })
    await observe(3800)
    const data = await wire()
    const late = data.received.filter((m) => typeof m.d === 'string' && m.d.includes('FORBIDDEN_LATE_MARKER'))
    assert(late.length === 0, `Ctrl+C failed: ${late.length} late output frame(s)`)
    const interruptFrames = data.sent.filter((m) => m.interrupt)
    assert(interruptFrames.length === 1, `Expected one owned-process-tree interrupt frame, got ${interruptFrames.length}`)
    await type('Write-Output "AFTER_INTERRUPT"'); await key('Enter'); await output('AFTER_INTERRUPT')
    await shot('real-interrupt-recovered')
    return { interruptFrames, late: late.length, socketsBefore: before.sockets, socketsAfter: data.sockets }
  })
  await test('MOCK HTTP agent ask: suggestion edited then executes once', async () => {
    await key('Control+u')
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByRole('button', { name: 'exec', exact: true }).click()
    const handleBefore = (await inspect()).handleId
    const before = agentRequests.length
    await type('DETERMINISTIC MOCK ONLY suggest an echo'); await key('Enter')
    await page.waitForFunction(() => window.__termInspect().editor?.buf === 'Write-Output "MOCK_AGENT_ONCE"', undefined, { timeout: 5000 })
    const suggestion = await inspect()
    assert(suggestion.handleId === handleBefore, 'Ordinary busy rerender changed terminal handle identity')
    assert(suggestion.editor?.fromAgent === true, 'Ask suggestion lost command-routing provenance')
    await shot('ask-suggestion-before-execution')
    await key('ArrowLeft'); await type('_EDITED'); await key('Enter')
    await output('MOCK_AGENT_ONCE_EDITED')
    await observe(300)
    const data = await wire()
    const calls = agentRequests.length - before
    const executions = data.sent.filter((m) => m.d === 'Write-Output "MOCK_AGENT_ONCE_EDITED"\n').length
    assert(calls === 1 && executions === 1, `Expected 1 mocked API request/1 shell execute; got ${calls}/${executions}`)
    assert((await inspect()).editor?.fromAgent === false, 'Accepted ask retained command provenance for next NL input')
    await shot('ask-suggestion-after-execution')
    return { mockedApiRequests: calls, realShellExecutions: executions, handleBefore, handleAfter: suggestion.handleId, suggestion: compact(suggestion) }
  })
  await test('MOCK HTTP after accepted ask: next natural-language input routes to agent only', async () => {
    command = 'Write-Output "MOCK_NEXT_ASK"'
    const beforeRequests = agentRequests.length
    const beforeWire = (await wire()).sent.length
    const text = 'DETERMINISTIC MOCK ONLY next natural language question'
    await type(text); await key('Enter')
    await page.waitForFunction(() => window.__termInspect().editor?.buf === 'Write-Output "MOCK_NEXT_ASK"', undefined, { timeout: 5000 })
    const afterWire = (await wire()).sent.slice(beforeWire)
    assert(agentRequests.length - beforeRequests === 1, 'Next NL input did not make exactly one agent API request')
    assert(agentRequests.at(-1).body.text === text, 'Next NL input was changed or routed to wrong request')
    assert(afterWire.length === 0, `Next NL input unexpectedly sent ${afterWire.length} shell frame(s) before review`)
    await key('Enter'); await output('MOCK_NEXT_ASK')
    assert((await wire()).sent.filter((m) => m.d === `${command}\n`).length === 1, 'Accepted second suggestion did not execute exactly once')
    return { mockedApiRequests: 1, shellFramesBeforeReview: 0, realShellExecutionsAfterReview: 1 }
  })
  await test('MOCK HTTP agent exec: exactly one request and one execution', async () => {
    await page.getByRole('button', { name: 'ask', exact: true }).click()
    command = 'Write-Output "MOCK_EXEC_ONCE"'
    const before = agentRequests.length
    await type('DETERMINISTIC MOCK ONLY execute echo'); await key('Enter')
    await output('MOCK_EXEC_ONCE')
    const data = await wire()
    const calls = agentRequests.length - before
    const executions = data.sent.filter((m) => m.d === `${command}\n`).length
    assert(calls === 1 && executions === 1, `Expected 1/1 request/execution; got ${calls}/${executions}`)
    return { mockedApiRequests: calls, realShellExecutions: executions }
  })
  for (const run of ['exec', 'ask']) {
    await test(`MOCK inference + REAL shell: agent ${run} long-command Ctrl+C kills tree and recovers`, async () => {
      const toggle = run === 'ask' ? 'exec' : 'ask'
      if (await page.getByRole('button', { name: toggle, exact: true }).count()) {
        await page.getByRole('button', { name: toggle, exact: true }).click()
      }
      const tag = run.toUpperCase()
      const started = `AGENT_${tag}_STARTED`
      const forbidden = `FORBIDDEN_AGENT_${tag}_LATE`
      const recovered = `AGENT_${tag}_RECOVERED`
      command = `Write-Output "${started}"; Start-Sleep -Seconds 3; Write-Output "${forbidden}"`
      const longCommand = command
      const beforeRequests = agentRequests.length
      const before = await wire()
      await type(`DETERMINISTIC MOCK ONLY ${run} long local echo`); await key('Enter')
      if (run === 'ask') {
        await page.waitForFunction((value) => window.__termInspect().editor?.buf === value, command, { timeout: 5000 })
        await shot('ask-long-command-before-review')
        assert((await wire()).sent.length === before.sent.length, 'Long ask command executed before review')
        await key('Enter')
      }
      await output(started)
      const running = await inspect()
      assert(running.editor?.agent && !running.editor?.buf && !running.editor?.awaitingAgent,
        'Delivered command did not leave a settled, empty agent-mode editor')
      await key('Control+c')
      await page.waitForFunction((n) => window.__termSmoke.sockets.length === n + 1
        && window.__termSmoke.received.some((m) => m.n === n && m.ready === true)
        && window.__termInspect().editor?.live, before.sockets, { timeout: 12000 })
      await observe(3800)
      const after = await wire()
      const late = after.received.slice(before.received.length).filter((m) => typeof m.d === 'string' && m.d.includes(forbidden))
      const interrupts = after.sent.slice(before.sent.length).filter((m) => m.interrupt)
      const executions = after.sent.slice(before.sent.length).filter((m) => m.d === `${longCommand}\n`)
      assert(late.length === 0, `Agent ${run} Ctrl+C leaked ${late.length} late marker output frame(s)`)
      assert(interrupts.length === 1 && executions.length === 1, `Expected 1 interrupt/1 command, got ${interrupts.length}/${executions.length}`)
      assert(agentRequests.length - beforeRequests === 1, `Agent ${run} command did not use exactly one inference request`)
      assert((await inspect()).editor?.agent === true, 'Interrupt recovery unexpectedly disabled agent mode')
      command = `Write-Output "${recovered}"`
      await type(`DETERMINISTIC MOCK ONLY ${run} recovery echo`); await key('Enter')
      if (run === 'ask') {
        await page.waitForFunction((value) => window.__termInspect().editor?.buf === value, command, { timeout: 5000 })
        await key('Enter')
      }
      await output(recovered)
      assert(agentRequests.length - beforeRequests === 2, 'Recovery command was not routed through exactly one new inference')
      await shot(`real-agent-${run}-interrupt-recovered`)
      return { label: 'MOCK inference only; REAL keyboard, WS, PowerShell and process-tree interruption',
        inferenceRequests: 2, longCommandExecutions: executions.length, interruptFrames: interrupts.length,
        lateOutputFrames: late.length, socketsBefore: before.sockets, socketsAfter: after.sockets,
        agentModePreserved: true, recoveryOutput: recovered }
    })
  }
  if (await page.getByRole('button', { name: 'ask', exact: true }).count()) {
    await page.getByRole('button', { name: 'ask', exact: true }).click()
  }
  await test('MOCK delayed HTTP: real Ctrl+C discards late command', async () => {
    const before = await wire()
    holdAgent = true
    command = 'Write-Output "FORBIDDEN_CANCELLED_COMMAND"'
    await type('DETERMINISTIC MOCK ONLY pending request'); await key('Enter')
    for (let i = 0; i < 30 && !releaseAgent; i++) await observe(50)
    assert(!!releaseAgent, 'Delayed mock request did not arrive')
    await key('Control+c')
    holdAgent = false; releaseAgent?.(); releaseAgent = undefined
    await observe(400)
    const sent = (await wire()).sent.filter((m) => m.d?.includes('FORBIDDEN_CANCELLED_COMMAND'))
    assert(sent.length === 0, `Cancelled response executed ${sent.length} time(s)`)
    const after = await wire()
    assert(after.sockets === before.sockets, 'Canceling pending inference unnecessarily reset shell')
    assert(after.sent.slice(before.sent.length).filter((m) => m.interrupt).length === 0, 'Pending inference Ctrl+C incorrectly interrupted child')
    assert(!(await inspect()).editor?.buf.includes('FORBIDDEN_CANCELLED_COMMAND'), 'Cancelled response became an editable suggestion')
    await shot('mock-agent-cancelled')
    return { cancelledCommandExecutions: sent.length, cancelMethod: 'real Ctrl+C' }
  })
  holdAgent = false; releaseAgent?.(); releaseAgent = undefined
  await test('MOCK delayed HTTP: mode toggle discards late command', async () => {
    holdAgent = true
    command = 'Write-Output "FORBIDDEN_MODE_TOGGLE_COMMAND"'
    await type('DETERMINISTIC MOCK ONLY toggle while pending'); await key('Enter')
    for (let i = 0; i < 30 && !releaseAgent; i++) await observe(50)
    assert(!!releaseAgent, 'Delayed mode-toggle mock request did not arrive')
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    holdAgent = false; releaseAgent?.(); releaseAgent = undefined
    await observe(500)
    const sent = (await wire()).sent.filter((m) => m.d?.includes('FORBIDDEN_MODE_TOGGLE_COMMAND'))
    const state = await inspect()
    assert(sent.length === 0, `Mode-toggled response executed ${sent.length} time(s)`)
    assert(!state.editor?.agent && state.editor?.buf === '', 'Mode flip retained stale agent suggestion')
    await shot('mock-mode-toggle-cancelled')
    return { cancelledCommandExecutions: sent.length, state: compact(state) }
  })
  holdAgent = false; releaseAgent?.(); releaseAgent = undefined
  if (await page.getByRole('button', { name: 'Agent', exact: true }).getAttribute('aria-pressed') === 'true') {
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
  }
  await key('Control+u')
  await test('real WS: unexpected disconnect reconnects without replay', async () => {
    const before = await wire()
    await page.evaluate(() => window.__termSmoke.sockets.at(-1).close())
    await page.waitForFunction((n) => window.__termSmoke.sockets.length > n
      && window.__termSmoke.received.some((m) => m.n === n && m.ready === true)
      && window.__termInspect().editor?.live, before.sockets, { timeout: 15000 })
    await type('Write-Output "AFTER_RECONNECT"'); await key('Enter'); await output('AFTER_RECONNECT')
    const after = await wire()
    const fresh = after.sent.filter((m) => m.n >= before.sockets && typeof m.d === 'string')
    assert(fresh.length === 1 && fresh[0].d === 'Write-Output "AFTER_RECONNECT"\n', `Reconnected socket replayed old data: ${JSON.stringify(fresh)}`)
    return { socketsBefore: before.sockets, socketsAfter: after.sockets, fresh }
  })
  await test('real WS: clean exit does not respawn', async () => {
    const before = (await wire()).sockets
    await type('exit'); await key('Enter')
    await page.waitForFunction((n) => window.__termSmoke.received.some((m) => m.n === n && m.exit !== undefined && !m.interrupted), before - 1)
    await observe(1800)
    const after = (await wire()).sockets
    assert(before === after, `Clean exit unexpectedly spawned ${after - before} shell(s)`)
    return { before, after, buffer: await inspect() }
  })
  await test('real browser: terminal tab closes then reopens one fresh shell', async () => {
    const before = (await wire()).sockets
    const tab = page.getByRole('button', { name: '终端 1', exact: true })
    await tab.locator('..').getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '新建终端', exact: true }).first().click()
    await page.waitForFunction((n) => window.__termSmoke.sockets.length > n
      && window.__termSmoke.received.some((m) => m.n === n && m.ready === true)
      && window.__termInspect().editor?.live, before)
    await type('Write-Output "TAB_REOPENED"'); await key('Enter'); await output('TAB_REOPENED')
    const after = (await wire()).sockets
    assert(after === before + 1, `Expected exactly one reopened shell, got ${after - before}`)
    return { before, after }
  })
  await page.waitForFunction(() => window.__termInspect().text.trimEnd().endsWith('❯'))
  await shot('final-normal-terminal')
  const realWire = await wire()
  const realBuffer = compact(await inspect())
  await test('LABELLED deterministic PTY WS mock: raw shell has no client prompt corruption', async () => {
    const mock = await page.context().newPage()
    mock.on('pageerror', (error) => errors.push(`PTY_MOCK: ${error}`))
    await mock.addInitScript(instrument)
    await mock.addInitScript(() => {
      const Native = window.WebSocket
      class MockPty extends EventTarget {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
        readyState = 0
        constructor() {
          super()
          window.__termSmoke.sockets.push(this)
          setTimeout(() => {
            this.readyState = 1
            this.emit('open', new Event('open'))
            this.message({ shell: 'pty', hint: 'POSIX shell command', ready: true })
            this.message({ d: 'DETERMINISTIC PTY WS MOCK\r\nmock$ ' })
          }, 30)
        }
        emit(name, event) { this.dispatchEvent(event); this[`on${name}`]?.(event) }
        message(value) {
          window.__termSmoke.received.push(value)
          this.emit('message', new MessageEvent('message', { data: JSON.stringify(value) }))
        }
        send(raw) {
          const value = JSON.parse(raw)
          window.__termSmoke.sent.push(value)
          if (typeof value.d === 'string') this.message({ d: value.d })
        }
        close() { this.readyState = 3; this.emit('close', new CloseEvent('close', { code: 1000 })) }
      }
      window.WebSocket = class {
        static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
        constructor(url, protocols) { return String(url).includes('/ws/term') ? new MockPty() : new Native(url, protocols) }
      }
    })
    await mock.route('**/*', (route) => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'))
    await mock.goto(`${origin}/admin/glorious-pupil?tab=term`)
    await mock.waitForFunction(() => window.__termSmoke.received.some((m) => m.shell === 'pty'))
    await mock.locator('.xterm-helper-textarea').focus()
    await mock.keyboard.type('echo PTY_REAL_KEYS')
    await mock.keyboard.press('Home'); await mock.keyboard.press('End'); await mock.keyboard.press('Enter')
    await mock.waitForTimeout(650)
    const state = await mock.evaluate(() => ({ state: window.__termInspect(), sent: window.__termSmoke.sent }))
    assert(state.state.editor?.shell === 'pty' && state.state.editor?.live, 'Mock PTY ready/profile handshake did not reach editor')
    const screenshot = await shot('pty-mock', mock)
    await mock.close()
    const localPrompts = (state.state.text.match(/❯/g) ?? []).length
    assert(localPrompts === 0, `Raw PTY output corrupted by ${localPrompts} local ❯ prompt(s); screenshot ${screenshot}`)
    assert(state.sent.some((m) => m.d?.includes('\x1b')), 'PTY cursor keys were not passed through raw')
    return { label: 'DETERMINISTIC MOCK WS, REAL browser keyboard', ...state, screenshot }
  })
  const health = await page.evaluate(async () => {
    const h = await fetch('/api/health'); const s = await fetch('/api/_super/status')
    return { health: { status: h.status, body: await h.json() }, supervisor: { status: s.status, body: await s.json() } }
  })
  const summary = { time: new Date().toISOString(), round, prefix,
    label: 'REAL local browser + REAL local shell; deterministic MOCK term-agent HTTP and labelled PTY WS/onData chunks',
    passed: results.filter((r) => r.status === 'PASS').length, failed: results.filter((r) => r.status === 'FAIL').length,
    mockedAgentRequestCount: agentRequests.length, results, agentRequests, errors, consoleMessages, requestFailures, deniedNonlocal, assets, health,
    finalWire: realWire, finalBuffer: realBuffer, screenshots }
  // Keep machine-readable evidence in the page for extraction without requiring
  // filesystem/network access from the browser automation server process.
  await page.evaluate((value) => { window.__terminalSmokeReport = value }, summary)
  await reportPage.evaluate((value) => {
    window.__terminalSmokeReport = value
    ;(window.__terminalFinalReports ??= []).push(value)
  }, summary)
  await page.close()
  return { ...summary, finalWire: undefined, results: results.map(({ state, evidence, ...result }) => ({ ...result,
    editor: state?.editor, bufferTail: state?.text.slice(-500), evidence: evidence?.mockedApiRequests !== undefined ? evidence : undefined })) }
}
