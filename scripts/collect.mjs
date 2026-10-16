// Robot PronoFoot : lancé toutes les 15 minutes par GitHub Actions.
// - Premier passage de la journée (après 7h) : programme, bilans domicile/extérieur,
//   niveau des adversaires, buteurs, absents → docs/data/today.json + notification.
// - Passages suivants : compositions officielles à partir d'1 h avant chaque match → notification.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMatch } from '../docs/js/model.js';
import { compByAf } from '../docs/js/config.js';
import { FD_CODES, buildCompetition, buildMatch, applyInjuries, applyLineups, groupSlots, hhmm } from '../docs/js/core.js';

const AF_KEY = process.env.APIFOOTBALL_KEY;
const FD_KEY = process.env.FOOTBALLDATA_KEY;
const NTFY = process.env.NTFY_TOPIC;
const PAGE_URL = process.env.PAGE_URL || '';
const FORCE = process.env.FORCE === 'oui';
const AF_BUDGET = 95; // l'offre gratuite d'API-Football autorise 100 requêtes par jour

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const TODAY_FILE = path.join(DATA, 'today.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const parisDate = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const parisHour = () => +new Date().toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false });
const pct = p => `${Math.round(p * 100)} %`;

// ---------- Appels aux deux sources ----------
let afUsed = 0;
async function af(p, params) {
  if (afUsed >= AF_BUDGET) throw new Error('Quota API-Football du jour presque atteint');
  afUsed++;
  const r = await fetch(`https://v3.football.api-sports.io/${p}?${new URLSearchParams(params)}`, { headers: { 'x-apisports-key': AF_KEY } });
  const j = await r.json();
  if (j.errors && !Array.isArray(j.errors) && Object.keys(j.errors).length) throw new Error('API-Football : ' + JSON.stringify(j.errors));
  return j;
}

let lastFd = 0;
async function fd(p) {
  // Offre gratuite : 10 requêtes par minute
  const wait = lastFd + 6500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastFd = Date.now();
  const r = await fetch(`https://api.football-data.org/v4/${p}`, { headers: { 'X-Auth-Token': FD_KEY } });
  const j = await r.json();
  if (!r.ok) throw new Error(`football-data ${p} : ${j.message || r.status}`);
  return j;
}

async function notify(title, message) {
  if (!NTFY) return;
  try {
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: NTFY, title, message, click: PAGE_URL || undefined, tags: ['soccer'] }),
    });
  } catch (e) { console.warn('Notification impossible :', e.message); }
}

// ---------- Collecte du matin ----------
async function daily(today) {
  const fx = await af('fixtures', { date: today, timezone: 'Europe/Paris' });
  const list = fx.response.filter(f => compByAf[f.league.id] && ['TBD', 'NS', 'PST'].includes(f.fixture.status.short));
  console.log(`${list.length} matchs suivis aujourd'hui`);

  const comps = {};
  for (const lid of [...new Set(list.map(f => f.league.id))]) {
    const code = FD_CODES[lid];
    if (!code) continue;
    try {
      const st = await fd(`competitions/${code}/standings`);
      const mt = await fd(`competitions/${code}/matches?status=FINISHED`);
      const sc = await fd(`competitions/${code}/scorers?limit=80`);
      comps[lid] = buildCompetition(st, mt, sc);
      console.log(`${code} : ${comps[lid].rows.length} équipes`);
    } catch (e) { console.warn(e.message); }
  }

  const matches = list.map(f => buildMatch(f, comps[f.league.id]));
  // Absents : en priorité les matchs avec statistiques (quota limité)
  const withStats = matches.filter(m => m.stats).sort((a, b) => a.kickoff - b.kickoff);
  for (const m of withStats) {
    if (afUsed >= 55) break; // on garde du quota pour les compositions
    try { applyInjuries(m, await af('injuries', { fixture: m.fixtureId })); } catch (e) { console.warn(e.message); break; }
  }
  return matches;
}

function bestTip(a) {
  const t = a.tips.filter(x => x.key !== 'SC2').sort((x, y) => y.p - x.p)[0];
  return t ? `${t.label} (${pct(t.p)})` : 'pas de piste';
}

