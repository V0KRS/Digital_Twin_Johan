import type { AlarmEvent, AlarmExpression, AlarmRule, EquipmentDefinition, EquipmentKind, SignalDefinition, SignalSnapshot, TrendSample, TwinMetadata } from './model'

type SignalTemplate = Pick<SignalDefinition, 'name' | 'description' | 'dataType' | 'unit' | 'lowLimit' | 'highLimit'>
const equipmentTemplates: Record<EquipmentKind, SignalTemplate[]> = {
  tank: [
    { name: 'Level', description: 'Vessel level measurement', dataType: 'number', unit: '%', lowLimit: 0, highLimit: 100 },
    { name: 'Inlet flow', description: 'Inlet volumetric flow', dataType: 'number', unit: 'm³/h', lowLimit: 0, highLimit: 100 },
    { name: 'Pressure', description: 'Vessel pressure', dataType: 'number', unit: 'bar', lowLimit: 0, highLimit: 10 },
  ],
  pump: [
    { name: 'Running', description: 'Motor run feedback', dataType: 'boolean', unit: '' },
    { name: 'Flow rate', description: 'Discharge volumetric flow', dataType: 'number', unit: 'm³/h', lowLimit: 0, highLimit: 100 },
    { name: 'Motor current', description: 'Motor phase current', dataType: 'number', unit: 'A', lowLimit: 0, highLimit: 25 },
  ],
  valve: [
    { name: 'Position', description: 'Valve travel feedback', dataType: 'number', unit: '%', lowLimit: 0, highLimit: 100 },
    { name: 'Commanded', description: 'Valve position demand', dataType: 'number', unit: '%', lowLimit: 0, highLimit: 100 },
  ],
  pipe: [
    { name: 'Flow rate', description: 'Line volumetric flow', dataType: 'number', unit: 'm³/h', lowLimit: 0, highLimit: 100 },
    { name: 'Line pressure', description: 'Line pressure measurement', dataType: 'number', unit: 'bar', lowLimit: 0, highLimit: 10 },
  ],
  instrument: [{ name: 'Process value', description: 'Instrument process value', dataType: 'number', unit: '°C', lowLimit: -20, highLimit: 120 }],
  generic: [{ name: 'Value', description: 'Process value', dataType: 'number', unit: '%', lowLimit: 0, highLimit: 100 }],
}

export function createEquipment(nodeId: string, nodeName: string, kind: EquipmentKind): { equipment: EquipmentDefinition; signals: SignalDefinition[]; rules: AlarmRule[] } {
  const equipmentId = crypto.randomUUID()
  const short = kind.toUpperCase().slice(0, 3)
  const namespaceName = nodeName.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^$/, 'asset')
  const telemetryNamespace = `factory/telemetry/${namespaceName}`
  const equipment: EquipmentDefinition = { id: equipmentId, nodeId, tag: `${short}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`, name: nodeName, kind, globalId: `https://plant.example.com/aas/${kind}/${crypto.randomUUID()}`, templateId: kind === 'pump' ? 'Centrifugal_Pump/1.0' : `${kind}/1.0`, telemetryNamespace }
  const templates: SignalTemplate[] = kind === 'pump' ? [
    { name: 'Temperature', description: 'Pump bearing temperature', dataType: 'number', unit: '°C', lowLimit: -20, highLimit: 120 },
    { name: 'Pressure', description: 'Pump discharge pressure', dataType: 'number', unit: 'bar', lowLimit: 0, highLimit: 25 },
    { name: 'Vibration', description: 'Pump vibration velocity', dataType: 'number', unit: 'mm/s', lowLimit: 0, highLimit: 20 },
  ] : equipmentTemplates[kind]
  const signals = templates.map((template): SignalDefinition => ({ ...template, id: crypto.randomUUID(), equipmentId, sourceTag: `${telemetryNamespace}/${template.name.toLowerCase().replaceAll(' ', '_')}`, semanticId: `urn:flux:property:${template.name.toLowerCase().replaceAll(' ', '-')}` }))
  const rules: AlarmRule[] = signals.flatMap((signal) => {
    if (signal.dataType !== 'number') return []
    const result: AlarmRule[] = []
    if (signal.name === 'Temperature') {
      result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'above', threshold: 75, clearThreshold: 72, severity: 'warning', message: `${signal.name} warning on ${equipment.tag}` })
      result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'above', threshold: 90, clearThreshold: 87, severity: 'critical', message: `${signal.name} critical on ${equipment.tag}` })
    } else if (signal.name === 'Vibration') {
      result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'above', threshold: 4.5, clearThreshold: 4, severity: 'warning', message: `${signal.name} warning on ${equipment.tag}` })
      result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'above', threshold: 7.1, clearThreshold: 6.5, severity: 'critical', message: `${signal.name} critical on ${equipment.tag}` })
    } else if (signal.highLimit !== undefined) result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'above', threshold: signal.name === 'Level' ? 90 : signal.highLimit * 0.88, severity: signal.name === 'Level' ? 'warning' : 'critical', message: `${signal.name} high on ${equipment.tag}` })
    if (signal.lowLimit !== undefined && ['Level', 'Flow rate'].includes(signal.name)) result.push({ id: crypto.randomUUID(), signalId: signal.id, condition: 'below', threshold: signal.name === 'Level' ? 12 : 0, severity: 'warning', message: `${signal.name} low on ${equipment.tag}` })
    return result
  })
  return { equipment, signals, rules }
}

