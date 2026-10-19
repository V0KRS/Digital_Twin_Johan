import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, Check, Radio, Waves } from 'lucide-react'
import type { AlarmEvent, EquipmentDefinition, SignalDefinition, SignalSnapshot, TrendSample } from './model'

type DockTab = 'signals' | 'alarms' | 'trends'
type Props = {
  signals: SignalDefinition[]
  equipment: EquipmentDefinition[]
  snapshots: Record<string, SignalSnapshot>
  history: Record<string, TrendSample[]>
  alarms: AlarmEvent[]
  running: boolean
  selectedSignalId: string | null
  onSelectSignal: (id: string) => void
  onAcknowledge: (ruleId: string) => void
}

function trendPoints(data: TrendSample[]) {
  if (!data.length) return ''
  const min = Math.min(...data.map((item) => item.value))
  const max = Math.max(...data.map((item) => item.value))
  const span = Math.max(max - min, 0.001)
  return data.map((item, index) => `${(index / Math.max(data.length - 1, 1)) * 560},${86 - ((item.value - min) / span) * 68}`).join(' ')
}

export function TelemetryDock({ signals, equipment, snapshots, history, alarms, running, selectedSignalId, onSelectSignal, onAcknowledge }: Props) {
  const [tab, setTab] = useState<DockTab>('signals')
  const [trendSignalId, setTrendSignalId] = useState(selectedSignalId ?? signals.find((signal) => signal.dataType === 'number')?.id ?? '')
  const [trendRange, setTrendRange] = useState<'1h' | '24h' | '7d'>('1h')
  const [historianSamples, setHistorianSamples] = useState<TrendSample[] | null>(null)
  const numericSignals = signals.filter((signal) => signal.dataType === 'number')
  const selectedTrend = numericSignals.find((signal) => signal.id === trendSignalId) ?? numericSignals[0]
  const activeCount = alarms.filter((alarm) => alarm.state === 'active').length
  const signalOwner = (signal: SignalDefinition) => equipment.find((item) => item.id === signal.equipmentId)
  const samples = historianSamples ?? (history[selectedTrend?.id ?? ''] ?? [])
  const values = samples.map((sample) => sample.value)
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  const deviation = values.length ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) : 0
  const outliers = values.filter((value) => deviation > 0 && Math.abs(value - mean) > 3 * deviation).length
  useEffect(() => {
    if (!selectedTrend) return
    const endpoint = import.meta.env.VITE_ANALYTICS_API_URL as string | undefined
    if (!endpoint || !selectedTrend.sourceTag) { setHistorianSamples(null); return }
    const end = new Date(); const start = new Date(end.getTime() - ({ '1h': 3600_000, '24h': 86400_000, '7d': 604800_000 }[trendRange]))
    let alive = true
    const url = `${endpoint}?tag=${encodeURIComponent(selectedTrend.sourceTag)}&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`
    fetch(url).then((response) => response.ok ? response.json() : Promise.reject(new Error('Trend endpoint unavailable'))).then((data: { events: Array<{ timestamp: string; value: number }> }) => { if (alive) setHistorianSamples(data.events.map((event) => ({ timestamp: event.timestamp, value: Number(event.value) }))) }).catch(() => { if (alive) setHistorianSamples(null) })
    return () => { alive = false }
  }, [selectedTrend, trendRange])

  return <section className="telemetry-dock">
    <div className="dock-head">
      <div className="dock-tabs">
        <button className={tab === 'signals' ? 'active' : ''} onClick={() => setTab('signals')}><Radio />Live signals<span>{signals.length}</span></button>
        <button className={tab === 'alarms' ? 'active' : ''} onClick={() => setTab('alarms')}><AlertTriangle />Alarm events{activeCount > 0 && <b>{activeCount}</b>}</button>
        <button className={tab === 'trends' ? 'active' : ''} onClick={() => setTab('trends')}><Activity />Trends</button>
      </div>
      <div className="simulation-controls"><span className="sim-badge"><i style={{ background: running ? '#78caa7' : '#dfb35e' }} />{running ? 'LIVE STREAM CONNECTED' : 'WAITING FOR LIVE DATA'}</span></div>
    </div>
    <div className="dock-content">
      {tab === 'signals' && <div className="signal-table-wrap">{signals.length ? <table className="signal-table"><thead><tr><th>TAG</th><th>DESCRIPTION</th><th>VALUE</th><th>QUALITY</th><th>UPDATED</th></tr></thead><tbody>{signals.map((signal) => { const snapshot = snapshots[signal.id]; const owner = signalOwner(signal); const value = snapshot?.value; const time = snapshot ? new Date(snapshot.timestamp).toLocaleTimeString() : '—'; return <tr key={signal.id} className={selectedSignalId === signal.id ? 'selected' : ''} onClick={() => onSelectSignal(signal.id)}><td><strong>{owner?.tag ?? 'TAG'}.{signal.name.replaceAll(' ', '_').toUpperCase()}</strong><small>{owner?.name ?? 'Unassigned asset'}</small></td><td>{signal.description}</td><td className="value-cell">{value === undefined ? '—' : typeof value === 'boolean' ? value ? 'RUNNING' : 'STOPPED' : `${value.toFixed(2)} ${signal.unit}`}</td><td><span className="quality"><i />{snapshot?.quality.toUpperCase() ?? 'WAITING'}</span></td><td className="time-cell">{time}</td></tr> })}</tbody></table> : <div className="dock-empty"><Waves /><strong>No signals configured</strong><span>Select an asset in the scene and assign an equipment type to create its signal set.</span></div>}</div>}
      {tab === 'alarms' && <div className="alarm-list">{alarms.length ? alarms.map((alarm) => { const signal = signals.find((item) => item.id === alarm.signalId); const owner = signal && signalOwner(signal); return <div className={`alarm-row ${alarm.severity} ${alarm.state}`} key={alarm.id}><span className="alarm-level">{alarm.severity.toUpperCase()}</span><div className="alarm-message"><strong>{alarm.message}</strong><span>{owner?.tag} · {signal?.name} · Raised {new Date(alarm.raisedAt).toLocaleTimeString()}{alarm.clearedAt ? ` · Cleared ${new Date(alarm.clearedAt).toLocaleTimeString()}` : ''}</span></div><span className={`alarm-state ${alarm.state}`}>{alarm.state.toUpperCase()}</span>{alarm.state === 'active' && !alarm.acknowledgedAt ? <button className="ack-button" onClick={() => onAcknowledge(alarm.ruleId)}><Check />Acknowledge</button> : alarm.acknowledgedAt ? <span className="acknowledged">ACK · {new Date(alarm.acknowledgedAt).toLocaleTimeString()}</span> : null}</div> }) : <div className="dock-empty"><Check /><strong>No alarm events</strong><span>Alarm rules are evaluated as mapped live values arrive.</span></div>}</div>}
      {tab === 'trends' && <div className="trend-view">{selectedTrend ? <><div className="trend-toolbar"><label>Signal<select value={selectedTrend.id} onChange={(event) => setTrendSignalId(event.target.value)}>{numericSignals.map((signal) => { const owner = signalOwner(signal); return <option key={signal.id} value={signal.id}>{owner?.tag ?? 'TAG'} · {signal.name}</option> })}</select></label><div className="range-tabs">{(['1h','24h','7d'] as const).map((range) => <button key={range} className={trendRange === range ? 'active' : ''} onClick={() => setTrendRange(range)}>{range}</button>)}</div><span>{samples.length} SAMPLES</span></div><div className="trend-chart"><div className="chart-grid"><i /><i /><i /><i /></div>{samples.length ? <svg viewBox="0 0 560 100" preserveAspectRatio="none"><polyline points={trendPoints(samples)} /></svg> : <div className="chart-wait">No samples in this range</div>}<div className="chart-unit">{selectedTrend.unit}</div></div><div className="trend-foot"><span><i />{selectedTrend.name.toUpperCase()}</span><strong>{snapshots[selectedTrend.id]?.value ?? '—'} {selectedTrend.unit}</strong><span>{snapshots[selectedTrend.id] ? new Date(snapshots[selectedTrend.id].timestamp).toLocaleTimeString() : 'No samples yet'}</span></div><div className="trend-stats"><span>MIN <b>{values.length ? Math.min(...values).toFixed(2) : '—'}</b></span><span>MAX <b>{values.length ? Math.max(...values).toFixed(2) : '—'}</b></span><span>MEAN <b>{values.length ? mean.toFixed(2) : '—'}</b></span><span>STD DEV <b>{values.length ? deviation.toFixed(2) : '—'}</b></span><span>OUTLIERS <b>{outliers}</b></span></div></> : <div className="dock-empty"><Activity /><strong>No numeric signals to trend</strong><span>Assign an equipment profile with numeric signals to start a local trend.</span></div>}</div>}
    </div>
  </section>
}
