// Robot PronoFoot : lancé toutes les 15 minutes par GitHub Actions.
// - Premier passage de la journée (après 7h) : programme, bilans domicile/extérieur,
//   niveau des adversaires, buteurs, absents → docs/data/today.json + notification.
// - Passages suivants : compositions officielles à partir d'1 h avant chaque match → notification.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMatch } from '../docs/js/model.js';
import { compByAf } from '../docs/js/config.js';
import { FD_CODES, ESPN_CODES, buildCompetition, buildMatch, applyInjuries, applyLineups, groupSlots, hhmm, tipResult, failReason, biasFactor, topPicks, espnCompetition, espnFindEvent, applyEspnLineups, espnLiveScore, comboLegs, espnEventTeams, espnTeamMatchStats, perfSummary, bestSlot, FDCOUK_CODES, fdcoukCompetition, fdcoukForMatch, fdcoukUpcomingOdds } from '../docs/js/core.js';

const AF_KEY = process.env.APIFOOTBALL_KEY;
const FD_KEY = process.env.FOOTBALLDATA_KEY;
const NTFY = process.env.NTFY_TOPIC;
const PAGE_URL = process.env.PAGE_URL || '';
const FORCE = process.env.FORCE === 'oui';
const AF_BUDGET = 95; // l'offre gratuite d'API-Football autorise 100 requêtes par jour

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'docs', 'data');
const TODAY_FILE = path.join(DATA, 'today.json');
// État du robot : en cas d'erreur, le message est enregistré ici (lisible par la page et pour le diagnostic)
const STATUS_FILE = path.join(DATA, 'robot-status.json');
let phase = 'demarrage';

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
  let ids = groups.flatMap(g => ((g.standings && g.standings.entries) || []).map(e => e.team.id));
  // Pas de classement publié (ex. Roumanie) : liste des équipes du championnat
  if (!ids.length) {
    try {
      const t = await espn(`${ESPN_SITE}${code}/teams`);
      ids = ((t.sports && t.sports[0].leagues[0].teams) || []).map(x => x.team.id);
    } catch (e) { console.warn(e.message); }
  }
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
// Rattrape aussi les jours manqués (jusqu'à 3 jours en arrière). Les scores viennent d'ESPN
// (gratuit, sans quota), ce qui ne dépend plus d'API-Football.
async function reviewYesterday(today, bilan) {
  let latest = null;
  for (let back = 3; back >= 1; back--) {
    const y = new Date(Date.parse(today + 'T12:00:00Z') - back * 86400000).toISOString().slice(0, 10);
    try {
      const r = await reviewDay(y, bilan);
      if (r && back === 1) latest = r;
    } catch (e) { console.warn(`Bilan du ${y} impossible :`, e.message); }
  }
  bilan.days.sort((a, b) => b.date.localeCompare(a.date));
  return latest;
}

async function reviewDay(y, bilan) {
  if (bilan.days.some(d => d.date === y)) return null;
  let prev;
  try { prev = JSON.parse(await fs.readFile(path.join(DATA, 'archive', `${y}.json`), 'utf8')); } catch { return null; }
  const scores = {}, boards = {}, day8 = y.replace(/-/g, '');
  for (const m of prev.matches) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!code || !m.stats) continue;
    try {
      boards[code] = boards[code] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day8}`);
      const s = espnLiveScore(boards[code], m.home.name, m.away.name);
      if (s && s.state === 'post') scores[m.id] = [s.h, s.a];
    } catch { /* compétition indisponible */ }
  }
  if (!Object.keys(scores).length) return null;

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
    const sc = scores[m.id];
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
  bilan.days = bilan.days.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
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

// ---------- xG, note du marché et cotes du jour (football-data.co.uk, fichiers gratuits) ----------
async function fetchText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 PronoFoot' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
    } catch { /* site lent : nouvel essai */ }
    await sleep(2000);
  }
  throw new Error('Téléchargement impossible : ' + url);
}

async function enrichFdcouk(matches) {
  const season = '2627';
  const comps = {};
  let fixtures = null;
  try { fixtures = await fetchText('https://www.football-data.co.uk/fixtures.csv'); } catch (e) { console.warn(e.message); }
  let withX = 0, withOdds = 0;
  for (const m of matches) {
    const code = FDCOUK_CODES[m.comp && m.comp.af];
    if (!code || !m.stats) continue;
    if (!(code in comps)) {
      try { comps[code] = fdcoukCompetition(await fetchText(`https://www.football-data.co.uk/mmz4281/${season}/${code}.csv`)); }
      catch (e) { console.warn(e.message); comps[code] = null; }
    }
    const F = comps[code];
    if (F) {
      const fm = fdcoukForMatch(F, m.home.name, m.away.name);
      if (fm) { if (fm.xg) { m.xg = fm.xg; withX++; } if (fm.market) m.market = fm.market; }
    }
    if (fixtures && !m.odds) {
      const odds = fdcoukUpcomingOdds(fixtures, code, m.home.name, m.away.name);
      if (odds) { m.odds = odds; withOdds++; }
    }
  }
  console.log(`football-data.co.uk : xG pour ${withX} matchs, cotes pour ${withOdds} matchs`);
}

