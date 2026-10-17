// Robot PronoFoot : lancé toutes les 15 minutes par GitHub Actions.
// - Premier passage de la journée (après 7h) : programme, bilans domicile/extérieur,
//   niveau des adversaires, buteurs, absents → docs/data/today.json + notification.
// - Passages suivants : compositions officielles à partir d'1 h avant chaque match → notification.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMatch } from '../docs/js/model.js';
import { compByAf } from '../docs/js/config.js';
import { FD_CODES, ESPN_CODES, buildCompetition, buildMatch, applyInjuries, applyLineups, groupSlots, hhmm, tipResult, failReason, biasFactor, topPicks, espnCompetition, espnFindEvent, applyEspnLineups } from '../docs/js/core.js';

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
let lastAf = 0;
async function af(p, params) {
  if (afUsed >= AF_BUDGET) throw new Error('Quota API-Football du jour presque atteint');
  // Offre gratuite : 10 requêtes par minute
  const wait = lastAf + 6500 - Date.now();
  if (wait > 0) await sleep(wait);
  lastAf = Date.now();
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

// ESPN : gratuit, sans clé ni quota (API non officielle : si elle change, on retombe sur API-Football)
const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
async function espn(url) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 PronoFoot' } });
      if (r.ok) return await r.json();
    } catch { /* nouvel essai */ }
    await sleep(800);
  }
  throw new Error('ESPN indisponible : ' + url);
}

