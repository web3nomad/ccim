// Message ids restart on a new relay. Keep its records separate without resetting wake budgets.
export function scopedStorage(storage, namespace = "") {
  if (!namespace) return storage;
  const prefix = `scope:${namespace}:`;
  const shared = (key) => key.startsWith("day:") || key.startsWith("rate:");
  const encode = (key) => shared(key) ? key : prefix + key;
  const decode = (key) => key.startsWith(prefix) ? key.slice(prefix.length) : key;
  return {
    async get(keys) {
      if (!Array.isArray(keys)) return storage.get(encode(keys));
      const entries = await storage.get(keys.map(encode));
      return new Map([...entries].map(([key, value]) => [decode(key), value]));
    },
    put(key, value) {
      if (typeof key === "string") return storage.put(encode(key), value);
      return storage.put(Object.fromEntries(Object.entries(key).map(([k, v]) => [encode(k), v])));
    },
    delete(keys) {
      return storage.delete(Array.isArray(keys) ? keys.map(encode) : encode(keys));
    },
    async list(options = {}) {
      const opts = { ...options, prefix: encode(options.prefix || "") };
      for (const key of ["start", "startAfter", "end"]) {
        if (options[key] !== undefined) opts[key] = encode(options[key]);
      }
      const entries = await storage.list(opts);
      return new Map([...entries].map(([key, value]) => [decode(key), value]));
    },
    transaction(callback) {
      return storage.transaction((txn) => callback(scopedStorage(txn, namespace)));
    },
  };
}
