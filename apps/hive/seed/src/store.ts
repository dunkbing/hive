import type { CreateTodoInput, Todo, UpdateTodoInput } from "./models/todo";

const todos = new Map<string, Todo>();

export function listTodos(): Todo[] {
  return [...todos.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getTodo(id: string): Todo | undefined {
  return todos.get(id);
}

export function createTodo(input: CreateTodoInput): Todo {
  const todo: Todo = {
    id: crypto.randomUUID(),
    title: input.title,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  todos.set(todo.id, todo);
  return todo;
}

export function updateTodo(id: string, input: UpdateTodoInput): Todo | undefined {
  const todo = todos.get(id);
  if (!todo) return undefined;
  const updated = { ...todo, ...input };
  todos.set(id, updated);
  return updated;
}

export function deleteTodo(id: string): boolean {
  return todos.delete(id);
}
