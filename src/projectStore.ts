import type { StoredProject } from './model'

const DB_NAME = 'forge-twin-workspace'
const STORE = 'projects'
const ACTIVE_KEY = 'active-project'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'projectId' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local project storage.'))
  })
}

export async function saveProject(project: StoredProject): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(project)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Could not save project.'))
  })
  localStorage.setItem(ACTIVE_KEY, project.projectId)
  db.close()
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const db = await openDb()
  const result = await new Promise<StoredProject | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(id)
    request.onsuccess = () => resolve(request.result as StoredProject | undefined)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return result
}

export async function getActiveProject(): Promise<StoredProject | undefined> {
  const id = localStorage.getItem(ACTIVE_KEY)
  return id ? getProject(id) : undefined
}

export async function listProjects(): Promise<StoredProject[]> {
  const db = await openDb()
  const result = await new Promise<StoredProject[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result as StoredProject[])
    request.onerror = () => reject(request.error)
  })
  db.close()
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function setActiveProject(id: string) { localStorage.setItem(ACTIVE_KEY, id) }
