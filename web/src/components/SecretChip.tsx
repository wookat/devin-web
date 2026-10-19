import { KeyGlyph } from './StructuredCards'

/**
 * Official `secrets` attachment pill (SecretChip, compact): 34px key tile,
 * 13px medium name, empty 12px subtitle line, max width 320px. Name only —
 * no value, request id or storage handle ever reaches this component.
 */
export default function SecretChip({ name }: { name: string }) {
  return (
    <div
      data-testid="attachment-secret"
      className="relative flex w-fit max-w-[320px] shrink-0 items-center gap-2 rounded-[10px] bg-tint-tertiary p-1.5 pr-[32px]"
    >
      <div className="flex size-[34px] shrink-0 items-center justify-center rounded-[6px] bg-tint-tertiary text-foreground">
        <KeyGlyph />
      </div>
      <div className="flex min-w-0 flex-col justify-center">
        <span className="truncate text-[13px] font-medium leading-[18px] text-foreground" title={name}>
          {name}
        </span>
        <span className="truncate text-[12px] font-normal leading-4 text-muted-foreground">&nbsp;</span>
      </div>
    </div>
  )
}
