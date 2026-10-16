// Construction des matchs à partir des données brutes (football-data.org + API-Football).
// Module pur (pas d'accès réseau ni fichier) : utilisé par le robot et testable dans un navigateur.
import { teamSplit, norm } from './model.js';
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
    (scorers[tid] = scorers[tid] || []).push({ id: null, name: x.player.name, goals: x.goals || 0, pos: 'A' });
  }
  return { rows, avg, pos, n, tierOf, scorers, matchday: (standingsJson.season && standingsJson.season.currentMatchday) || null };
}

// ---------- Rapprochement des noms d'équipes entre les deux sources ----------
const STOP = new Set(['fc', 'afc', 'ac', 'as', 'sc', 'ssc', 'cf', 'club', 'de', 'du', 'la', 'le', 'les', 'olympique', 'stade', 'rc', 'ogc', 'sv', 'vfb', 'vfl', 'tsg', 'fsv', 'sport', 'sporting', 'calcio', 'us', 'ud', 'cd', 'rcd', 'sad', 'bv', 'borussia', '1', '04', '05', 'hotspur', 'and', 'albion', 'city', 'town', 'united', 'utd']);
const tokens = s => norm(s).split(' ').filter(w => w && !STOP.has(w));
const KEEP_DISTINCT = ['city', 'united'];

function similarity(a, b) {
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
    id: 'af-' + f.fixture.id, fixtureId: f.fixture.id, source: 'auto', comp, round: f.league.round,
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
  m.scorers = { home: (C.scorers[th.id] || []).slice(0, 4), away: (C.scorers[ta.id] || []).slice(0, 4) };
  m.teamGoals = { home: th.home.gf + th.away.gf, away: ta.home.gf + ta.away.gf };
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
export function applyInjuries(m, injuriesJson) {
  const list = (injuriesJson.response || []).map(x => ({ id: null, name: x.player.name, type: x.player.type, reason: x.player.reason, team: x.team.id }));
  m.injuries = { home: list.filter(x => x.team === m.home.id), away: list.filter(x => x.team === m.away.id) };
}

export function applyLineups(m, lineupsJson) {
  const r = lineupsJson.response || [];
  const conv = l => ({
    status: 'officielle', formation: l.formation, coach: l.coach && l.coach.name,
    startXI: (l.startXI || []).map(p => ({ id: null, name: p.player.name, pos: p.player.pos })),
    subs: (l.substitutes || []).map(p => ({ id: null, name: p.player.name, pos: p.player.pos })),
  });
  const h = r.find(l => l.team.id === m.home.id), a = r.find(l => l.team.id === m.away.id);
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

export const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
