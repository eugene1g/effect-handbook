import { h } from "vue"
import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"

import MarkdownToolbar from "./MarkdownToolbar.vue"
import RelatedTopics from "./RelatedTopics.vue"
import "./custom.css"

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    "doc-before": () => h(MarkdownToolbar),
    "doc-after": () => h(RelatedTopics)
  })
} satisfies Theme
