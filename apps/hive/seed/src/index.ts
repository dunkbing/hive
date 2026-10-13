import { notFound } from "./http";
import { handleTodos } from "./routes/todos";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/todos" || url.pathname.startsWith("/todos/")) {
      return handleTodos(request, url);
    }

    return notFound();
  },
};
