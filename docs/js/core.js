// Construction des matchs à partir des données brutes (football-data.org + API-Football).
// Module pur (pas d'accès réseau ni fichier) : utilisé par le robot et testable dans un navigateur.
import { teamSplit, norm, lineOf } from './model.js';
export { lineOf };
import { compByAf } from './config.js';

// Compétitions couvertes gratuitement par football-data.org (identifiant API-Football → code)
export const FD_CODES = { 61: 'FL1', 39: 'PL', 40: 'ELC', 140: 'PD', 135: 'SA', 78: 'BL1', 88: 'DED', 94: 'PPL', 2: 'CL' };

// ---------- Saison d'une compétition : bilans domicile / extérieur, niveaux, buteurs ----------
export function buildCompetition(standingsJson, matchesJson, scorersJson) {
  const teams = new Map();
  const ensure = t => {
    if (!teams.has(t.id)) {
      teams.set(t.id, {
        id: t.id, name: t.name, shortName: t.shortName, tla: t.tla,
        home: { p: 0, w: 0, gf: 0, ga: 0 }, away: { p: 0, w: 0, gf: 0, ga: 0 }, games: [],
      });
    }
    return teams.get(t.id);
  };
  for (const g of matchesJson.matches || []) {
    const hs = g.score && g.score.fullTime && g.score.fullTime.home, as = g.score && g.score.fullTime && g.score.fullTime.away;
    if (hs == null || as == null || !g.homeTeam || !g.homeTeam.id || !g.awayTeam || !g.awayTeam.id) continue;
    const h = ensure(g.homeTeam), a = ensure(g.awayTeam);
    h.home.p++; h.home.gf += hs; h.home.ga += as; if (hs > as) h.home.w++;
    a.away.p++; a.away.gf += as; a.away.ga += hs; if (as > hs) a.away.w++;
    h.games.push({ date: g.utcDate, opp: a.id, oppName: g.awayTeam.shortName || g.awayTeam.name, venue: 'dom', gf: hs, ga: as });
    a.games.push({ date: g.utcDate, opp: h.id, oppName: g.homeTeam.shortName || g.homeTeam.name, venue: 'ext', gf: as, ga: hs });
  }
  teams.forEach(t => t.games.sort((x, y) => Date.parse(y.date) - Date.parse(x.date)));

  // Niveaux à partir du classement général : gros (1er tiers), moyens, faibles
  const table = ((standingsJson.standings || []).find(s => s.type === 'TOTAL') || {}).table || [];
  const n = table.length || teams.size;
  const pos = {};
  table.forEach(r => { pos[r.team.id] = r.position; ensure(r.team); });
  const tierOf = id => {
    const p = pos[id];
    if (!p) return 'moyen';
    return p <= n / 3 ? 'gros' : p <= (2 * n) / 3 ? 'moyen' : 'faible';
  };

  const rows = [...teams.values()];
  const s = rows.reduce((acc, t) => ({ hg: acc.hg + t.home.gf, hp: acc.hp + t.home.p, ag: acc.ag + t.away.gf, ap: acc.ap + t.away.p }), { hg: 0, hp: 0, ag: 0, ap: 0 });
  const avg = s.hp && s.ap ? { avgHome: s.hg / s.hp, avgAway: s.ag / s.ap } : null;

  const scorers = {};
  for (const x of (scorersJson && scorersJson.scorers) || []) {
    const tid = x.team && x.team.id;
    if (!tid) continue;
    (scorers[tid] = scorers[tid] || []).push({ id: null, name: x.player.name, goals: x.goals || 0, played: x.playedMatches || null, pos: 'A' });
  }
  return { rows, avg, pos, n, tierOf, scorers, matchday: (standingsJson.season && standingsJson.season.currentMatchday) || null };
}

// ---------- Rapprochement des noms d'équipes entre les deux sources ----------
const STOP = new Set(['fc', 'afc', 'ac', 'as', 'sc', 'ssc', 'cf', 'club', 'de', 'du', 'la', 'le', 'les', 'olympique', 'stade', 'rc', 'ogc', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'sport', 'sporting', 'calcio', 'us', 'ud', 'cd', 'rcd', 'sad', 'bv', 'borussia', '1', '04', '05', 'hotspur', 'and', 'albion', 'city', 'town', 'united', 'utd',
  // Articles et sigles trop courants pour distinguer deux clubs (« Al Diriyah » / « Al Ettifaq », « FK … »)
  'al', 'el', 'fk', 'sk', 'if', 'bk', 'nk', 'cs', 'ks', 'gks', 'kv', 'kaa', 'krc', 'sv', 'ca', 'cr', 'ec', 'se', 'sd', 'ue', 'cfr', 'fcsb']);
const tokens = s => norm(s).split(' ').filter(w => w && !STOP.has(w));
const KEEP_DISTINCT = ['city', 'united'];

export function similarity(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  let hit = 0;
  for (const x of ta) {
    if (tb.includes(x)) hit += 1;
    else if (tb.some(y => x.length >= 4 && y.length >= 4 && (x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4))))) hit += 0.6;
  }
  // « City » / « United » distinguent Manchester City de Manchester United
  const na = norm(a), nb = norm(b);
  for (const k of KEEP_DISTINCT) if (na.includes(k) !== nb.includes(k) && (na.includes('manchester') || nb.includes('manchester'))) hit -= 1;
  return hit / Math.max(ta.length, tb.length);
}

