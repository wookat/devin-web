import { forwardRef, useEffect, useImperativeHandle, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { showPillTooltip } from '@/lib/pillTooltip'

// Official composer (Slate) renders selected mentions/secrets as inline void
// pills: contenteditable=false span, bg-tint-secondary, rounded, h-[19px],
// 16px leading icon, followed by editable text (sampled live from app.devin.ai).

import { filePillSvg } from './filePillIcons'

export type PillIcon = 'lock' | 'repo' | 'file' | 'session'

export interface ComposerEditorHandle {
  insertPill: (token: string, label: string, icon?: PillIcon, tooltip?: string) => void
  focus: () => void
}

function serialize(root: HTMLElement): string {
  let out = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent || ''
      return
    }
    if (node instanceof HTMLElement) {
      if (node.dataset.pill != null) {
        out += node.dataset.pill
        return
      }
      if (node.tagName === 'BR') {
        out += '\n'
        return
      }
      const isBlock = node.tagName === 'DIV' && node !== root
      if (isBlock && out && !out.endsWith('\n')) out += '\n'
      node.childNodes.forEach(walk)
    }
  }
  root.childNodes.forEach(walk)
  return out.replace(/\u00a0/g, ' ')
}

const LOCK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="self-center shrink-0" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>'

// GitHub mark (official repo pills lead with it, sampled from the live composer).
const REPO_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" class="self-center shrink-0" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M12 1.5C6.2 1.5 1.5 6.3 1.5 12.27c0 4.76 3.01 8.78 7.19 10.21.52.11.71-.23.71-.51 0-.25-.02-1.11-.02-2-2.92.64-3.53-1.28-3.53-1.28-.47-1.25-1.17-1.57-1.17-1.57-.95-.66.08-.66.08-.66 1.06.07 1.62 1.1 1.62 1.1.94 1.64 2.45 1.18 3.06.9.09-.7.37-1.18.66-1.45-2.33-.25-4.78-1.18-4.78-5.31 0-1.18.42-2.14 1.08-2.89-.1-.27-.47-1.37.11-2.85 0 0 .89-.29 2.89 1.1a9.9 9.9 0 0 1 5.26 0c2-1.39 2.89-1.1 2.89-1.1.58 1.48.21 2.58.11 2.85.67.75 1.08 1.71 1.08 2.89 0 4.13-2.45 5.05-4.8 5.31.38.34.71.98.71 2 0 1.45-.02 2.61-.02 2.97 0 .28.19.63.71.51a10.77 10.77 0 0 0 7.19-10.21C22.5 6.3 17.8 1.5 12 1.5Z"/></svg>'

const FILE_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="self-center shrink-0" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path></svg>'

const SESSION_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="self-center shrink-0" aria-hidden="true"><path d="M12 8V4H8"></path><rect width="16" height="12" x="4" y="8" rx="2"></rect><path d="M2 14h2"></path><path d="M20 14h2"></path><path d="M15 13v2"></path><path d="M9 13v2"></path></svg>'

const PILL_SVGS: Record<PillIcon, string> = { lock: LOCK_SVG, repo: REPO_SVG, file: FILE_SVG, session: SESSION_SVG }

function pillEl(token: string, label: string, icon: PillIcon, tooltip?: string): HTMLElement {
  const outer = document.createElement('span')
  outer.contentEditable = 'false'
  outer.dataset.pill = token
  if (tooltip) {
    let hide: (() => void) | null = null
    outer.addEventListener('mouseenter', () => {
      hide?.()
      hide = showPillTooltip(outer, tooltip)
    })
    outer.addEventListener('mouseleave', () => {
      hide?.()
      hide = null
    })
  }
  outer.className = 'inline-flex max-w-full items-baseline rounded align-baseline shadow-sm'
  const inner = document.createElement('span')
  inner.className =
    'inline-flex h-[19px] max-w-full items-baseline gap-1 overflow-hidden rounded bg-muted px-0.5 text-[14px] text-foreground'
  inner.innerHTML = icon === 'file' ? filePillSvg(label) : PILL_SVGS[icon]
  const txt = document.createElement('span')
  txt.className = 'truncate'
  txt.textContent = label
  inner.appendChild(txt)
  outer.appendChild(inner)
  return outer
}

