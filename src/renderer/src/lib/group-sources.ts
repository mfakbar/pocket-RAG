import type { Citation } from '../../../shared/contracts'

export interface SourceFileGroup {
  file: string
  locations: Array<{ location: string; indexes: number[] }>
}

export function groupSources(sources: Citation[]): SourceFileGroup[] {
  const groups: SourceFileGroup[] = []
  sources.forEach((source, index) => {
    let fileGroup = groups.find((group) => group.file === source.file)
    if (!fileGroup) {
      fileGroup = { file: source.file, locations: [] }
      groups.push(fileGroup)
    }
    const locationGroup = fileGroup.locations.find(
      (location) => location.location === source.location
    )
    if (locationGroup) locationGroup.indexes.push(index + 1)
    else fileGroup.locations.push({ location: source.location, indexes: [index + 1] })
  })
  return groups
}
