import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitepress"

import { capabilities, handbookRelease, siteGroups, sitePages, slugifyHeading } from "../handbook.ts"

process.env.VITE_EXTRA_EXTENSIONS = [process.env.VITE_EXTRA_EXTENSIONS, "md"].filter(Boolean).join(",")

const base = normalizeBase(process.env.VITEPRESS_BASE ?? "/")
const repository = process.env.HANDBOOK_REPOSITORY ?? process.env.GITHUB_REPOSITORY
const repositoryUrl = process.env.HANDBOOK_REPOSITORY_URL ?? (repository ? `https://github.com/${repository}` : undefined)
const siteUrl = normalizeSiteUrl(process.env.HANDBOOK_SITE_URL)
const pagesBySource = new Map(sitePages.map((page) => [page.source, page]))
const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs")

export default defineConfig({
  title: "The Effect 4 Handbook",
  description: "A source-grounded guide to Effect v4 for humans and coding agents.",
  lang: "en-US",
  base,
  srcDir: "docs",
  outDir: "dist",
  cleanUrls: true,
  lastUpdated: true,
  ignoreDeadLinks: false,
  sitemap: siteUrl ? { hostname: siteUrl } : undefined,
  vite: {
    publicDir: "../public",
    plugins: [{
      name: "effect-handbook-raw-markdown",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          try {
            const url = new URL(request.url ?? "/", "http://localhost")
            if ((request.method !== "GET" && request.method !== "HEAD") || url.search || !url.pathname.startsWith(base)) {
              next()
              return
            }
            const source = decodeURIComponent(url.pathname.slice(base.length))
            if (!pagesBySource.has(source)) {
              next()
              return
            }
            const contents = await readFile(path.join(docsRoot, source))
            response.writeHead(200, {
              "cache-control": "no-cache",
              "content-length": contents.byteLength,
              "content-type": "text/markdown; charset=utf-8"
            })
            response.end(request.method === "HEAD" ? undefined : contents)
          } catch (error) {
            next(error as Error)
          }
        })
      }
    }]
  },
  markdown: {
    anchor: {
      slugify: slugifyHeading
    },
    image: {
      lazyLoad: true
    }
  },
  head: [
    ["link", { rel: "icon", type: "image/svg+xml", href: `${base}favicon.svg` }],
    ["meta", { name: "theme-color", content: "#7056d8" }],
    ["meta", { name: "color-scheme", content: "light dark" }]
  ],
  transformPageData(pageData) {
    const source = pageData.filePath.replaceAll("\\", "/")
    const page = pagesBySource.get(source)
    if (!page) return

    const rawUrl = siteUrl
      ? new URL(page.source, siteUrl).href
      : `${base}${page.source}`
    const canonicalUrl = siteUrl
      ? new URL(page.link.replace(/^\//, ""), siteUrl).href
      : undefined
    const title = `${page.title} | The Effect 4 Handbook`
    const head = [
      ["link", { rel: "alternate", type: "text/markdown", href: rawUrl, title: "Markdown source" }],
      ["link", { rel: "describedby", type: "text/plain", href: artifactHref("llms.txt"), title: "LLM documentation index" }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: page.description }],
      ["meta", { property: "og:type", content: "article" }],
      ["meta", { name: "twitter:card", content: "summary" }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: page.description }]
    ] as NonNullable<typeof pageData.frontmatter.head>
    if (canonicalUrl) {
      head.push(["link", { rel: "canonical", href: canonicalUrl }])
      head.push(["meta", { property: "og:url", content: canonicalUrl }])
    }
    pageData.description = page.description
    pageData.frontmatter.head = [...(pageData.frontmatter.head ?? []), ...head]
  },
  themeConfig: {
    siteTitle: "Effect 4 Handbook",
    nav: [
      { text: "Handbook", link: "/" },
      { text: "Deep Dives", link: "/deep-dives/" },
      { text: "Cheat Sheet", link: "/reference/cheat-sheet-index" },
      {
        text: "Official Effect",
        items: [
          { text: "Cookbooks", link: upstreamUrl("tree", "cookbooks") },
          { text: "Schema guide", link: upstreamUrl("blob", "packages/effect/SCHEMA.md") },
          { text: "AI documentation source", link: upstreamUrl("tree", "ai-docs/src") },
          { text: "LLMS.md", link: upstreamUrl("blob", "LLMS.md") }
        ]
      },
      {
        text: "Downloads",
        items: [
          { text: "Concise handbook .md", link: absoluteArtifactUrl("effect-4-handbook.md"), target: "_blank" },
          { text: "Standalone HTML", link: "/effect-4-handbook.html", target: "_blank" }
        ]
      },
      ...(repositoryUrl ? [{ text: "GitHub", link: repositoryUrl }] : [])
    ],
    sidebar: siteGroups.map((group) => ({
      text: group.text,
      collapsed: true,
      items: group.items.map((item) => ({ text: item.text, link: item.link }))
    })),
    outline: {
      level: [2, 3],
      label: "On this page"
    },
    search: {
      provider: "local",
      options: {
        detailedView: true,
        async _render(source, env, md) {
          const html = await md.renderAsync(source, env)
          const relativePath = env.relativePath?.replaceAll("\\", "/")
          return appendCapabilityAliases(html, relativePath)
        },
        miniSearch: {
          searchOptions: {
            boost: { title: 6, titles: 3, text: 1 },
            prefix: true,
            fuzzy: 0.2
          }
        }
      }
    },
    lastUpdated: {
      text: "Last updated"
    },
    docFooter: {
      prev: "Previous topic",
      next: "Next topic"
    },
    notFound: {
      title: "TOPIC NOT FOUND",
      quote: "That route is not in this edition of the Effect 4 Handbook. Search the handbook or return to its orientation page.",
      link: "/",
      linkLabel: "return to the handbook",
      linkText: "Back to the handbook"
    },
    footer: {
      message: `Audited ${handbookRelease.auditedAt} against Effect ${handbookRelease.version}.`,
      copyright: "Canonical Markdown and generated site share one source."
    },
    ...(repositoryUrl ? {
      socialLinks: [{ icon: "github", link: repositoryUrl }],
      editLink: {
        pattern: `${repositoryUrl}/edit/main/docs/:path`,
        text: "Edit this page on GitHub"
      }
    } : {})
  }
})

