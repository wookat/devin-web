import type { DashboardData, Widget } from '@/lib/api'
import { Card } from './ui'
import { timeAgo } from '@/lib/utils'

function Chart({ w }: { w: Extract<Widget, { type: 'chart' }> }) {
  const W = 560, H = 200, PAD = 30
  const all = w.series.flatMap((s) => s.points)
  if (all.length === 0) return <div className="text-sm text-muted-foreground">暂无数据</div>
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...ys, 0), ymax = Math.max(...ys)
  const sx = (x: number) => PAD + ((x - xmin) / (xmax - xmin || 1)) * (W - 2 * PAD)
  const sy = (y: number) => H - PAD - ((y - ymin) / (ymax - ymin || 1)) * (H - 2 * PAD)
  const colors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#06b6d4']
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#e2e8f0" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#e2e8f0" />
        <text x={PAD - 4} y={sy(ymax) + 4} fontSize={10} fill="#94a3b8" textAnchor="end">{ymax}</text>
        <text x={PAD - 4} y={sy(ymin) + 4} fontSize={10} fill="#94a3b8" textAnchor="end">{ymin}</text>
        {w.series.map((s, i) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={colors[i % colors.length]}
            strokeWidth={2}
            points={s.points.map((p) => `${sx(p[0])},${sy(p[1])}`).join(' ')}
          />
        ))}
      </svg>
      <div className="flex flex-wrap gap-3 mt-1">
        {w.series.map((s, i) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 rounded-full" style={{ background: colors[i % colors.length] }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  )
}

function WidgetCard({ w }: { w: Widget }) {
  return (
    <Card className={`p-4 ${w.type === 'table' || w.type === 'chart' || w.type === 'log' ? 'sm:col-span-2' : ''}`}>
      <div className="text-xs font-medium text-muted-foreground mb-2">{w.title}</div>
      {w.type === 'metric' && (
        <div className="text-3xl font-semibold tracking-tight">
          {w.value}
          {w.unit && <span className="text-base font-normal text-muted-foreground ml-1">{w.unit}</span>}
        </div>
      )}
      {w.type === 'progress' && (
        <div>
          <div className="flex justify-between text-sm mb-1.5">
            <span>{w.value ?? ''}</span>
            <span className="font-medium">{Math.round(w.percent)}%</span>
          </div>
          <div className="h-2.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, Math.max(0, w.percent))}%` }} />
          </div>
        </div>
      )}
      {w.type === 'table' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>{w.columns.map((col) => <th key={col} className="text-left font-medium text-muted-foreground border-b border-border px-2 py-1.5">{col}</th>)}</tr>
            </thead>
            <tbody>
              {w.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0">
                  {row.map((cell, j) => <td key={j} className="px-2 py-1.5">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {w.type === 'log' && (
        <pre className="bg-slate-900 text-slate-200 rounded-lg p-3 text-xs leading-relaxed overflow-x-auto max-h-64 overflow-y-auto">
          {w.lines.join('\n')}
        </pre>
      )}
      {w.type === 'chart' && <Chart w={w} />}
    </Card>
  )
}

export default function Dashboard({ data, updatedAt }: { data: DashboardData | null; updatedAt?: string }) {
  if (!data || !data.widgets?.length) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <div className="text-4xl mb-3">📊</div>
        <p className="text-sm">看板暂无内容</p>
        <p className="text-xs mt-1">AI 推送数据后将自动显示（每 3 秒刷新）</p>
      </div>
    )
  }
  return (
    <div>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-base font-semibold">{data.title || '看板'}</h2>
        <span className="text-xs text-muted-foreground">
          {data.updated || (updatedAt ? `更新于 ${timeAgo(updatedAt)}` : '')}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {data.widgets.map((w, i) => <WidgetCard key={i} w={w} />)}
      </div>
    </div>
  )
}
