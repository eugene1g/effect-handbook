<script setup lang="ts">
import { computed } from "vue"
import { useData, withBase } from "vitepress"

import { capabilities, siteGroups, sitePages } from "../../handbook.ts"

const { page } = useData()
const pagesBySource = new Map(sitePages.map((entry) => [entry.source, entry]))
const capabilitiesById = new Map(capabilities.map((entry) => [entry.id, entry]))

const related = computed(() => {
  const source = page.value.filePath?.replaceAll("\\", "/")
  if (!source) return []

  const scores = new Map<string, { score: number; reason: string }>()
  const add = (target: string, score: number, reason: string) => {
    if (target === source || !pagesBySource.has(target)) return
    const previous = scores.get(target)
    if (!previous || score > previous.score) scores.set(target, { score, reason })
  }

  const owned = capabilities.filter((entry) => entry.page === source)
  const currentPage = pagesBySource.get(source)
  for (const target of currentPage?.related ?? []) add(target, 20, "Selected companion topic")
  for (const entry of owned) {
    for (const alternativeId of entry.alternatives) {
      const alternative = capabilitiesById.get(alternativeId)
      if (alternative) add(alternative.page, 10, `Compare with ${alternative.symbols[0]}`)
    }
    for (const peer of capabilities) {
      if (peer.domain === entry.domain) add(peer.page, 4, `Related ${entry.domain} capability`)
    }
  }

  const group = siteGroups.find((candidate) => candidate.items.some((item) => item.source === source))
  const index = group?.items.findIndex((item) => item.source === source) ?? -1
  if (group && index >= 0) {
    if (group.items[index - 1]) add(group.items[index - 1].source, 2, "Previous topic in this area")
    if (group.items[index + 1]) add(group.items[index + 1].source, 2, "Next topic in this area")
  }
  const globalIndex = sitePages.findIndex((item) => item.source === source)
  if (globalIndex >= 0) {
    if (sitePages[globalIndex - 1]) add(sitePages[globalIndex - 1].source, 1, "Previous handbook page")
    if (sitePages[globalIndex + 1]) add(sitePages[globalIndex + 1].source, 1, "Next handbook page")
  }

  return [...scores]
    .sort(([leftSource, left], [rightSource, right]) => right.score - left.score || leftSource.localeCompare(rightSource))
    .slice(0, 5)
    .map(([target, result]) => {
      const targetPage = pagesBySource.get(target)!
      return {
        title: targetPage.title,
        description: targetPage.description,
        reason: result.reason,
        href: withBase(targetPage.link)
      }
    })
})
</script>

<template>
  <aside v-if="related.length" class="related-topics" aria-labelledby="related-topics-title">
    <h2 id="related-topics-title" data-generated-heading="related-topics">Related topics</h2>
    <ul>
      <li v-for="item in related" :key="item.href">
        <a :href="item.href">{{ item.title }}</a>
        <span>{{ item.reason }}. {{ item.description }}</span>
      </li>
    </ul>
  </aside>
</template>
