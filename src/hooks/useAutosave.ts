import { useCallback, useEffect, useRef, useState } from 'react'
import { readAutosave, writeAutosave } from '../lib/autosaveStore'
import { getBridge, getFolderOf } from '../lib/bridge'
import { AUTOSAVE_FILE_NAME, AUTOSAVE_INTERVAL_MS } from '../lib/editorConstants'
import type { EmbedMode, ProjectFile } from '../lib/projectTypes'
import type { Photo } from '../types'

type Params = {
  photos: Photo[]
  buildProject: (embed: EmbedMode) => Promise<ProjectFile>
  restoreProject: (project: ProjectFile, label: string) => void
  openProject: () => Promise<void>
  setStatus: (message: string) => void
}

/** Autosave every 5 minutes, only when something changed. */
export function useAutosave(params: Params) {
  const paramsRef = useRef(params)
  paramsRef.current = params

  const [lastAutosave, setLastAutosave] = useState<{ time: string; target: string } | null>(null)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const recoveryCheckedRef = useRef(false)

  const markDirty = useCallback(() => {
    dirtyRef.current = true
  }, [])

  const runAutosave = useCallback(async () => {
    const { photos, buildProject, setStatus } = paramsRef.current
    if (!dirtyRef.current || savingRef.current || photos.length === 0) return
    savingRef.current = true
    dirtyRef.current = false
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

    try {
      const bridge = getBridge()
      // Save next to the photos: use the folder of the first photo that has a known folder.
      const dir = photos.map((photo) => getFolderOf(photo.path)).find((value): value is string => Boolean(value)) ?? null

      if (bridge?.autosaveProject && dir) {
        // 'unlinked': photos on disk are referenced by path, so the autosave file stays small.
        // Only photos without a known folder (e.g. dropped from the browser) are embedded.
        const result = await bridge.autosaveProject({
          dir,
          fileName: AUTOSAVE_FILE_NAME,
          project: await buildProject('unlinked'),
        })
        if (!result?.ok) throw new Error(result?.error ?? 'Autosave failed.')
        setLastAutosave({ time, target: result.filePath ?? dir })
      } else {
        // No desktop bridge or no known folder: keep a self-contained copy in browser storage.
        await writeAutosave({ savedAt: Date.now(), project: await buildProject('all') })
        setLastAutosave({ time, target: 'browser storage (photo folder unknown)' })
      }
    } catch (error) {
      dirtyRef.current = true // try again next tick
      setStatus(`Autosave failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    } finally {
      savingRef.current = false
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => void runAutosave(), AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [runAutosave])

  // Offer to recover a browser-storage autosave once on startup.
  useEffect(() => {
    if (recoveryCheckedRef.current) return
    recoveryCheckedRef.current = true
    readAutosave()
      .then((record) => {
        if (!record?.project?.photos?.length) return
        const when = new Date(record.savedAt).toLocaleString()
        if (window.confirm(`Recover the autosaved project from ${when} (${record.project.photos.length} photo(s))?`)) {
          try {
            paramsRef.current.restoreProject(record.project, 'Recovered autosave with')
          } catch (error) {
            paramsRef.current.setStatus(error instanceof Error ? error.message : 'Unable to recover the autosave.')
          }
        }
      })
      .catch(() => {})
  }, [])

  const recoverAutosave = useCallback(async () => {
    const { restoreProject, openProject, setStatus } = paramsRef.current
    try {
      const record = await readAutosave()
      if (record?.project?.photos?.length) {
        restoreProject(record.project, 'Recovered autosave with')
        return
      }
    } catch {
      // fall through to the hint below
    }

    if (getBridge()?.openProject) {
      setStatus(`Choose ${AUTOSAVE_FILE_NAME} from your photo folder to recover it.`)
      void openProject()
    } else {
      setStatus('No autosave found.')
    }
  }, [])

  return { lastAutosave, markDirty, recoverAutosave }
}
