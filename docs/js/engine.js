// Version en ligne : lit les données préparées par le robot (data/today.json)
// et les recharge toutes les 5 minutes. Les analyses sont calculées dans le navigateur.
import { analyzeMatch } from './model.js';
import { load, save } from './store.js';
import { parsePasted, mergeExtras } from './claude.js';

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
    state.analyses = {};
    state.matches.forEach(m => { state.analyses[m.id] = analyzeMatch(m); });
    state.alerts = (d.events || []).map(e => ({ id: e.t + e.title, ...e }));
    state.lastUpdate = Date.parse(d.updatedAt || d.generatedAt);
    state.error = null;
    buildBanner();
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  emit();
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
}

export async function start() {
  await loadAll();
  setInterval(loadAll, 5 * 60000);
}