const ComposerEditor = forwardRef<
  ComposerEditorHandle,
  {
    value: string
    onChange: (v: string) => void
    onKeyDown: (e: React.KeyboardEvent) => void
    placeholder: string
    /** Rich placeholder (e.g. official <kbd> chips); rendered over the empty editor instead of `placeholder`. */
    placeholderNode?: ReactNode
    className?: string
    onFiles?: (files: File[]) => void
    disabled?: boolean
  }
>(function ComposerEditor({ value, onChange, onKeyDown, placeholder, placeholderNode, className, onFiles, disabled = false }, ref) {
  const elRef = useRef<HTMLDivElement>(null)

  // External resets (send/queue clears input): rewrite DOM only when the
  // serialized content differs from the incoming value.
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    if (serialize(el) !== value) {
      el.textContent = value
      const sel = window.getSelection()
      if (sel && document.activeElement === el) {
        sel.selectAllChildren(el)
        sel.collapseToEnd()
      }
    }
  }, [value])

  useImperativeHandle(ref, () => ({
    focus: () => elRef.current?.focus(),
    insertPill: (token: string, label: string, icon: PillIcon = 'lock', tooltip?: string) => {
      const el = elRef.current
      if (!el) return
      el.focus()
      // Strip the trigger token (`$foo` / `@foo` ...) at the end of the last text node.
      const last = (function lastText(n: Node): Text | null {
        for (let i = n.childNodes.length - 1; i >= 0; i--) {
          const c = n.childNodes[i]
          if (c.nodeType === Node.TEXT_NODE) return c as Text
          const t = lastText(c)
          if (t) return t
        }
        return null
      })(el)
      if (last) {
        last.textContent = (last.textContent || '').replace(/[/!@$][\w\u4e00-\u9fff./-]*$/, '')
      }
      const pill = pillEl(token, label, icon, tooltip)
      const space = document.createTextNode('\u00a0')
      if (last?.parentNode) {
        last.parentNode.insertBefore(pill, last.nextSibling)
        last.parentNode.insertBefore(space, pill.nextSibling)
      } else {
        el.appendChild(pill)
        el.appendChild(space)
      }
      const sel = window.getSelection()
      if (sel) {
        const r = document.createRange()
        r.setStartAfter(space)
        r.collapse(true)
        sel.removeAllRanges()
        sel.addRange(r)
      }
      onChange(serialize(el))
    },
  }), [onChange])

  return (
    <div className="relative max-h-[250px] overflow-y-auto p-1">
      {placeholderNode != null && value === '' && (
        <div aria-hidden className="pointer-events-none absolute inset-0 select-none p-1 text-[14px] leading-[20px] text-muted-foreground">
          {placeholderNode}
        </div>
      )}
    <div
      ref={elRef}
      contentEditable={!disabled}
      role="textbox"
      aria-multiline="true"
      aria-label="Message Devin"
      data-placeholder={placeholderNode != null ? '' : placeholder}
      aria-placeholder={placeholder}
      onInput={() => { if (!disabled && elRef.current) onChange(serialize(elRef.current)) }}
      onKeyDown={onKeyDown}
      onPaste={(e) => {
        e.preventDefault()
        const files = [...e.clipboardData.files]
        if (files.length > 0 && onFiles) {
        if (!disabled) onFiles(files)
          return
        }
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        const files = [...e.dataTransfer.files]
        if (!disabled && files.length > 0) onFiles?.(files)
      }}
      className={cn(
        'composer-editor relative min-h-5 overflow-visible whitespace-pre-wrap break-words text-[14px] leading-[20px] outline-none',
        disabled && 'cursor-not-allowed opacity-60',
        'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]',
        className,
      )}
    />
    </div>
  )
})

export default ComposerEditor
