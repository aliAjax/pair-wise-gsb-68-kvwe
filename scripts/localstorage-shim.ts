// 必须在任何 store 代码求值前安装 localStorage / window 桩
const mem = new globalThis.Map<string, string>()
const storage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, v) },
  removeItem: (k: string) => { mem.delete(k) },
  clear: () => mem.clear()
}
;(globalThis as any).localStorage = storage
;(globalThis as any).window = { localStorage: storage }
