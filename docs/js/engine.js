// Version en ligne : lit les données préparées par le robot (data/today.json)
// et les recharge toutes les 5 minutes. Les analyses sont calculées dans le navigateur.
import { analyzeMatch } from './model.js';
import { load, save } from './store.js';
import { parsePasted, mergeExtras } from './claude.js';
import { ESPN_CODES, espnLiveScore } from './core.js';

export const state = {
  settings: { mode: 'auto', notify: false, comps: [] },
  matches: [], analyses: {}, standings: {},
  hidden: new Set(load('hidden', [])),
  alerts: [], phase: {}, loading: false, error: null, lastUpdate: null,
  quota: { af: null, odds: null }, kind: 'auto', bannerHtml: '',
};

const listeners = [];
export const onChange = fn => listeners.push(fn);
const emit = () => listeners.forEach(fn => fn());

export function toggleHidden(id) {
  state.hidden.has(id) ? state.hidden.delete(id) : state.hidden.add(id);
  save('hidden', [...state.hidden]);
  emit();
}
export function clearAlerts() { state.alerts = []; emit(); }
export function saveSettings() {}
export async function testKeys() { return {}; }

function liveStatus(m, now) {
  if (!['NS', 'TBD'].includes(m.status)) return m.status;
  const mins = (m.kickoff - now) / 60000;
  return mins > 0 ? 'NS' : mins > -110 ? 'LIVE' : 'FT';
}

export async function loadAll() {
  state.loading = true; emit();
  try {
    const r = await fetch('data/today.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('Pas encore de données : le robot n\'a pas encore fait sa première collecte.');
    const d = await r.json();
    const now = Date.now();
    robot = d;
    state.matches = mergeExtras(d.matches || [], todayExtras()).map(m => ({ ...m, status: liveStatus(m, now) }));
    applyLive();
    state.analyses = {};
    state.matches.forEach(m => { state.analyses[m.id] = analyzeMatch(m); });
    state.alerts = (d.events || []).map(e => ({ id: e.t + e.title, ...e }));
    state.lastUpdate = Date.parse(d.updatedAt || d.generatedAt);
    state.error = null;
    await loadBilan();
    try {
      const s = await fetch('data/robot-status.json?t=' + Date.now(), { cache: 'no-store' });
      state.robotStatus = s.ok ? await s.json() : null;
    } catch { state.robotStatus = null; }
    // Dernier passage du robot (même quand il n'a rien trouvé de nouveau)
    try {
      const r = await fetch('https://api.github.com/repos/altiximmo33-blip/pronofoot/actions/workflows/collecte.yml/runs?per_page=1', { cache: 'no-store' });
      const run = r.ok ? (await r.json()).workflow_runs[0] : null;
      state.lastRun = run ? { at: Date.parse(run.updated_at), ok: run.conclusion !== 'failure' } : null;
    } catch { /* information facultative */ }
    buildBanner();
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  emit();
}

// --- Bilan : résultats des pistes des jours passés (préparé par le robot) ---
async function loadBilan() {
  try {
    const r = await fetch('data/bilan.json?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const b = await r.json();
    const rates = {}, top = { n: 0, ok: 0 };
    for (const d of b.days || []) for (const m of d.matches) {
      m.picks.forEach(p => { const x = rates[p.key] = rates[p.key] || { n: 0, ok: 0, label: p.label }; x.n++; if (p.ok) x.ok++; });
      if (m.top && m.picks[0]) { top.n++; if (m.picks[0].ok) top.ok++; }
    }
    Object.values(rates).forEach(x => { x.rate = x.ok / x.n; });
    state.bilan = b; state.bilanRates = rates; state.bilanTop = top;
  } catch { /* pas encore de bilan */ }
}

// --- Matchs ajoutés depuis Claude (gardés dans ce navigateur, pour la journée) ---
let robot = null;
const parisToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

function todayExtras() {
  const ex = load('extras', null);
  return ex && ex.date === parisToday() ? ex.matches : [];
}

export function addExtras(text) {
  const added = parsePasted(text);
  const current = todayExtras().filter(m => !added.some(a => a.id === m.id));
  save('extras', { date: parisToday(), matches: [...current, ...added] });
  refresh();
  return added.length;
}

export function removeExtra(id) {
  save('extras', { date: parisToday(), matches: todayExtras().filter(m => m.id !== id) });
  refresh();
}

function refresh() {
  if (!robot) return loadAll();
  const now = Date.now();
  state.matches = mergeExtras(robot.matches || [], todayExtras()).map(m => ({ ...m, status: liveStatus(m, now) }));
  state.analyses = {};
  state.matches.forEach(m => { state.analyses[m.id] = analyzeMatch(m); });
  buildBanner();
  emit();
}

function buildBanner() {
  const d = robot || {};
  const day = d.date ? new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const withStats = state.matches.filter(m => m.stats).length;
  const fromClaude = state.matches.filter(m => m.source === 'claude').length;
  state.bannerHtml = `<strong>Analyse automatique du ${day}.</strong> ${state.matches.length} matchs, dont ${withStats} avec statistiques complètes${fromClaude ? ` (${fromClaude} ajouté${fromClaude > 1 ? 's' : ''} depuis Claude)` : ''}. Les compositions officielles sont ajoutées automatiquement environ 1 h avant chaque match. Les pistes écartent les paris évidents.`;
  if (d.date && d.date !== parisToday()) {
    state.bannerHtml += ' <strong>Attention : ces données ne sont pas celles d\'aujourd\'hui.</strong> La collecte du jour démarre vers 7h.';
  }
  // Le robot a rencontré un problème récemment
  const st = state.robotStatus;
  if (st && st.ok === false && Date.now() - st.at < 6 * 3600000) {
    const at = new Date(st.at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    state.bannerHtml += `<br><strong>⚠ Le robot a rencontré un problème à ${at} (${st.phase}).</strong> Il réessaie automatiquement toutes les 30 minutes.`;
  }
}

// --- Scores en direct (ESPN, interrogé directement par la page toutes les minutes) ---
state.live = {};
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';

function applyLive() {
  state.matches.forEach(m => {
    const s = state.live[m.id];
    if (s) m.status = s.state === 'in' ? 'LIVE' : s.state === 'post' ? 'FT' : m.status;
  });
}

async function pollLive() {
  const now = Date.now();
  const due = state.matches.filter(m => m.kickoff - now < 10 * 60000 && now - m.kickoff < 150 * 60000 && ESPN_CODES[m.comp && m.comp.af]);
  if (!due.length) return;
  const boards = {};
  for (const m of due) {
    const code = ESPN_CODES[m.comp.af];
    const day = new Date(m.kickoff).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
    try {
      boards[code + day] = boards[code + day] || await fetch(`${ESPN_SITE}${code}/scoreboard?dates=${day}`).then(r => r.json());
      const s = espnLiveScore(boards[code + day], m.home.name, m.away.name);
      if (s) state.live[m.id] = s;
    } catch { /* on réessaiera à la prochaine minute */ }
  }
  applyLive();
  emit();
}

export async function start() {
  await loadAll();
  await pollLive();
  setInterval(async () => { await loadAll(); applyLive(); emit(); }, 5 * 60000);
  setInterval(pollLive, 60000);
}