// ---------- Forme réelle et fatigue (ESPN, sans quota) ----------
// Pour chaque équipe du jour : statistiques de ses derniers matchs (tirs cadrés, possession),
// jours de repos, et match de coupe d'Europe en semaine.
const UEFA = { 'uefa.champions': 'Ligue des champions', 'uefa.europa': 'Ligue Europa', 'uefa.europa.conf': 'Ligue Conférence' };
const ymd = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');

async function enrichEspn(matches, bilan, today) {
  // Matchs européens des 5 derniers jours
  const euro = [];
  for (let d = 1; d <= 5; d++) {
    const day = ymd(Date.parse(today + 'T12:00:00Z') - d * 86400000);
    for (const [code, label] of Object.entries(UEFA)) {
      try {
        const sb = await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
        for (const ev of sb.events || []) {
          const c = ev.competitions[0];
          c.competitors.forEach(x => euro.push({ teamId: String(x.team.id), date: Date.parse(ev.date), comp: label, away: x.homeAway === 'away', opp: (c.competitors.find(y => y !== x) || {}).team?.displayName || '' }));
        }
      } catch { /* jour sans match */ }
    }
  }
  const boards = {}, schedules = {};
  const dayName = t => new Date(t).toLocaleDateString('fr-FR', { weekday: 'long', timeZone: 'Europe/Paris' });
  for (const m of matches) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!m.stats || !code) continue;
    let ids;
    try {
      const day = ymd(m.kickoff);
      boards[code + day] = boards[code + day] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
      ids = espnEventTeams(boards[code + day], m.home.name, m.away.name);
    } catch (e) { console.warn(e.message); continue; }
    if (!ids) continue;
    m.perf = {}; m.fatigue = {}; m.notes = m.notes || [];
    for (const side of ['home', 'away']) {
      const espnId = side === 'home' ? ids.homeId : ids.awayId, name = m[side].name;
      const mem = bilan.teams[m[side].id] = bilan.teams[m[side].id] || { name, att: [], def: [] };
      mem.perf = mem.perf || [];
      let lastDate = 0;
      try {
        schedules[code + espnId] = schedules[code + espnId] || await espn(`${ESPN_SITE}${code}/teams/${espnId}/schedule`);
        const done = (schedules[code + espnId].events || [])
          .filter(ev => ev.competitions && ev.competitions[0].status && ev.competitions[0].status.type.completed)
          .sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
        if (done[0]) lastDate = Date.parse(done[0].date);
        // Statistiques des 5 derniers matchs (déjà lues = gardées en mémoire)
        for (const ev of done.slice(0, 5)) {
          if (mem.perf.some(p => p.ev === ev.id)) continue;
          try {
            const st = espnTeamMatchStats(await espn(`${ESPN_SITE}${code}/summary?event=${ev.id}`), espnId);
            if (st) mem.perf.push({ ev: ev.id, date: ev.date, ...st });
          } catch { /* match sans statistiques */ }
          await sleep(100);
        }
        mem.perf = mem.perf.sort((x, y) => Date.parse(x.date) - Date.parse(y.date)).slice(-10);
      } catch (e) { console.warn(e.message); }

      // Forme réelle
      const perf = perfSummary(name, mem.perf);
      if (perf) {
        m.perf[side] = { label: perf.label, sotF: perf.sotF, sotA: perf.sotA, poss: perf.poss, n: perf.n };
        m.notes.push(perf.text);
        if (m.adj) m.adj[side] *= perf.factor;
      }
      // Fatigue : coupe d'Europe en semaine et jours de repos
      const eu = euro.filter(e => e.teamId === String(espnId) && e.date < m.kickoff).sort((x, y) => y.date - x.date)[0];
      const last = Math.max(lastDate, eu ? eu.date : 0);
      const rest = last ? Math.floor((m.kickoff - last) / 86400000) : null;
      m.fatigue[side] = { rest, euro: eu ? { comp: eu.comp, away: eu.away, opp: eu.opp, date: eu.date } : null };
      if (eu && rest != null && rest <= 4) {
        m.notes.push(`Fatigue : ${name} a joué ${dayName(eu.date)} en ${eu.comp}${eu.away ? ` à l'extérieur (déplacement chez ${eu.opp})` : ` contre ${eu.opp}`}, ${rest} jour${rest > 1 ? 's' : ''} de repos.`);
        if (m.adj) {
          m.adj[side] *= eu.away ? 0.95 : 0.97;                      // attaque émoussée
          m.adj[side === 'home' ? 'away' : 'home'] *= eu.away ? 1.04 : 1.02; // défense plus perméable
        }
      } else if (rest != null && rest <= 2) {
        m.notes.push(`Fatigue : ${name} n'a eu que ${rest} jour${rest > 1 ? 's' : ''} de repos.`);
        if (m.adj) m.adj[side] *= 0.97;
      }
    }
  }
}

