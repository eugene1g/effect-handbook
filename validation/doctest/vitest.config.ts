import path from "node:path"
import { fileURLToPath } from "node:url"

import * as Doctest from "@effect/doctest/Plugin"
import { defineConfig } from "vitest/config"

import { sitePages } from "../../handbook.ts"

const validationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repositoryRoot = path.resolve(validationRoot, "..")
const includeSource = sitePages.map((page) => path
  .relative(validationRoot, path.join(repositoryRoot, "docs", page.source))
  .split(path.sep)
  .join("/"))

export default defineConfig({
  root: validationRoot,
  plugins: [Doctest.plugin()],
  test: {
    runner: path.join(validationRoot, "node_modules", "@effect", "doctest", "dist", "Runner.js"),
    deps: {
      moduleDirectories: [path.join(validationRoot, "node_modules")]
    },
    include: [],
    includeSource,
    passWithNoTests: false,
    testTimeout: 5_000
  }
})
