export function encodeCappedJson(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value);
  if (text.length > maxChars) {
    throw new Error("result_too_large");
  }
  return text;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("tool_timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
