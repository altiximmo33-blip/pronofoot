// Robot PronoFoot : lancé toutes les 15 minutes par GitHub Actions.
// - Premier passage de la journée (après 7h) : programme, bilans domicile/extérieur,
//   niveau des adversaires, buteurs, absents → docs/data/today.json + notification.
// - Passages suivants : compositions officielles à partir d'1 h avant chaque match → notification.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeMatch } from '../docs/js/model.js';
import { compByAf } from '../docs/js/config.js';
import { FD_CODES, ESPN_CODES, buildCompetition, buildMatch, applyInjuries, applyLineups, groupSlots, hhmm, tipResult, failReason, biasFactor, topPicks, espnCompetition, espnScorers, espnStartersOf, espnRedCards, espnGoalScorers, scorerTipResult, failCause, espnPenalties, penTakers, espnStartersWithLine, espnSquad, rotationText, espnTeamGoals, similarity, domesticLevel, unknownLevel, levelFactor, espnFindEvent, applyEspnLineups, espnLiveScore, comboLegs, espnEventTeams, espnTeamMatchStats, perfSummary, bestSlot, FDCOUK_CODES, fdcoukCompetition, fdcoukForMatch, fdcoukUpcomingOdds } from '../docs/js/core.js';

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
  // Meilleurs buteurs du championnat (pour les paris buteur)
  let scorers = null;
  try { scorers = espnScorers(await espn(`${ESPN_SITE}${code}/statistics`)); } catch (e) { console.warn(e.message); }
  return espnCompetition(st, schedules, scorers);
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

// ---------- Tireurs de penalty : mémoire de tous les penalties de la saison (ESPN) ----------
// Le robot parcourt les journées passées de chaque championnat, un peu à chaque passage,
// puis retient qui a tiré chaque penalty pour chaque équipe.
const PENS_FILE = path.join(DATA, 'penalties.json');
async function penaltiesBackfill(budget) {
  let P;
  try { P = JSON.parse(await fs.readFile(PENS_FILE, 'utf8')); } catch { P = { scanned: {}, teams: {} }; }
  P.cal = P.cal || {};
  const yesterday = ymd(Date.now() - 86400000), today = ymd(Date.now());
  let used = 0, added = 0;
  for (const code of [...new Set(Object.values(ESPN_CODES))]) {
    if (used >= budget) break;
    const done = new Set(P.scanned[code] || []);
    // Jours de match de la saison (calendrier « par jour » ; les coupes à calendrier par tour sont ignorées),
    // relus une fois par jour seulement
    if (!P.cal[code] || P.cal[code].at !== today) {
      try {
        const sb = await espn(`${ESPN_SITE}${code}/scoreboard`); used++;
        P.cal[code] = { at: today, days: ((sb.leagues && sb.leagues[0] && sb.leagues[0].calendar) || []).filter(d => typeof d === 'string').map(d => d.slice(0, 10).replace(/-/g, '')) };
      } catch { continue; }
    }
    const days = P.cal[code].days;
    for (const d of days.filter(x => x <= yesterday && !done.has(x))) {
      if (used >= budget) break;
      try {
        const sb = await espn(`${ESPN_SITE}${code}/scoreboard?dates=${d}`); used++;
        for (const p of espnPenalties(sb)) {
          const list = P.teams[p.team] = P.teams[p.team] || [];
          if (list.some(x => x.ev === p.ev && x.n === p.n && x.m === p.m)) continue;
          list.push({ ev: p.ev, d, n: p.n, ok: p.ok, m: p.m });
          if (list.length > 40) list.shift();
          added++;
        }
        done.add(d);
      } catch { /* journée indisponible : on réessaiera */ }
      await sleep(80);
    }
    P.scanned[code] = [...done];
  }
  await fs.writeFile(PENS_FILE, JSON.stringify(P));
  console.log(`Penalties : ${used} journées lues, ${added} penalties ajoutés`);
  return { P, added };
}