export function evaluateAlarms(twin: TwinMetadata, snapshots: Record<string, SignalSnapshot>, previous: AlarmEvent[], timestamp: string): AlarmEvent[] {
  const next = previous.map((event) => ({ ...event }))
  for (const rule of twin.alarmRules) {
    const snapshot = snapshots[rule.signalId]
    if (rule.expression) {
      const breached = evaluateAlarmExpression(rule.expression, snapshots)
      const active = next.find((event) => event.ruleId === rule.id && event.state === 'active')
      if (breached && !active) next.unshift({ id: crypto.randomUUID(), ruleId: rule.id, signalId: rule.signalId, severity: rule.severity, message: rule.message, state: 'active', raisedAt: timestamp })
      else if (!breached && active) { active.state = 'cleared'; active.clearedAt = timestamp }
      continue
    }
    if (!snapshot || typeof snapshot.value !== 'number' || snapshot.quality === 'bad') continue
    const active = next.find((event) => event.ruleId === rule.id && event.state === 'active')
    const threshold = active && rule.clearThreshold !== undefined ? rule.clearThreshold : rule.threshold
    let breached = rule.condition === 'above' ? snapshot.value > threshold : snapshot.value < threshold
    if (rule.severity === 'warning') {
      const critical = twin.alarmRules.find((candidate) => candidate.signalId === rule.signalId && candidate.severity === 'critical' && candidate.condition === rule.condition)
      if (critical && (critical.condition === 'above' ? snapshot.value > critical.threshold : snapshot.value < critical.threshold)) breached = false
    }
    if (breached && !active) next.unshift({ id: crypto.randomUUID(), ruleId: rule.id, signalId: rule.signalId, severity: rule.severity, message: rule.message, state: 'active', raisedAt: timestamp })
    else if (!breached && active) { active.state = 'cleared'; active.clearedAt = timestamp }
  }
  return next.filter((event) => event.state === 'active' || Boolean(event.clearedAt && Date.parse(timestamp) - Date.parse(event.clearedAt) < 300_000)).slice(0, 100)
}

export function evaluateAlarmExpression(expression: AlarmExpression, snapshots: Record<string, SignalSnapshot>): boolean {
  if (expression.all && !expression.all.every((child) => evaluateAlarmExpression(child, snapshots))) return false
  if (expression.any && !expression.any.some((child) => evaluateAlarmExpression(child, snapshots))) return false
  if (expression.all || expression.any) return true
  if (!expression.signalId) return false
  const snapshot = snapshots[expression.signalId]
  if (!snapshot || snapshot.quality === 'bad') return false
  const value = snapshot.value
  return (expression.gt === undefined || Number(value) > expression.gt)
    && (expression.gte === undefined || Number(value) >= expression.gte)
    && (expression.lt === undefined || Number(value) < expression.lt)
    && (expression.lte === undefined || Number(value) <= expression.lte)
    && (expression.eq === undefined || value === expression.eq)
}

export function appendTrend(history: Record<string, TrendSample[]>, snapshots: Record<string, SignalSnapshot>): Record<string, TrendSample[]> {
  const next = { ...history }
  for (const [id, snapshot] of Object.entries(snapshots)) {
    if (typeof snapshot.value !== 'number' || snapshot.quality === 'bad') continue
    next[id] = [...(history[id] ?? []), { timestamp: snapshot.timestamp, value: snapshot.value }].slice(-90)
  }
  return next
}
