import { spawn } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { handbookRelease } from "../../handbook.ts"
import { assertExactObjectKeys, readCanonicalExamples, repositoryRoot, validationRoot } from "./example-model.ts"

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"))

const collectProbeFiles = async () => (await readdir(path.join(validationRoot, "probes"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
  .map((entry) => path.join(validationRoot, "probes", entry.name))

export const assertNoStaleEffectRelease = (source, label, expected) => {
  const versions = new Set(source.match(/\b4\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/g) ?? [])
  for (const version of versions) {
    if (version !== expected) throw new Error(`${label} contains stale Effect release ${version}; expected ${expected}`)
  }
}

export const assertDirectEffectImports = (examples, dependencies, expected) => {
  const imported = new Set(examples.flatMap((example) => example.packages))
  for (const name of [...imported].filter((name) => name === "effect" || name.startsWith("@effect/")).sort()) {
    if (!Object.hasOwn(dependencies, name)) throw new Error(`Canonical examples import ${name}, but validation/package.json does not pin it directly`)
    if (dependencies[name] !== expected && name !== "@effect/tsgo") {
      throw new Error(`Canonical examples import ${name}, but its direct pin ${dependencies[name]} does not match Effect ${expected}`)
    }
  }
}

export const assertTargetShape = (target) => {
  assertExactObjectKeys(target, {
    required: ["schemaVersion", "effect", "tools", "toolingExceptions"],
    optional: ["$schema"]
  }, "validation/target.json")
  if (target.schemaVersion !== 1) throw new Error("validation/target.json must use schemaVersion 1")
  assertExactObjectKeys(target.effect, {
    required: ["version", "tag", "commit", "publishedAt", "auditedAt"]
  }, "validation/target.json effect")
  assertExactObjectKeys(target.tools, {
    required: ["node", "pnpm", "typescript", "nodeTypes", "effectTsgo", "vitest", "doctest"]
  }, "validation/target.json tools")
  assertExactObjectKeys(target.toolingExceptions, { optional: Object.keys(target.toolingExceptions) }, "validation/target.json toolingExceptions")
  for (const [key, value] of Object.entries({ ...target.effect, ...target.tools, ...target.toolingExceptions })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`validation/target.json ${key} must be a non-empty string`)
  }
  if (!/^[a-f0-9]{40}$/.test(target.effect.commit)) throw new Error("validation/target.json effect.commit must be a 40-character lowercase SHA")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target.effect.auditedAt)) throw new Error("validation/target.json effect.auditedAt must be YYYY-MM-DD")
}

const runCaptured = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  child.on("error", reject)
  child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")} failed (${code})\n${output}`)))
})

const collectInstalled = (node, versions = new Map()) => {
  if (!node || typeof node !== "object") return versions
  for (const section of [node.dependencies, node.devDependencies, node.optionalDependencies]) {
    if (!section || typeof section !== "object") continue
    for (const [name, dependency] of Object.entries(section)) {
      if (name === "effect" || name.startsWith("@effect/")) {
        const current = versions.get(name) ?? new Set()
        if (typeof dependency.version === "string") current.add(dependency.version)
        versions.set(name, current)
      }
      collectInstalled(dependency, versions)
    }
  }
  return versions
}

const isToolingException = (target, name) =>
  Object.hasOwn(target.toolingExceptions, name) || name.startsWith("@effect/tsgo-")

export const workspaceImporter = (lockfile, name) => {
  const importers = lockfile.split(/^packages:/m)[0]
  const marker = `\n  ${name}:\n`
  const start = importers.indexOf(marker)
  if (start === -1) throw new Error(`root pnpm-lock.yaml has no ${name} workspace importer`)
  const afterMarker = importers.slice(start + marker.length)
  const nextImporter = afterMarker.search(/^  \S[^\n]*:\n/m)
  return nextImporter === -1 ? afterMarker : afterMarker.slice(0, nextImporter)
}