// Tireurs de penalty des deux équipes de chaque match (identifiants ESPN trouvés le matin)
function attachPens(matches, P) {
  let changed = false;
  for (const m of matches) {
    if (!m.espn) continue;
    const pens = { home: penTakers(P.teams['espn-' + m.espn.home]), away: penTakers(P.teams['espn-' + m.espn.away]) };
    if (JSON.stringify(pens) !== JSON.stringify(m.pens || null)) { m.pens = pens; changed = true; }
  }
  return changed;
}
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
  const scores = {}, boards = {}, ctxs = {}, day8 = y.replace(/-/g, '');
  for (const m of prev.matches) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!code || !m.stats) continue;
    try {
      boards[code] = boards[code] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day8}`);
      const s = espnLiveScore(boards[code], m.home.name, m.away.name);
      if (!s || s.state !== 'post') continue;
      scores[m.id] = [s.h, s.a];
      // De quoi expliquer un échec : cartons rouges, tirs cadrés, titulaires réels
      const ctx = { reds: espnRedCards(boards[code], m.home.name, m.away.name), goals: espnGoalScorers(boards[code], m.home.name, m.away.name), sot: null, xi: null };
      const ids = espnEventTeams(boards[code], m.home.name, m.away.name, espnIdOf(m));
      if (ids) {
        try {
          const sum = await espn(`${ESPN_SITE}${code}/summary?event=${ids.id}`);
          const sh = espnTeamMatchStats(sum, ids.homeId);
          if (sh) ctx.sot = { home: sh.sotF, away: sh.sotA };
          ctx.xi = { home: espnStartersOf(sum, ids.homeId), away: espnStartersOf(sum, ids.awayId) };
        } catch { /* résumé indisponible */ }
        await sleep(100);
      }
      ctxs[m.id] = ctx;
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
      return { key: t.key, label: t.label, p: +t.p.toFixed(3), ok };
    }).filter(p => p.ok !== null);
    // Cause : carton rouge, compo, malchance ou vraie erreur de stats
    const cause = failCause(m, an, h, a, picks.filter(p => !p.ok), ctxs[m.id] || {});
    picks.forEach(p => { p.why = p.ok ? '' : cause ? cause.t : failReason(m, an.lh, an.la, h, a); });
    day.matches.push({
      id: m.id, comp: m.comp.name, home: m.home.name, away: m.away.name, score: `${h}-${a}`,
      exp: `${an.lh.toFixed(1)}-${an.la.toFixed(1)}`, verdict: an.verdict.label, top: topIds.has(m.id),
      official: !!(m.lineups && m.lineups.home && m.lineups.home.status === 'officielle'), picks,
      cause: cause && picks.some(p => !p.ok) ? cause.k : null,
      // Paris buteur (comptés à part, pour ne pas mélanger avec la réussite des pistes)
      scorerPicks: (ctxs[m.id] && ctxs[m.id].goals) ? an.tips.filter(t => ['SC', 'SC2', 'SCD'].includes(t.key))
        .map(t => ({ key: t.key, label: t.label, p: +t.p.toFixed(3), ok: scorerTipResult(t, ctxs[m.id].goals) }))
        .filter(p => p.ok !== null) : [],
      scorers: (ctxs[m.id] && ctxs[m.id].goals) || [],
    });
    // Seuls les matchs « normaux » nourrissent la mémoire : un carton rouge, une compo inconnue
    // ou un match dominé sans réussite fausseraient la correction des équipes
    if (cause && cause.k !== 'stats') continue;
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

// ---------- Coupes et coupes d'Europe : stats, buteurs et niveau du championnat de chaque équipe ----------
// En coupe, on n'a que quelques matchs de la compétition : on prend plutôt le bilan domicile / extérieur
// et les buteurs du championnat de chaque équipe, puis on corrige selon l'écart de niveau (division, pays, classement).
async function enrichCups(matches, today) {
  const teamCache = {}, scorersCache = {}, boards = {};
  const team = async (slug, id) => {
    const k = slug + '/' + id;
    if (!(k in teamCache)) { try { teamCache[k] = await espn(`${ESPN_SITE}${slug}/teams/${id}`); } catch { teamCache[k] = null; } }
    return teamCache[k];
  };
  for (const m of matches) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!code || !['cup', 'europe'].includes(m.comp.type)) continue;
    try {
      if (!m.espn) {
        const day = ymd(m.kickoff);
        boards[code + day] = boards[code + day] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
        const ids = espnEventTeams(boards[code + day], m.home.name, m.away.name, espnIdOf(m));
        if (!ids) continue;
        m.espn = { id: ids.id, home: ids.homeId, away: ids.awayId };
      }
      const level = {};
      for (const side of ['home', 'away']) {
        const first = await team(code, m.espn[side]);
        const slug = first && first.team && first.team.defaultLeague && first.team.defaultLeague.slug;
        if (!slug || slug.startsWith('uefa.') || slug === code) continue;
        const L = domesticLevel(await team(slug, m.espn[side]));
        if (L) level[side] = L;
      }
      if (!level.home && !level.away) continue;
      // Championnat non couvert par ESPN (Tchéquie, Azerbaïdjan, Slovaquie…) : forcément plus modeste que les grands
      for (const side of ['home', 'away']) if (!level[side]) level[side] = unknownLevel();
      m.level = level;
      // Bilan domicile / extérieur du championnat (si assez de matchs) : mélangé 50/50 avec celui de la compétition,
      // ou utilisé seul quand la coupe n'a pas de statistiques
      if (level.home.home.p >= 3 && level.away.away.p >= 3) {
        const dom = { avgHome: 1.5, avgAway: 1.2, home: level.home.home, away: level.away.away };
        const split = L => ({ home: L.home, away: L.away, n: null, ranks: {}, avg: { avgHome: 1.5, avgAway: 1.2 } });
        const domTs = { home: split(level.home), away: split(level.away) };
        if (m.stats) { m.domStats = dom; m.domTeamStats = domTs; m.statsSource = 'mixte'; }
        else { m.stats = dom; m.teamStats = domTs; m.statsSource = 'championnat'; }
      }
      // Correction selon l'écart de niveau (bornée) : un 2 buts par match en National ne vaut pas 2 buts en Ligue 1
      const f = levelFactor(level);
      m.adj = m.adj || { home: 1, away: 1 };
      m.adj.home *= f; m.adj.away /= f;
      // Buteurs du championnat de chaque équipe
      for (const side of ['home', 'away']) {
        const slug = level[side].slug;
        if (!slug) continue;
        if (!(slug in scorersCache)) { try { scorersCache[slug] = espnScorers(await espn(`${ESPN_SITE}${slug}/statistics`)); } catch { scorersCache[slug] = null; } }
        const list = ((scorersCache[slug] && scorersCache[slug].scorers) || []).filter(x => x.team.id === 'espn-' + m.espn[side])
          .map(x => ({ id: null, name: x.player.name, goals: x.goals, played: x.playedMatches, pos: 'A' }));
        if (list.length) {
          m.scorers = m.scorers || { home: [], away: [] };
          m.scorers[side] = list.slice(0, 5);
          m.teamGoals = m.teamGoals || {}; m.teamGames = m.teamGames || {};
          m.teamGoals[side] = level[side].gf; m.teamGames[side] = level[side].gp;
        }
      }
      console.log(`Coupe : ${m.home.name} (${level.home.league}) – ${m.away.name} (${level.away.league}), facteur ${f.toFixed(2)}`);
    } catch (e) { console.warn('Coupe :', e.message); }
    await sleep(80);
  }
}

async function enrichEspn(matches, bilan, today) {
  // Matchs européens des 3 dernières semaines (fatigue, et équipe type toutes compétitions confondues)
  const euro = [];
  for (let d = 1; d <= 21; d++) {
    const day = ymd(Date.parse(today + 'T12:00:00Z') - d * 86400000);
    for (const [code, label] of Object.entries(UEFA)) {
      try {
        const sb = await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
        for (const ev of sb.events || []) {
          const c = ev.competitions[0];
          if (!c.status || !c.status.type || !c.status.type.completed) continue;
          c.competitors.forEach(x => euro.push({ teamId: String(x.team.id), ev: ev.id, code, date: Date.parse(ev.date), comp: label, away: x.homeAway === 'away', opp: (c.competitors.find(y => y !== x) || {}).team?.displayName || '' }));
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
      ids = espnEventTeams(boards[code + day], m.home.name, m.away.name, espnIdOf(m));
    } catch (e) { console.warn(e.message); continue; }
    if (!ids) continue;
    m.espn = { id: ids.id, home: ids.homeId, away: ids.awayId };
    m.perf = {}; m.fatigue = {}; m.notes = m.notes || [];
    for (const side of ['home', 'away']) {
      const espnId = side === 'home' ? ids.homeId : ids.awayId, name = m[side].name;
      const mem = bilan.teams[m[side].id] = bilan.teams[m[side].id] || { name, att: [], def: [] };
      mem.perf = mem.perf || [];
      let lastDate = 0;
      try {
        // Derniers matchs TOUTES compétitions : championnat (+ championnat national pour une coupe) + coupes d'Europe
        const codes = [...new Set([code, m.level && m.level[side] && m.level[side].slug].filter(Boolean))];
        const evs = new Map();
        for (const c of codes) {
          try {
            schedules[c + espnId] = schedules[c + espnId] || await espn(`${ESPN_SITE}${c}/teams/${espnId}/schedule`);
            (schedules[c + espnId].events || [])
              .filter(ev => ev.competitions && ev.competitions[0].status && ev.competitions[0].status.type.completed)
              .forEach(ev => evs.set(ev.id, { id: ev.id, date: ev.date, code: c }));
          } catch { /* calendrier indisponible */ }
        }
        euro.filter(e => e.teamId === String(espnId) && e.date < m.kickoff).forEach(e => { if (!evs.has(e.ev)) evs.set(e.ev, { id: e.ev, date: new Date(e.date).toISOString(), code: e.code }); });
        const done = [...evs.values()].sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
        if (done[0]) lastDate = Date.parse(done[0].date);
        // Statistiques (5 derniers), onze de départ et buteurs (8 derniers) : déjà lus = gardés en mémoire
        mem.xis = mem.xis || []; mem.goals = mem.goals || [];
        for (const [i, ev] of done.slice(0, 8).entries()) {
          const needPerf = i < 5 && !mem.perf.some(p => p.ev === ev.id), needXI = !mem.xis.some(x => x.ev === ev.id), needGoals = !mem.goals.some(x => x.ev === ev.id);
          if (!needPerf && !needXI && !needGoals) continue;
          try {
            const sum = await espn(`${ESPN_SITE}${ev.code}/summary?event=${ev.id}`);
            const st = needPerf && espnTeamMatchStats(sum, espnId);
            if (st) mem.perf.push({ ev: ev.id, date: ev.date, ...st });
            const xi = needXI && espnStartersWithLine(sum, espnId);
            if (xi) mem.xis.push({ ev: ev.id, date: ev.date, xi });
            const g = needGoals && espnTeamGoals(sum, espnId);
            if (g) mem.goals.push({ ev: ev.id, date: ev.date, ...g });
          } catch { /* match sans statistiques */ }
          await sleep(100);
        }
        const recentIds = new Set(done.slice(0, 8).map(e => e.id));
        mem.perf = mem.perf.sort((x, y) => Date.parse(x.date) - Date.parse(y.date)).slice(-10);
        mem.xis = mem.xis.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)).slice(0, 10);
        mem.goals = mem.goals.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)).slice(0, 10);
        // Équipe type : onzes des 8 derniers matchs
        const xis = mem.xis.filter(x => recentIds.has(x.ev));
        if (xis.length >= 3) (m.recentXI = m.recentXI || {})[side] = xis.map(x => x.xi);
        // Buteurs en forme : buts sur les 6 derniers matchs
        const gl = mem.goals.filter(x => recentIds.has(x.ev)).slice(0, 6);
        if (gl.length >= 3) {
          const players = {};
          gl.forEach(x => x.scorers.forEach(n => { players[n] = (players[n] || 0) + 1; }));
          (m.recentGoals = m.recentGoals || {})[side] = { games: gl.length, teamGoals: gl.reduce((s, x) => s + x.gf, 0), players };
        }
        // Onze de départ du dernier match (repère, quand l'équipe type n'est pas encore connue)
        const last = mem.xis.find(x => done[0] && x.ev === done[0].id);
        if (last) (m.lastXI = m.lastXI || {})[side] = last.xi.map(p => p.n);
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
// Panne d'API-Football le matin (source des absents) : affichée sur la page
let afError = null;

async function daily(today) {
  let list, afDown = false;
  try {
    const fx = await af('fixtures', { date: today, timezone: 'Europe/Paris' });
    list = fx.response.filter(f => compByAf[f.league.id] && ['TBD', 'NS', 'PST'].includes(f.fixture.status.short));
  } catch (e) {
    console.warn('API-Football indisponible, programme pris sur ESPN :', e.message);
    afError = e.message;
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
    if (afDown || afUsed >= 30) break;
    if (typeof m.fixtureId !== 'number') continue; // match ajouté depuis ESPN : absents revérifiés à H-3 et H-1
    try { applyInjuries(m, await af('injuries', { fixture: m.fixtureId })); m.injChecked = Date.now(); } catch (e) { console.warn(e.message); }
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

// Garde-fou : deux matchs du jour ne peuvent pas pointer vers le même match ESPN.
// En cas de doublon, on garde celui dont l'identifiant est sûr et on retire aux autres tout ce qui vient d'ESPN
// (forme, fatigue, onzes, penalties, niveau) : mieux vaut pas d'info qu'une info d'un autre match.
function dedupeEspn(matches) {
  const by = {};
  matches.filter(m => m.espn && m.espn.id).forEach(m => { (by[m.espn.id] = by[m.espn.id] || []).push(m); });
  for (const [id, list] of Object.entries(by)) {
    if (list.length < 2) continue;
    for (const m of list) {
      if (espnIdOf(m) === id) continue;
      console.warn(`Doublon ESPN ${id} : infos ESPN retirées pour ${m.home.name} – ${m.away.name}`);
      for (const k of ['espn', 'perf', 'fatigue', 'lastXI', 'recentXI', 'pens', 'level', 'squad']) delete m[k];
      m.notes = [];
    }
  }
}
// Identifiant ESPN d'un match venu du programme ESPN (fixtureId « e401900893 »)
const espnIdOf = m => (/^e(\d+)$/.exec(String(m.fixtureId || '')) || [])[1] || null;
// Le résumé ESPN concerne-t-il bien ce match ? (les deux équipes doivent ressembler)
function summaryMatches(sum, m) {
  const comps = (sum && sum.header && sum.header.competitions && sum.header.competitions[0] && sum.header.competitions[0].competitors) || [];
  const h = comps.find(c => c.homeAway === 'home'), a = comps.find(c => c.homeAway === 'away');
  if (!h || !a) return false;
  const ok = (name, t) => Math.max(similarity(name, t.displayName || ''), similarity(name, t.shortDisplayName || t.name || '')) >= 0.5;
  return ok(m.home.name, h.team) && ok(m.away.name, a.team);
}

async function espnLineups(due) {
  const found = [], boards = {};
  const parisDay = t => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
  for (const m of due) {
    const code = ESPN_CODES[m.comp && m.comp.af];
    if (!code) continue;
    try {
      const day = parisDay(m.kickoff), key = code + day;
      boards[key] = boards[key] || await espn(`${ESPN_SITE}${code}/scoreboard?dates=${day}`);
      // Identifiant ESPN connu quand le match vient du programme ESPN ; sinon recherche par les noms
      const id = espnIdOf(m) || espnFindEvent(boards[key], m.home.name, m.away.name);
      if (!id) continue;
      const sum = await espn(`${ESPN_SITE}${code}/summary?event=${id}`);
      // Garde-fou : les équipes du résumé doivent bien être celles du match
      if (!summaryMatches(sum, m)) { console.warn(`Compos ignorées : le match ESPN ${id} ne correspond pas à ${m.home.name} – ${m.away.name}`); continue; }
      if (applyEspnLineups(m, sum)) found.push(m);
    } catch (e) { console.warn(e.message); }
  }
  return found;
}

// ---------- Absents revérifiés 3 h puis 1 h avant chaque match ----------
// La liste des blessés est souvent en retard (Ligue des champions, forfaits annoncés en conférence de presse) :
// on la recharge, par paquets de 20 matchs. Les matchs venus du programme ESPN sont d'abord retrouvés
// dans le programme API-Football du jour (1 requête).
async function injuriesPass(state) {
  const now = Date.now();
  const stage = m => { const mins = (m.kickoff - now) / 60000; return mins <= 70 && mins > 5 ? 'h1' : mins <= 190 && mins > 70 ? 'h3' : null; };
  const due = state.matches.filter(m => m.stats && stage(m) && !(m.injStages || []).includes(stage(m)));
  if (!due.length || afUsed >= AF_BUDGET - 5) return false;
  // Compte suspendu ou clé refusée : inutile de réessayer avant le lendemain
  if (state.afError && /suspend|account|token|key/i.test(state.afError.msg || '')) return false;
  // Identifiants API-Football des matchs venus d'ESPN
  if (due.some(m => typeof m.fixtureId !== 'number')) {
    try {
      if (!state.afFixtures) {
        const fx = await af('fixtures', { date: state.date, timezone: 'Europe/Paris' });
        state.afFixtures = fx.response.filter(f => compByAf[f.league.id]).map(f => ({ id: f.fixture.id, h: f.teams.home.name, a: f.teams.away.name, hid: f.teams.home.id, aid: f.teams.away.id }));
      }
      for (const m of due.filter(x => typeof x.fixtureId !== 'number')) {
        const f = state.afFixtures.find(x => similarity(x.h, m.home.name) >= 0.6 && similarity(x.a, m.away.name) >= 0.6);
        if (f) { m.afFixture = f.id; m.afTeams = { home: f.hid, away: f.aid }; }
      }
      state.afError = null;
    } catch (e) { state.afError = { at: now, msg: e.message }; console.warn('API-Football toujours indisponible :', e.message); return true; }
  }
  const idOf = m => typeof m.fixtureId === 'number' ? m.fixtureId : m.afFixture;
  const ready = due.filter(idOf);
  let changed = false;
  for (let i = 0; i < ready.length; i += 20) {
    if (afUsed >= AF_BUDGET - 3) break;
    const chunk = ready.slice(i, i + 20);
    let resp;
    try { resp = (await af('injuries', { ids: chunk.map(idOf).join('-') })).response || []; }
    catch (e) { console.warn('Absents groupés impossibles :', e.message); state.afError = { at: now, msg: e.message }; break; }
    for (const m of chunk) {
      const added = applyInjuries(m, { response: resp.filter(x => x.fixture && x.fixture.id === idOf(m)) });
      m.injStages = [...(m.injStages || []), stage(m)];
      m.injChecked = now;
      changed = true;
      if (added.length) {
        const title = `Nouvel absent : ${m.home.name} – ${m.away.name}`;
        const body = added.map(x => `${x.name} (${m[x.side].name}${x.reason ? `, ${x.reason}` : ''})`).join(', ');
        state.events.unshift({ t: Date.now(), matchId: m.id, level: 'warn', title, body });
        if (analyzeMatch(m).verdict.code !== 'skip') await notify(title, body);
      }
    }
  }
  // Matchs sans identifiant API-Football : on note quand même l'étape, pour ne pas réessayer en boucle
  due.filter(m => !idOf(m)).forEach(m => { m.injStages = [...(m.injStages || []), stage(m)]; changed = true; });
  return changed;
}

// Effectif ESPN des deux équipes (poste, matchs joués) dès que les compos sont connues : sert au turn-over
async function loadSquads(m) {
  const code = ESPN_CODES[m.comp && m.comp.af];
  if (!code || !m.espn || m.squad) return;
  m.squad = {};
  for (const side of ['home', 'away']) {
    try { m.squad[side] = espnSquad(await espn(`${ESPN_SITE}${code}/teams/${m.espn[side]}/roster`)); } catch (e) { console.warn('Effectif :', e.message); }
  }
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

  // (matchs venus d'ESPN : identifiant API-Football retrouvé par la revérification des absents)
  const afId = m => typeof m.fixtureId === 'number' ? m.fixtureId : m.afFixture;
  const due = state.matches.filter(m => !isOfficial(m) && afId(m) && inWindow(m, LINEUPS_FROM_MIN, LINEUPS_UNTIL_MIN));
  if (due.length) console.log(`API-Football : compositions recherchées pour ${due.length} match(s)`);
  for (let i = 0; i < due.length; i += 20) {
    if (afUsed >= AF_BUDGET) break;
    const chunk = due.slice(i, i + 20);
    try {
      const j = await af('fixtures', { ids: chunk.map(afId).join('-') });
      for (const f of j.response || []) {
        const m = chunk.find(x => afId(x) === f.fixture.id);
        if (m && applyLineups(m, { response: f.lineups || [] })) found.push(m);
      }
    } catch (e) {
      // Si la recherche groupée est refusée, on interroge les matchs un par un
      console.warn('Recherche groupée impossible :', e.message);
      for (const m of chunk) {
        if (afUsed >= AF_BUDGET) break;
        try { if (applyLineups(m, await af('fixtures/lineups', { fixture: afId(m) }))) found.push(m); } catch (err) { console.warn(err.message); break; }
      }
    }
  }
  console.log(`${found.length} composition(s) trouvée(s)`);
  if (!found.length) return false;
  // Effectifs (poste, matchs joués) pour décrire le turn-over
  for (const m of found) await loadSquads(m);

  // Une notification par créneau
  for (const slot of groupSlots(found)) {
    const lines = slot.matches.map(m => {
      const a = analyzeMatch(m);
      const benched = [...a.presence.home.missing, ...a.presence.away.missing].filter(p => p.status === 'remplacant' || p.status === 'absent').map(p => p.name);
      const rot = ['home', 'away'].map(s => rotationText(m, a.presence[s], s)).filter(r => r && r.level === 'bad').map(r => r.short);
      return `${m.home.name}-${m.away.name} : ${bestTip(a)}${benched.length ? ` · absents/banc : ${benched.slice(0, 3).join(', ')}` : ''}${rot.length ? ` · ⚠ ${rot.join(' ; ')}` : ''}`;
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
    try { await enrichCups(matches, today); } catch (e) { console.warn('Coupes :', e.message); }
    try { await enrichEspn(matches, bilan, today); } catch (e) { console.warn('Forme / fatigue :', e.message); }
    dedupeEspn(matches);
    await fs.writeFile(BILAN_FILE, JSON.stringify(bilan));
    state = { date: today, generatedAt: new Date().toISOString(), afUsed: 0, matches, events: [], afError: afError ? { at: Date.now(), msg: afError } : null };
    let summary = dailySummary(matches);
    if (review && review.total) summary = `Bilan d'hier : ${review.ok}/${review.total} pistes réussies.\n` + summary;
    state.events.unshift({ t: Date.now(), level: 'info', title: 'Analyse du jour prête', body: summary.replace(/\n/g, ' | ') });
    await notify('PronoFoot : analyse du jour prête', summary);
    changed = true;
  } else {
    afUsed = state.afUsed || 0;
  }
  // Tireurs de penalty : la mémoire se complète un peu à chaque passage
  try {
    const { P } = await penaltiesBackfill(changed ? 200 : 40); // plus large juste après la collecte du matin
    if (attachPens(state.matches, P)) changed = true;
  } catch (e) { console.warn('Penalties :', e.message); }
  phase = 'compositions et scores en direct';
  const usedBefore = afUsed;
  try { if (await injuriesPass(state)) changed = true; } catch (e) { console.warn('Absents :', e.message); }
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
