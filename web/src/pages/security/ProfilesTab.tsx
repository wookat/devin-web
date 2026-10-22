import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, MoreHorizontal, Pencil, Shield } from 'lucide-react'
import { EmptyPanel, ScanListSkeleton } from './atoms'
import type { Profile } from './atoms'

/* ---------- profiles tab — official rows ---------- */

function ProfileRowMenu({ p, onEdit, onDelete }: { p: Profile; onEdit: (p: Profile) => void; onDelete: (p: Profile) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  return (
    <div className="relative z-10" ref={ref}>
      <button aria-label={t('sec.profileActions')} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}
        className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100">
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-44 rounded-[8px] border border-border-secondary bg-background p-1 shadow-lg" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setOpen(false); onEdit(p) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Pencil size={13} />{t('sec.edit')}
          </button>
          <button onClick={() => { setOpen(false); onDelete(p) }} className="flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[13px] hover:bg-tint-secondary">
            <Archive size={13} />{t('sec.archive')}
          </button>
        </div>
      )}
    </div>
  )
}

export function ProfilesTab({ profiles, loading, searching, onCreate, onEdit, onDelete }: {
  profiles: Profile[]; loading: boolean; searching: boolean
  onCreate: (name: string, prompt: string) => void
  onEdit: (p: Profile, name: string, prompt: string) => void
  onDelete: (p: Profile) => void
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState<Profile | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const openForm = (p: Profile | null) => {
    setEditing(p); setName(p?.name ?? ''); setPrompt(p?.prompt ?? ''); setAdding(true)
  }
  if (loading) return <ScanListSkeleton />
  const form = adding && (
    <div className="mx-1 flex flex-col gap-2 rounded-[12px] bg-bg-elevated p-3">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('sec.profileName')} className="h-8 rounded-[6px] border border-border-secondary bg-background px-2 text-[13px] outline-none" />
      <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t('sec.profilePrompt')} rows={3} className="rounded-[6px] border border-border-secondary bg-background px-2 py-1.5 text-[13px] outline-none" />
      <div className="flex justify-end gap-2">
        <button onClick={() => setAdding(false)} className="h-7 rounded-[6px] px-2.5 text-[13px] text-muted-foreground hover:bg-tint-secondary">{t('sec.cancel')}</button>
        <button onClick={() => {
          if (!name.trim()) return
          if (editing) onEdit(editing, name.trim(), prompt.trim()); else onCreate(name.trim(), prompt.trim())
          setAdding(false); setEditing(null); setName(''); setPrompt('')
        }} className="h-7 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white">{t('sec.save')}</button>
      </div>
    </div>
  )
  if (profiles.length === 0 && !adding) {
    return (
      <>
        <div className="mx-1 flex justify-end">
          <button onClick={() => openForm(null)} className="flex h-7 items-center gap-1 rounded-[6px] bg-accent-primary px-2.5 text-[13px] font-medium text-white hover:opacity-90">{t('sec.createProfile')}</button>
        </div>
        <EmptyPanel title={searching ? t('sec.noMatchingProfiles') : t('sec.noProfilesYet')} hint={searching ? t('sec.tryDifferentSearch') : t('sec.createProfileDescription')} />
      </>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 pl-3.5 pr-2.5 text-12 font-medium leading-4 text-text-secondary">
          <span className="truncate">{t('sec.createdByYou')}</span>
          <span className="w-20 text-right">{t('sec.globs')}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          {profiles.map((p) => (
            <div key={p.id} className="group/row relative flex items-center gap-6 rounded-md py-2 pl-3.5 pr-2.5 hover:bg-tint-secondary">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Shield size={16} className="size-4 shrink-0 text-text-secondary" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-13 leading-[18px] text-text-primary">{p.name}</span>
                  </span>
                  {p.prompt && <span className="truncate text-12 leading-4 text-text-secondary">{p.prompt}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-1 whitespace-nowrap text-right text-13 leading-[18px]">
                <span className="min-w-0 flex-1 truncate text-text-disabled tabular-nums">0</span>
                <ProfileRowMenu p={p} onEdit={(pp) => openForm(pp)} onDelete={onDelete} />
              </div>
            </div>
          ))}
        </div>
      </div>
      {form}
    </div>
  )
}
