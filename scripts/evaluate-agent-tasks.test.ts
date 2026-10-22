import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prepare, score } from "./evaluate-agent-tasks.ts"

// Hand-authored behavioral controls, not model runs or primitive conformance evidence.
const controls = {
  host: `export async function adapt(signal: AbortSignal, work: (s: AbortSignal) => Promise<string>) {
    if(signal.aborted) return {kind:'interrupted'};
    const downstream=new AbortController();
    return await new Promise(resolve=>{
      const abort=()=>{downstream.abort(); resolve({kind:'interrupted'})};
      signal.addEventListener('abort',abort,{once:true});
      work(downstream.signal).then(value=>resolve({kind:'success',value}),error=>resolve({kind:'failure',message:error.message})).finally(()=>signal.removeEventListener('abort',abort));
    });
  }`,
  config: `export async function settings(v: Record<string,string>) {
    const host=v.HOST; const raw=v.PORT;
    if(!host || (raw!==undefined && (!/^\\d+$/.test(raw) || Number(raw)<1 || Number(raw)>65535))) throw Error('bad config');
    return {host,port:raw===undefined?8123:Number(raw)};
  }`,
  tenants: `export async function lookup(rows: ReadonlyArray<{tenant:string,id:string}>, fetch:(tenant:string,ids:ReadonlyArray<string>)=>Promise<Readonly<Record<string,string>>>) {
    const groups=new Map<string,Set<string>>();
    for(const r of rows){if(!groups.has(r.tenant)) groups.set(r.tenant,new Set()); groups.get(r.tenant)!.add(r.id)}
    const data=new Map<string,Readonly<Record<string,string>>>();
    await Promise.all([...groups].map(async ([t,ids])=>{data.set(t,await fetch(t,[...ids]))}));
    return rows.map(r=>data.get(r.tenant)![r.id]??null);
  }`
}

test("public prepare/score accepts controls and rejects behavioral mutants, compile failure and missing artifacts", { timeout: 180000 }, async () => {
  await mkdir(".validation", { recursive: true })
  const dir = await mkdtemp(path.resolve(".validation/agent-eval-test-"))
  try {
    const built = path.join(dir, "fixture-snapshot")
    await mkdir(built)
    const packages = JSON.parse(await readFile("validation/package.json", "utf8"))
    await writeFile(path.join(built, "effect-4-catalog.json"), JSON.stringify({ handbook: { effectVersion: packages.dependencies.effect } }))
    await writeFile(path.join(built, "effect-4-handbook.md"), "# Test-only snapshot, not model evidence\n")
    await writeFile(path.join(built, "llms.txt"), "# Test index\n")
    await prepare(dir, built)
    const execute = promisify(execFile)
    const fetched = await execute(process.execPath, [path.join(dir, "fetch.mjs"), "llms.txt"])
    assert.equal(fetched.stdout, "# Test index\n")
    await assert.rejects(execute(process.execPath, [path.join(dir, "fetch.mjs"), "index.html"]))
    await assert.rejects(execute(process.execPath, [path.join(dir, "fetch.mjs"), "../outside.md"]))
    assert.match(await readFile(path.join(dir, "host/TASK.md"), "utf8"), /Use Effect/)
    for (const [id, code] of Object.entries(controls)) {
      await writeFile(path.join(dir, id, "main.ts"), code)
      await writeFile(path.join(dir, id, "report.json"), JSON.stringify({ generator: "hand-authored-test-control", citations: [] }))
    }
    const good = await score(dir)
    assert.equal(good.fetchProvenance[0].requested, "llms.txt")
    assert.match(good.fetchProvenance[0].sha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(good.results.map(r => [r.task, r.passed, r.compiler.status, r.effect.status, r.runtime.status]), ["host", "config", "tenants"].map(id => [id, true, "passed", "passed", "passed"]), JSON.stringify(good.results))
    await writeFile(path.join(dir, "host/main.ts"), controls.host.replace("downstream.abort();", ""))
    await writeFile(path.join(dir, "config/main.ts"), controls.config.replace("return {host,port:", "if(raw===undefined) return {host:'localhost',port:8123}; return {host,port:"))
    await writeFile(path.join(dir, "tenants/main.ts"), controls.tenants.replaceAll("r.tenant", "'shared'"))
    const bad = await score(dir)
    assert.ok(bad.results.every(r => !r.passed && r.compiler.status === "passed" && r.runtime.status === "failed"), JSON.stringify(bad.results))
    await writeFile(path.join(dir, "host/main.ts"), "const bad: number = 'not a number'; export {}")
    await rm(path.join(dir, "config/main.ts"))
    await rm(path.join(dir, "tenants/report.json"))
    await rm(path.join(dir, "fetch.jsonl"))
    const broken = await score(dir)
    assert.equal(broken.results[0].compiler.status, "failed")
    assert.equal(broken.results[0].runtime.status, "skipped")
    assert.ok(broken.results[1].missing.includes("main.ts"))
    assert.ok(broken.results[2].missing.some(s => s.includes("report.json")))
    assert.equal(broken.missingFetchLog, true)
    await writeFile(path.join(dir, "host/main.ts"), "setInterval(()=>{},1000); await new Promise(()=>{}); export {}")
    const hanging = await score(dir, 1000)
    assert.equal(hanging.results[0].runtime.timedOut, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
