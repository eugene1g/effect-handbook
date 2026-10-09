// Sends a visitor who lands on an old deep link (a section that moved to
// another page when a large page was split) to the section's new home.
// The moves are recorded in docs-moves.json at the repository root.
import type { Router } from "vitepress"

import movesFile from "../../docs-moves.json"

const moves: Readonly<Record<string, string>> = movesFile.moves

function currentKey(base: string): string | undefined {
  const { pathname, hash } = window.location
  if (!hash || hash.length < 2) return undefined
  let path = pathname.startsWith(base) ? pathname.slice(base.length - 1) : pathname
  path = path.replace(/\.html$/, "").replace(/\/index$/, "/")
  if (!path.startsWith("/")) path = `/${path}`
  return `${path}${decodeURIComponent(hash)}`
}

export function redirectMovedAnchor(base: string): void {
  if (typeof window === "undefined") return
  const key = currentKey(base)
  if (key === undefined) return
  const target = moves[key]
  if (target === undefined) return
  const id = decodeURIComponent(window.location.hash.slice(1))
  if (document.getElementById(id)) return
  window.location.replace(`${base}${target.slice(1)}`)
}

export function installAnchorMoves(router: Router, base: string): void {
  if (typeof window === "undefined") return
  const previous = router.onAfterRouteChange
  router.onAfterRouteChange = async (to) => {
    await previous?.(to)
    redirectMovedAnchor(base)
  }
  window.addEventListener("hashchange", () => redirectMovedAnchor(base))
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => redirectMovedAnchor(base), { once: true })
  } else {
    queueMicrotask(() => redirectMovedAnchor(base))
  }
}
