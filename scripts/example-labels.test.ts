import assert from "node:assert/strict"
import test from "node:test"
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress"
import { exampleLabels } from "./example-labels.ts"

test("rendered fences distinguish source completeness from validation without changing copied code", async () => {
  const markdown = 'Prose added after the contracts were loaded.\n\n```ts\ndeclare const client: string\n```\n\n```ts\nconsole.log(42)\n```\n\n```sh\necho ok\n```\n'
  const renderer = await createMarkdownRenderer(process.cwd(), {
    config: exampleLabels([
      { source: "docs/example.md", body: "declare const client: string", sourceForm: "fragment", disposition: "compile" },
      { source: "docs/example.md", body: "console.log(42)", sourceForm: "self-contained", disposition: "run" }
    ])
  })
  try {
    const html = await renderer.renderAsync(markdown, { relativePath: "example.md" })
    assert.match(html, /data-source-form="fragment" data-check="compile">Fragment · Type-checked<\/p>/)
    assert.match(html, /data-source-form="self-contained" data-check="run">Self-contained source · Runtime assertion<\/p>/)
    assert.equal((html.match(/class="example-contract"/g) ?? []).length, 2)
    assert.equal((html.match(/<pre\b/g) ?? []).length, 3)
    const text = html.replace(/<[^>]+>/g, "")
    assert.match(text, /declare const client: string/)
    assert.match(text, /console\.log\(42\)/)
  } finally { disposeMdItInstance() }
})
