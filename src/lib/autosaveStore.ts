import type { AutosaveRecord } from './projectTypes'

/** Browser / no-folder fallback storage. */
const AUTOSAVE_DB_NAME = 'polaroid-editor'
const AUTOSAVE_STORE = 'projects'
const AUTOSAVE_KEY = 'autosave'

function openAutosaveDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(AUTOSAVE_DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(AUTOSAVE_STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open autosave storage.'))
  })
}

export async function writeAutosave(record: AutosaveRecord): Promise<void> {
  const db = await openAutosaveDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(AUTOSAVE_STORE, 'readwrite')
      tx.objectStore(AUTOSAVE_STORE).put(record, AUTOSAVE_KEY)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Autosave failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('Autosave failed.'))
    })
  } finally {
    db.close()
  }
}

export async function readAutosave(): Promise<AutosaveRecord | null> {
  const db = await openAutosaveDb()
  try {
    return await new Promise<AutosaveRecord | null>((resolve, reject) => {
      const request = db.transaction(AUTOSAVE_STORE, 'readonly').objectStore(AUTOSAVE_STORE).get(AUTOSAVE_KEY)
      request.onsuccess = () => resolve((request.result as AutosaveRecord | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error('Unable to read autosave.'))
    })
  } finally {
    db.close()
  }
}
