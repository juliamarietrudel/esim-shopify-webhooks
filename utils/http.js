export async function safeFetch(url, options = {}) {
  const ctrl = new AbortController();
  const timeoutMs = Number(process.env.FETCH_TIMEOUT_MS || 15000);
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    console.error("❌ FETCH ERROR:", e?.message, "cause:", e?.cause);
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}