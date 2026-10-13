# todo-api

A tiny TODO API used as the demo codebase for Hive. Agents edit this repo concurrently.

- `GET /todos` — list todos
- `POST /todos` — create a todo `{ "title": string }`
- `PATCH /todos/:id` — update a todo
- `DELETE /todos/:id` — delete a todo

Type-check with `npm install && npm run check`.
