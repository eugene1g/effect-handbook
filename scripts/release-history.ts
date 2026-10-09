/**
 * The Release History page (`docs/reference/release-history.md`) keeps one
 * entry per audited Effect release, newest first. Each entry is an H2 of the
 * exact form
 *
 *   ## `effect@<version>` — audited <YYYY-MM-DD>
 *
 * so `docs:check` can prove the page records the release in `handbook.ts`
 * before a refresh is merged.
 */

export const releaseHistorySource = "reference/release-history.md"

export interface ReleaseIdentity {
  readonly version: string
  readonly auditedAt: string
}

const entryHeading = /^## `effect@([^`]+)` — audited (\d{4}-\d{2}-\d{2})$/

/** Release entries in page order, read from their H2 headings outside code fences. */
export function releaseHistoryEntries(markdown: string): Array<ReleaseIdentity> {
  const entries: Array<ReleaseIdentity> = []
  let fence: string | undefined
  for (const line of markdown.split("\n")) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (fence === undefined) fence = marker[1]
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined
      continue
    }
    if (fence !== undefined) continue
    const match = line.match(entryHeading)
    if (match) entries.push({ version: match[1], auditedAt: match[2] })
  }
  return entries
}

/** Every reason the page does not record `release` as its newest entry; empty when it does. */
export function releaseHistoryProblems(markdown: string, release: ReleaseIdentity): Array<string> {
  const entries = releaseHistoryEntries(markdown)
  const problems: Array<string> = []
  if (entries.length === 0) {
    problems.push("has no release entries (expected H2 headings like \"## `effect@4.0.2` — audited 2026-10-09\")")
    return problems
  }
  const [newest] = entries
  if (newest.version !== release.version || newest.auditedAt !== release.auditedAt) {
    problems.push(
      `newest entry is effect@${newest.version} audited ${newest.auditedAt}, but handbook.ts records effect@${release.version} audited ${release.auditedAt}; add an entry for the current release at the top`
    )
  }
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${entry.version}/${entry.auditedAt}`
    if (seen.has(key)) problems.push(`repeats the entry for effect@${entry.version} audited ${entry.auditedAt}`)
    seen.add(key)
  }
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].auditedAt < entries[index].auditedAt) {
      problems.push(`entries are not newest first: effect@${entries[index].version} (${entries[index].auditedAt}) follows an older audit`)
    }
  }
  return problems
}
