<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"

interface Edition {
  id: string
  effectVersion: string
  auditedAt: string
  isLatest: boolean
  isCurrent: boolean
  path: string
}

interface Versions {
  current: string
  latest: string
  rootBase: string
  editions: Edition[]
}

const { theme } = useData()
const versions = computed(() => (theme.value as { versions?: Versions }).versions)
const current = computed(() => versions.value?.editions.find((entry) => entry.isCurrent))

// Editions live at sibling bases (`/eh/4.0/`, `/eh/4.1/`), so these are plain
// absolute hrefs rather than VitePress links, which would re-prefix the base.
function navigate(event: Event): void {
  const target = event.target as HTMLSelectElement
  const edition = versions.value?.editions.find((entry) => entry.id === target.value)
  if (edition && !edition.isCurrent) window.location.assign(edition.isLatest ? versions.value!.rootBase : edition.path)
}
</script>

<template>
  <label v-if="versions && current" class="version-switcher" title="Each edition is audited against one Effect release">
    <span class="version-switcher__label">Effect</span>
    <select class="version-switcher__select" :value="current.id" aria-label="Handbook edition" @change="navigate">
      <option v-for="edition in versions.editions" :key="edition.id" :value="edition.id">
        {{ edition.effectVersion }}{{ edition.isLatest ? " (latest)" : "" }}
      </option>
    </select>
  </label>
</template>