export async function checkPackageCoherence() {
  const probeFiles = await collectProbeFiles()
  const [target, packageJson, rootPackageJson, canonical, indexMarkdown, viteConfig, lockfile, validationReadme, workspace, ...probes] = await Promise.all([
    readJson(path.join(validationRoot, "target.json")),
    readJson(path.join(validationRoot, "package.json")),
    readJson(path.join(repositoryRoot, "package.json")),
    readCanonicalExamples(),
    readFile(path.join(repositoryRoot, "docs", "index.md"), "utf8"),
    readFile(path.join(repositoryRoot, ".vitepress", "config.ts"), "utf8"),
    readFile(path.join(repositoryRoot, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(validationRoot, "README.md"), "utf8"),
    readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8"),
    ...probeFiles.map((file) => readFile(file, "utf8"))
  ])
  assertTargetShape(target)
  const expected = target.effect.version
  for (const key of ["version", "tag", "commit", "publishedAt", "auditedAt"]) {
    if (target.effect[key] !== handbookRelease[key]) throw new Error(`validation/target.json effect.${key} does not match handbookRelease`)
  }
  for (const value of [expected, target.effect.tag, target.effect.commit, target.effect.auditedAt]) {
    if (!indexMarkdown.includes(value)) throw new Error(`docs/index.md does not assert current target value ${value}`)
  }
  if (!viteConfig.includes("handbookRelease.version") || !viteConfig.includes("handbookRelease.auditedAt")) {
    throw new Error("VitePress footer must derive its release and audit date from handbookRelease")
  }
  for (const [source, label] of [
    [validationReadme, "validation/README.md"],
    [workspace, "pnpm-workspace.yaml"],
    ...probes.map((source, index) => [source, path.relative(repositoryRoot, probeFiles[index])])
  ]) assertNoStaleEffectRelease(source, label, expected)

  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies }
  assertDirectEffectImports(canonical.examples, dependencies, expected)
  for (const [name, version] of Object.entries(dependencies)) {
    if ((name === "effect" || name.startsWith("@effect/")) && !isToolingException(target, name) && version !== expected) {
      throw new Error(`${name}@${version} is not coherent with Effect ${expected}`)
    }
  }
  const toolPins = {
    "@effect/doctest": target.tools.doctest,
    "@effect/tsgo": target.tools.effectTsgo,
    "@types/node": target.tools.nodeTypes,
    typescript: target.tools.typescript,
    vitest: target.tools.vitest
  }
  for (const [name, version] of Object.entries(toolPins)) {
    if (dependencies[name] !== version) throw new Error(`${name} must be pinned to ${version}`)
  }
  if (rootPackageJson.packageManager !== `pnpm@${target.tools.pnpm}`) {
    throw new Error(`root packageManager must be pnpm@${target.tools.pnpm}`)
  }

  const importer = workspaceImporter(lockfile, "validation")
  for (const [name, version] of Object.entries(dependencies)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const entry = new RegExp(`(?:'${escaped}'|${escaped}):\\n\\s+specifier: ${version.replaceAll(".", "\\.")}(?:\\n|$)`)
    if (!entry.test(importer)) {
      throw new Error(`root pnpm-lock.yaml validation importer is stale for ${name}@${version}`)
    }
  }

  const listOutput = await runCaptured("pnpm", ["--filter", packageJson.name, "list", "--json", "--depth", "Infinity"], repositoryRoot)
  const roots = JSON.parse(listOutput)
  const installed = roots.reduce((versions, root) => collectInstalled(root, versions), new Map())
  for (const [name, versions] of installed) {
    if (isToolingException(target, name)) continue
    for (const version of versions) {
      if (version !== expected) throw new Error(`Installed graph mixes ${name}@${version} with target ${expected}`)
    }
  }
  const installedToolVersions = {}
  for (const [name, version] of Object.entries(toolPins)) {
    const installedVersion = await readJson(path.join(validationRoot, "node_modules", ...name.split("/"), "package.json"))
    if (installedVersion.version !== version) throw new Error(`Installed ${name}@${installedVersion.version} does not match ${version}`)
    installedToolVersions[name] = installedVersion.version
  }
  const nodeMajor = Number(process.versions.node.split(".")[0])
  const minimumNode = Number(target.tools.node.match(/\d+/)?.[0])
  if (!Number.isInteger(minimumNode) || nodeMajor < minimumNode) throw new Error(`Node ${target.tools.node} is required; found ${process.versions.node}`)
  const actualPnpm = (await runCaptured("pnpm", ["--version"], validationRoot)).trim()
  if (actualPnpm !== target.tools.pnpm) throw new Error(`pnpm ${target.tools.pnpm} is required; found ${actualPnpm}`)
  return {
    target,
    installedPackages: [...installed.keys()].sort(),
    node: process.versions.node,
    pnpm: actualPnpm,
    installedTools: installedToolVersions
  }
}
