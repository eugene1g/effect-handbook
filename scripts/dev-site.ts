import { spawn } from "node:child_process"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { buildAgentHandbook } from "./build-agent-handbook.ts"
import { buildLlmsIndex } from "./build-page-markdown.ts"
import { buildRetrievalArtifacts } from "./build-retrieval-artifacts.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const publicDirectory = path.join(root, "public")
const retrieval = await buildRetrievalArtifacts()
const developmentArtifacts = [
  { relativePath: "effect-4-handbook.md", contents: Buffer.from(await buildAgentHandbook()) },
  { relativePath: "llms.txt", contents: Buffer.from(buildLlmsIndex()) },
  ...retrieval.artifacts
]

await mkdir(publicDirectory, { recursive: true })
for (const artifact of developmentArtifacts) {
  const destination = path.join(publicDirectory, artifact.relativePath)
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, artifact.contents)
}

const vitepress = spawn(
  process.execPath,
  [path.join(root, "node_modules/vitepress/bin/vitepress.js"), ...process.argv.slice(2).filter((arg) => arg !== "--")],
  { cwd: root, stdio: "inherit" }
)

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => vitepress.kill(signal))
}

vitepress.on("exit", (code, signal) => {
  void Promise.all(developmentArtifacts.map((artifact) => rm(path.join(publicDirectory, artifact.relativePath), { force: true }))).finally(() => {
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
})
