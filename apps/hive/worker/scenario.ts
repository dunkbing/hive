export interface Task {
  name: string;
  task: string;
}

/**
 * Five tasks against the seed TODO API. Most of them touch `src/routes/todos.ts`
 * and `src/store.ts`, so they collide on purpose.
 */
export const DEMO_TASKS: Task[] = [
  {
    name: "validator",
    task: "Validate input when creating a todo in POST /todos: `title` must be a non-empty string of at most 200 characters (trim whitespace). Respond 400 with `{ error: string }` when invalid.",
  },
  {
    name: "paginator",
    task: "Add pagination to GET /todos using `?limit=` and `?offset=` query parameters (default limit 20, max 100, default offset 0). Respond with `{ items, total, limit, offset }`.",
  },
  {
    name: "prioritizer",
    task: "Add a `priority` field to todos with values 'low' | 'medium' | 'high' (default 'medium'). Accept it when creating and updating todos.",
  },
  {
    name: "logger",
    task: "Add request logging: every request should log `METHOD path -> status (Nms)` with console.log. Put the logging helper in a new file src/logger.ts and use it from src/index.ts.",
  },
  {
    name: "janitor",
    task: "Add a `DELETE /todos/completed` endpoint that removes all completed todos and responds with `{ deleted: number }`.",
  },
];
