export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function notFound(): Response {
  return json({ error: "not found" }, 404);
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}