async function espnLoadCompetition(code) {
  const st = await espn(`https://site.api.espn.com/apis/v2/sports/soccer/${code}/standings`);
  const groups = st.children || [st];
  const ids = groups.flatMap(g => ((g.standings && g.standings.entries) || []).map(e => e.team.id));
  const schedules = [];
  for (const id of ids) {
    try { schedules.push(await espn(`${ESPN_SITE}${code}/teams/${id}/schedule`)); } catch (e) { console.warn(e.message); }
    await sleep(120);
  }
  return espnCompetition(st, schedules);
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

// ---------- Bilan de la veille et apprentissage ----------
const BILAN_FILE = path.join(DATA, 'bilan.json');
const FINISHED = ['FT', 'AET', 'PEN'];

async function readBilan() {
  try { return JSON.parse(await fs.readFile(BILAN_FILE, 'utf8')); } catch { return { days: [], teams: {} }; }
}

// Vérifie les pistes de la veille avec les vrais scores, explique les erreurs,
// et met à jour la mémoire de chaque équipe (buts attendus / buts réels).
async function reviewYesterday(today, bilan) {
  const y = new Date(Date.parse(today + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  if (bilan.days.some(d => d.date === y)) return;
  let prev;
  try { prev = JSON.parse(await fs.readFile(path.join(DATA, 'archive', `${y}.json`), 'utf8')); } catch { return; }
  const fx = await af('fixtures', { date: y, timezone: 'Europe/Paris' });
  const scores = {};
  for (const f of fx.response || []) if (FINISHED.includes(f.fixture.status.short)) scores[f.fixture.id] = [f.goals.home, f.goals.away];

  const analyses = {};
  prev.matches.forEach(m => { analyses[m.id] = analyzeMatch(m); });
  const topIds = new Set(topPicks(prev.matches.map(m => ({ ...m, status: 'NS' })), analyses).map(t => t.m.id));
  const day = { date: y, matches: [] };
  const remember = (id, name, kind, exp, act) => {
    const t = bilan.teams[id] = bilan.teams[id] || { name, att: [], def: [] };
    t[kind].push([+exp.toFixed(2), act]);
    t[kind] = t[kind].slice(-10);
  };
  for (const m of prev.matches) {
    const sc = scores[m.fixtureId];
    if (!sc || !m.stats) continue;
    const [h, a] = sc, an = analyses[m.id];
    const picks = an.tips.filter(t => !String(t.key).startsWith('SC')).map(t => {
      const ok = tipResult(t.key, h, a);
      return { key: t.key, label: t.label, p: +t.p.toFixed(3), ok, why: ok === false ? failReason(m, an.lh, an.la, h, a) : '' };
    }).filter(p => p.ok !== null);
    day.matches.push({
      id: m.id, comp: m.comp.name, home: m.home.name, away: m.away.name, score: `${h}-${a}`,
      exp: `${an.lh.toFixed(1)}-${an.la.toFixed(1)}`, verdict: an.verdict.label, top: topIds.has(m.id),
      official: !!(m.lineups && m.lineups.home && m.lineups.home.status === 'officielle'), picks,
    });
    remember(m.home.id, m.home.name, 'att', an.lh, h);
    remember(m.away.id, m.away.name, 'att', an.la, a);
    remember(m.home.id, m.home.name, 'def', an.la, a);
    remember(m.away.id, m.away.name, 'def', an.lh, h);
  }
  bilan.days.unshift(day);
  bilan.days = bilan.days.slice(0, 60);
  bilan.updatedAt = new Date().toISOString();
  const all = day.matches.flatMap(x => x.picks), ok = all.filter(p => p.ok).length;
  console.log(`Bilan du ${y} : ${ok}/${all.length} pistes réussies`);
  return { y, ok, total: all.length, top: day.matches.filter(x => x.top).flatMap(x => x.picks.slice(0, 1)) };
}

// Applique ce que le robot a appris sur chaque équipe aux matchs du jour
function applyLearning(matches, bilan) {
  for (const m of matches) {
    if (!m.stats || !m.adj) continue;
    const th = bilan.teams[m.home.id], ta = bilan.teams[m.away.id];
    const attH = biasFactor(th && th.att), defA = biasFactor(ta && ta.def);
    const attA = biasFactor(ta && ta.att), defH = biasFactor(th && th.def);
    m.adj.home *= attH * defA;
    m.adj.away *= attA * defH;
    const pct = f => `${f > 1 ? '+' : ''}${Math.round((f - 1) * 100)} %`;
    const notes = [];
    if (Math.abs(attH - 1) >= 0.05) notes.push(`${m.home.name} marque ${attH > 1 ? 'plus' : 'moins'} que prévu sur ses derniers matchs suivis (${pct(attH)})`);
    if (Math.abs(defA - 1) >= 0.05) notes.push(`${m.away.name} encaisse ${defA > 1 ? 'plus' : 'moins'} que prévu (${pct(defA)})`);
    if (Math.abs(attA - 1) >= 0.05) notes.push(`${m.away.name} marque ${attA > 1 ? 'plus' : 'moins'} que prévu (${pct(attA)})`);
    if (Math.abs(defH - 1) >= 0.05) notes.push(`${m.home.name} encaisse ${defH > 1 ? 'plus' : 'moins'} que prévu (${pct(defH)})`);
    if (notes.length) m.tierText.push(`Correction apprise des erreurs passées : ${notes.join(' ; ')}.`);
  }
}

// ---------- Collecte du matin ----------
async function daily(today) {
  const fx = await af('fixtures', { date: today, timezone: 'Europe/Paris' });
  const list = fx.response.filter(f => compByAf[f.league.id] && ['TBD', 'NS', 'PST'].includes(f.fixture.status.short));
  console.log(`${list.length} matchs suivis aujourd'hui`);

  const comps = {};
  for (const lid of [...new Set(list.map(f => f.league.id))]) {
    // 1) football-data.org (avec les buteurs) pour les grandes compétitions
    const code = FD_CODES[lid];
    if (code) {
      try {
        const st = await fd(`competitions/${code}/standings`);
        const mt = await fd(`competitions/${code}/matches?status=FINISHED`);
        const sc = await fd(`competitions/${code}/scorers?limit=80`);
        comps[lid] = buildCompetition(st, mt, sc);
        console.log(`${code} : ${comps[lid].rows.length} équipes (football-data)`);
        continue;
      } catch (e) { console.warn(e.message); }
    }
    // 2) ESPN pour les autres (Ligue 2, 2. Bundesliga, Turquie, Autriche, coupes d'Europe…)
    const ecode = ESPN_CODES[lid];
    if (!ecode) continue;
    try {
      const C = await espnLoadCompetition(ecode);
      if (C.rows.length && C.avg) { comps[lid] = C; console.log(`${ecode} : ${C.rows.length} équipes (ESPN)`); }
    } catch (e) { console.warn(e.message); }
  }

  const matches = list.map(f => buildMatch(f, comps[f.league.id]));
  // Absents : matchs avec statistiques, grandes compétitions d'abord (quota limité :
  // on garde environ 65 requêtes pour les compositions de la journée)
  const PRIORITY = [2, 61, 39, 140, 135, 78, 40, 88, 94];
  const withStats = matches.filter(m => m.stats)
    .sort((a, b) => PRIORITY.indexOf(a.comp.af) - PRIORITY.indexOf(b.comp.af) || a.kickoff - b.kickoff);
  for (const m of withStats) {
    if (afUsed >= 30) break;
    try { applyInjuries(m, await af('injuries', { fixture: m.fixtureId })); } catch (e) { console.warn(e.message); }
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
  const analyses = {};
  withStats.forEach(m => { analyses[m.id] = analyzeMatch(m); });
  const top = topPicks(withStats, analyses);
  const lines = [
    `${matches.length} matchs aujourd'hui, ${withStats.length} avec statistiques complètes.`,
    'Créneaux : ' + slots.map(s => `${hhmm(s.start)} (${s.matches.length})`).join(' · '),
    top.length
      ? `Top du jour (${top.length}) : ` + top.slice(0, 6).map(x => `${hhmm(x.m.kickoff)} ${x.m.home.name}-${x.m.away.name} : ${x.tip.label} ${pct(x.tip.p)}`).join(' | ')
      : 'Top du jour : aucune piste assez fiable pour l\'instant (à revoir avec les compositions).',
  ];
  return lines.join('\n');
}

// ---------- Compositions officielles ----------
// Compositions, à chaque passage (toutes les 5 min) :
// 1) ESPN, sans quota : de 60 min avant jusqu'au coup d'envoi ;
// 2) API-Football en secours (quota limité) : de 45 à 20 min avant, en une seule requête groupée.
const ESPN_FROM_MIN = 60;
const LINEUPS_FROM_MIN = 45, LINEUPS_UNTIL_MIN = 20;

async function espnLineups(due) {
  const found = [], boards = {};
  const parisDay = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
  for (const m of due) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!code) continue;
    try {
      const day = parisDay(m.kickoff), key = code + day;
      boards[key] = boards[key] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
      const id = espnFindEvent(boards[key], m.home.name, m.away.name);
      if (!id) continue;
      if (applyEspnLineups(m, await espn(`${ESPN_SITE}${code}/summary?event=${id}`))) found.push(m);
    } catch (e) { console.warn(e.message); }
  }
  return found;
}

async function lineupsPass(state) {
  const now = Date.now();
  const isOfficial = m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  const inWindow = (m, from, until) => m.kickoff - now <= from * 60000 && m.kickoff - now > until * 60000;
  const found = [];

  const dueEspn = state.matches.filter(m => !isOfficial(m) && inWindow(m, ESPN_FROM_MIN, -5));
  if (dueEspn.length) {
    const f = await espnLineups(dueEspn);
    found.push(...f);
    console.log(`ESPN : ${f.length}/${dueEspn.length} composition(s) trouvée(s)`);
  }

  const due = state.matches.filter(m => !isOfficial(m) && inWindow(m, LINEUPS_FROM_MIN, LINEUPS_UNTIL_MIN));
  if (due.length) console.log(`API-Football : compositions recherchées pour ${due.length} match(s)`);
  for (let i = 0; i < due.length; i += 20) {
    if (afUsed >= AF_BUDGET) break;
    const chunk = due.slice(i, i + 20);
    try {
      const j = await af('fixtures', { ids: chunk.map(m => m.fixtureId).join('-') });
      for (const f of j.response || []) {
        const m = chunk.find(x => x.fixtureId === f.fixture.id);
        if (m && applyLineups(m, { response: f.lineups || [] })) found.push(m);
      }
    } catch (e) {
      // Si la recherche groupée est refusée, on interroge les matchs un par un
      console.warn('Recherche groupée impossible :', e.message);
      for (const m of chunk) {
        if (afUsed >= AF_BUDGET) break;
        try { if (applyLineups(m, await af('fixtures/lineups', { fixture: m.fixtureId }))) found.push(m); } catch (err) { console.warn(err.message); break; }
      }
    }
  }
  console.log(`${found.length} composition(s) trouvée(s)`);
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
    // Bilan de la veille d'abord (il sert à corriger les analyses du jour)
    const bilan = await readBilan();
    let review = null;
    try { review = await reviewYesterday(today, bilan); } catch (e) { console.warn('Bilan impossible :', e.message); }
    await fs.writeFile(BILAN_FILE, JSON.stringify(bilan));

    const matches = await daily(today);
    applyLearning(matches, bilan);
    state = { date: today, generatedAt: new Date().toISOString(), afUsed: 0, matches, events: [] };
    let summary = dailySummary(matches);
    if (review && review.total) summary = `Bilan d'hier : ${review.ok}/${review.total} pistes réussies.\n` + summary;
    state.events.unshift({ t: Date.now(), level: 'info', title: 'Analyse du jour prête', body: summary.replace(/\n/g, ' | ') });
    await notify('PronoFoot : analyse du jour prête', summary);
    changed = true;
  } else {
    afUsed = state.afUsed || 0;
  }
  const usedBefore = afUsed;
  if (await lineupsPass(state)) changed = true;

  // Le compteur de requêtes doit être enregistré même sans nouveauté (pour respecter le quota)
  if (!changed && afUsed === usedBefore) { console.log('Rien de nouveau.'); return; }
  state.afUsed = afUsed;
  state.updatedAt = new Date().toISOString();
  state.events = state.events.slice(0, 60);
  const json = JSON.stringify(state);
  await fs.writeFile(TODAY_FILE, json);
  await fs.writeFile(path.join(DATA, 'archive', `${today}.json`), json);
  console.log(`Enregistré (${afUsed} requêtes API-Football utilisées aujourd'hui).`);
}

main().catch(e => { console.error(e); process.exit(1); });
