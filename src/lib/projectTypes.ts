import type { SavedProject } from '../types'

/** The project file may carry a few fields beyond the shared SavedProject type. */
export type ProjectFile = SavedProject & { fillBlur?: boolean }

export type SavedPhoto = ProjectFile['photos'][number]

/** embed 'all'      -> every image is stored inside the file (self-contained).
 *  embed 'unlinked' -> only photos with no known folder are embedded; the rest are referenced by path.
 *  embed 'none'     -> paths only. */
export type EmbedMode = 'all' | 'unlinked' | 'none'

export type AutosaveRecord = { savedAt: number; project: ProjectFile }