function normalizeBase(input: string): string {
  const trimmed = input.trim()
  if (trimmed === "" || trimmed === "/") return "/"
  const segments = trimmed.split("/").filter(Boolean)
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid VITEPRESS_BASE: ${JSON.stringify(input)}`)
  }
  return `/${segments.join("/")}/`
}

function normalizeSiteUrl(input: string | undefined): string | undefined {
  if (!input?.trim()) return undefined
  const url = new URL(input)
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`HANDBOOK_SITE_URL must use http or https: ${JSON.stringify(input)}`)
  }
  url.hash = ""
  url.search = ""
  if (!url.pathname.endsWith("/")) url.pathname += "/"
  return url.href
}

function absoluteArtifactUrl(relativePath: string): string {
  return new URL(relativePath, `https://handbook.invalid${base}`).pathname
}

function artifactHref(relativePath: string): string {
  return siteUrl ? new URL(relativePath, siteUrl).href : absoluteArtifactUrl(relativePath)
}

function upstreamUrl(kind: "blob" | "tree", pathname: string): string {
  return `https://github.com/Effect-TS/effect/${kind}/${encodeURIComponent(handbookRelease.tag)}/${pathname}`
}

function appendCapabilityAliases(html: string, source: string | undefined): string {
  if (!source) return html
  let output = html
  for (const entry of capabilities.filter((candidate) => candidate.page === source)) {
    const marker = new RegExp(`(<h[1-3]\\s+id=["']${escapeRegExp(entry.anchor)}["'][^>]*>[\\s\\S]*?<\\/h[1-3]>)`)
    const aliases = [
      ...entry.symbols,
      ...entry.imports.map((imported) => imported.path),
      ...entry.tasks,
      entry.summary,
      entry.chooseWhen,
      entry.avoidWhen
    ].join(" · ")
    output = output.replace(marker, `$1<span class="capability-search-aliases">${escapeHtml(aliases)}</span>`)
  }
  return output
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!)
}
