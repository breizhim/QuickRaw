// Accès au worker « moteur » (aperçu réduit, copie en mémoire partagée).
export const engine = (() => {
  const w = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  let id = 0; const pending = new Map();
  w.onmessage = ({ data }) => {
    const p = pending.get(data.id); if (!p) return;
    pending.delete(data.id);
    data.ok ? p.resolve(data) : p.reject(new Error(data.error));
  };
  w.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Erreur du worker')); pending.clear(); };
  const call = (msg, transfer = []) => new Promise((resolve, reject) => {
    const i = ++id; pending.set(i, { resolve, reject });
    w.postMessage({ ...msg, id: i }, transfer);
  });
  return { call };
})();