function dailySummary(matches) {
  const slots = groupSlots(matches);
  const withStats = matches.filter(m => m.stats);
  const analysed = withStats.map(m => ({ m, a: analyzeMatch(m) })).filter(x => x.a.verdict.code !== 'skip');
  const top = analysed.map(x => ({ x, t: x.a.tips.filter(t => t.key !== 'SC2').sort((p, q) => q.p - p.p)[0] }))
    .filter(y => y.t).sort((p, q) => q.t.p - p.t.p).slice(0, 4);
  const lines = [
    `${matches.length} matchs aujourd'hui, ${withStats.length} avec statistiques complètes.`,
    'Créneaux : ' + slots.map(s => `${hhmm(s.start)} (${s.matches.length})`).join(' · '),
  ];
  if (top.length) lines.push('Pistes : ' + top.map(y => `${y.x.m.home.name}-${y.x.m.away.name} : ${y.t.label} ${pct(y.t.p)}`).join(' | '));
  return lines.join('\n');
}

// ---------- Compositions officielles ----------
async function lineupsPass(state) {
  const now = Date.now();
  state.lineupTries = state.lineupTries || {};
  const isOfficial = m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  const due = state.matches
    .filter(m => !isOfficial(m) && m.kickoff - now <= 60 * 60000 && m.kickoff - now > -10 * 60000 && (state.lineupTries[m.id] || 0) < 4)
    .sort((a, b) => (b.stats ? 1 : 0) - (a.stats ? 1 : 0) || a.kickoff - b.kickoff);
  const found = [];
  for (const m of due) {
    if (afUsed >= AF_BUDGET) break;
    state.lineupTries[m.id] = (state.lineupTries[m.id] || 0) + 1;
    try { if (applyLineups(m, await af('fixtures/lineups', { fixture: m.fixtureId }))) found.push(m); } catch (e) { console.warn(e.message); break; }
  }
  if (!found.length) return false;

  // Une notification par créneau
  for (const slot of groupSlots(found)) {
    const lines = slot.matches.map(m => {
      const a = analyzeMatch(m);
      const benched = [...a.presence.home.missing, ...a.presence.away.missing].filter(p => p.status === 'remplacant' || p.status === 'absent').map(p => p.name);
      return `${m.home.name}-${m.away.name} : ${bestTip(a)}${benched.length ? ` · absents/banc : ${benched.slice(0, 3).join(', ')}` : ''}`;
    });
    const title = `Compos officielles ${hhmm(slot.start)}`;
    const message = lines.join('\n');
    state.events.unshift({ t: Date.now(), matchId: slot.matches[0].id, level: 'go', title, body: message.replace(/\n/g, ' | ') });
    await notify(title, message);
  }
  return true;
}

// ---------- Programme principal ----------
async function main() {
  if (!AF_KEY || !FD_KEY) throw new Error('Clés manquantes : APIFOOTBALL_KEY et FOOTBALLDATA_KEY doivent être dans les secrets GitHub.');
  await fs.mkdir(path.join(DATA, 'archive'), { recursive: true });
  const today = parisDate();
  let state = null;
  try { state = JSON.parse(await fs.readFile(TODAY_FILE, 'utf8')); } catch { /* premier lancement */ }

  let changed = false;
  if (!state || state.date !== today || FORCE) {
    if (parisHour() < 7 && !FORCE) { console.log('Trop tôt pour la collecte du jour.'); return; }
    const matches = await daily(today);
    state = { date: today, generatedAt: new Date().toISOString(), afUsed: 0, matches, events: [], lineupTries: {} };
    const summary = dailySummary(matches);
    state.events.unshift({ t: Date.now(), level: 'info', title: 'Analyse du jour prête', body: summary.replace(/\n/g, ' | ') });
    await notify('PronoFoot : analyse du jour prête', summary);
    changed = true;
  } else {
    afUsed = state.afUsed || 0;
  }
  if (await lineupsPass(state)) changed = true;

  if (!changed) { console.log('Rien de nouveau.'); return; }
  state.afUsed = afUsed;
  state.updatedAt = new Date().toISOString();
  state.events = state.events.slice(0, 60);
  const json = JSON.stringify(state);
  await fs.writeFile(TODAY_FILE, json);
  await fs.writeFile(path.join(DATA, 'archive', `${today}.json`), json);
  console.log(`Enregistré (${afUsed} requêtes API-Football utilisées aujourd'hui).`);
}

main().catch(e => { console.error(e); process.exit(1); });
