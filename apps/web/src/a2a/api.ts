import { resolveWsHttpUrl } from "../lib/wsHttpUrl";

export async function requestA2A<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(resolveWsHttpUrl(path), {
    credentials: "include",
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `请求失败 (${response.status})`);
  return result as T;
}
