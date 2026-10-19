import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { Grid, Html, OrbitControls, TransformControls } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { Box, ChevronDown, ChevronRight, Crosshair, Eye, EyeOff, FolderOpen, Grid2X2, Layers3, Maximize2, Move3D, Rotate3D, Save, Scan, Search, Settings2, Upload, ZoomIn, ZoomOut } from 'lucide-react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import type { AlarmEvent, EquipmentKind, HealthInsight, MaintenanceNote, NodeOverlay, ProjectManifest, SignalSnapshot, StoredProject, TrendSample, TwinMetadata, Vec3 } from './model'
import { createOverlay, emptyTwin } from './model'
import { getActiveProject, getProject, listProjects, saveProject, setActiveProject } from './projectStore'
import { appendTrend, createEquipment, evaluateAlarms } from './twinRuntime'
import { connectLiveData, mapTelemetry, type RawTelemetry } from './liveData'
import { HistoryBar } from './HistoryBar'
import { TelemetryDock } from './TelemetryDock'
import './TelemetryDock.css'
import './SceneTree.css'
import './App.css'

type SceneNode = { id: string; object: THREE.Object3D; name: string; children: SceneNode[] }
type Project = { manifest: ProjectManifest; bytes: ArrayBuffer; externalAssets: Record<string, ArrayBuffer> }
const v3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z]
const eulerVec = (v: THREE.Euler): Vec3 => [v.x, v.y, v.z]

function buildTree(object: THREE.Object3D, overlay: NodeOverlay): SceneNode {
  return { id: overlay.id, object, name: object.name, children: object.children.map((child, index) => buildTree(child, overlay.children[index] ?? createOverlay(child))) }
}
function flatten(tree: SceneNode | null): SceneNode[] { return tree ? [tree, ...tree.children.flatMap(flatten)] : [] }
function sceneLayer(node: SceneNode): string {
  const name = node.name.toLowerCase()
  if (/pipe|plumb|valve|pump|flow/.test(name)) return 'plumbing'
  if (/hvac|duct|vent|air/.test(name)) return 'hvac'
  if (/wall|concrete|foundation|column|beam|slab/.test(name)) return 'structure'
  return 'equipment'
}
function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    mesh.geometry?.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
    materials.forEach((material) => { Object.values(material).forEach((value) => { if (value instanceof THREE.Texture) value.dispose() }); material.dispose() })
  })
}
function applyOverlay(root: THREE.Object3D, overlay: NodeOverlay) {
  root.userData.overlayId = overlay.id
  root.name = overlay.name
  root.visible = overlay.visible ?? true
  root.position.fromArray(overlay.position)
  root.rotation.set(...overlay.rotation)
  root.scale.fromArray(overlay.scale)
  root.children.forEach((child, index) => { const childOverlay = overlay.children[index]; if (childOverlay) applyOverlay(child, childOverlay) })
}
function updateOverlay(root: THREE.Object3D, overlay: NodeOverlay): NodeOverlay {
  return { ...overlay, name: root.name, visible: root.userData.layerBaseVisible ?? root.visible, position: v3(root.position), rotation: eulerVec(root.rotation), scale: v3(root.scale), children: root.children.map((child, i) => updateOverlay(child, overlay.children[i] ?? createOverlay(child))) }
}
function makeManifest(projectName: string, modelFileName: string, overlay: NodeOverlay, existing?: ProjectManifest, twin: TwinMetadata = existing?.twin ?? emptyTwin()): ProjectManifest {
  const now = new Date().toISOString()
  return { format: 'industrial-twin-project', version: 2, projectId: existing?.projectId ?? crypto.randomUUID(), projectName, modelFileName, createdAt: existing?.createdAt ?? now, updatedAt: now, overlay, twin }
}

