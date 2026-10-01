<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useData } from "vitepress"

interface PublishedEdition {
  id: string
  effectVersion: string
  status: "latest" | "frozen"
  url: string
}

interface PublishedVersions {
  latest: string
  rootUrl: string
  editions: PublishedEdition[]
}

const { theme } = useData()
const versions = computed(() => (theme.value as { versions?: { current: string; versionsUrl: string; editions: { id: string; effectVersion: string }[] } }).versions)
const newer = ref<PublishedEdition | undefined>()

// A frozen edition is built once and never rebuilt, so it cannot know about
// editions published after it. The root versions.json is always current;
// read it at runtime and only speak up when a newer edition exists.
onMounted(async () => {
  const data = versions.value
  if (!data) return
  try {
    const response = await fetch(data.versionsUrl, { headers: { accept: "application/json" } })
    if (!response.ok) return
    const published = await response.json() as PublishedVersions
    if (published.latest === data.current) return
    const latest = published.editions.find((entry) => entry.id === published.latest)
    if (latest) newer.value = latest
  } catch {
    // Offline previews and file:// builds have no versions.json to consult.
  }
})

const currentEffect = computed(() => versions.value?.editions.find((entry) => entry.id === versions.value?.current)?.effectVersion)
</script>

<template>
  <div v-if="newer" class="version-banner" role="status">
    This edition describes <strong>effect@{{ currentEffect }}</strong>. A newer handbook covers
    <a :href="newer.url">effect@{{ newer.effectVersion }}</a>.
  </div>
</template>
