export type Vec3 = [number, number, number]

export interface NodeOverlay {
  id: string
  name: string
  visible: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  children: NodeOverlay[]
}

export interface ProjectManifest {
  format: 'industrial-twin-project'
  version: 2
  projectId: string
  projectName: string
  modelFileName: string
  createdAt: string
  updatedAt: string
  overlay: NodeOverlay
  twin: TwinMetadata
}

export interface StoredProject extends ProjectManifest {
  modelBytes: ArrayBuffer
  externalAssetBytes?: Record<string, ArrayBuffer>
}

export type EquipmentKind = 'tank' | 'pump' | 'valve' | 'pipe' | 'instrument' | 'generic'
export type AlarmSeverity = 'critical' | 'warning' | 'info'

export interface SignalDefinition {
  id: string
  equipmentId: string
  name: string
  description: string
  dataType: 'number' | 'boolean'
  unit: string
  /** Source tag path, for example FactoryFloor.Line1.Pump02.Temperature. */
  sourceTag?: string
  semanticId?: string
  lowLimit?: number
  highLimit?: number
}

export interface AlarmRule {
  id: string
  signalId: string
  condition: 'above' | 'below'
  threshold: number
  clearThreshold?: number
  severity: AlarmSeverity
  message: string
  expression?: AlarmExpression
}

export type AlarmExpression = { all?: AlarmExpression[]; any?: AlarmExpression[]; signalId?: string; gt?: number; gte?: number; lt?: number; lte?: number; eq?: number | boolean }

export interface EquipmentDefinition {
  id: string
  nodeId: string
  tag: string
  name: string
  kind: EquipmentKind
  globalId?: string
  templateId?: string
  telemetryNamespace?: string
}

export interface TwinMetadata {
  equipment: EquipmentDefinition[]
  signals: SignalDefinition[]
  alarmRules: AlarmRule[]
  notes?: MaintenanceNote[]
}

export interface MaintenanceNote { id: string; assetId: string; nodeId: string; point: Vec3; text: string; createdAt: string; author: string; ticket?: string; attachmentName?: string; attachmentDataUrl?: string }
export interface HealthInsight { assetId: string; score: number; remainingHours?: number; anomalyScore: number; updatedAt: string; model: string; confidence?: number }

export interface SignalSnapshot {
  signalId: string
  value: number | boolean
  timestamp: string
  quality: 'good' | 'uncertain' | 'bad'
}

export interface TrendSample { timestamp: string; value: number }

export interface AlarmEvent {
  id: string
  ruleId: string
  signalId: string
  severity: AlarmSeverity
  message: string
  state: 'active' | 'cleared'
  raisedAt: string
  clearedAt?: string
  acknowledgedAt?: string
}

export const emptyTwin = (): TwinMetadata => ({ equipment: [], signals: [], alarmRules: [] })

export const makeNodeId = () => crypto.randomUUID()

export function createOverlay(object: import('three').Object3D): NodeOverlay {
  return {
    id: makeNodeId(), name: object.name || 'Object', visible: object.visible,
    position: object.position.toArray().slice(0, 3) as Vec3,
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z],
    children: object.children.map(createOverlay),
  }
}

