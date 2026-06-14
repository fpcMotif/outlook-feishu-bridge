import '@testing-library/jest-dom/vitest'

// Node 25 ships a built-in global `localStorage` that throws "Cannot initialize
// local storage without a --localstorage-file path" on first access. In the jsdom
// test environment we want a plain in-memory Storage instead, so install one
// before any test touches it.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number {
    return this.store.size
  }
  clear(): void {
    this.store.clear()
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true,
  })
}

process.env.FEISHU_APP_ID = "test";
process.env.FEISHU_APP_SECRET = "test";
process.env.FEISHU_FALLBACK_REDIRECT_URI = "test";

(globalThis as any).Bun = {
  serve: () => ({ port: 8788, stop: () => {} }),
} as any;
