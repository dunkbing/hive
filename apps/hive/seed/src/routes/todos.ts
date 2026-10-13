import { json, notFound, readJson } from "../http";
import type { CreateTodoInput, UpdateTodoInput } from "../models/todo";
import { createTodo, deleteTodo, listTodos, updateTodo } from "../store";

export async function handleTodos(request: Request, url: URL): Promise<Response> {
  const [, , id] = url.pathname.split("/");

  if (request.method === "GET" && !id) {
    return json(listTodos());
  }

  if (request.method === "POST" && !id) {
    const input = await readJson<CreateTodoInput>(request);
    return json(createTodo(input), 201);
  }

  if (request.method === "PATCH" && id) {
    const input = await readJson<UpdateTodoInput>(request);
    const todo = updateTodo(id, input);
    return todo ? json(todo) : notFound();
  }

  if (request.method === "DELETE" && id) {
    return deleteTodo(id) ? new Response(null, { status: 204 }) : notFound();
  }

  return notFound();
}