export function findTeam(name, rows) {
  let best = null, bestScore = 0;
  for (const t of rows) {
    const sc = Math.max(similarity(name, t.name || ''), similarity(name, t.shortName || ''), norm(name) === norm(t.tla || '') ? 1 : 0);
    if (sc > bestScore) { bestScore = sc; best = t; }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------- Comportement contre gros / moyens / faibles ----------
const TIER_LABEL = { gros: 'les gros', moyen: 'les équipes moyennes', faible: 'les équipes faibles' };

function tierSummary(team, C, last = 8) {
  const games = team.games.slice(0, last).map(g => ({ ...g, tier: C.tierOf(g.opp) }));
  const sum = { gros: { p: 0, pts: 0, gf: 0, ga: 0 }, moyen: { p: 0, pts: 0, gf: 0, ga: 0 }, faible: { p: 0, pts: 0, gf: 0, ga: 0 } };
  games.forEach(g => {
    const s = sum[g.tier];
    s.p++; s.gf += g.gf; s.ga += g.ga; s.pts += g.gf > g.ga ? 3 : g.gf === g.ga ? 1 : 0;
  });
  return { games, sum };
}

function tierAnalysis(name, team, oppTier, C) {
  const { games, sum } = tierSummary(team, C);
  const all = games.length ? games.reduce((a, g) => a + g.gf, 0) / games.length : null;
  const vs = sum[oppTier];
  let factor = 1, text = '';
  if (vs.p >= 2 && all) {
    const ratio = (vs.gf / vs.p) / Math.max(all, 0.3);
    factor = Math.max(0.85, Math.min(1.15, 1 + 0.15 * (ratio - 1)));
    const ppm = (vs.pts / vs.p).toFixed(1);
    if (factor >= 1.07) text = `${name} est à l'aise contre ${TIER_LABEL[oppTier]} : ${ppm} pt/match et ${(vs.gf / vs.p).toFixed(1)} but/match sur ses ${vs.p} derniers matchs face à ce niveau.`;
    else if (factor <= 0.93) text = `${name} peine contre ${TIER_LABEL[oppTier]} : ${ppm} pt/match et ${(vs.gf / vs.p).toFixed(1)} but/match sur ses ${vs.p} derniers matchs face à ce niveau.`;
  }
  // Forme trompeuse sur les 5 derniers matchs
  const last5 = games.slice(0, 5);
  const losses = last5.filter(g => g.gf < g.ga), wins = last5.filter(g => g.gf > g.ga);
  let flag = '';
  if (losses.length >= 2 && losses.every(g => g.tier === 'gros')) flag = `Forme trompeuse : ${name} a perdu ses derniers matchs seulement contre des gros. Sa mauvaise série est à relativiser.`;
  else if (wins.length >= 3 && wins.every(g => g.tier === 'faible')) flag = `Forme trompeuse : ${name} n'a gagné que contre des équipes faibles. Sa bonne série est à relativiser.`;
  return { factor, text, flag, games, sum };
}

// ---------- Construction d'un match ----------
export function buildMatch(f, C) {
  const comp = compByAf[f.league.id];
  const m = {
    id: 'af-' + f.fixture.id, fixtureId: f.fixture.id, source: 'auto', comp,
    round: String(f.league.round || '').replace(/Regular Season - (\d+)/, 'Journée $1').replace(/League Stage - (\d+)/, 'Phase de ligue, journée $1'),
    kickoff: Date.parse(f.fixture.date), status: f.fixture.status.short,
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo },
    stats: null, teamStats: null, form: {}, injuries: { home: [], away: [] },
    scorers: { home: [], away: [] }, teamGoals: { home: 0, away: 0 },
    lineups: { home: null, away: null }, apiPrediction: null, odds: null, h2h: [],
    recent: null, tierStats: null, tiers: null, adj: null, tierText: [], tierFlags: [],
  };
  if (!C || !C.avg) return m;
  const th = findTeam(f.teams.home.name, C.rows), ta = findTeam(f.teams.away.name, C.rows);
  if (!th || !ta || th === ta) return m;

  m.stats = { ...C.avg, home: th.home, away: ta.away };
  m.teamStats = {
    home: { ...teamSplit(C.rows, th), avg: C.avg },
    away: { ...teamSplit(C.rows, ta), avg: C.avg },
  };
  m.scorers = { home: (C.scorers[th.id] || []).slice(0, 5), away: (C.scorers[ta.id] || []).slice(0, 5) };
  m.teamGoals = { home: th.home.gf + th.away.gf, away: ta.home.gf + ta.away.gf };
  m.teamGames = { home: th.home.p + th.away.p, away: ta.home.p + ta.away.p };
  const formOf = t => t.games.slice(0, 5).reverse().map(g => g.gf > g.ga ? 'W' : g.gf === g.ga ? 'D' : 'L').join('');
  m.form = { home: formOf(th), away: formOf(ta) };

  const tierH = C.tierOf(th.id), tierA = C.tierOf(ta.id);
  const aH = tierAnalysis(m.home.name, th, tierA, C), aA = tierAnalysis(m.away.name, ta, tierH, C);
  m.tiers = { home: tierH, away: tierA };
  m.adj = { home: aH.factor, away: aA.factor };
  m.tierStats = { home: aH.sum, away: aA.sum };
  m.recent = {
    home: aH.games.slice(0, 5).map(g => ({ date: g.date, opp: g.oppName, tier: g.tier, venue: g.venue, gf: g.gf, ga: g.ga })),
    away: aA.games.slice(0, 5).map(g => ({ date: g.date, opp: g.oppName, tier: g.tier, venue: g.venue, gf: g.gf, ga: g.ga })),
  };
  const levelTxt = `Niveau : ${m.home.name} fait partie des ${tierH === 'gros' ? 'gros' : tierH === 'moyen' ? 'équipes moyennes' : 'équipes faibles'}, ${m.away.name} des ${tierA === 'gros' ? 'gros' : tierA === 'moyen' ? 'équipes moyennes' : 'équipes faibles'} de son championnat.`;
  m.tierText = [levelTxt, aH.text, aA.text, aH.flag, aA.flag].filter(Boolean);
  m.tierFlags = [aH.flag, aA.flag].filter(Boolean);
  if (C.matchday && C.matchday < 8) m.tierText.push('Début de saison : les niveaux gros / moyens / faibles sont encore provisoires.');
  return m;
}

// ---------- Absents et compositions (API-Football) ----------
// Renvoie les nouveaux absents (par rapport à ce qui était déjà connu), pour les alertes
export function applyInjuries(m, injuriesJson) {
  // Identifiants API-Football des équipes (différents quand le match vient du programme ESPN)
  const ids = m.afTeams || { home: m.home.id, away: m.away.id };
  // La source répète parfois un même joueur : on ne le garde qu'une fois
  const seen = new Set();
  const list = (injuriesJson.response || [])
    .map(x => ({ id: null, name: x.player.name, type: x.player.type, reason: x.player.reason, team: x.team.id, src: 'API-Football', at: Date.now() }))
    .filter(x => { const k = x.team + '|' + x.name; if (seen.has(k)) return false; seen.add(k); return true; });
  const prev = m.injuries || { home: [], away: [] };
  m.injuries = { home: list.filter(x => x.team === ids.home), away: list.filter(x => x.team === ids.away) };
  const added = [];
  for (const side of ['home', 'away']) {
    for (const x of m.injuries[side]) {
      const old = (prev[side] || []).find(p => p.name === x.name);
      if (old) x.at = old.at || x.at; else added.push({ side, name: x.name, reason: x.reason });
    }
  }
  return added;
}

// ---------- Postes et turn-over ----------
export const LINE_NAME = { G: 'gardien', D: 'défense', M: 'milieu', F: 'attaque' };

// Titulaires d'une équipe dans le résumé d'un match joué, avec leur ligne : [{ n, l }]
export function espnStartersWithLine(summaryJson, espnTeamId) {
  const r = (summaryJson.rosters || []).find(x => x.team && String(x.team.id) === String(espnTeamId));
  const xi = r ? (r.roster || []).filter(p => p.starter).map(p => ({ n: (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '', l: lineOf(p.position && p.position.abbreviation) })) : [];
  return xi.length >= 11 ? xi : null;
}

// Buts d'une équipe dans le résumé d'un match joué : { gf, scorers: [noms] } (contre-son-camp exclus des buteurs)
export function espnTeamGoals(summaryJson, espnTeamId) {
  const comp = (summaryJson.header && summaryJson.header.competitions && summaryJson.header.competitions[0]) || {};
  const me = (comp.competitors || []).find(c => String(c.team.id) === String(espnTeamId));
  if (!me) return null;
  const scorers = (summaryJson.keyEvents || [])
    .filter(e => e.scoringPlay && e.team && String(e.team.id) === String(espnTeamId) && !/own goal/i.test((e.type && e.type.text) || '') && !e.shootout)
    .map(e => (e.participants && e.participants[0] && e.participants[0].athlete && e.participants[0].athlete.displayName) || '')
    .filter(Boolean);
  return { gf: +me.score || 0, scorers };
}

// Résultat d'un match joué vu par une équipe : { venue, oppId, opp, gf, ga }
export function espnTeamResult(summaryJson, espnTeamId) {
  const comps = (summaryJson.header && summaryJson.header.competitions && summaryJson.header.competitions[0] && summaryJson.header.competitions[0].competitors) || [];
  const me = comps.find(c => String(c.team.id) === String(espnTeamId)), op = comps.find(c => String(c.team.id) !== String(espnTeamId));
  if (!me || !op) return null;
  return { venue: me.homeAway, oppId: String(op.team.id), opp: op.team.displayName, gf: +me.score || 0, ga: +op.score || 0 };
}

// ---------- Forme pondérée : les résultats comparés au niveau des adversaires ----------
// Points qu'on pouvait attendre face à un adversaire (forces S de domesticLevel, avantage du terrain compris)
export function expectedPoints(selfS, oppS, venue) {
  const e = (selfS - oppS) / 10 + (venue === 'home' ? 0.35 : -0.35);
  return 3 * 0.74 / (1 + Math.exp(-e)) + 0.26;
}
// list : [{ venue, opp, gf, ga, oppS }] du plus récent au plus ancien ; selfS : force de l'équipe
// Renvoie { form: 'VNDDV', delta, label, text } — delta = points obtenus − points attendus
// selfRank : classement de l'équipe dans son championnat — les cadors (top 4) ne sont jamais en « forme flatteuse » :
// battre des équipes plus faibles, c'est leur quotidien
export function weightedForm(name, list, selfS, selfRank = null) {
  const l = (list || []).filter(x => x.oppS != null).slice(0, 5);
  if (l.length < 3 || selfS == null) return null;
  const res = x => x.gf > x.ga ? 'V' : x.gf === x.ga ? 'N' : 'D';
  const pts = x => x.gf > x.ga ? 3 : x.gf === x.ga ? 1 : 0;
  const delta = l.reduce((s, x) => s + pts(x) - expectedPoints(selfS, x.oppS, x.venue), 0);
  const tier = x => x.oppS >= selfS + 6 ? 'plus forts' : x.oppS <= selfS - 6 ? 'plus faibles' : 'de son niveau';
  const losses = l.filter(x => res(x) === 'D'), wins = l.filter(x => res(x) === 'V');
  const names = arr => arr.map(x => x.opp).join(', ');
  let label = '', text = '';
  if (losses.length >= 2 && losses.every(x => tier(x) === 'plus forts')) {
    label = 'défaites logiques'; text = `${losses.length} défaite${losses.length > 1 ? 's' : ''} sur ${l.length}, mais contre des adversaires plus forts (${names(losses)}) : à relativiser`;
  } else if (losses.length >= 2 && losses.filter(x => tier(x) === 'plus faibles').length >= 2) {
    label = 'inquiétante'; text = `a perdu contre des adversaires plus faibles (${names(losses.filter(x => tier(x) === 'plus faibles'))}) : vraie mauvaise passe`;
  } else if (wins.length >= 3 && wins.every(x => tier(x) === 'plus faibles') && delta < 2 && (!selfRank || selfRank >= 5)) {
    label = 'flatteuse'; text = `${wins.length} victoires, mais toutes contre des adversaires plus faibles (${names(wins)}) : forme flatteuse`;
  } else if (wins.length >= 2 && wins.filter(x => tier(x) === 'plus forts').length >= 2) {
    label = 'solide'; text = `a battu des adversaires plus forts (${names(wins.filter(x => tier(x) === 'plus forts'))}) : vraie bonne forme`;
  } else if (delta >= 3) { label = 'au-dessus'; text = 'résultats au-dessus de ce que son calendrier laissait attendre'; }
  else if (delta <= -3) { label = 'en dessous'; text = 'résultats en dessous de ce que son calendrier laissait attendre'; }
  return { form: l.map(res).join(''), delta, label, text, games: l.map(x => ({ opp: x.opp, r: res(x), score: `${x.gf}-${x.ga}`, tier: tier(x) })) };
}

// Effectif ESPN d'une équipe : poste et nombre de matchs joués cette saison
export function espnSquad(rosterJson) {
  return (rosterJson.athletes || []).map(a => {
    const stats = ((a.statistics && a.statistics.splits && a.statistics.splits.categories) || []).flatMap(c => c.stats || []);
    const apps = stats.find(s => s.name === 'appearances');
    return { n: a.displayName, l: lineOf(a.position && a.position.abbreviation), apps: apps ? +apps.value || 0 : null };
  });
}

// Parmi des noms de joueurs absents, les « gros noms » : buteurs importants de l'équipe (15 % de ses buts ou 5 buts et plus)
const lastNm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/).pop();
export function keyNames(pres, names) {
  const players = (pres && pres.players) || [];
  return names.filter(n => players.some(p => lastNm(p.name) === lastNm(n) && (p.share >= 0.15 || p.goals >= 5)));
}

// Texte du turn-over d'une équipe (présence calculée par analyzeMatch) : { level: 'bad' | 'info', short, long } ou null
export function rotationText(m, pres, side) {
  const r = pres && pres.rotation;
  if (!r || !r.changes) return null;
  const team = m[side].name;
  // Le nombre d'absents suffit ; on ne nomme que les gros joueurs (buteurs importants de l'équipe)
  const big = keyNames(pres, r.out.map(o => o.n));
  const who = big.length ? ` (dont ${big.join(', ')})` : '';
  const base = r.of > 1 ? 'titulaire' + (r.changes > 1 ? 's' : '') + ' habituel' + (r.changes > 1 ? 's' : '') : 'titulaire' + (r.changes > 1 ? 's' : '') + ' du dernier match';
  return {
    level: r.changes >= 3 ? 'bad' : 'info',
    short: `${team} sans ${r.changes} ${base}${who}`,
    long: r.changes >= 4 ? `🔄 Gros turn-over chez ${team} : ${r.changes} ${base} absents${who}` : `👥 ${team} sans ${r.changes} ${base}${who}`,
  };
}

export function applyLineups(m, lineupsJson) {
  const r = lineupsJson.response || [];
  const conv = l => ({
    status: 'officielle', formation: l.formation, coach: l.coach && l.coach.name, source: 'API-Football', at: Date.now(),
    startXI: (l.startXI || []).map(p => ({ id: null, name: p.player.name, pos: p.player.pos })),
    subs: (l.substitutes || []).map(p => ({ id: null, name: p.player.name, pos: p.player.pos })),
  });
  const ids = m.afTeams || { home: m.home.id, away: m.away.id };
  const h = r.find(l => l.team.id === ids.home), a = r.find(l => l.team.id === ids.away);
  if (h) m.lineups.home = conv(h);
  if (a) m.lineups.away = conv(a);
  return !!(h && a);
}

// Créneaux : matchs qui commencent à moins de 30 minutes d'écart
export function groupSlots(matches) {
  const sorted = [...matches].sort((a, b) => a.kickoff - b.kickoff);
  const slots = [];
  for (const m of sorted) {
    const last = slots[slots.length - 1];
    if (last && m.kickoff - last.start <= 30 * 60000) last.matches.push(m);
    else slots.push({ start: m.kickoff, matches: [m] });
  }
  return slots;
}

// ---------- football-data.co.uk : xG, tirs et cotes des bookmakers (fichiers CSV gratuits) ----------
export const FDCOUK_CODES = { 39: 'E0', 40: 'E1', 140: 'SP1', 135: 'I1', 78: 'D1', 79: 'D2', 61: 'F1', 62: 'F2', 88: 'N1', 94: 'P1', 144: 'B1', 203: 'T1', 197: 'G1', 179: 'SC0' };

export function parseCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  const head = lines[0].split(',');
  return lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((h, i) => { o[h] = v[i]; }); return o; });
}