// Programme du jour pris sur ESPN (si API-Football ne répond pas : quota épuisé, panne…)
async function espnFixtures(today) {
  const day = today.replace(/-/g, ''), out = [];
  for (const [afId, code] of Object.entries(ESPN_CODES)) {
    let sb;
    try { sb = await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`); } catch { continue; }
    for (const ev of sb.events || []) {
      const c = ev.competitions && ev.competitions[0];
      if (!c || !c.status || c.status.type.state !== 'pre') continue;
      if (new Date(ev.date).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }) !== today) continue;
      const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
      if (!h || !a) continue;
      const team = x => ({ id: 'espn-' + x.team.id, name: x.team.displayName, logo: x.team.logo });
      out.push({ fixture: { id: 'e' + ev.id, date: ev.date, status: { short: 'NS' } }, league: { id: +afId, season: null, round: '' }, teams: { home: team(h), away: team(a) } });
    }
    await sleep(100);
  }
  return out;
}

// ---------- Collecte du matin ----------
async function daily(today) {
  let list, afDown = false;
  try {
    const fx = await af('fixtures', { date: today, timezone: 'Europe/Paris' });
    list = fx.response.filter(f => compByAf[f.league.id] && ['TBD', 'NS', 'PST'].includes(f.fixture.status.short));
  } catch (e) {
    console.warn('API-Football indisponible, programme pris sur ESPN :', e.message);
    list = await espnFixtures(today);
    afDown = true;
  }
  // Complète avec ESPN les championnats qu'API-Football n'a pas renvoyés
  if (!afDown) {
    try {
      const have = new Set(list.map(f => f.league.id));
      const extra = (await espnFixtures(today)).filter(f => !have.has(f.league.id));
      if (extra.length) { list = list.concat(extra); console.log(`${extra.length} matchs ajoutés depuis ESPN`); }
    } catch (e) { console.warn('Complément ESPN :', e.message); }
  }
  console.log(`${list.length} matchs suivis aujourd'hui${afDown ? ' (programme ESPN)' : ''}`);

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
    if (afDown || typeof m.fixtureId !== 'number' || afUsed >= 30) break;
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
  // Meilleur créneau : le plus de matchs analysés à la même heure (à jouer 15 min avant)
  const slot = bestSlot(withStats.map(m => ({ ...m, status: 'NS' })), analyses);
  if (slot) lines.push(`Meilleur créneau : ${hhmm(slot.start)} (${slot.count} matchs), à jouer vers ${hhmm(slot.betAt)} avec les compos officielles.`);
  // Combiné du jour (5 sélections solides, sans attendre les compositions)
  const legs = comboLegs(withStats, analyses).slice(0, 5);
  if (legs.length >= 3) {
    const p = legs.reduce((acc, x) => acc * x.tip.p, 1);
    lines.push(`Combiné ${legs.length} sélections (${pct(p)}, cote ≈ ${Math.round(1 / p)}) : ` + legs.map(x => `${x.m.home.name}-${x.m.away.name} : ${x.tip.label}`).join(' | '));
  }
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

  const due = state.matches.filter(m => !isOfficial(m) && typeof m.fixtureId === 'number' && inWindow(m, LINEUPS_FROM_MIN, LINEUPS_UNTIL_MIN));
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

// ---------- Scores en direct : alertes de buts et de fin de match ----------
// Uniquement pour les matchs suivis : top du jour et matchs jugés « Intéressant ».
async function livePass(state) {
  const now = Date.now();
  const live = state.matches.filter(m => m.stats && ESPN_CODES[m.comp && m.comp.af] && m.kickoff <= now + 2 * 60000 && now - m.kickoff < 150 * 60000);
  if (!live.length) return false;
  state.live = state.live || {};
  const analyses = {};
  state.matches.forEach(m => { analyses[m.id] = analyzeMatch(m); });
  const topIds = new Set(topPicks(state.matches.map(m => ({ ...m, status: 'NS' })), analyses).map(x => x.m.id));
  const followed = live.filter(m => topIds.has(m.id) || analyses[m.id].verdict.code === 'play');
  if (!followed.length) return false;

  let changed = false;
  const boards = {};
  for (const m of followed) {
    const code = ESPN_CODES[m.comp.af];
    const day = new Date(m.kickoff).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
    let s;
    try {
      boards[code + day] = boards[code + day] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
      s = espnLiveScore(boards[code + day], m.home.name, m.away.name);
    } catch (e) { console.warn(e.message); continue; }
    if (!s || s.state === 'pre') continue;
    const prev = state.live[m.id] || { h: 0, a: 0, state: 'pre' };
    const name = `${m.home.name} ${s.h}-${s.a} ${m.away.name}`;
    const tip = analyses[m.id].tips.filter(t => !String(t.key).startsWith('SC')).sort((x, y) => y.p - x.p)[0];

    // Nouveau but (on ignore une baisse de score : but annulé par la vidéo)
    if (s.h + s.a > prev.h + prev.a) {
      const scorer = s.h > prev.h ? m.home.name : m.away.name;
      const ok = tip ? tipResult(tip.key, s.h, s.a) : null;
      await notify(`⚽ But de ${scorer} (${s.clock})`, `${name}${tip ? `\nPiste « ${tip.label} » : ${ok ? 'en bonne voie' : 'pas encore'}` : ''}`);
      state.events.unshift({ t: Date.now(), matchId: m.id, level: 'info', title: `⚽ But : ${name}`, body: `${s.clock}` });
    }
    // Coup de sifflet final
    if (s.state === 'post' && prev.state !== 'post') {
      const ok = tip ? tipResult(tip.key, s.h, s.a) : null;
      const verdict = tip ? `Piste « ${tip.label} » : ${ok ? '✓ gagnée' : '✗ perdue'}` : '';
      await notify(`Terminé : ${name}`, verdict);
      state.events.unshift({ t: Date.now(), matchId: m.id, level: ok ? 'go' : 'warn', title: `Terminé : ${name}`, body: verdict });
    }
    if (s.h !== prev.h || s.a !== prev.a || s.state !== prev.state) {
      state.live[m.id] = { h: s.h, a: s.a, state: s.state, clock: s.clock };
      changed = true;
    }
  }
  return changed;
}

// ---------- Programme principal ----------
async function main() {
  if (!AF_KEY || !FD_KEY) throw new Error('Clés manquantes : APIFOOTBALL_KEY et FOOTBALLDATA_KEY doivent être dans les secrets GitHub.');
  // Pause la nuit (1h-7h, heure de Paris) : pas de match, rien à faire
  const hour = parisHour();
  if (hour >= 1 && hour < 7 && !FORCE) { console.log('Pause de nuit (1h-7h).'); return; }
  await fs.mkdir(path.join(DATA, 'archive'), { recursive: true });
  const today = parisDate();
  let state = null;
  try { state = JSON.parse(await fs.readFile(TODAY_FILE, 'utf8')); } catch { /* premier lancement */ }

  let changed = false;
  if (!state || state.date !== today || FORCE) {
    if (parisHour() < 7 && !FORCE) { console.log('Trop tôt pour la collecte du jour.'); return; }
    // Après un échec de la collecte du matin, on attend 30 minutes avant de réessayer
    // (sinon chaque passage toutes les 5 minutes consomme le quota pour rien)
    const last = await readStatus();
    if (!FORCE && last && last.ok === false && last.phase === 'collecte du matin' && last.date === today && Date.now() - last.at < 30 * 60000) {
      console.log('Échec récent de la collecte du matin : nouvel essai dans 30 minutes.');
      return;
    }
    phase = 'collecte du matin';
    // Bilan de la veille d'abord (il sert à corriger les analyses du jour)
    const bilan = await readBilan();
    let review = null;
    try { review = await reviewYesterday(today, bilan); } catch (e) { console.warn('Bilan impossible :', e.message); }
    await fs.writeFile(BILAN_FILE, JSON.stringify(bilan));

    const matches = await daily(today);
    applyLearning(matches, bilan);
    try { await enrichFdcouk(matches); } catch (e) { console.warn('xG / marché :', e.message); }
    try { await enrichEspn(matches, bilan, today); } catch (e) { console.warn('Forme / fatigue :', e.message); }
    await fs.writeFile(BILAN_FILE, JSON.stringify(bilan));
    state = { date: today, generatedAt: new Date().toISOString(), afUsed: 0, matches, events: [] };
    let summary = dailySummary(matches);
    if (review && review.total) summary = `Bilan d'hier : ${review.ok}/${review.total} pistes réussies.\n` + summary;
    state.events.unshift({ t: Date.now(), level: 'info', title: 'Analyse du jour prête', body: summary.replace(/\n/g, ' | ') });
    await notify('PronoFoot : analyse du jour prête', summary);
    changed = true;
  } else {
    afUsed = state.afUsed || 0;
  }
  phase = 'compositions et scores en direct';
  const usedBefore = afUsed;
  if (await lineupsPass(state)) changed = true;
  try { if (await livePass(state)) changed = true; } catch (e) { console.warn('Scores en direct :', e.message); }

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

// ---------- État du robot (erreurs lisibles par la page et pour le diagnostic) ----------
async function readStatus() {
  try { return JSON.parse(await fs.readFile(STATUS_FILE, 'utf8')); } catch { return null; }
}

main()
  .then(async () => {
    // Retour à la normale : on efface l'alerte (une seule fois, pour ne pas enregistrer à chaque passage)
    const last = await readStatus();
    if (last && last.ok === false) await fs.writeFile(STATUS_FILE, JSON.stringify({ ok: true, at: Date.now() }));
  })
  .catch(async e => {
    console.error(e);
    const status = { ok: false, at: Date.now(), date: parisDate(), phase, error: String((e && e.stack) || e).slice(0, 1500) };
    try { await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(STATUS_FILE, JSON.stringify(status)); } catch { /* rien */ }
    // On termine « sans erreur » pour que l'étape Enregistrer sauvegarde ce diagnostic
    process.exit(0);
  });
