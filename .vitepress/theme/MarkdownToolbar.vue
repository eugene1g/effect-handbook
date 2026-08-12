<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useData, withBase } from "vitepress"

const { page } = useData()

const copying = ref(false)
const status = ref("")
let statusTimer: ReturnType<typeof setTimeout> | undefined
let copyAttempt = 0

const rawUrl = computed(() => {
  const source = page.value.filePath
  if (!source || !source.endsWith(".md")) return undefined

  const encodedSource = source
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")

  return withBase(`/${encodedSource}`)
})

const copyLabel = computed(() => copying.value ? "Copying…" : "Copy Markdown")

watch(rawUrl, () => {
  copyAttempt += 1
  copying.value = false
  clearStatus()
})

onBeforeUnmount(() => {
  copyAttempt += 1
  clearStatus()
})

async function copyMarkdown(): Promise<void> {
  if (copying.value || !rawUrl.value) return

  const attempt = ++copyAttempt
  copying.value = true
  clearStatus()

  try {
    const response = await fetch(rawUrl.value, {
      credentials: "same-origin",
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" }
    })

    if (!response.ok) {
      throw new Error(`Markdown request failed with ${response.status}`)
    }

    const markdown = await response.text()
    await writeToClipboard(markdown)

    if (attempt !== copyAttempt) return
    setStatus("Markdown copied to the clipboard.")
  } catch {
    if (attempt !== copyAttempt) return
    setStatus("Could not copy Markdown. Open View raw to copy it manually.", false)
  } finally {
    if (attempt === copyAttempt) copying.value = false
  }
}

async function writeToClipboard(markdown: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(markdown)
      return
    } catch {
      // Clipboard access is commonly unavailable on file:// and non-secure origins.
    }
  }

  const textArea = document.createElement("textarea")
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined

  textArea.value = markdown
  textArea.setAttribute("readonly", "")
  textArea.setAttribute("aria-hidden", "true")
  textArea.style.position = "fixed"
  textArea.style.inset = "0 auto auto -9999px"
  textArea.style.opacity = "0"
  textArea.style.pointerEvents = "none"

  document.body.appendChild(textArea)
  textArea.select()
  textArea.setSelectionRange(0, textArea.value.length)

  let copied = false
  try {
    copied = document.execCommand("copy")
  } finally {
    textArea.remove()
    activeElement?.focus()
  }

  if (!copied) throw new Error("Clipboard API unavailable")
}

function setStatus(message: string, clearAutomatically = true): void {
  clearStatus()
  status.value = message

  if (clearAutomatically) {
    statusTimer = setTimeout(() => {
      status.value = ""
      statusTimer = undefined
    }, 4_000)
  }
}

function clearStatus(): void {
  if (statusTimer !== undefined) {
    clearTimeout(statusTimer)
    statusTimer = undefined
  }
  status.value = ""
}
</script>

<template>
  <div v-if="rawUrl" class="markdown-toolbar" role="group" aria-label="Markdown source">
    <span class="markdown-toolbar__status" role="status" aria-live="polite" aria-atomic="true">
      {{ status }}
    </span>
    <button
      class="markdown-toolbar__action"
      type="button"
      :disabled="copying"
      @click="copyMarkdown"
    >
      {{ copyLabel }}
    </button>
    <a
      class="markdown-toolbar__action"
      :href="rawUrl"
      target="_blank"
      rel="noopener"
      type="text/markdown"
    >
      View raw
    </a>
  </div>
</template>