// Noms abrégés du fichier anglais → noms complets (pour retrouver les équipes)
const FDC_ALIASES = [
  [/^man city$/, 'manchester city'], [/^man united$/, 'manchester united'], [/^nott'?m forest$/, 'nottingham forest'],
  [/^ath madrid$/, 'atletico madrid'], [/^ath bilbao$/, 'athletic club bilbao'], [/^sociedad$/, 'real sociedad'], [/^betis$/, 'real betis'],
  [/^sp lisbon$/, 'sporting cp'], [/^paris sg$/, 'paris saint germain'], [/^ein frankfurt$/, 'eintracht frankfurt'],
  [/^m'?gladbach$/, 'borussia monchengladbach'], [/^fc koln$/, 'koln'], [/^sheffield weds$/, 'sheffield wednesday'],
  [/^qpr$/, 'queens park rangers'], [/^west brom$/, 'west bromwich albion'], [/^wolves$/, 'wolverhampton'], [/^leverkusen$/, 'bayer leverkusen'],
  [/^dortmund$/, 'borussia dortmund'], [/^st etienne$/, 'saint etienne'], [/^st pauli$/, 'sankt pauli'], [/^for sittard$/, 'fortuna sittard'],
  [/^inter$/, 'inter milan'], [/^milan$/, 'ac milan'], [/^roma$/, 'as roma'], [/^verona$/, 'hellas verona'],
  // Japon
  [/^urawa reds$/, 'urawa red diamonds'], [/^verdy$/, 'tokyo verdy 1969'], [/^chiba$/, 'jef united ichihara chiba'],
];
const fdcName = n => { const s = norm(n); const a = FDC_ALIASES.find(([re]) => re.test(s)); return a ? a[1] : s; };

// Probabilités du marché (moyenne des bookmakers, marge retirée) → buts attendus implicites
const MKT_GRID = (() => {
  const g = [];
  const pmf = (k, l) => { let p = Math.exp(-l); for (let i = 1; i <= k; i++) p *= l / i; return p; };
  for (let lh = 0.2; lh <= 4.01; lh += 0.1) for (let la = 0.2; la <= 4.01; la += 0.1) {
    let H = 0, A = 0, O = 0;
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = pmf(i, lh) * pmf(j, la); if (i > j) H += p; else if (j > i) A += p; if (i + j > 2) O += p; }
    g.push([lh, la, H, A, O]);
  }
  return g;
})();
function oddsToLambdas(r, pre = 'Avg') {
  const h = +r[pre + 'H'], d = +r[pre + 'D'], a = +r[pre + 'A'];
  if (!(h > 1 && d > 1 && a > 1)) return null;
  const s = 1 / h + 1 / d + 1 / a, pH = (1 / h) / s, pA = (1 / a) / s;
  const o = +r[pre + '>2.5'], u = +r[pre + '<2.5'];
  const pO = o > 1 && u > 1 ? (1 / o) / (1 / o + 1 / u) : null;
  let best = null, err = 9;
  for (const [lh, la, H, A, O] of MKT_GRID) {
    const e = (H - pH) ** 2 + (A - pA) ** 2 + (pO == null ? 0 : (O - pO) ** 2);
    if (e < err) { err = e; best = [lh, la]; }
  }
  return best;
}

const fdcDate = s => { const [d, m, y] = String(s || '').split('/'); return Date.parse(`${y.length === 2 ? '20' + y : y}-${m}-${d}T12:00:00Z`); };

// Saison d'un championnat : par équipe, buts, xG et « buts attendus selon le marché », à domicile et à l'extérieur
// Championnats du « nouveau » format de football-data.co.uk (un fichier par pays, toutes saisons) :
// résultats et cotes de clôture, sans xG — de quoi calculer la note du marché de chaque équipe
export const FDCOUK_NEW = { 98: 'JPN' };
export function fdcoukNewRows(csvText) {
  const rows = parseCsv(csvText).filter(r => r.Home && r.HG !== '' && r.HG != null);
  const season = rows.reduce((s, r) => (r.Season > s ? r.Season : s), '');   // saison en cours = la plus récente
  return rows.filter(r => r.Season === season).map(r => ({
    Date: r.Date, HomeTeam: r.Home, AwayTeam: r.Away, FTHG: r.HG, FTAG: r.AG,
    AvgH: r.AvgCH, AvgD: r.AvgCD, AvgA: r.AvgCA, B365H: r.B365CH, B365D: r.B365CD, B365A: r.B365CA,
  }));
}

export function fdcoukCompetition(csvText, beforeTime = Infinity) {
  const rows = (Array.isArray(csvText) ? csvText : parseCsv(csvText)).filter(r => r.HomeTeam && r.FTHG !== '' && r.FTHG != null && fdcDate(r.Date) < beforeTime);
  const teams = new Map();
  const zero = () => ({ p: 0, gf: 0, ga: 0, xp: 0, xgf: 0, xga: 0, mp: 0, mgf: 0, mga: 0 });
  const get = n => { if (!teams.has(n)) teams.set(n, { name: fdcName(n), shortName: n, home: zero(), away: zero() }); return teams.get(n); };
  const sum = { gH: 0, gA: 0, xH: 0, xA: 0, xp: 0, mH: 0, mA: 0, mp: 0, n: 0 };
  for (const r of rows) {
    const h = get(r.HomeTeam), a = get(r.AwayTeam), hg = +r.FTHG, ag = +r.FTAG;
    h.home.p++; h.home.gf += hg; h.home.ga += ag; a.away.p++; a.away.gf += ag; a.away.ga += hg;
    sum.gH += hg; sum.gA += ag; sum.n++;
    if (r.HxG !== '' && r.HxG != null && !isNaN(+r.HxG)) {
      const hx = +r.HxG, ax = +r.AxG;
      h.home.xp++; h.home.xgf += hx; h.home.xga += ax; a.away.xp++; a.away.xgf += ax; a.away.xga += hx;
      sum.xH += hx; sum.xA += ax; sum.xp++;
    }
    const lam = oddsToLambdas(r) || oddsToLambdas(r, 'B365');
    if (lam) {
      h.home.mp++; h.home.mgf += lam[0]; h.home.mga += lam[1]; a.away.mp++; a.away.mgf += lam[1]; a.away.mga += lam[0];
      sum.mH += lam[0]; sum.mA += lam[1]; sum.mp++;
    }
  }
  const list = [...teams.values()];
  return {
    list, n: sum.n,
    avg: { gH: sum.gH / Math.max(1, sum.n), gA: sum.gA / Math.max(1, sum.n), xH: sum.xp ? sum.xH / sum.xp : null, xA: sum.xp ? sum.xA / sum.xp : null, mH: sum.mp ? sum.mH / sum.mp : null, mA: sum.mp ? sum.mA / sum.mp : null },
  };
}

// Données xG et marché d'un match, au même format que m.stats / m.teamStats (pour le calcul)
export function fdcoukForMatch(F, homeName, awayName) {
  const th = findTeam(homeName, F.list), ta = findTeam(awayName, F.list);
  if (!th || !ta || th === ta) return null;
  const pack = (kind, avgH, avgA) => {
    if (avgH == null) return null;
    const v = (t, side) => kind === 'x' ? { p: t[side].xp, gf: t[side].xgf, ga: t[side].xga } : { p: t[side].mp, gf: t[side].mgf, ga: t[side].mga };
    if (!v(th, 'home').p || !v(ta, 'away').p) return null;
    return {
      avgHome: avgH, avgAway: avgA, home: v(th, 'home'), away: v(ta, 'away'),
      teamStats: { home: { home: v(th, 'home'), away: v(th, 'away') }, away: { home: v(ta, 'home'), away: v(ta, 'away') } },
    };
  };
  return { xg: pack('x', F.avg.xH, F.avg.xA), market: pack('m', F.avg.mH, F.avg.mA), names: [th.shortName, ta.shortName] };
}

// Cotes des matchs à venir (fichier fixtures.csv) : moyenne des bookmakers
export function fdcoukUpcomingOdds(csvText, div, homeName, awayName) {
  const rows = parseCsv(csvText).filter(r => r.Div === div);
  const list = rows.map(r => ({ name: fdcName(r.HomeTeam), shortName: r.HomeTeam, r }));
  for (const x of list) {
    if (!findTeam(homeName, [x])) continue;
    const r = x.r;
    if (!findTeam(awayName, [{ name: fdcName(r.AwayTeam), shortName: r.AwayTeam }])) continue;
    const num = k => (+r[k] > 1 ? +r[k] : null);
    const pre = num('AvgH') ? 'Avg' : 'B365';
    return {
      bookmaker: 'Moyenne des bookmakers',
      h2h: { home: num(pre + 'H'), draw: num(pre + 'D'), away: num(pre + 'A') },
      totals: num(pre + '>2.5') ? { '2.5': { over: num(pre + '>2.5'), under: num(pre + '<2.5') } } : {},
    };
  }
  return null;
}

// ---------- ESPN : deuxième source (compositions + résultats de la saison) ----------
// Codes ESPN des compétitions suivies (identifiant API-Football → code ESPN)
export const ESPN_CODES = {
  61: 'fra.1', 62: 'fra.2', 66: 'fra.coupe_de_france', 39: 'eng.1', 40: 'eng.2', 45: 'eng.fa', 48: 'eng.league_cup',
  140: 'esp.1', 143: 'esp.copa_del_rey', 135: 'ita.1', 137: 'ita.coppa_italia', 78: 'ger.1', 79: 'ger.2', 81: 'ger.dfb_pokal',
  88: 'ned.1', 94: 'por.1', 144: 'bel.1', 207: 'sui.1', 203: 'tur.1', 179: 'sco.1', 218: 'aut.1', 197: 'gre.1', 119: 'den.1',
  2: 'uefa.champions', 3: 'uefa.europa', 848: 'uefa.europa.conf',
  283: 'rou.1', 318: 'cyp.1', 307: 'ksa.1', 98: 'jpn.1',
};

const espnTeam = t => ({ id: 'espn-' + t.id, name: t.displayName || t.name, shortName: t.shortDisplayName || t.name, tla: t.abbreviation });

// Transforme le classement + les calendriers d'équipes ESPN au format attendu par buildCompetition
// Meilleurs buteurs ESPN (/statistics), au format football-data.org
export function espnScorers(statsJson) {
  const cat = ((statsJson && statsJson.stats) || []).find(s => s.name === 'goalsLeaders');
  const scorers = ((cat && cat.leaders) || []).filter(l => l.athlete && l.athlete.team).map(l => {
    const played = /M:\s*(\d+)/.exec(l.shortDisplayValue || '') || /Matches:\s*(\d+)/.exec(l.displayValue || '');
    return { player: { name: l.athlete.displayName }, team: { id: 'espn-' + l.athlete.team.id }, goals: +l.value || 0, playedMatches: played ? +played[1] : null };
  });
  return { scorers };
}

export function espnCompetition(standingsJson, schedulesJson, scorersJson = null) {
  const groups = standingsJson.children || [standingsJson];
  const table = [];
  groups.forEach(g => ((g.standings && g.standings.entries) || []).forEach(e => {
    const rank = (e.stats || []).find(s => s.name === 'rank');
    table.push({ team: espnTeam(e.team), position: rank ? +rank.value : table.length + 1 });
  }));
  const seen = new Set(), matches = [];
  for (const s of schedulesJson) for (const ev of (s && s.events) || []) {
    const c = ev.competitions && ev.competitions[0];
    if (!c || !c.status || !c.status.type || !c.status.type.completed || seen.has(ev.id)) continue;
    const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const sc = x => x.score && (x.score.value != null ? +x.score.value : +x.score.displayValue);
    seen.add(ev.id);
    matches.push({ utcDate: ev.date, homeTeam: espnTeam(h.team), awayTeam: espnTeam(a.team), score: { fullTime: { home: sc(h), away: sc(a) } } });
  }
  // Pas de classement publié (ex. Roumanie) : on le recalcule à partir des résultats
  if (!table.length) {
    const pts = new Map();
    const add = (t, p, gd) => { const x = pts.get(t.id) || { team: t, p: 0, gd: 0 }; x.p += p; x.gd += gd; pts.set(t.id, x); };
    matches.forEach(g => {
      const h = g.score.fullTime.home, a = g.score.fullTime.away;
      add(g.homeTeam, h > a ? 3 : h === a ? 1 : 0, h - a);
      add(g.awayTeam, a > h ? 3 : h === a ? 1 : 0, a - h);
    });
    [...pts.values()].sort((x, y) => y.p - x.p || y.gd - x.gd).forEach((x, i) => table.push({ team: x.team, position: i + 1 }));
  }
  // Journée en cours estimée : nombre de matchs joués par équipe en moyenne
  const matchday = table.length ? Math.round((matches.length * 2) / table.length) : null;
  return buildCompetition({ standings: [{ type: 'TOTAL', table }], season: { currentMatchday: matchday } }, { matches }, scorersJson);
}

// Identifiants ESPN du match et des deux équipes
export function espnEventTeams(scoreboardJson, homeName, awayName, knownId = null) {
  // Identifiant déjà connu (match venu du programme ESPN) : prioritaire sur la recherche par les noms
  const id = knownId && (scoreboardJson.events || []).some(e => e.id === knownId) ? knownId : espnFindEvent(scoreboardJson, homeName, awayName);
  if (!id) return null;
  const c = (scoreboardJson.events || []).find(e => e.id === id).competitions[0];
  const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
  return { id, homeId: h.team.id, awayId: a.team.id };
}

// Score en direct d'un match dans le programme ESPN : { h, a, state: 'pre' | 'in' | 'post', clock, detail }
export function espnLiveScore(scoreboardJson, homeName, awayName) {
  const id = espnFindEvent(scoreboardJson, homeName, awayName);
  if (!id) return null;
  const ev = (scoreboardJson.events || []).find(e => e.id === id);
  const c = ev.competitions[0];
  const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
  const st = (c.status || ev.status || {});
  const num = x => +((x && x.score && (x.score.value != null ? x.score.value : x.score.displayValue)) || x.score || 0);
  return {
    id, h: num(h), a: num(a),
    state: (st.type && st.type.state) || 'pre',
    clock: st.displayClock || '',
    detail: (st.type && (st.type.shortDetail || st.type.description)) || '',
  };
}

// Retrouve un match API-Football dans le programme ESPN du jour
// Retrouve un match dans un programme ESPN : le PLUS ressemblant (pas le premier venu),
// avec un minimum pour chacune des deux équipes
export function espnFindEvent(scoreboardJson, homeName, awayName) {
  const score = (name, t) => { const e = espnTeam(t); return Math.max(similarity(name, e.name || ''), similarity(name, e.shortName || ''), norm(name) === norm(e.tla || '') ? 1 : 0); };
  let best = null, bestScore = 0;
  for (const ev of scoreboardJson.events || []) {
    const c = ev.competitions && ev.competitions[0];
    if (!c) continue;
    const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const sh = score(homeName, h.team), sa = score(awayName, a.team);
    if (sh < 0.5 || sa < 0.5) continue;
    if (sh + sa > bestScore) { bestScore = sh + sa; best = ev.id; }
  }
  return best;
}

// Compositions ESPN (11 titulaires + remplaçants) appliquées à un match
export function applyEspnLineups(m, summaryJson) {
  const rs = summaryJson.rosters || [];
  const conv = r => {
    const players = r.roster || [];
    const xi = players.filter(p => p.starter);
    if (xi.length < 11) return null;
    const name = p => (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '';
    // ESPN indique parfois « SUB » comme poste des titulaires : on l'ignore
    const pos = p => { const a = p.position && p.position.abbreviation; return a && a !== 'SUB' ? a : ''; };
    return {
      status: 'officielle', formation: r.formation || '', source: 'ESPN', at: Date.now(),
      startXI: xi.map(p => ({ id: null, name: name(p), pos: pos(p) })),
      subs: players.filter(p => !p.starter).map(p => ({ id: null, name: name(p), pos: p.position && p.position.abbreviation })),
    };
  };
  const h = rs.find(r => r.homeAway === 'home'), a = rs.find(r => r.homeAway === 'away');
  const lh = h && conv(h), la = a && conv(a);
  if (lh && la) { m.lineups = { home: lh, away: la }; return true; }
  return false;
}

// Titulaires d'une équipe (identifiant ESPN) dans le résumé d'un match joué
export function espnStartersOf(summaryJson, espnTeamId) {
  const r = (summaryJson.rosters || []).find(x => x.team && String(x.team.id) === String(espnTeamId));
  const xi = r ? (r.roster || []).filter(p => p.starter).map(p => (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '') : [];
  return xi.length >= 11 ? xi : null;
}

// ---------- Forme réelle : tirs cadrés et possession des derniers matchs (ESPN) ----------
// Statistiques d'un match joué, vues du côté d'une équipe (identifiant ESPN)
export function espnTeamMatchStats(summaryJson, espnTeamId) {
  const teams = (summaryJson.boxscore && summaryJson.boxscore.teams) || [];
  const comps = (summaryJson.header && summaryJson.header.competitions && summaryJson.header.competitions[0] && summaryJson.header.competitions[0].competitors) || [];
  const me = teams.find(t => String(t.team.id) === String(espnTeamId)), opp = teams.find(t => String(t.team.id) !== String(espnTeamId));
  const cMe = comps.find(c => String(c.team.id) === String(espnTeamId)), cOpp = comps.find(c => String(c.team.id) !== String(espnTeamId));
  if (!me || !opp || !cMe || !cOpp) return null;
  const v = (t, n) => { const s = (t.statistics || []).find(x => x.name === n); return s ? parseFloat(s.displayValue) || 0 : 0; };
  return { sotF: v(me, 'shotsOnTarget'), sotA: v(opp, 'shotsOnTarget'), poss: v(me, 'possessionPct'), gf: +cMe.score || 0, ga: +cOpp.score || 0, venue: cMe.homeAway };
}

// Résumé des derniers matchs : en pleine bourre, en galère, malchanceuse (domine sans être récompensée)…
export function perfSummary(name, list) {
  const l = (list || []).slice(-6);
  if (l.length < 3) return null;
  const s = l.reduce((a, x) => ({ sotF: a.sotF + x.sotF, sotA: a.sotA + x.sotA, gf: a.gf + x.gf, ga: a.ga + x.ga, poss: a.poss + x.poss }), { sotF: 0, sotA: 0, gf: 0, ga: 0, poss: 0 });
  const sotShare = s.sotF / Math.max(1, s.sotF + s.sotA), goalShare = (s.gf + s.ga) ? s.gf / (s.gf + s.ga) : 0.5;
  const n = l.length, per = x => (x / n).toFixed(1).replace('.', ',');
  const base = `${per(s.sotF)} tirs cadrés par match pour, ${per(s.sotA)} contre, ${Math.round(s.poss / n)} % de possession sur ses ${n} derniers matchs`;
  let label = '', text = '', factor = 1;
  if (sotShare - goalShare >= 0.15) { label = 'malchanceuse'; factor = 1.05; text = `${name} domine sans être récompensée (${base}) : ses résultats devraient s'améliorer.`; }
  else if (goalShare - sotShare >= 0.15) { label = 'chanceuse'; factor = 0.95; text = `${name} gagne au-dessus de son jeu (${base}) : attention au retour sur terre.`; }
  else if (sotShare >= 0.6 && goalShare >= 0.58) { label = 'en pleine bourre'; factor = 1.04; text = `${name} est en pleine bourre (${base}).`; }
  else if (sotShare <= 0.4 && goalShare <= 0.42) { label = 'en galère'; factor = 0.96; text = `${name} est en galère (${base}).`; }
  else text = `${name} : ${base}, performances conformes à ses résultats.`;
  return { n, sotF: s.sotF / n, sotA: s.sotA / n, poss: s.poss / n, label, text, factor };
}

// ---------- Vérification d'une piste une fois le score connu ----------
export function tipResult(key, h, a) {
  const t = h + a;
  const rules = {
    '1': h > a, 'N': h === a, '2': a > h, '1N': h >= a, 'N2': a >= h,
    O15: t > 1.5, O25: t > 2.5, U25: t < 2.5, O35: t > 3.5, U15: t < 1.5, O45: t > 4.5, H3G: h >= 3, A3G: a >= 3, 'H3+': h - a >= 3, 'A3+': a - h >= 3, BTTSO25: h > 0 && a > 0 && t > 2.5,
    '1NU35': h >= a && t < 3.5, 'N2U35': a >= h && t < 3.5, '1NO15': h >= a && t > 1.5, 'N2O15': a >= h && t > 1.5,
    BTTS: h > 0 && a > 0, NBTTS: h === 0 || a === 0, H2G: h >= 2, A2G: a >= 2,
    'H2+': h - a >= 2, 'A2+': a - h >= 2, '1O25': h > a && t > 2.5, '2O25': a > h && t > 2.5,
    '1BTTS': h > a && a > 0, '2BTTS': a > h && h > 0, '1CS': h > a && a === 0, '2CS': a > h && h === 0,
  };
  return key in rules ? rules[key] : null;
}

// Pourquoi une piste a échoué : comparaison buts attendus / buts marqués
export function failReason(m, lh, la, h, a) {
  const parts = [];
  if (h - lh <= -1.2) parts.push(`attaque de ${m.home.name} surestimée (${lh.toFixed(1)} but attendu, ${h} marqué)`);
  if (h - lh >= 1.5) parts.push(`défense de ${m.away.name} plus faible que prévu (${h} buts encaissés pour ${lh.toFixed(1)} attendu)`);
  if (a - la <= -1.2) parts.push(`attaque de ${m.away.name} surestimée (${la.toFixed(1)} attendu, ${a} marqué)`);
  if (a - la >= 1.5) parts.push(`défense de ${m.home.name} plus faible que prévu (${a} encaissés pour ${la.toFixed(1)} attendu)`);
  if (!parts.length) parts.push(`écart normal (${lh.toFixed(1)}-${la.toFixed(1)} attendu, ${h}-${a} réel) : part de hasard`);
  return parts.join(' ; ');
}

// ---------- Coupes et coupes d'Europe : niveau de chaque équipe dans son championnat ----------
// Niveau approximatif des championnats (100 = Premier League), pour comparer deux équipes de pays ou de divisions différents
export const LEAGUE_LEVEL = {
  'eng.1': ['Premier League', 1, 100], 'esp.1': ['Liga', 1, 95], 'ita.1': ['Serie A', 1, 92], 'ger.1': ['Bundesliga', 1, 92], 'fra.1': ['Ligue 1', 1, 88],
  'por.1': ['Liga Portugal', 1, 80], 'ned.1': ['Eredivisie', 1, 80], 'bel.1': ['Pro League', 1, 76], 'tur.1': ['Süper Lig', 1, 74],
  'eng.2': ['Championship', 2, 72], 'ger.2': ['2. Bundesliga', 2, 68], 'esp.2': ['Liga 2', 2, 64], 'ita.2': ['Serie B', 2, 64], 'fra.2': ['Ligue 2', 2, 62],
  'sco.1': ['Premiership', 1, 68], 'gre.1': ['Super League', 1, 68], 'aut.1': ['Bundesliga autrichienne', 1, 68], 'sui.1': ['Super League suisse', 1, 66],
  'den.1': ['Superliga', 1, 64], 'cze.1': ['Tchéquie', 1, 62], 'nor.1': ['Norvège', 1, 60], 'swe.1': ['Suède', 1, 58], 'pol.1': ['Pologne', 1, 60],
  'ukr.1': ['Ukraine', 1, 62], 'cro.1': ['Croatie', 1, 58], 'srb.1': ['Serbie', 1, 58], 'isr.1': ['Israël', 1, 54], 'ksa.1': ['Arabie saoudite', 1, 60],
  'rou.1': ['Roumanie', 1, 56], 'cyp.1': ['Chypre', 1, 54], 'jpn.1': ['J1 League', 1, 60], 'eng.3': ['League One', 3, 58], 'eng.4': ['League Two', 4, 50],
  'fra.3': ['National', 3, 46], 'ger.3': ['3. Liga', 3, 52], 'esp.3': ['Primera RFEF', 3, 46], 'ita.3': ['Serie C', 3, 46],
};

// Niveau d'une équipe : fiche ESPN de l'équipe (dans son championnat) → { slug, league, div, rank, coef, S, home, away }
export function domesticLevel(teamJson) {
  const t = teamJson && teamJson.team;
  if (!t || !t.defaultLeague) return null;
  const slug = t.defaultLeague.slug, L = LEAGUE_LEVEL[slug];
  const st = {};
  (((t.record && t.record.items) || [])[0]?.stats || []).forEach(s => { st[s.name] = s.value; });
  const rankM = /^(\d+)/.exec(t.standingSummary || '');
  const gp = st.gamesPlayed || 0;
  // Force de l'ÉQUIPE : niveau du championnat (70 %) + ce que fait l'équipe (différence de buts, classement).
  // La différence de buts compte d'autant plus que le championnat est fort : dominer la Norvège ne vaut pas
  // dominer la Premier League (bilan du 21/10 : Viking donné favori à Aston Villa, à tort).
  const gd = gp ? (st.pointsFor - st.pointsAgainst) / gp : 0;
  const coef = L ? L[2] : 50, rank = rankM ? +rankM[1] : (st.rank || null);
  const rankBonus = rank ? (rank <= 2 ? 6 : rank <= 4 ? 4 : rank <= 8 ? 1 : rank >= 15 ? -3 : 0) : 0;
  return {
    slug, league: L ? L[0] : t.defaultLeague.name, div: L ? L[1] : null, rank, coef,
    S: 20 + 0.7 * coef + 8 * Math.max(-1.5, Math.min(1.5, gd)) * (coef / 100) + rankBonus, gp,
    home: { p: st.homeGamesPlayed || 0, gf: st.homePointsFor || 0, ga: st.homePointsAgainst || 0, w: st.homeWins || 0 },
    away: { p: st.awayGamesPlayed || 0, gf: st.awayPointsFor || 0, ga: st.awayPointsAgainst || 0, w: st.awayWins || 0 },
    gf: st.pointsFor || 0,
  };
}

// Équipe d'un championnat non couvert par ESPN (petits pays) : niveau modeste par défaut, sans bilan
export function unknownLevel() {
  const none = { p: 0, gf: 0, ga: 0, w: 0 };
  // Championnat non suivi (Andorre, Lituanie, Kazakhstan…) : plus modeste qu'on ne le pensait (bilan du 22/10 : Inter d'Escaldes, Kauno)
  return { slug: null, league: 'championnat non suivi', div: null, rank: null, coef: 50, S: 20 + 0.7 * 50, gp: 0, home: none, away: none, gf: 0, unknown: true };
}
// Nombre de matchs sur lesquels reposent les stats (en coupe : le plus grand entre compétition et championnat)
export function statGames(m) {
  const n = s => s && s.home && s.away ? Math.min(s.home.p, s.away.p) : 0;
  return Math.max(n(m.stats), n(m.domStats));
}
// Correction des buts attendus selon l'écart de niveau (modérée : la forme du jour et la coupe gardent leur part)
export function levelFactor(level) {
  return Math.max(1 / 1.3, Math.min(1.3, Math.exp(0.012 * (level.home.S - level.away.S))));
}

// Écart de niveau entre les deux équipes d'un match de coupe : { gap, size: 'grand' | 'moyen' | 'faible', text, warn }
export function levelGap(m) {
  const h = m.level && m.level.home, a = m.level && m.level.away;
  if (!h || !a) return null;
  const gap = h.S - a.S, fav = gap >= 0 ? m.home.name : m.away.name, abs = Math.abs(gap);
  const desc = (x, team) => `${team} (${x.league}${x.rank ? `, ${x.rank}${x.rank === 1 ? 'er' : 'e'}` : ''})`;
  const divs = h.div && a.div && h.div !== a.div ? Math.abs(h.div - a.div) : 0;
  const size = abs >= 18 ? 'grand' : abs >= 8 ? 'moyen' : 'faible';
  const head = divs ? `${divs} division${divs > 1 ? 's' : ''} d'écart` : size === 'faible' ? 'niveau proche' : `écart de niveau ${size}`;
  const text = `🏆 ${m.comp.type === 'europe' ? 'Coupe d\'Europe' : 'Coupe'} · ${head} : ${desc(h, m.home.name)} contre ${desc(a, m.away.name)}.`
    + (size === 'faible' ? ' Niveau proche en coupe : risque de surprise élevé.' : ` ${fav} a nettement plus de niveau${size === 'moyen' ? ', mais la coupe réserve des surprises' : ''}.`);
  return { gap, size, text, warn: size === 'faible' };
}

// ---------- Profil de jeu d'une équipe ----------
// À partir de ses chiffres (buts, xG, tirs cadrés, possession) comparés à la moyenne de son championnat,
// dans le contexte du match (à domicile pour l'une, à l'extérieur pour l'autre).
// Renvoie { att, def, tags: [textes courts], xgNote } — att / def : 1 = moyenne du championnat
export function teamProfile(m, side) {
  const s = m.domStats || m.stats, ts = (m.domTeamStats || m.teamStats || {})[side];
  if (!s || !s[side] || !s[side].p) return null;
  const home = side === 'home';
  const avgFor = home ? s.avgHome : s.avgAway, avgAg = home ? s.avgAway : s.avgHome;
  const v = s[side], gf = v.gf / v.p, ga = v.ga / v.p;
  const att = avgFor ? gf / avgFor : 1, def = avgAg ? ga / avgAg : 1;
  const where = home ? 'à domicile' : 'à l\'extérieur';
  const f1 = x => x.toFixed(1).replace('.', ',');
  const tags = [];
  if (v.p >= 3) {
    if (att >= 1.3) tags.push(`attaque redoutable ${where} (${f1(gf)} buts/match)`);
    else if (att <= 0.75) tags.push(`attaque en panne ${where} (${f1(gf)} but/match)`);
    if (def <= 0.75) tags.push(`défense solide ${where} (${f1(ga)} encaissé/match)`);
    else if (def >= 1.3) tags.push(`défense fragile ${where} (${f1(ga)} encaissés/match)`);
  }
  // Domicile / extérieur : écart de différence de buts par match
  if (ts && ts.home && ts.away && ts.home.p >= 2 && ts.away.p >= 2) {
    const gdH = (ts.home.gf - ts.home.ga) / ts.home.p, gdA = (ts.away.gf - ts.away.ga) / ts.away.p;
    if (gdH - gdA >= 1.2) tags.push(home ? 'forteresse à domicile' : 'beaucoup moins forte loin de chez elle');
    else if (gdA - gdH >= 0.6) tags.push(home ? 'curieusement meilleure à l\'extérieur' : 'aussi forte à l\'extérieur qu\'à domicile');
  }
  // Style : possession et tirs cadrés sur les derniers matchs
  const p = m.perf && m.perf[side];
  if (p && p.poss) {
    if (p.poss >= 58) tags.push(`fait le jeu (${Math.round(p.poss)} % de possession)`);
    else if (p.poss <= 42) tags.push(`joue en bloc / en contre (${Math.round(p.poss)} % de possession)`);
  }
  // Efficacité : buts réels comparés aux xG (occasions) — un écart finit souvent par se résorber
  let xgNote = null;
  const x = !m.domStats && m.xg && m.xg[side];
  if (x && x.p >= 3) {
    const dF = gf - x.gf / x.p, dA = ga - x.ga / x.p;
    if (dF >= 0.4) xgNote = `efficace : marque plus que ses occasions (xG ${f1(x.gf / x.p)})`;
    else if (dF <= -0.4) xgNote = `maladroite : se crée ${f1(x.gf / x.p)} xG par match mais marque moins, ça peut tourner`;
    if (dA <= -0.4) xgNote = (xgNote ? xgNote + ' ; ' : '') + `encaisse moins que les occasions adverses (xG contre ${f1(x.ga / x.p)})`;
    else if (dA >= 0.4) xgNote = (xgNote ? xgNote + ' ; ' : '') + `encaisse plus que les occasions adverses : malchance derrière`;
  }
  return { att, def, gf, ga, n: v.p, where, tags, xgNote };
}

// ---------- Tireurs de penalty ----------
// Penalties tirés dans un programme ESPN (hors séances de tirs au but) : [{ team: 'espn-ID', ev, n, ok, m }]
export function espnPenalties(scoreboardJson) {
  const out = [];
  for (const ev of scoreboardJson.events || []) {
    const c = ev.competitions && ev.competitions[0];
    if (!c || !c.status || !c.status.type || !c.status.type.completed) continue;
    for (const x of c.details || []) {
      const min = parseInt((x.clock && x.clock.displayValue) || '0', 10) || 0;
      const who = x.athletesInvolved && x.athletesInvolved[0];
      if (!x.penaltyKick || x.shootout || min > 120 || !who || !x.team) continue;
      out.push({ team: 'espn-' + x.team.id, ev: ev.id, n: who.displayName, ok: !!x.scoringPlay, m: min });
    }
  }
  return out;
}

// Tireurs d'une équipe, du plus utilisé au moins utilisé : [{ name, att, ok }]
export function penTakers(list) {
  const by = new Map();
  for (const p of list || []) {
    const x = by.get(p.n) || { name: p.n, att: 0, ok: 0, last: '' };
    x.att++; if (p.ok) x.ok++; if (p.d > x.last) x.last = p.d;
    by.set(p.n, x);
  }
  return [...by.values()].sort((a, b) => b.att - a.att || b.last.localeCompare(a.last)).slice(0, 3).map(({ name, att, ok }) => ({ name, att, ok }));
}

// ---------- Cause d'un échec : carton rouge, compo, malchance ou vraie erreur de stats ----------
// Cartons rouges d'un match dans le programme ESPN : [{ side: 'home' | 'away', min }]
export function espnRedCards(scoreboardJson, homeName, awayName) {
  const id = espnFindEvent(scoreboardJson, homeName, awayName);
  if (!id) return [];
  const c = (scoreboardJson.events || []).find(e => e.id === id).competitions[0];
  const homeId = String((c.competitors.find(x => x.homeAway === 'home') || {}).team?.id);
  return (c.details || []).filter(d => d.redCard).map(d => ({
    side: String(d.team && d.team.id) === homeId ? 'home' : 'away',
    min: parseInt((d.clock && d.clock.displayValue) || '0', 10) || 0,
  }));
}

// Buteurs d'un match terminé (hors contre-son-camp et tirs au but), d'après le programme ESPN ; null si match introuvable
export function espnGoalScorers(scoreboardJson, homeName, awayName) {
  const id = espnFindEvent(scoreboardJson, homeName, awayName);
  if (!id) return null;
  const c = (scoreboardJson.events || []).find(e => e.id === id).competitions[0];
  return (c.details || [])
    .filter(d => d.scoringPlay && !d.shootout && !d.ownGoal && !/own goal/i.test((d.type && d.type.text) || ''))
    .map(d => (d.athletesInvolved && d.athletesInvolved[0] && d.athletesInvolved[0].displayName) || '')
    .filter(Boolean);
}
// Pari buteur gagné ? (SC : le joueur marque ; SC2 : doublé ; SCD : l'un des deux marque)
export function scorerTipResult(tip, scorers) {
  const key = n => norm(n).split(' ').pop();
  const goals = n => scorers.filter(s => key(s) === key(n)).length;
  if (tip.key === 'SC' && tip.player) return goals(tip.player) >= 1;
  if (tip.key === 'SC2' && tip.player) return goals(tip.player) >= 2;
  if (tip.key === 'SCD' && tip.duo) return tip.duo.some(p => goals(p.name) >= 1);
  return null;
}

const RESULT_HOME = ['1', 'H2+', '1O25', '1BTTS', '1CS'], RESULT_AWAY = ['2', 'A2+', '2O25', '2BTTS', '2CS'];
const GOALS_OVER = ['O25', 'O35', 'BTTS', 'H2G', 'A2G', 'O15'];

// ctx : { reds, sot: { home, away } | null, xi: { home: [noms], away: [noms] } | null }
// Renvoie { k: 'rouge' | 'compo' | 'malchance' | 'stats', t: texte } — k ≠ 'stats' : le match n'apprend rien au robot
export function failCause(m, an, h, a, failed, ctx) {
  const name = s => m[s].name;
  const keys = failed.map(p => p.key);
  // Équipe dont la piste ratée avait besoin (victoire, ou buts à marquer)
  const needs = new Set();
  keys.forEach(k => {
    if (RESULT_HOME.includes(k) || k === 'H2G') needs.add('home');
    if (RESULT_AWAY.includes(k) || k === 'A2G') needs.add('away');
    if (k === 'BTTS') { if (h === 0) needs.add('home'); if (a === 0) needs.add('away'); }
  });
  // Un carton rouge n'excuse l'échec que s'il a frappé l'équipe dont la piste avait besoin
  const red = (ctx.reds || []).filter(r => r.min <= 75 && needs.has(r.side)).sort((x, y) => x.min - y.min)[0];
  if (red) return { k: 'rouge', t: `Carton rouge pour ${name(red.side)} (${red.min}e minute) : match faussé, pas une erreur d'analyse.` };
  const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  if (!official && ctx.xi) {
    for (const s of needs) {
      const xi = ctx.xi[s];
      if (!xi) continue;
      const out = an.presence[s].players.filter(p => p.status === 'probable' && p.share >= 0.15 && !xi.some(n => norm(n).split(' ').pop() === norm(p.name).split(' ').pop()));
      if (out.length) return { k: 'compo', t: `${out.map(p => `${p.name} (${p.goals} buts)`).join(', ')} n'était pas titulaire chez ${name(s)} : compo inconnue au moment de l'analyse.` };
    }
  }
  if (!failed.length) return null;
  const sot = ctx.sot;
  if (sot) {
    const other = s => (s === 'home' ? 'away' : 'home');
    // Piste sur le résultat : l'équipe visée a nettement dominé (3 tirs cadrés de plus au moins)
    for (const s of ['home', 'away']) {
      const list = s === 'home' ? RESULT_HOME : RESULT_AWAY;
      if (keys.some(k => list.includes(k)) && sot[s] - sot[other(s)] >= 3) return { k: 'malchance', t: `${name(s)} a dominé (${sot[s]} tirs cadrés contre ${sot[other(s)]}) sans être récompensé : bonne analyse, mauvais résultat.` };
    }
    // Piste sur les buts : l'équipe qui devait marquer s'est créé de quoi le faire
    const goalKeys = keys.filter(k => GOALS_OVER.includes(k));
    if (goalKeys.length === keys.length) {
      const shooters = [...needs].filter(s => sot[s] >= (keys.includes('BTTS') ? 5 : 7));
      if (needs.size && shooters.length === needs.size) return { k: 'malchance', t: `${shooters.map(s => `${name(s)} (${sot[s]} tirs cadrés)`).join(' et ')} s'est créé les occasions sans les mettre : maladresse ou gardien, pas les stats.` };
      if (!needs.size && sot.home + sot.away >= 11) return { k: 'malchance', t: `Beaucoup d'occasions (${sot.home + sot.away} tirs cadrés) mais peu de buts : maladresse ou gardiens, pas les stats.` };
    }
  }
  return { k: 'stats', t: failReason(m, an.lh, an.la, h, a) };
}

// ---------- Apprentissage : correction par équipe ----------
// Pour chaque équipe, on garde les 10 derniers matchs suivis : buts attendus / buts réels,
// en attaque et en défense. Si l'équipe marque (ou encaisse) régulièrement plus ou moins que prévu,
// on corrige ses prochains buts attendus (au plus ±15 %, à partir de 3 matchs).
export function biasFactor(list) {
  if (!list || list.length < 3) return 1;
  const exp = list.reduce((s, x) => s + x[0], 0), act = list.reduce((s, x) => s + x[1], 0);
  return Math.max(0.85, Math.min(1.15, 1 + 0.5 * (act - exp) / Math.max(exp, 1)));
}

// ---------- Top du jour : uniquement les pistes jugées fiables ----------
// Conditions : statistiques présentes, au moins 4 matchs à domicile / à l'extérieur,
// indice de confiance du match d'au moins 55/100, piste non évidente à 60 % ou plus,
// et type de pari qui n'échoue pas trop souvent d'après les résultats passés.
// (Les compositions officielles font monter l'indice : le top se complète avant les matchs.)
export function topPicks(matches, analyses, bilanRates = {}) {
  const out = [];
  for (const m of matches) {
    const a = analyses[m.id];
    if (!a || !m.stats || a.verdict.code === 'skip' || a.verdict.score < 55 || m.status !== 'NS') continue;
    if (statGames(m) < 4) continue;
    // (les paris buteurs ne sont pas vérifiables automatiquement : hors top)
    const tip = a.tips.filter(t => !String(t.key).startsWith('SC') && t.p >= 0.60)
      .filter(t => { const r = bilanRates[t.key]; return !r || r.n < 10 || r.rate >= 0.45; })
      .sort((x, y) => y.p - x.p)[0];
    if (!tip) continue;
    const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
    out.push({ m, tip, official });
  }
  return out.sort((x, y) => y.tip.p - x.tip.p);
}

// ---------- Combinés du jour : sélections solides sans attendre les compositions ----------
// Une seule piste par match, non évidente (55 à 66 %), avec des statistiques solides.
// Points en plus : bel écart entre les équipes, absents sûrs chez l'adversaire (suspendu, buteur blessé).
// Points en moins : piste qui dépend d'un joueur incertain, peu de matchs joués.
export function comboLegs(matches, analyses) {
  const legs = [];
  for (const m of matches) {
    const a = analyses[m.id];
    if (!a || !m.stats || m.status !== 'NS' || a.verdict.code === 'skip') continue;
    const games = statGames(m);
    if (games < 4) continue;
    const tip = a.tips.filter(t => !String(t.key).startsWith('SC') && !t.easy && t.p >= 0.55).sort((x, y) => y.p - x.p)[0];
    if (!tip) continue;
    const reasons = [];
    let score = tip.p * 100;
    const gap = Math.abs(a.p.home - a.p.away);
    if (gap >= 0.3) { score += 4; reasons.push('bel écart entre les deux équipes'); }
    // Absents sûrs (confirmés le matin) : suspensions et buteurs blessés
    for (const side of ['home', 'away']) {
      const team = m[side].name;
      const inj = (m.injuries && m.injuries[side]) || [];
      const susp = inj.filter(i => /red card|yellow card|suspen/i.test(String(i.reason || '')));
      if (susp.length) { score += 2; reasons.push(`${team} : ${susp.slice(0, 2).map(i => i.name).join(', ')} suspendu${susp.length > 1 ? 's' : ''}`); }
      const keyOut = a.presence[side].players.filter(p => p.status === 'absent' && p.share >= 0.15);
      if (keyOut.length) { score += 3; reasons.push(`${team} privé de ${keyOut.map(p => `${p.name} (${p.goals} buts)`).join(', ')}`); }
      const doubt = a.presence[side].players.filter(p => p.status === 'incertain' && p.share >= 0.15);
      if (doubt.length) { score -= 6; reasons.push(`attention : ${doubt.map(p => p.name).join(', ')} incertain (risque lié aux compos)`); }
    }
    if (games >= 6) score += 2;
    if (['O25', 'U25', 'BTTS', 'NBTTS', 'O35'].includes(tip.key)) reasons.push(`${(a.lh + a.la).toFixed(1)} buts attendus`);
    legs.push({ m, tip, score, reasons });
  }
  return legs.sort((x, y) => y.score - x.score);
}

// ---------- Meilleur créneau du jour ----------
// Le créneau horaire (matchs à moins de 30 min d'écart) qui regroupe le plus de matchs analysés
// avec une piste solide : on y parie 15 min avant, quand la plupart des compositions sont sorties.
export function bestSlot(matches, analyses) {
  const candidates = matches.filter(m => m.status === 'NS' && m.stats && analyses[m.id] && analyses[m.id].verdict.code !== 'skip');
  let best = null;
  for (const slot of groupSlots(candidates)) {
    const legs = slot.matches.map(m => {
      const t = analyses[m.id].tips.filter(x => !String(x.key).startsWith('SC') && !x.easy && x.p >= 0.55).sort((a, b) => b.p - a.p)[0];
      return t ? { m, tip: t, reasons: [] } : null;
    }).filter(Boolean).sort((a, b) => b.tip.p - a.tip.p);
    if (legs.length < 2) continue;
    const official = slot.matches.filter(m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle').length;
    const score = legs.length + legs.slice(0, 5).reduce((s, x) => s + x.tip.p, 0) / 5;
    if (!best || score > best.score) best = { start: slot.start, betAt: slot.start - 15 * 60000, count: slot.matches.length, official, legs: legs.slice(0, 5), score };
  }
  return best;
}

export const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
