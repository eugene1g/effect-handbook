import { h } from "vue"
import type { Theme } from "vitepress"
import DefaultTheme from "vitepress/theme"

import { installAnchorMoves } from "./anchor-moves.ts"
import MarkdownToolbar from "./MarkdownToolbar.vue"
import RelatedTopics from "./RelatedTopics.vue"
import VersionBanner from "./VersionBanner.vue"
import VersionSwitcher from "./VersionSwitcher.vue"
import "./custom.css"

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    "layout-top": () => h(VersionBanner),
    "nav-bar-content-after": () => h(VersionSwitcher),
    "doc-before": () => h(MarkdownToolbar),
    "doc-after": () => h(RelatedTopics)
  }),
  enhanceApp({ router, siteData }) {
    installAnchorMoves(router, siteData.value.base)
  }
} satisfies Theme