function createModelLoader(assets: Record<string, ArrayBuffer> = {}) {
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath(`${import.meta.env.BASE_URL}draco/gltf/`)
  loader.setDRACOLoader(draco)
  const urls = new Map<string, string>()
  loader.manager.setURLModifier((url) => {
    const path = decodeURIComponent(url.split(/[?#]/)[0]).replaceAll('\\', '/').replace(/^\.\//, '')
    const name = path.split('/').pop() ?? path
    const suffixMatches = Object.keys(assets).filter((key) => key.replaceAll('\\', '/').endsWith(`/${path}`) || key.replaceAll('\\', '/').endsWith(`/${name}`))
    const assetKey = assets[path] ? path : assets[name] ? name : suffixMatches.length === 1 ? suffixMatches[0] : undefined
    const bytes = assetKey ? assets[assetKey] : undefined
    if (!assetKey || !bytes) return url
    if (!urls.has(assetKey)) urls.set(assetKey, URL.createObjectURL(new Blob([bytes])))
    return urls.get(assetKey)!
  })
  return { loader, dispose: () => { urls.forEach((url) => URL.revokeObjectURL(url)); draco.dispose() } }
}

function SceneTreeRow({ node, selectedId, depth, onSelect, onToggleVisibility }: { node: SceneNode; selectedId: string | null; depth: number; onSelect: (id: string) => void; onToggleVisibility: (id: string) => void }) {
  const [expanded, setExpanded] = useState(depth === 0)
  return <>
    <div className={`tree-item ${node.id === selectedId ? 'selected' : ''}`} style={{ paddingLeft: 5 + depth * 13 }}>
      {node.children.length ? <button className="tree-expand" aria-label={expanded ? 'Collapse node' : 'Expand node'} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDown /> : <ChevronRight />}</button> : <span className="tree-expand-spacer" />}
      <button className="tree-select" onClick={() => onSelect(node.id)}>{node.object instanceof THREE.Mesh ? <Box className="node-icon mesh-icon" /> : <Layers3 className="node-icon" />}<span className="tree-name">{node.name}</span>{node.id === selectedId && <span className="tree-dot" />}</button>
      <button className={`tree-visibility ${node.object.visible ? '' : 'hidden'}`} title={node.object.visible ? 'Hide object' : 'Show object'} aria-label={node.object.visible ? 'Hide object' : 'Show object'} onClick={() => onToggleVisibility(node.id)}>{node.object.visible ? <Eye /> : <EyeOff />}</button>
    </div>
    {expanded && node.children.map((child) => <SceneTreeRow key={child.id} node={child} selectedId={selectedId} depth={depth + 1} onSelect={onSelect} onToggleVisibility={onToggleVisibility} />)}
  </>
}

function SceneModel({ root, selectedId, onSelect, onPin, onTransform, onFrame, mode, snap, notes, layerFilter }: { root: THREE.Object3D; selectedId: string | null; onSelect: (id: string) => void; onPin: (id: string, point: THREE.Vector3) => void; onTransform: () => void; onFrame: (center: THREE.Vector3) => void; mode: 'translate' | 'rotate' | 'scale'; snap: boolean; notes: MaintenanceNote[]; layerFilter: string }) {
  const camera = useThree((state) => state.camera)
  const selected = useMemo(() => { let result: THREE.Object3D | null = null; root.traverse((o) => { if (o.userData.overlayId === selectedId) result = o }); return result }, [root, selectedId])
  const helper = useMemo(() => selected ? new THREE.BoxHelper(selected, '#76e0bc') : null, [selected])
  useEffect(() => {
    root.updateWorldMatrix(true, true)
    const bounds = new THREE.Box3().setFromObject(root)
    if (bounds.isEmpty()) return
    const center = bounds.getCenter(new THREE.Vector3())
    const sphere = bounds.getBoundingSphere(new THREE.Sphere())
    const distance = Math.max(sphere.radius * 2.8, 2)
    const direction = new THREE.Vector3(1, 0.78, 1).normalize()
    // oxlint-disable react/immutability: Three.js camera mutation is required for initial framing.
    camera.position.copy(center).addScaledVector(direction, distance)
    // oxlint-disable-next-line react/immutability
    camera.near = Math.max(distance / 1000, 0.001)
    camera.far = Math.max(distance * 100, 1000)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    // oxlint-enable react/immutability
    onFrame(center)
  }, [root, camera, onFrame])
  useEffect(() => {
    root.traverse((object) => {
      const id = object.userData.overlayId
      if (!id) return
      if (object.userData.layerBaseVisible === undefined) object.userData.layerBaseVisible = object.visible
      const node = { id, name: object.name } as SceneNode
      object.visible = Boolean(object.userData.layerBaseVisible) && (layerFilter === 'all' || sceneLayer(node) === layerFilter)
    })
  }, [root, layerFilter])
  useFrame(() => { if (helper) helper.update() })
  useFrame(({ clock }) => {
    const intensity = 0.72 + (Math.sin(clock.elapsedTime * 5) + 1) * 0.38
    root.traverse((object) => {
      const mesh = object as THREE.Mesh
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      materials.forEach((material) => { if (material.userData.alarmOriginal && 'emissiveIntensity' in material) (material as THREE.MeshStandardMaterial).emissiveIntensity = intensity })
    })
  })
  return <>
    <primitive object={root} onClick={(event: { stopPropagation: () => void; object: THREE.Object3D }) => { event.stopPropagation(); let object: THREE.Object3D | null = event.object; while (object && !object.userData.overlayId) object = object.parent; if (object) onSelect(object.userData.overlayId) }} onDoubleClick={(event: { stopPropagation: () => void; object: THREE.Object3D; point: THREE.Vector3 }) => { event.stopPropagation(); let object: THREE.Object3D | null = event.object; while (object && !object.userData.overlayId) object = object.parent; if (object) onPin(object.userData.overlayId, root.worldToLocal(event.point.clone())) }} />
    {notes.map((note) => <Html key={note.id} position={note.point} center><span className="spatial-pin" title={note.text}>✎</span></Html>)}
    {helper && <primitive object={helper} />}
    {selected && <TransformControls object={selected} mode={mode} translationSnap={snap ? 0.1 : null} rotationSnap={snap ? THREE.MathUtils.degToRad(15) : null} scaleSnap={snap ? 0.1 : null} onObjectChange={onTransform} />}
  </>
}

function App() {
  const [project, setProject] = useState<Project | null>(null)
  const [root, setRoot] = useState<THREE.Object3D | null>(null)
  const [tree, setTree] = useState<SceneNode | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [projectList, setProjectList] = useState<StoredProject[]>([])
  const [showProjects, setShowProjects] = useState(false)
  const [viewportMode, setViewportMode] = useState<'orbit' | 'pan'>('orbit')
  const [toolMode, setToolMode] = useState<'translate' | 'rotate' | 'scale'>('translate')
  const [snap, setSnap] = useState(false)
  const [gridVisible, setGridVisible] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [twin, setTwin] = useState<TwinMetadata>(emptyTwin)
  const [snapshots, setSnapshots] = useState<Record<string, SignalSnapshot>>({})
  const [history, setHistory] = useState<Record<string, TrendSample[]>>({})
  const [alarmEvents, setAlarmEvents] = useState<AlarmEvent[]>([])
  const [liveConnected, setLiveConnected] = useState(false)
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const [modelSearch, setModelSearch] = useState('')
  const [noteAnchor, setNoteAnchor] = useState<{ nodeId: string; point: Vec3 } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [noteTicket, setNoteTicket] = useState('')
  const [layerFilter, setLayerFilter] = useState('all')
  const [noteAuthor, setNoteAuthor] = useState('Local operator')
  const [commandStatus, setCommandStatus] = useState('')
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [commandToken, setCommandToken] = useState('')
  const [noteAttachment, setNoteAttachment] = useState<{ name: string; dataUrl: string } | null>(null)
  const [healthInsight, setHealthInsight] = useState<HealthInsight | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const controlsRef = useRef<any>(null)
  const dirtyRef = useRef(false)
  const focusedAlarmRef = useRef<string | null>(null)
  const notificationSignatureRef = useRef('')
  const selected = useMemo(() => flatten(tree).find((n) => n.id === selectedId) ?? null, [tree, selectedId])
  const nodes = useMemo(() => flatten(tree), [tree])
  const activeProjectId = project?.manifest.projectId
  const selectedEquipment = twin.equipment.find((equipment) => equipment.nodeId === selectedId)
  const visibleNotes = (twin.notes ?? []).filter((note) => !selectedId || note.nodeId === selectedId)
  const selectedSignals = useMemo(() => twin.signals.filter((signal) => signal.equipmentId === selectedEquipment?.id), [twin.signals, selectedEquipment?.id])
  const healthValues = selectedSignals.flatMap((signal) => {
    const value = snapshots[signal.id]?.value
    if (typeof value !== 'number') return []
    if (/temperature/i.test(signal.name)) return [Math.max(0, Math.min(100, 100 - Math.max(0, value - 60) * 2.5))]
    if (/vibration/i.test(signal.name)) return [Math.max(0, Math.min(100, 100 - Math.max(0, value - 1) * 12))]
    return []
  })
  const healthScore = healthValues.length ? Math.round(healthValues.reduce((sum, value) => sum + value, 0) / healthValues.length) : null
  useEffect(() => {
    const endpoint = import.meta.env.VITE_NOTES_API_URL as string | undefined
    if (!endpoint || !selectedEquipment?.globalId) return
    let alive = true
    fetch(`${endpoint}?assetId=${encodeURIComponent(selectedEquipment.globalId)}`).then((response) => response.ok ? response.json() : Promise.reject(new Error('Notes API unavailable'))).then((data: { notes: MaintenanceNote[] }) => {
      if (!alive) return
      setTwin((previous) => {
        const existing = previous.notes ?? []
        const ids = new Set(existing.map((note) => note.id))
        const remote = data.notes.filter((note) => !ids.has(note.id))
        return remote.length ? { ...previous, notes: [...existing, ...remote] } : previous
      })
    }).catch(() => undefined)
    return () => { alive = false }
  }, [selectedEquipment?.globalId])
  useEffect(() => {
    if (!selectedEquipment) { setHealthInsight(null); return }
    const numericByName = Object.fromEntries(selectedSignals.map((signal) => [signal.name.toLowerCase(), snapshots[signal.id]?.value]))
    if (typeof numericByName.temperature !== 'number' || typeof numericByName.vibration !== 'number') { setHealthInsight(null); return }
    const features = { temperature: Number(numericByName.temperature ?? 25), vibration: Number(numericByName.vibration ?? 0), pressure: Number(numericByName.pressure ?? 0) }
    const endpoint = import.meta.env.VITE_HEALTH_API_URL as string | undefined
    if (!endpoint) { setHealthInsight(null); return }
    let alive = true
    const controller = new AbortController()
    const timer = window.setTimeout(() => { void fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assetId: selectedEquipment.globalId, ...features }), signal: controller.signal }).then((response) => { if (!response.ok) throw new Error('Health API unavailable'); return response.json() }).then((result: HealthInsight) => { if (alive) setHealthInsight({ ...result, assetId: selectedEquipment.globalId! }) }).catch(() => { if (alive) setHealthInsight(null) }) }, 300)
    return () => { alive = false; window.clearTimeout(timer); controller.abort() }
  }, [selectedEquipment, selectedSignals, snapshots])

  const installProject = useCallback(async (next: Project) => {
    setBusy(true); setError(''); setNotice('')
    try {
      const modelLoader = createModelLoader(next.externalAssets)
      let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>
      try { gltf = await modelLoader.loader.parseAsync(next.bytes, '') } finally { modelLoader.dispose() }
      const nextRoot = gltf.scene
      applyOverlay(nextRoot, next.manifest.overlay)
      setRoot(nextRoot)
      const normalizedManifest = { ...next.manifest, version: 2 as const, twin: next.manifest.twin ?? emptyTwin() }
      const externalAssets = next.externalAssets ?? {}
      setTree(buildTree(nextRoot, normalizedManifest.overlay)); setSelectedId(null); setProject({ ...next, manifest: normalizedManifest, externalAssets }); setTwin(normalizedManifest.twin); setSnapshots({}); setHistory({}); setAlarmEvents([]); dirtyRef.current = false; setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? `Could not load model: ${cause.message}` : 'Could not load this model.')
    } finally { setBusy(false) }
  }, [])

  useEffect(() => { let alive = true; getActiveProject().then(async (stored) => { if (!alive || !stored) return; await installProject({ manifest: stored, bytes: stored.modelBytes, externalAssets: stored.externalAssetBytes ?? {} }) }).catch((e) => setError(`Local project restore failed: ${String(e)}`)); return () => { alive = false } }, [installProject])
  useEffect(() => {
    const endpoint = import.meta.env.VITE_NOTIFICATIONS_API_URL as string | undefined
    if (!endpoint || !activeProjectId) return
    let alive = true
    fetch(`${endpoint}?projectId=${encodeURIComponent(activeProjectId)}`).then((response) => response.ok ? response.json() : Promise.reject(new Error('Notifications API unavailable'))).then((data: { notifications: AlarmEvent[] }) => {
      if (!alive) return
      setAlarmEvents((previous) => { const merged = new Map(data.notifications.map((event) => [event.id, event])); previous.forEach((event) => merged.set(event.id, { ...merged.get(event.id), ...event })); return [...merged.values()].sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt)).slice(0, 200) })
    }).catch(() => undefined)
    return () => { alive = false }
  }, [activeProjectId])
  useEffect(() => {
    const endpoint = import.meta.env.VITE_NOTIFICATIONS_API_URL as string | undefined
    if (!endpoint || !activeProjectId || !alarmEvents.length) return
    const signature = JSON.stringify(alarmEvents.map(({ id, state, acknowledgedAt, clearedAt }) => [id, state, acknowledgedAt, clearedAt]))
    if (signature === notificationSignatureRef.current) return
    notificationSignatureRef.current = signature
    for (const event of alarmEvents) void fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...event, projectId: activeProjectId }) }).catch(() => undefined)
  }, [activeProjectId, alarmEvents])
  useEffect(() => () => { if (root) disposeObject(root) }, [root])
  useEffect(() => {
    if (!activeProjectId || twin.signals.length === 0) { setLiveConnected(false); return }
    const connection = connectLiveData(twin.signals, (incoming) => {
      setSnapshots((previous) => {
        const next = { ...previous, ...incoming }
        setHistory((historyPrevious) => appendTrend(historyPrevious, incoming))
        setAlarmEvents((alarmPrevious) => evaluateAlarms(twin, next, alarmPrevious, new Date().toISOString()))
        return next
      })
    }, setLiveConnected)
    return () => connection.stop()
  }, [activeProjectId, twin])

  const updateSelected = (field: 'name' | 'position' | 'rotation' | 'scale', value: string | Vec3) => {
    if (!selected || !project) return
    // oxlint-disable-next-line react/immutability
    if (field === 'name') selected.object.name = value as string
    else if (field === 'position') selected.object.position.set((value as Vec3)[0], (value as Vec3)[1], (value as Vec3)[2])
    else if (field === 'rotation') { const v = (value as Vec3).map((d) => THREE.MathUtils.degToRad(d)) as Vec3; selected.object.rotation.set(v[0], v[1], v[2]) }
    else selected.object.scale.set((value as Vec3)[0], (value as Vec3)[1], (value as Vec3)[2])
    dirtyRef.current = true
    setDirty(true)
    if (field === 'name') setTwin((previous) => ({ ...previous, equipment: previous.equipment.map((item) => item.nodeId === selected.id ? { ...item, name: value as string } : item) }))
    setTree((t) => t ? { ...t } : null)
  }
  const selectNode = (id: string) => { setSelectedId(id); const node = nodes.find((n) => n.id === id); if (node && controlsRef.current) controlsRef.current.target.copy(node.object.getWorldPosition(new THREE.Vector3())) }
  const transformChanged = () => { if (!project || !root) return; dirtyRef.current = true; setDirty(true); setTree((t) => t ? { ...t } : null) }
  const toggleVisibility = (id: string) => { const node = nodes.find((item) => item.id === id); if (!node) return; const base = node.object.userData.layerBaseVisible ?? node.object.visible; node.object.userData.layerBaseVisible = !base; node.object.visible = layerFilter === 'all' ? !base : !base && sceneLayer(node) === layerFilter; dirtyRef.current = true; setDirty(true); setTree((current) => current ? { ...current } : null) }
  const frameObject = (object: THREE.Object3D) => {
    const controls = controlsRef.current
    const camera = controls?.object as THREE.PerspectiveCamera | undefined
    if (!controls || !camera) return
    const bounds = new THREE.Box3().setFromObject(object)
    if (bounds.isEmpty()) return
    const center = bounds.getCenter(new THREE.Vector3())
    const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1)
    const direction = camera.position.clone().sub(controls.target).normalize()
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.15
    controls.target.copy(center)
    camera.position.copy(center).addScaledVector(direction, distance)
    camera.near = Math.max(distance / 1000, 0.001)
    camera.far = Math.max(distance * 100, 1000)
    camera.updateProjectionMatrix()
    controls.update()
  }
  useEffect(() => {
    if (!root) return
    const activeEvents = alarmEvents.filter((event) => event.state === 'active')
    root.traverse((object) => {
      if (object.userData.xrayOriginalMaterial) {
        const previousMaterial = (object as THREE.Mesh).material
        const cloned = Array.isArray(previousMaterial) ? previousMaterial : [previousMaterial]
        cloned.forEach((material: THREE.Material) => material.dispose())
        ;(object as THREE.Mesh).material = object.userData.xrayOriginalMaterial
        delete object.userData.xrayOriginalMaterial
      }
      const mesh = object as THREE.Mesh
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
      for (const material of materials) if ('emissive' in material && material.userData.alarmOriginal) {
        const original = material.userData.alarmOriginal
        ;(material as THREE.MeshStandardMaterial).emissive.setHex(original.color); (material as THREE.MeshStandardMaterial).emissiveIntensity = original.intensity
        delete material.userData.alarmOriginal
      }
    })
    if (activeEvents.length) {
      const primarySignal = twin.signals.find((item) => item.id === activeEvents[0].signalId)
      const primaryEquipment = twin.equipment.find((item) => item.id === primarySignal?.equipmentId)
      const primaryNode = nodes.find((item) => item.id === primaryEquipment?.nodeId)
      if (primaryNode) root.traverse((object) => {
        if (object === primaryNode.object || primaryNode.object.getObjectById(object.id) || sceneLayer({ id: object.userData.overlayId, name: object.name } as SceneNode) !== 'structure') return
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || !mesh.material) return
        object.userData.xrayOriginalMaterial = mesh.material
        const glass = (material: THREE.Material) => { const clone = material.clone(); clone.transparent = true; clone.opacity = 0.18; clone.depthWrite = false; return clone }
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(glass) : glass(mesh.material)
      })
    }
    for (const event of activeEvents) {
      const signal = twin.signals.find((item) => item.id === event.signalId)
      const equipment = twin.equipment.find((item) => item.id === signal?.equipmentId)
      const node = nodes.find((item) => item.id === equipment?.nodeId)
      if (!node) continue
      node.object.traverse((object) => {
        const mesh = object as THREE.Mesh
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
        for (const material of materials) if ('emissive' in material) {
          const emissiveMaterial = material as THREE.MeshStandardMaterial
          if (!emissiveMaterial.userData.alarmOriginal) emissiveMaterial.userData.alarmOriginal = { color: emissiveMaterial.emissive.getHex(), intensity: emissiveMaterial.emissiveIntensity }
          emissiveMaterial.emissive.set(event.severity === 'critical' ? '#ff2419' : '#ffad27'); emissiveMaterial.emissiveIntensity = 1.1
        }
      })
      if (event.id !== focusedAlarmRef.current) { frameObject(node.object); focusedAlarmRef.current = event.id }
    }
  }, [alarmEvents, nodes, root, twin])
  const frameModel = useCallback((center: THREE.Vector3) => { if (controlsRef.current) { controlsRef.current.target.copy(center); controlsRef.current.update() } }, [])
  const zoomCamera = (factor: number) => {
    const controls = controlsRef.current
    if (!controls) return
    const camera = controls.object as THREE.Camera
    camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target)
    controls.update()
  }
  const assignEquipment = (kind: EquipmentKind) => {
    if (!selected || !project || twin.equipment.some((equipment) => equipment.nodeId === selected.id)) return
    const created = createEquipment(selected.id, selected.name, kind)
    setTwin((previous) => ({ equipment: [...previous.equipment, created.equipment], signals: [...previous.signals, ...created.signals], alarmRules: [...previous.alarmRules, ...created.rules] }))
    setDirty(true); dirtyRef.current = true
  }
  const updateSourceTag = (signalId: string, sourceTag: string) => {
    setTwin((previous) => ({ ...previous, signals: previous.signals.map((signal) => signal.id === signalId ? { ...signal, sourceTag } : signal) }))
    dirtyRef.current = true; setDirty(true)
  }
  const acknowledgeAlarm = (ruleId: string) => {
    const acknowledgedAt = new Date().toISOString()
    setAlarmEvents((previous) => previous.map((event) => event.ruleId === ruleId && event.state === 'active' ? { ...event, acknowledgedAt } : event))
  }
  const addSpatialNote = () => {
    if (!noteAnchor || !noteText.trim()) return
    const assetId = twin.equipment.find((equipment) => equipment.nodeId === noteAnchor.nodeId)?.globalId ?? `https://plant.example.com/aas/node/${noteAnchor.nodeId}`
    const note: MaintenanceNote = { id: crypto.randomUUID(), assetId, nodeId: noteAnchor.nodeId, point: noteAnchor.point, text: noteText.trim(), createdAt: new Date().toISOString(), author: noteAuthor, ticket: noteTicket || undefined, attachmentName: noteAttachment?.name, attachmentDataUrl: noteAttachment?.dataUrl }
    const notesApi = import.meta.env.VITE_NOTES_API_URL as string | undefined
    if (notesApi) void fetch(notesApi, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(note) }).catch(() => setNotice('Note saved to this project; notes service was unavailable.'))
    setTwin((previous) => ({ ...previous, notes: [...(previous.notes ?? []), note] })); setDirty(true); dirtyRef.current = true; setNoteText(''); setNoteTicket(''); setNoteAttachment(null); setNoteAnchor(null)
  }
  const sendCommand = async () => {
    if (!selectedEquipment?.globalId || !selectedEquipment.telemetryNamespace || !selectedEquipment.kind) { setCommandStatus('Assign a globally identified asset first.'); return }
    const wsUrl = import.meta.env.VITE_TELEMETRY_WS_URL as string | undefined
    if (!wsUrl) { setCommandStatus('Gateway WebSocket URL is not configured.'); return }
    setCommandStatus('Sending command…')
    const assetSlug = selectedEquipment.telemetryNamespace.split('/').pop() ?? selectedEquipment.tag.toLowerCase()
    const socket = new WebSocket(wsUrl)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'command', command: { token: commandToken, assetId: selectedEquipment.globalId, action: 'shutdown', topic: `factory/control/${assetSlug}/shutdown`, timestamp: new Date().toISOString() } }))
    socket.onmessage = (message) => { const reply = JSON.parse(message.data); setCommandStatus(reply.status ? `Broker receipt: ${reply.status}` : reply.message ?? 'Command rejected'); socket.close() }
    socket.onerror = () => setCommandStatus('Gateway command connection failed.')
  }
  const applyHistoricalEvents = (events: RawTelemetry[]) => {
    const incoming = mapTelemetry(events, twin.signals)
    if (!Object.keys(incoming).length) return
    setSnapshots((previous) => {
      const next = { ...previous, ...incoming }
      setHistory((historyPrevious) => appendTrend(historyPrevious, incoming))
      setAlarmEvents((alarmPrevious) => evaluateAlarms(twin, next, alarmPrevious, events.at(-1)?.timestamp ?? new Date().toISOString()))
      return next
    })
  }

  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return
    const selectedFiles = [...files]
    const modelFile = selectedFiles.find((f) => /\.glb$/i.test(f.name)) ?? selectedFiles.find((f) => /\.gltf$/i.test(f.name))
    if (!modelFile) { setError('Choose a .glb or .gltf model file.'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const externalEntries = await Promise.all(selectedFiles.filter((file) => file !== modelFile).map(async (file) => [file.webkitRelativePath || file.name, await file.arrayBuffer()] as const))
      const externalAssets: Record<string, ArrayBuffer> = {}
      for (const [path, data] of externalEntries) {
        if (Object.hasOwn(externalAssets, path)) throw new Error(`Two selected dependency files share the path “${path}”. Rename one file or import a self-contained GLB.`)
        externalAssets[path] = data
      }
      const bytes = await modelFile.arrayBuffer()
      const modelLoader = createModelLoader(externalAssets)
      let gltf: Awaited<ReturnType<GLTFLoader['parseAsync']>>
      try { gltf = await modelLoader.loader.parseAsync(bytes, '') } finally { modelLoader.dispose() }
      const treeOverlay = createOverlay(gltf.scene)
      const manifest = makeManifest(modelFile.name.replace(/\.(glb|gltf)$/i, ''), modelFile.name, treeOverlay, undefined, emptyTwin())
      const nextRoot = gltf.scene
      applyOverlay(nextRoot, treeOverlay)
      setRoot(nextRoot)
      const nextProject = { manifest, bytes, externalAssets }
      setProject(nextProject); setTwin(manifest.twin); setSnapshots({}); setHistory({}); setAlarmEvents([]); setTree(buildTree(nextRoot, treeOverlay)); setSelectedId(null); dirtyRef.current = true; setDirty(true)
      setNotice(`Imported ${modelFile.name}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Model import failed.') }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const save = useCallback(async () => {
    if (!project || !root) { setError('Import a model before saving a project.'); return }
    try {
      const manifest = makeManifest(project.manifest.projectName, project.manifest.modelFileName, updateOverlay(root, project.manifest.overlay), project.manifest, twin)
      await saveProject({ ...manifest, modelBytes: project.bytes, externalAssetBytes: project.externalAssets })
      setProject({ manifest, bytes: project.bytes, externalAssets: project.externalAssets }); dirtyRef.current = false; setDirty(false); setNotice('Project saved to this browser')
    } catch (cause) { setError(`Save failed: ${cause instanceof Error ? cause.message : String(cause)}`) }
  }, [project, root, twin])
  useEffect(() => {
    if (!dirty || !project || !root) return
    const timer = window.setTimeout(async () => {
      const manifest = makeManifest(project.manifest.projectName, project.manifest.modelFileName, updateOverlay(root, project.manifest.overlay), project.manifest, twin)
      try {
        await saveProject({ ...manifest, modelBytes: project.bytes, externalAssetBytes: project.externalAssets })
        setProject({ ...project, manifest }); dirtyRef.current = false; setDirty(false)
      } catch (cause) { setError(`Draft autosave failed: ${cause instanceof Error ? cause.message : String(cause)}`) }
    }, 900)
    return () => window.clearTimeout(timer)
  }, [dirty, project, root, twin])
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save() }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [save])
  const reopen = async (id: string) => { setShowProjects(false); try { const item = await getProject(id); if (item) { setActiveProject(id); await installProject({ manifest: item, bytes: item.modelBytes, externalAssets: item.externalAssetBytes ?? {} }) } } catch (e) { setError(`Could not reopen project: ${String(e)}`) } }
  const openProjectMenu = async () => { try { setProjectList(await listProjects()); setShowProjects((v) => !v) } catch (e) { setError(String(e)) } }
  const changeName = (name: string) => { if (!project) return; const manifest = { ...project.manifest, projectName: name, updatedAt: new Date().toISOString() }; setProject({ ...project, manifest }); dirtyRef.current = true; setDirty(true) }
  const changeNumber = (field: 'position' | 'rotation' | 'scale', index: number, value: string) => { if (!selected) return; const arr = field === 'position' ? v3(selected.object.position) : field === 'rotation' ? eulerVec(selected.object.rotation).map((d) => THREE.MathUtils.radToDeg(d)) as Vec3 : v3(selected.object.scale); arr[index] = Number(value) || 0; updateSelected(field, arr) }

  return <main className="workbench">
    <header className="topbar">
      <div className="brand"><div className="brand-mark"><span /><span /><span /></div><div><strong>FLUX<span> / </span>WORKS</strong><small>INDUSTRIAL TWIN STUDIO</small></div></div>
      <div className="project-heading"><div className="project-state"><i /> LOCAL PROJECT</div><input aria-label="Project name" value={project?.manifest.projectName ?? 'Untitled project'} onChange={(e) => changeName(e.target.value)} /></div>
      <div className="toolbar">
        <button className="tool-button" onClick={() => fileRef.current?.click()}><Upload /><span>Import model</span></button>
        <span className="toolbar-divider" />
        <button className="tool-button" onClick={openProjectMenu}><FolderOpen /><span>Reopen</span></button>
        <button className="tool-button save-button" onClick={save}><Save /><span>Save</span><kbd>⌘ S</kbd></button>
        <input ref={fileRef} className="file-input" type="file" multiple onChange={(e) => void importFiles(e.target.files)} />
        {showProjects && <div className="project-menu"><div className="menu-heading">SAVED PROJECTS</div>{projectList.length ? projectList.map((p) => <button key={p.projectId} className="saved-project" onClick={() => void reopen(p.projectId)}><span>{p.projectName}</span><small>{p.modelFileName}</small></button>) : <div className="menu-empty">No local projects saved yet.</div>}</div>}
      </div>
      <div className="notification-area"><button className="notification-button" onClick={() => setNotificationsOpen((value) => !value)}>Alerts <b>{alarmEvents.filter((alarm) => alarm.state === 'active').length}</b></button>{notificationsOpen && <div className="notification-menu"><strong>NOTIFICATION CENTER</strong>{alarmEvents.length ? alarmEvents.map((event) => <div key={event.id} className={`notification-entry ${event.severity}`}><b>{event.severity.toUpperCase()}</b><span>{event.message}</span><small>{new Date(event.raisedAt).toLocaleString()} · {event.state}</small></div>) : <small>No alarm notifications</small>}</div>}</div>
    </header>
    {error && <div className="alert error-alert"><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}
    {notice && !error && <div className="toast"><span className="toast-dot" />{notice}<button aria-label="Dismiss" onClick={() => setNotice('')}>×</button></div>}
    <div className="workspace">
      <aside className="panel hierarchy-panel">
        <div className="panel-header"><div><Layers3 /><h2>Scene</h2><span className="count-badge">{nodes.length || '—'}</span></div></div>
        <div className="scene-meta"><span className="live-dot" />{project ? project.manifest.modelFileName : 'No model loaded'}</div>
        <div className="tree-search"><Search /><input placeholder="Find object…" value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} /><kbd>⌘ F</kbd></div>
        <div className="layer-filters"><span>LAYERS</span>{[['all','All'],['structure','Structure'],['plumbing','Plumbing'],['hvac','HVAC'],['equipment','Equipment']].map(([value,label]) => <button key={value} className={layerFilter === value ? 'active' : ''} onClick={() => setLayerFilter(value)}>{label}</button>)}</div>
        <div className="tree-list">{tree ? layerFilter !== 'all' || modelSearch ? nodes.filter((n) => (layerFilter === 'all' || sceneLayer(n) === layerFilter) && n.name.toLowerCase().includes(modelSearch.toLowerCase())).map((n) => <SceneTreeRow key={n.id} node={n} selectedId={selectedId} depth={0} onSelect={selectNode} onToggleVisibility={toggleVisibility} />) : <SceneTreeRow node={tree} selectedId={selectedId} depth={0} onSelect={selectNode} onToggleVisibility={toggleVisibility} /> : <div className="tree-empty"><div className="empty-icon"><Layers3 /></div><strong>Your scene is empty</strong><span>Import a GLB or glTF model to<br />start building your twin.</span><button onClick={() => fileRef.current?.click()}><Upload />Import a model</button></div>}</div>
        <div className="panel-footer"><span>SCENE GRAPH</span></div>
      </aside>

      <section className="viewport-shell">
        <div className="viewport-top"><div className="view-tabs"><button className="active"><Box />3D View</button><span className="view-separator" /><span className="view-caption">PERSPECTIVE</span></div><div className="view-actions"><span className="fps"><i /> REALTIME</span><button title="Frame selection" onClick={() => selected && frameObject(selected.object)}><Crosshair /></button><button title={gridVisible ? 'Hide grid' : 'Show grid'} className={gridVisible ? 'active-action' : ''} onClick={() => setGridVisible((visible) => !visible)}><Grid2X2 /></button></div></div>
        <div className="viewport">
          <div className="viewport-watermark"><span>FLUX</span><i> / </i>3D WORKSPACE</div><div className="axis-widget"><div className="axis axis-y">Y</div><div className="axis axis-x">X</div><div className="axis axis-z">Z</div><div className="axis-center" /></div>
          <Canvas camera={{ position: [7, 5, 8], fov: 42 }} onCreated={({ gl }) => { gl.setClearColor('#111820'); gl.toneMapping = THREE.ACESFilmicToneMapping }}>
            <ambientLight intensity={1.2} /><directionalLight position={[8, 12, 7]} intensity={2.4} castShadow /><directionalLight position={[-6, 4, -5]} intensity={0.8} />
            {gridVisible && <Grid position={[0, -0.015, 0]} args={[40, 40]} cellSize={1} cellThickness={0.6} cellColor="#26343b" sectionSize={5} sectionThickness={1} sectionColor="#354a50" fadeDistance={32} infiniteGrid />}
            {root ? <Suspense fallback={<Html center><div className="loading-pill">Loading geometry…</div></Html>}><SceneModel root={root} selectedId={selectedId} onSelect={selectNode} onPin={(nodeId, point) => setNoteAnchor({ nodeId, point: v3(point) })} onTransform={transformChanged} onFrame={frameModel} mode={toolMode} snap={snap} notes={visibleNotes} layerFilter={layerFilter} /></Suspense> : <Html center><div className="viewport-empty"><div className="empty-cube"><Box /></div><strong>Bring your model into view</strong><span>Import a 3D model to begin exploring<br />your industrial asset.</span><button onClick={() => fileRef.current?.click()}><Upload />Import model</button><small>GLB · glTF supported</small></div></Html>}
            <OrbitControls ref={controlsRef} makeDefault enableDamping mouseButtons={viewportMode === 'pan' ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }} />
          </Canvas>
          {busy && <div className="loading-overlay"><div className="spinner" /><span>Preparing model…</span></div>}
          <div className="viewport-bottom"><span><i className="status-dot" />{root ? 'MODEL READY' : 'READY'}</span><span>{root ? `${nodes.length} OBJECTS` : 'AWAITING MODEL'}</span></div>
          <div className="viewport-tools"><button title="Orbit" className={viewportMode === 'orbit' ? 'selected' : ''} onClick={() => setViewportMode('orbit')}><Rotate3D /></button><button title="Pan" className={viewportMode === 'pan' ? 'selected' : ''} onClick={() => setViewportMode('pan')}><Move3D /></button><span /><button title="Zoom in" onClick={() => zoomCamera(0.86)}><ZoomIn /></button><button title="Zoom out" onClick={() => zoomCamera(1.16)}><ZoomOut /></button><button title="Fit model" onClick={() => root && frameObject(root)}><Maximize2 /></button></div>
        </div>
        <TelemetryDock
          signals={twin.signals}
          equipment={twin.equipment}
          snapshots={snapshots}
          history={history}
          alarms={alarmEvents}
          running={liveConnected}
          selectedSignalId={selectedSignalId}
          onSelectSignal={(id) => { setSelectedSignalId(id); const signal = twin.signals.find((item) => item.id === id); const owner = twin.equipment.find((item) => item.id === signal?.equipmentId); if (owner) selectNode(owner.nodeId) }}
          onAcknowledge={acknowledgeAlarm}
        />
        <div className="timeline-bar"><div className="timeline-left"><span className="timeline-label">WORKSPACE</span><span className="timeline-divider" /><span className="timeline-info">{project ? project.manifest.projectName : 'New scene'}</span></div><div className="timeline-center"><span className="timeline-icon"><Scan /></span><span>DESIGN MODE</span><span className="timeline-sep">/</span><span>TRANSFORM TOOLS</span></div><div className="timeline-right"><span>WORLD UNITS</span><strong>METERS</strong></div></div>
        <HistoryBar signals={twin.signals} onEvents={applyHistoricalEvents} />
      </section>

      <aside className="panel inspector-panel">
        <div className="panel-header"><div><Settings2 /><h2>Properties</h2></div></div>
        {selected ? <><div className="selection-card"><div className="selection-icon"><Box /></div><div className="selection-label"><span>SELECTED OBJECT</span><strong>{selected.name}</strong></div><span className="selection-type">{selected.object.type.toUpperCase()}</span></div>
          <div className="property-section"><div className="section-title"><span>IDENTITY</span><span className="section-line" /></div><label className="field-label">Display name</label><input className="text-field" value={selected.name} onChange={(e) => updateSelected('name', e.target.value)} />{selectedEquipment && <><label className="field-label identity-id-label">Global asset IRI</label><small className="identity-id">{selectedEquipment.globalId}</small><small className="identity-id">AAS template · {selectedEquipment.templateId}</small></>}</div>
          <div className="property-section equipment-section"><div className="section-title"><span>EQUIPMENT</span><span className="section-line" /></div>{selectedEquipment ? <><div className="equipment-summary"><span className={`equipment-glyph ${selectedEquipment.kind}`}><Box /></span><span><strong>{selectedEquipment.tag}</strong><small>{selectedEquipment.kind.toUpperCase()} · LIVE MAPPING</small></span></div><div className="equipment-tags">{twin.signals.filter((signal) => signal.equipmentId === selectedEquipment.id).map((signal) => <div key={signal.id} className="equipment-mapping"><button className={selectedSignalId === signal.id ? 'active' : ''} onClick={() => setSelectedSignalId(signal.id)}><span>{signal.name}</span><strong>{typeof snapshots[signal.id]?.value === 'boolean' ? snapshots[signal.id]?.value ? 'RUN' : 'STOP' : snapshots[signal.id] ? `${snapshots[signal.id].value} ${signal.unit}` : '—'}</strong></button><input aria-label={`${signal.name} source tag`} placeholder="Raw source tag path" value={signal.sourceTag ?? ''} onChange={(event) => updateSourceTag(signal.id, event.target.value)} /></div>)}</div></> : <><p className="equipment-hint">Map this scene node to an equipment profile to add typed process signals.</p><select className="equipment-select" defaultValue="" onChange={(e) => { if (e.target.value) assignEquipment(e.target.value as EquipmentKind); e.target.value = '' }}><option value="" disabled>Assign equipment profile…</option><option value="tank">Storage tank</option><option value="pump">Centrifugal pump</option><option value="valve">Control valve</option><option value="pipe">Process line</option><option value="instrument">Field instrument</option><option value="generic">Generic asset</option></select></>}</div>
          {selectedEquipment && <div className="property-section health-section"><div className="section-title"><span>ASSET HEALTH</span><span className="section-line" /></div><div className="health-score"><strong>{healthInsight?.score ?? (healthScore === null ? '—' : `${healthScore}%`)}</strong><span>{healthInsight ? `${healthInsight.model} · CONFIDENCE ${Math.round((healthInsight.confidence ?? 0) * 100)}%` : 'HEURISTIC HEALTH INDEX'}</span></div><small>Estimate: {healthInsight?.remainingHours ? `${healthInsight.remainingHours} operating hours to service threshold` : healthScore === null ? 'awaiting temperature and vibration data' : `${Math.max(1, Math.round((healthScore / Math.max(1, 100 - healthScore)) * 500))} operating hours to service threshold`}</small><input className="text-field" type="password" value={commandToken} onChange={(event) => setCommandToken(event.target.value)} placeholder="Signed operator JWT" /><button className="command-button" onClick={() => void sendCommand()}>Dispatch shutdown command</button><small>{commandStatus || 'Requires a valid operator JWT, asset grant, and gateway allow-list.'}</small></div>}
          <div className="property-section notes-section"><div className="section-title"><span>MAINTENANCE NOTES</span><span className="section-line" /></div><small className="pin-help">Double-click a mesh surface to place an anchor pin.</small>{noteAnchor?.nodeId === selectedId && <><input className="text-field" value={noteAuthor} onChange={(event) => setNoteAuthor(event.target.value)} placeholder="Author" /><textarea className="note-input" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Maintenance note…" /><input className="text-field" value={noteTicket} onChange={(e) => setNoteTicket(e.target.value)} placeholder="Repair ticket ID (optional)" /><input type="file" accept="application/pdf" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; const reader = new FileReader(); reader.onload = () => setNoteAttachment({ name: file.name, dataUrl: String(reader.result) }); reader.readAsDataURL(file) }} /><button className="note-save" onClick={addSpatialNote}>Save anchored note</button></>}{visibleNotes.map((note) => <div className="saved-note" key={note.id}><b>{note.author}</b><span>{note.text}</span>{note.attachmentDataUrl && <a href={note.attachmentDataUrl} download={note.attachmentName}>{note.attachmentName ?? 'Open PDF manual'}</a>}<small>{note.ticket ? `Ticket ${note.ticket} · ` : ''}{new Date(note.createdAt).toLocaleDateString()}</small></div>)}</div>
          <div className="property-section transform-section"><div className="section-title"><span>TRANSFORM</span><span className="section-line" /><button className={`snap-button ${snap ? 'on' : ''}`} onClick={() => setSnap(!snap)} title="Toggle snap"><Crosshair /></button></div><div className="mode-tabs">{(['translate', 'rotate', 'scale'] as const).map((mode) => <button key={mode} className={toolMode === mode ? 'active' : ''} onClick={() => setToolMode(mode)}>{mode === 'translate' ? <Move3D /> : mode === 'rotate' ? <Rotate3D /> : <Maximize2 />}{mode}</button>)}</div>{(['position', 'rotation', 'scale'] as const).map((field) => { const vals = field === 'position' ? v3(selected.object.position) : field === 'rotation' ? eulerVec(selected.object.rotation).map((d) => THREE.MathUtils.radToDeg(d)) as Vec3 : v3(selected.object.scale); return <div className="vector-field" key={field}><div className="vector-label">{field}<span>{field === 'rotation' ? '°' : field === 'position' ? 'm' : '×'}</span></div><div className="vector-inputs">{vals.map((value, i) => <label key={i} className={`axis-input axis-input-${'xyz'[i]}`}><span>{'XYZ'[i]}</span><input type="number" step={snap ? field === 'rotation' ? 15 : 0.1 : 'any'} value={Number(value.toFixed(3))} onChange={(e) => changeNumber(field, i, e.target.value)} /></label>)}</div></div> })}</div>
          <div className="object-info"><div className="section-title"><span>OBJECT INFO</span><span className="section-line" /></div><div><span>TYPE</span><strong>{selected.object.type}</strong></div><div><span>CHILDREN</span><strong>{selected.children.length}</strong></div><div><span>UUID</span><strong className="uuid">{selected.object.uuid.slice(0, 13)}…</strong></div></div>
        </> : <div className="inspector-empty"><div><Settings2 /></div><strong>Nothing selected</strong><span>Select an object in the scene tree<br />or viewport to inspect its properties.</span></div>}
        <div className="inspector-bottom"><span className="inspector-dot" />{dirty ? 'UNSAVED CHANGES' : 'ALL CHANGES SAVED'}</div>
      </aside>
    </div>
    <footer className="statusbar"><div className="status-left"><span className="online-mark" />WORKSPACE ONLINE<span className="status-divider" />{project ? <><span className="model-chip"><Box />{project.manifest.modelFileName}</span><span className="status-divider" /><span>{nodes.length} NODES</span></> : <span>NO ACTIVE MODEL</span>}</div><div className="status-right"><span>{selected ? selected.name : 'No selection'}</span><span className="status-divider" /><span>FLUX WORKS <b>0.1.0</b></span></div></footer>
    {busy && <div className="global-busy" aria-live="polite"><span className="spinner" />{project ? 'Restoring local project…' : 'Loading model…'}</div>}
  </main>
}

export default App


