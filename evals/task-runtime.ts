import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"

const m = await import(pathToFileURL(process.argv[3]!).href)
switch (process.argv[2]) {
  case "host": {
    assert.deepEqual(await m.adapt(new AbortController().signal, async () => "unequal-π"), { kind: "success", value: "unequal-π" })
    assert.deepEqual(await m.adapt(new AbortController().signal, async () => { throw new Error("ordinary-503") }), { kind: "failure", message: "ordinary-503" })
    const pre = new AbortController(); pre.abort()
    assert.deepEqual(await m.adapt(pre.signal, async () => { assert.fail("started after abort") }), { kind: "interrupted" })
    const c = new AbortController()
    let downstream: AbortSignal | undefined
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const pending = m.adapt(c.signal, (signal: AbortSignal) => { downstream = signal; started(); return new Promise(() => {}) })
    await ready
    c.abort()
    assert.deepEqual(await pending, { kind: "interrupted" })
    assert.equal(downstream?.aborted, true)
    break
  }
  case "config": {
    assert.deepEqual(await m.settings({ HOST: "violet.internal" }), { host: "violet.internal", port: 8123 })
    for (const port of ["1", "65535", "4917"]) assert.deepEqual(await m.settings({ HOST: "other.example", PORT: port }), { host: "other.example", port: Number(port) })
    for (const port of ["oops", "", "0", "-1", "65536", "3.5", "12x"]) await assert.rejects(() => m.settings({ HOST: "keep.me", PORT: port }))
    await assert.rejects(() => m.settings({ PORT: "1234" }))
    await assert.rejects(() => m.settings({ HOST: "" }))
    break
  }
  case "tenants": {
    const calls: Array<[string, ReadonlyArray<string>]> = []
    const rows = [{ tenant: "red", id: "a" }, { tenant: "blue", id: "a" }, { tenant: "red", id: "a" }, { tenant: "blue", id: "missing" }, { tenant: "red", id: "b" }]
    assert.deepEqual(await m.lookup(rows, async (tenant: string, ids: ReadonlyArray<string>) => { calls.push([tenant, [...ids]]); return tenant === "red" ? { a: "R-a", b: "R-b" } : { a: "B-a" } }), ["R-a", "B-a", "R-a", null, "R-b"])
    assert.deepEqual(calls.sort(([a], [b]) => a.localeCompare(b)).map(([t, ids]) => [t, [...ids].sort()]), [["blue", ["a", "missing"]], ["red", ["a", "b"]]])
    assert.deepEqual(await m.lookup([], async () => { assert.fail("empty fetch") }), [])
    await assert.rejects(() => m.lookup(rows, async () => { throw new Error("backend failure") }))
    break
  }
  default: assert.fail("Unknown task")
}
console.log("behavior passed")
