// Sauvegarde locale (navigateur) : réglages, matchs masqués, cache, alertes
const PREFIX = 'pronofoot:';

export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); }
  catch {
    // Stockage plein : on vide le cache et on réessaie
    try {
      Object.keys(localStorage).filter(k => k.startsWith(PREFIX + 'cache:')).forEach(k => localStorage.removeItem(k));
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch { /* tant pis */ }
  }
}
