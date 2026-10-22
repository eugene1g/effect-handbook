import { sha256 } from "./validation/example-model.ts"

/** Render the declared validation contract, never a cached pass/fail result. */
export function exampleLabels(examples) {
  const byContent = new Map(examples.map((example) => [`${example.source}:${sha256(example.body)}`, example]))
  return (md) => {
    const fence = md.renderer.rules.fence
    md.renderer.rules.fence = (tokens, index, options, env, self) => {
      const token = tokens[index]
      const rendered = fence(tokens, index, options, env, self)
      if (!/^(ts|typescript|tsx)(?:\s|$)/.test(token.info.trim())) return rendered
      const source = `docs/${env.relativePath}`
      const example = byContent.get(`${source}:${sha256(token.content.replace(/\n$/, ""))}`)
      if (!example) throw new Error(`No example contract for ${source}:${token.map[0] + 1}`)
      const form = { fragment: "Fragment", "self-contained": "Self-contained source", illustrative: "Illustrative" }[example.sourceForm]
      const check = {
        compile: "Type-checked",
        contextual: "Type-checked with fixture",
        run: "Runtime assertion",
        pseudocode: "Pseudocode — not executable",
        invalid: "Intentional type error"
      }[example.disposition]
      return `<p class="example-contract" data-source-form="${example.sourceForm}" data-check="${example.disposition}">${form} · ${check}</p>\n${rendered}`
    }
  }
}
