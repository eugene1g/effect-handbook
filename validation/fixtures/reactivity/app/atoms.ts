import { Context, Effect, Layer } from "effect"
import { Atom } from "effect/unstable/reactivity"

export interface Todo {
  readonly id: number
  readonly text: string
  readonly done: boolean
}

export class TodoApi extends Context.Service<
  TodoApi,
  {
    readonly list: Effect.Effect<ReadonlyArray<Todo>>
    readonly add: (text: string) => Effect.Effect<Todo>
    readonly toggle: (id: number) => Effect.Effect<Todo>
  }
>()("fixtures/TodoApi") {}

const TodoApiLive = Layer.succeed(
  TodoApi,
  TodoApi.of({
    list: Effect.succeed([]),
    add: (text) => Effect.succeed({ id: 1, text, done: false }),
    toggle: (id) => Effect.succeed({ id, text: "", done: true })
  })
)

export const runtime = Atom.runtime(TodoApiLive)
export const todosAtom = runtime.atom(TodoApi.use((api) => api.list))
export const visibleTodos = todosAtom
export const addTodo = runtime.fn((text: string) => TodoApi.use((api) => api.add(text)))
export const toggleTodo = runtime.fn((id: number) => TodoApi.use((api) => api.toggle(id)))
export const draft = Atom.make("")
