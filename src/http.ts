// Petit helper de retry partagé par les clients eBay / Cardmarket.
// Volontairement minimal (pas de lib externe) : 3 tentatives, backoff linéaire.
export async function fetchWithRetry(
  input: string,
  init?: RequestInit,
  retries = 3,
  delayMs = 1000
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(input, init);
      if (!res.ok && res.status >= 500 && attempt < retries) {
        throw new Error(`HTTP ${res.status} (tentative ${attempt}/${retries})`);
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
