import type { SignalDefinition, SignalSnapshot } from './model'

export type RawTelemetry = { tag: string; value: number | boolean | string; timestamp?: string; quality?: SignalSnapshot['quality'] }
export type LiveConnection = { stop: () => void }

function normalizeValue(value: RawTelemetry['value'], signal: SignalDefinition): number | boolean | null {
  if (signal.dataType === 'boolean') {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (/^(true|1|on|running)$/i.test(value)) return true
    if (/^(false|0|off|stopped)$/i.test(value)) return false
    return null
  }
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** Route normalized raw tag events to their mapped twin signal IDs. */
export function mapTelemetry(events: RawTelemetry[], signals: SignalDefinition[]): Record<string, SignalSnapshot> {
  const byTag = new Map(signals.flatMap((signal) => signal.sourceTag ? [[signal.sourceTag, signal] as const] : []))
  const snapshots: Record<string, SignalSnapshot> = {}
  for (const event of events) {
    const signal = byTag.get(event.tag)
    if (!signal) continue
    const value = normalizeValue(event.value, signal)
    if (value === null) continue
    snapshots[signal.id] = { signalId: signal.id, value, timestamp: event.timestamp ?? new Date().toISOString(), quality: event.quality ?? 'good' }
  }
  return snapshots
}

export function connectLiveData(signals: SignalDefinition[], onData: (snapshots: Record<string, SignalSnapshot>) => void, onStatus: (connected: boolean) => void): LiveConnection {
  const wsUrl = import.meta.env.VITE_TELEMETRY_WS_URL as string | undefined
  const restUrl = import.meta.env.VITE_TELEMETRY_REST_URL as string | undefined
  let stopped = false
  let socket: WebSocket | undefined
  let polling: number | undefined
  const consume = (data: unknown) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data
      const events = Array.isArray(parsed) ? parsed : [parsed]
      const mapped = mapTelemetry(events as RawTelemetry[], signals)
      if (Object.keys(mapped).length) onData(mapped)
    } catch (error) { console.warn('Ignoring malformed telemetry event', error) }
  }
  if (wsUrl) {
    socket = new WebSocket(wsUrl)
    socket.onopen = () => onStatus(true)
    socket.onclose = () => { onStatus(false); if (!stopped && restUrl) startPolling() }
    socket.onerror = () => onStatus(false)
    socket.onmessage = (event) => consume(event.data)
  } else if (restUrl) startPolling()
  else onStatus(false)

  function startPolling() {
    if (!restUrl || polling !== undefined || stopped) return
    const poll = async () => {
      try {
        const response = await fetch(restUrl!, { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(`Telemetry REST returned ${response.status}`)
        consume(await response.json()); onStatus(true)
      } catch { onStatus(false) }
    }
    void poll()
    polling = window.setInterval(poll, 1000)
  }
  return { stop: () => { stopped = true; socket?.close(); if (polling !== undefined) window.clearInterval(polling) } }
}
