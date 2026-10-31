import { useCallback, useRef, type ChangeEvent } from 'react'
import type { AdjustmentSettings, PaperSizeKey, PresetKey } from '../engine/polaroidEngine'
import { getBridge, getFolderOf, toAppFileUrl } from '../lib/bridge'
import { NEUTRAL_SETTINGS } from '../lib/editorConstants'
import type { EmbedMode, ProjectFile, SavedPhoto } from '../lib/projectTypes'
import type { CropApplied, ExportFormat, ExportOrientation, Photo } from '../types'

/** Everything about the current editor state that goes into a project file. */
export type ProjectSnapshot = {
  settingsByPhoto: Record<number, AdjustmentSettings>
  cropAppliedByPhoto: Record<number, CropApplied | null>
  activeSettings: AdjustmentSettings
  selectedPhotoIndex: number
  preset: PresetKey
  paperSize: PaperSizeKey
  exportFormat: ExportFormat
  exportPageCount: number
  exportOrientation: ExportOrientation
  exportAutoRotate: boolean
  exportGridOffsetX: number
  exportGridOffsetY: number
  fillBlur: boolean
}

export type RestoredProject = {
  project: ProjectFile
  entries: Array<{ saved: SavedPhoto; photo: Photo }>
}

type Params = {
  photos: Photo[]
  snapshot: ProjectSnapshot
  nextPhotoId: () => number
  loadImageResource: (src: string) => Promise<HTMLImageElement>
  /** Called with the validated project; the editor applies it to its own state. */
  applyRestored: (restored: RestoredProject, label: string) => void
  setStatus: (message: string) => void
  setLastOutputDir: (dir: string | null) => void
}

export function useProject(params: Params) {
  // Always read the latest values, so the returned callbacks stay stable.
  const paramsRef = useRef(params)
  paramsRef.current = params

  const projectInputRef = useRef<HTMLInputElement>(null)

  const photoToDataUrl = useCallback(async (photo: Photo): Promise<string> => {
    if (photo.url.startsWith('data:')) return photo.url
    try {
      const response = await fetch(photo.url)
      if (!response.ok) throw new Error('fetch failed')
      const blob = await response.blob()
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error ?? new Error('Unable to read image data.'))
        reader.readAsDataURL(blob)
      })
    } catch {
      // Fallback for URLs fetch() can't read: re-encode from the decoded image.
      const image = await paramsRef.current.loadImageResource(photo.url)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      canvas.getContext('2d')?.drawImage(image, 0, 0)
      return canvas.toDataURL('image/jpeg', 0.95)
    }
  }, [])

  const buildProject = useCallback(
    async (embed: EmbedMode): Promise<ProjectFile> => {
      const { photos, snapshot } = paramsRef.current
      const savedPhotos = await Promise.all(
        photos.map(async (photo) => {
          const shouldEmbed = embed === 'all' || (embed === 'unlinked' && !getFolderOf(photo.path))
          return {
            name: photo.name,
            path: photo.path,
            ...(shouldEmbed ? { dataUrl: await photoToDataUrl(photo) } : {}),
            cropApplied: snapshot.cropAppliedByPhoto[photo.id] ?? null,
            settings: snapshot.settingsByPhoto[photo.id] ?? NEUTRAL_SETTINGS,
          }
        }),
      )

      return {
        version: 1,
        photos: savedPhotos,
        settings: snapshot.activeSettings,
        preset: snapshot.preset,
        paperSize: snapshot.paperSize,
        selectedPhotoIndex: snapshot.selectedPhotoIndex,
        exportFormat: snapshot.exportFormat,
        exportPageCount: snapshot.exportPageCount,
        exportOrientation: snapshot.exportOrientation,
        exportAutoRotate: snapshot.exportAutoRotate,
        exportGridOffsetX: snapshot.exportGridOffsetX,
        exportGridOffsetY: snapshot.exportGridOffsetY,
        fillBlur: snapshot.fillBlur,
      } as unknown as ProjectFile
    },
    [photoToDataUrl],
  )

  const restoreProject = useCallback((project: ProjectFile, label: string) => {
    if (!project || project.version !== 1 || !Array.isArray(project.photos)) {
      throw new Error('This file is not a supported Polaroid project.')
    }

    const { nextPhotoId, applyRestored } = paramsRef.current
    const entries = project.photos.map((saved, index) => {
      const path = saved.path ?? ''
      const url = saved.dataUrl || (getFolderOf(path) ? toAppFileUrl(path) : '')
      if (!url) {
        throw new Error(`The project is missing image data for ${saved.name || `photo ${index + 1}`}.`)
      }
      return { saved, photo: { id: nextPhotoId(), name: saved.name, path, url } as Photo }
    })

    applyRestored({ project, entries }, label)
  }, [])

  const handleSaveProject = useCallback(async () => {
    const { photos, setStatus, setLastOutputDir } = paramsRef.current
    if (photos.length === 0) {
      setStatus('Add at least one photo before saving a project.')
      return
    }

    try {
      const bridge = getBridge()
      if (bridge?.saveProject) {
        const result = await bridge.saveProject(await buildProject('all'))
        if (result.canceled) return
        if (!result.ok) throw new Error(result.error ?? 'Unable to save the project file.')
        setLastOutputDir(result.filePath ?? null)
        setStatus(`Project saved to ${result.filePath ?? 'file'}`)
        return
      }

      // Browser fallback: download a self-contained project file.
      setStatus('Preparing project file…')
      const project = await buildProject('all')
      const blob = new Blob([JSON.stringify(project)], { type: 'application/json' })
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const anchor = document.createElement('a')
      anchor.href = URL.createObjectURL(blob)
      anchor.download = `polaroid-project-${stamp}.polaroid.json`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(anchor.href), 1000)
      setStatus(`Project downloaded: ${anchor.download}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unable to save the project.')
    }
  }, [buildProject])

  const handleOpenProject = useCallback(async () => {
    const bridge = getBridge()
    if (!bridge?.openProject) {
      projectInputRef.current?.click()
      return
    }

    try {
      const result = await bridge.openProject()
      if (result.canceled) return
      if (result.error || !result.project) throw new Error(result.error ?? 'Unable to read the project file.')
      restoreProject(result.project as ProjectFile, 'Opened project with')
    } catch (error) {
      paramsRef.current.setStatus(error instanceof Error ? error.message : 'Unable to open the project.')
    }
  }, [restoreProject])

  const handleProjectFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0]
      event.target.value = ''
      if (!file) return
      try {
        restoreProject(JSON.parse(await file.text()) as ProjectFile, 'Opened project with')
      } catch (error) {
        paramsRef.current.setStatus(
          error instanceof SyntaxError
            ? 'That file is not a valid project file.'
            : error instanceof Error
              ? error.message
              : 'Unable to open the project.',
        )
      }
    },
    [restoreProject],
  )

  return {
    projectInputRef,
    buildProject,
    restoreProject,
    handleSaveProject,
    handleOpenProject,
    handleProjectFileSelected,
  }
}
