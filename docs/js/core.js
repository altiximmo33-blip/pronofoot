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
  // La source répète parfois un même joueur : on ne le garde qu'une fois
  const seen = new Set();
  const list = (injuriesJson.response || [])
    .map(x => ({ id: null, name: x.player.name, type: x.player.type, reason: x.player.reason, team: x.team.id }))
    .filter(x => { const k = x.team + '|' + x.name; if (seen.has(k)) return false; seen.add(k); return true; });
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

// ---------- ESPN : deuxième source (compositions + résultats de la saison) ----------
// Codes ESPN des compétitions suivies (identifiant API-Football → code ESPN)
export const ESPN_CODES = {
  61: 'fra.1', 62: 'fra.2', 66: 'fra.coupe_de_france', 39: 'eng.1', 40: 'eng.2', 45: 'eng.fa', 48: 'eng.league_cup',
  140: 'esp.1', 143: 'esp.copa_del_rey', 135: 'ita.1', 137: 'ita.coppa_italia', 78: 'ger.1', 79: 'ger.2', 81: 'ger.dfb_pokal',
  88: 'ned.1', 94: 'por.1', 144: 'bel.1', 207: 'sui.1', 203: 'tur.1', 179: 'sco.1', 218: 'aut.1', 197: 'gre.1', 119: 'den.1',
  2: 'uefa.champions', 3: 'uefa.europa', 848: 'uefa.europa.conf',
};

const espnTeam = t => ({ id: 'espn-' + t.id, name: t.displayName || t.name, shortName: t.shortDisplayName || t.name, tla: t.abbreviation });

// Transforme le classement + les calendriers d'équipes ESPN au format attendu par buildCompetition
export function espnCompetition(standingsJson, schedulesJson) {
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
  // Journée en cours estimée : nombre de matchs joués par équipe en moyenne
  const matchday = table.length ? Math.round((matches.length * 2) / table.length) : null;
  return buildCompetition({ standings: [{ type: 'TOTAL', table }], season: { currentMatchday: matchday } }, { matches }, null);
}

// Retrouve un match API-Football dans le programme ESPN du jour
export function espnFindEvent(scoreboardJson, homeName, awayName) {
  for (const ev of scoreboardJson.events || []) {
    const c = ev.competitions && ev.competitions[0];
    if (!c) continue;
    const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
    if (!h || !a) continue;
    const rowsH = [espnTeam(h.team)], rowsA = [espnTeam(a.team)];
    if (findTeam(homeName, rowsH) && findTeam(awayName, rowsA)) return ev.id;
  }
  return null;
}

// Compositions ESPN (11 titulaires + remplaçants) appliquées à un match
export function applyEspnLineups(m, summaryJson) {
  const rs = summaryJson.rosters || [];
  const conv = r => {
    const players = r.roster || [];
    const xi = players.filter(p => p.starter);
    if (xi.length < 11) return null;
    const name = p => (p.athlete && (p.athlete.displayName || p.athlete.fullName)) || '';
    return {
      status: 'officielle', formation: r.formation || '', source: 'ESPN',
      startXI: xi.map(p => ({ id: null, name: name(p), pos: p.position && p.position.abbreviation })),
      subs: players.filter(p => !p.starter).map(p => ({ id: null, name: name(p), pos: p.position && p.position.abbreviation })),
    };
  };
  const h = rs.find(r => r.homeAway === 'home'), a = rs.find(r => r.homeAway === 'away');
  const lh = h && conv(h), la = a && conv(a);
  if (lh && la) { m.lineups = { home: lh, away: la }; return true; }
  return false;
}

// ---------- Vérification d'une piste une fois le score connu ----------
export function tipResult(key, h, a) {
  const t = h + a;
  const rules = {
    '1': h > a, 'N': h === a, '2': a > h, '1N': h >= a, 'N2': a >= h,
    O15: t > 1.5, O25: t > 2.5, U25: t < 2.5, O35: t > 3.5, U15: t < 1.5,
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
    if (Math.min(m.stats.home.p, m.stats.away.p) < 4) continue;
    // (les paris buteurs ne sont pas vérifiables automatiquement : hors top)
    const tip = a.tips.filter(t => !String(t.key).startsWith('SC') && t.p >= 0.60 && !t.easy)
      .filter(t => { const r = bilanRates[t.key]; return !r || r.n < 10 || r.rate >= 0.45; })
      .sort((x, y) => y.p - x.p)[0];
    if (!tip) continue;
    const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
    out.push({ m, tip, official });
  }
  return out.sort((x, y) => y.tip.p - x.tip.p);
}

export const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
