import { useRef, useState } from 'react'
import type { SignalDefinition } from './model'
import type { RawTelemetry } from './liveData'

type Props = { signals: SignalDefinition[]; onEvents: (events: RawTelemetry[]) => void }
const localInput = (date: Date) => { const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16) }

/** Queries the gateway edge historian and replays events at a controllable rate. */
export function HistoryBar({ signals, onEvents }: Props) {
  const [mode, setMode] = useState<'LIVE' | 'PLAYBACK'>('LIVE')
  const [start, setStart] = useState(localInput(new Date(Date.now() - 3600_000)))
  const [end, setEnd] = useState(localInput(new Date()))
  const [speed, setSpeed] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState('')
  const eventsRef = useRef<RawTelemetry[]>([])
  const timerRef = useRef<number | undefined>(undefined)
  const stop = () => { if (timerRef.current !== undefined) window.clearInterval(timerRef.current); timerRef.current = undefined; setPlaying(false) }
  const load = () => {
    const url = (import.meta.env.VITE_TELEMETRY_HISTORY_WS_URL || import.meta.env.VITE_TELEMETRY_WS_URL) as string | undefined
    if (!url) { setStatus('Configure the gateway WebSocket URL'); return }
    setMode('PLAYBACK'); stop(); setStatus('Loading history…')
    const socket = new WebSocket(url)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'history.query', requestId: crypto.randomUUID(), start: new Date(start).toISOString(), end: new Date(end).toISOString(), tags: signals.map((s) => s.sourceTag).filter(Boolean) }))
    socket.onmessage = (message) => {
      const response = JSON.parse(message.data)
      if (response.type === 'history.result') { eventsRef.current = response.events; setStatus(`${response.events.length} samples loaded`); socket.close() }
      if (response.type === 'error') { setStatus(response.message); socket.close() }
    }
    socket.onerror = () => setStatus('History connection failed')
  }
  const play = () => {
    if (!eventsRef.current.length) { setStatus('Choose a time range and load history'); return }
    stop(); setPlaying(true); let index = 0
    const tick = () => { if (index >= eventsRef.current.length) { stop(); setStatus('Playback complete'); return }
      const batch = [eventsRef.current[index++]]
      while (index < eventsRef.current.length && Date.parse(eventsRef.current[index].timestamp ?? '') - Date.parse(batch[0].timestamp ?? '') <= 1000 * speed) batch.push(eventsRef.current[index++])
      onEvents(batch)
    }
    tick(); timerRef.current = window.setInterval(tick, Math.max(50, 1000 / speed))
  }
  return <div className="history-bar"><button className={mode === 'LIVE' ? 'selected' : ''} onClick={() => { stop(); setMode('LIVE'); setStatus('Live stream') }}>LIVE</button><button className={mode === 'PLAYBACK' ? 'selected' : ''} onClick={() => setMode('PLAYBACK')}>HISTORICAL PLAYBACK</button><label>From<input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></label><label>To<input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></label><button onClick={load}>Load</button><select aria-label="Playback speed" value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 2, 5, 10].map((n) => <option key={n} value={n}>{n}×</option>)}</select><button onClick={playing ? stop : play}>{playing ? 'Pause' : 'Play'}</button><span>{status}</span></div>
}
