// Moteur d'analyse : buts attendus (modèle de Poisson), absences, forme,
// buteurs, comparaison avec les cotes et verdict final.

const MAX_GOALS = 10;

function pmf(k, l) {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i++) p *= l / i;
  return p;
}

function scoreMatrix(lh, la) {
  const m = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    m[h] = [];
    for (let a = 0; a <= MAX_GOALS; a++) m[h][a] = pmf(h, lh) * pmf(a, la);
  }
  return m;
}

function outcome(lh, la) {
  const m = scoreMatrix(lh, la);
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAX_GOALS; h++)
    for (let a = 0; a <= MAX_GOALS; a++) {
      if (h > a) home += m[h][a]; else if (h === a) draw += m[h][a]; else away += m[h][a];
    }
  return { m, home, draw, away };
}

export const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function samePlayer(a, b) {
  if (a.id && b.id) return a.id === b.id;
  const na = norm(a.name), nb = norm(b.name);
  if (na === nb) return true;
  const la = na.split(' ').pop(), lb = nb.split(' ').pop();
  return la.length > 3 && la === lb;
}

// Bilan domicile / extérieur d'une équipe, avec son rang dans son championnat
// (attaque : 1er = marque le plus ; défense : 1er = encaisse le moins)
export function teamSplit(rows, row) {
  if (!row) return null;
  const rank = (venue, key, asc) => {
    if (!rows) return null;
    const list = rows.filter(t => t[venue].p > 0).map(t => ({ t, v: t[venue][key] / t[venue].p }))
      .sort((x, y) => asc ? x.v - y.v : y.v - x.v);
    const i = list.findIndex(x => x.t === row);
    return i < 0 ? null : i + 1;
  };
  return {
    home: row.home, away: row.away, n: rows ? rows.length : null,
    ranks: { homeGf: rank('home', 'gf'), homeGa: rank('home', 'ga', true), awayGf: rank('away', 'gf'), awayGa: rank('away', 'ga', true) },
  };
}

// Moyenne pondérée vers 1 tant que peu de matchs ont été joués
// Réglages recalibrés après le bilan du week-end du 16-18 octobre (92 matchs) :
// - poids de 8 matchs « moyens » (les petits échantillons trompent) ;
// - bilan du match (domicile / extérieur) combiné à 50 % avec toute la saison de l'équipe ;
// - avantage du terrain et niveau de buts légèrement relevés (le modèle les sous-estimait).
const PRIOR = 8, VENUE_WEIGHT = 0.5, HOME_BOOST = 1.08, GOAL_LEVEL = 1.05;
// Avantage du terrain supplémentaire en coupe d'Europe quand les deux équipes ont un niveau proche
const HOME_EURO = 1.1;
const shrink = (v, n) => (v * n + 1 * PRIOR) / (n + PRIOR);

// --- 1. Buts attendus de base ------------------------------------------------
// Calcul générique (buts réels, xG ou « buts attendus selon le marché ») :
// bilan du match (domicile / extérieur) mêlé à toute la saison, ramené vers la moyenne s'il y a peu de matchs.
function lambdaFrom(s, ts, prior = PRIOR) {
  if (!s || !s.home || !s.away || !s.avgHome || !s.avgAway) return null;
  const sh = (v, n) => (v * n + prior) / (n + prior);
  const L = (s.avgHome + s.avgAway) / 2, w = VENUE_WEIGHT;
  const tot = t => t && t.home && t.away ? t.home.p + t.away.p : 0;
  const all = (t, k) => (t.home[k] + t.away[k]) / tot(t) / L;
  // Bilan à domicile (ou à l'extérieur) mêlé au bilan global. Si l'équipe n'a encore joué que de l'autre côté
  // (ex. 2e journée de coupe d'Europe), le bilan global sert seul.
  const side = (v, t, k, avgF, avgA) => {
    const venue = v && v.p > 0 ? { att: v.gf / v.p / avgF, def: v.ga / v.p / avgA } : null;
    const glob = tot(t) > 0 ? { att: all(t, 'gf'), def: all(t, 'ga') } : null;
    if (!venue && !glob) return null;
    if (venue && glob) return { att: w * venue.att + (1 - w) * glob.att, def: w * venue.def + (1 - w) * glob.def, n: tot(t) };
    return venue ? { ...venue, n: v.p } : { ...glob, n: tot(t) };
  };
  const H = side(s.home, ts && ts.home, 'home', s.avgHome, s.avgAway);
  const A = side(s.away, ts && ts.away, 'away', s.avgAway, s.avgHome);
  if (!H || !A) return null;
  let attH = H.att, defH = H.def, attA = A.att, defA = A.def;
  const nH = H.n, nA = A.n;
  attH = sh(attH, nH); defH = sh(defH, nH); attA = sh(attA, nA); defA = sh(defA, nA);
  return { lh: s.avgHome * attH * defA, la: s.avgAway * attA * defH, idx: { attH, defH, attA, defA } };
}

// Poids des trois sources (renormalisés selon ce qui est disponible) :
// le marché est le signal le plus fiable, puis les xG, puis les buts réels.
const W_GOALS = 0.35, W_XG = 0.25, W_MARKET = 0.40;

// Coupes d'Europe : la moyenne de la compétition n'est calculée que sur quelques journées (souvent très
// prolifiques en début de saison) ; on prend la référence d'une saison européenne normale (~3 buts par match)
const EURO_AVG = { avgHome: 1.65, avgAway: 1.35 };

// Buts par match des championnats : un 2-1 aux Pays-Bas (3,2 buts/match) ne vaut pas un 2-1 en Liga (2,6)
export const LEAGUE_GOALS = {
  'eng.1': 2.85, 'esp.1': 2.6, 'ita.1': 2.65, 'ger.1': 3.1, 'fra.1': 2.8, 'por.1': 2.6, 'ned.1': 3.2, 'bel.1': 2.9, 'tur.1': 2.9,
  'eng.2': 2.6, 'ger.2': 3.0, 'esp.2': 2.3, 'ita.2': 2.4, 'fra.2': 2.5, 'sco.1': 2.8, 'gre.1': 2.4, 'aut.1': 3.1, 'sui.1': 3.1,
  'den.1': 2.9, 'cze.1': 2.8, 'nor.1': 3.1, 'swe.1': 2.8, 'pol.1': 2.7, 'ukr.1': 2.6, 'cro.1': 2.7, 'srb.1': 2.8, 'isr.1': 2.6,
  'ksa.1': 2.9, 'rou.1': 2.5, 'cyp.1': 2.6, 'jpn.1': 2.6, 'eng.3': 2.7, 'eng.4': 2.6,
};
// Bilans de championnat ramenés à une échelle commune avant de comparer deux équipes de pays différents :
// on corrige le nombre de buts du championnat, et le niveau (marquer dans un petit championnat compte moins)
function normDomestic(m) {
  const d = m.domStats, L = m.level;
  if (!d || !L || !L.home || !L.away) return { stats: d, ts: m.domTeamStats };
  const fix = (side, r) => {
    if (!r) return r;
    // q : poids du niveau (exposant 0,75 plutôt que 0,5 depuis le bilan du 22/10 : Lillestrøm 0-6, Jagiellonia 0-3, Kauno 1-4)
    const lv = L[side], k = 2.7 / (LEAGUE_GOALS[lv.slug] || 2.7), q = Math.pow((lv.coef || 55) / 85, 0.75);
    return { ...r, gf: r.gf * k * q, ga: r.ga * k / q };
  };
  const ts = m.domTeamStats;
  return {
    stats: { ...d, home: fix('home', d.home), away: fix('away', d.away) },
    ts: ts && ts.home && ts.away ? {
      home: { ...ts.home, home: fix('home', ts.home.home), away: fix('home', ts.home.away) },
      away: { ...ts.away, home: fix('away', ts.away.home), away: fix('away', ts.away.away) },
    } : ts,
  };
}

function baseExpectedGoals(m) {
  const stats = m.comp && m.comp.type === 'europe' && m.stats ? { ...m.stats, ...EURO_AVG } : m.stats;
  // Match de coupe : bilan du championnat de chaque équipe, à poids égal avec celui de la compétition
  const nd = m.domStats ? normDomestic(m) : null;
  const D = nd ? lambdaFrom(nd.stats, nd.ts) : null;
  // 1re journée d'une coupe (0 match joué) : le bilan du championnat sert seul
  const G = lambdaFrom(stats, m.teamStats) || D;
  if (G) {
    const parts = [{ w: W_GOALS, lh: G.lh * HOME_BOOST * GOAL_LEVEL, la: G.la * GOAL_LEVEL }];
    if (D && D !== G) parts.push({ w: W_GOALS, lh: D.lh * HOME_BOOST * GOAL_LEVEL, la: D.la * GOAL_LEVEL });
    const X = m.xg ? lambdaFrom(m.xg, m.xg.teamStats) : null;
    if (X) parts.push({ w: W_XG, lh: X.lh * HOME_BOOST * GOAL_LEVEL, la: X.la * GOAL_LEVEL });
    // Le marché intègre déjà l'avantage du terrain : pas de correction
    const M = m.market ? lambdaFrom(m.market, m.market.teamStats, 3) : null;
    if (M) parts.push({ w: W_MARKET, lh: M.lh, la: M.la });
    const W = parts.reduce((s, p) => s + p.w, 0);
    return {
      lh: parts.reduce((s, p) => s + p.w * p.lh, 0) / W, la: parts.reduce((s, p) => s + p.w * p.la, 0) / W,
      method: 'stats', idx: G.idx, sources: { goals: G, xg: X, market: M },
    };
  }
  const pc = m.apiPrediction && m.apiPrediction.percent;
  if (pc && pc.home + pc.away > 0) return { ...fitToPercent(pc), method: 'prediction' };
  return { lh: 1.45, la: 1.15, method: 'defaut' };
}

// --- Cotes du jour : probabilités du marché (marge retirée) et mélange avec notre estimation ---
const MARKET_MIX = 0.5;
function marketTargets(odds) {
  const h = odds && odds.h2h;
  if (!h || !(h.home > 1 && h.draw > 1 && h.away > 1)) return null;
  const s = 1 / h.home + 1 / h.draw + 1 / h.away;
  const t = odds.totals && odds.totals['2.5'];
  const pO = t && t.over > 1 && t.under > 1 ? (1 / t.over) / (1 / t.over + 1 / t.under) : null;
  return { pH: (1 / h.home) / s, pD: (1 / h.draw) / s, pA: (1 / h.away) / s, pO };
}
function over25(M) { let s = 0; for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) if (h + a > 2) s += M[h][a]; return s; }
let FIT_GRID = null;
function fitTargets(pH, pA, pO) {
  if (!FIT_GRID) {
    FIT_GRID = [];
    for (let lh = 0.2; lh <= 4.01; lh += 0.05) for (let la = 0.2; la <= 4.01; la += 0.05) {
      const o = outcome(lh, la); FIT_GRID.push([lh, la, o.home, o.away, over25(o.m)]);
    }
  }
  let best = [1.4, 1.1], err = 9;
  for (const [lh, la, H, A, O] of FIT_GRID) {
    const e = (H - pH) ** 2 + (A - pA) ** 2 + (pO == null ? 0 : (O - pO) ** 2);
    if (e < err) { err = e; best = [lh, la]; }
  }
  return best;
}

// Retrouve des buts attendus cohérents avec des pourcentages 1N2 connus
function fitToPercent(pc) {
  const t = { home: pc.home / 100, draw: pc.draw / 100, away: pc.away / 100 };
  let best = { lh: 1.4, la: 1.1, err: 9 };
  for (let lh = 0.3; lh <= 3.5; lh += 0.05)
    for (let la = 0.3; la <= 3.5; la += 0.05) {
      const o = outcome(lh, la);
      const err = (o.home - t.home) ** 2 + (o.draw - t.draw) ** 2 + (o.away - t.away) ** 2 + 0.002 * (lh + la - 2.7) ** 2;
      if (err < best.err) best = { lh, la, err };
    }
  return { lh: best.lh, la: best.la };
}

// Ligne d'un poste (ESPN : G, CD-L, LB, AM-R, F… ; API-Football : G, D, M, F) : 'G' | 'D' | 'M' | 'F' | ''
export function lineOf(pos) {
  const p = String(pos || '').toUpperCase();
  if (!p || p === 'SUB') return '';
  if (p === 'G' || p === 'GK' || /^GOAL/.test(p)) return 'G';
  if (/^ATT/.test(p)) return 'F';
  if (/^(D|CB|CD|LB|RB|LWB|RWB|SW|WB)/.test(p)) return 'D';
  if (/^(CF|ST|LW|RW|LF|RF|F)/.test(p)) return 'F';
  if (/^(M|DM|CM|AM|LM|RM)/.test(p)) return 'M';
  return '';
}

// Équipe type d'une équipe : les plus titularisés de la saison (effectif ESPN, championnat + coupe additionnés)
// → { xi: [{ n, l, starts }], games } : 1 gardien + les 10 joueurs de champ les plus titularisés, ou null
export function seasonXI(m, side) {
  const sq = m.squad && m.squad[side], games = m.squadGames && m.squadGames[side];
  if (!sq || !games || games < 4 || !sq.some(p => p.starts)) return null;
  const by = [...sq].filter(p => p.starts > 0).sort((x, y) => y.starts - x.starts);
  const gk = by.find(p => p.l === 'G');
  const field = by.filter(p => p !== gk && p.l !== 'G').slice(0, 10);
  if (field.length < 10) return null;
  return { xi: [gk, ...field].filter(Boolean), games };
}

// Gros turn-over : poids des absents de 4 ou plus (un cadre compte 1, un titulaire habituel 0,5)
export const bigTurn = r => !!r && (r.weight != null ? r.weight >= 4 : r.changes >= 5);

// --- 2. Absences et remplaçants ------------------------------------------------
function teamPresence(m, side) {
  const lu = m.lineups && m.lineups[side];
  const official = !!(lu && lu.status === 'officielle' && lu.startXI && lu.startXI.length);
  const injuries = (m.injuries && m.injuries[side]) || [];
  const teamGoals = Math.max((m.teamGoals && m.teamGoals[side]) || 0, 1);
  // Buteurs : classement de la saison + joueurs en forme sur les derniers matchs (toutes compétitions),
  // même s'ils ne sont pas dans le classement (ex. un ailier qui enchaîne les buts depuis 3 semaines)
  const rg = m.recentGoals && m.recentGoals[side];
  const recentOf = n => { if (!rg) return null; const k = Object.keys(rg.players).find(x => samePlayer({ name: x }, { name: n })); return k ? rg.players[k] : 0; };
  const pool = [...((m.scorers && m.scorers[side]) || [])];
  if (rg) Object.entries(rg.players).forEach(([n, g]) => { if (g >= 2 && !pool.some(p => samePlayer(p, { name: n }))) pool.push({ id: null, name: n, goals: 0, played: null, pos: 'A', recentOnly: true }); });

  const players = pool.map(p => {
    const inj = injuries.find(i => samePlayer(i, p));
    let status = 'probable';
    if (official) {
      if (lu.startXI.some(x => samePlayer(x, p))) status = 'titulaire';
      else if ((lu.subs || []).some(x => samePlayer(x, p))) status = 'remplacant';
      else status = 'absent';
    } else if (inj) {
      status = /question|doubt|incertain/i.test(inj.type || '') ? 'incertain' : 'absent';
    }
    // Part des buts de l'équipe, calculée par match joué quand on le sait (joueur arrivé en cours
    // de saison, retour de blessure), sans descendre sous la moitié des matchs de l'équipe
    const games = m.teamGames && m.teamGames[side];
    const raw = p.played && games ? (p.goals / Math.max(p.played, games / 2)) / (teamGoals / games) : p.goals / teamGoals;
    // Petit échantillon (début de saison, coupe d'Europe) : part ramenée vers zéro, sinon 1 but sur 2 = « 50 % des buts »
    const seasonShare = p.recentOnly ? 0 : raw * teamGoals / (teamGoals + 4);
    // Forme récente : part des buts de l'équipe sur ses derniers matchs (ramenée vers zéro, petit échantillon)
    const recent = recentOf(p.name);
    const recentShare = rg && recent != null ? recent / (Math.max(rg.teamGoals, 1) + 3) : null;
    // Série en cours : part des buts sur les 3 derniers matchs (un joueur qui marque à chaque match pèse plus)
    const l3n = rg && rg.last3 ? (rg.last3[Object.keys(rg.last3).find(x => samePlayer({ name: x }, { name: p.name }))] || 0) : 0;
    const last3Share = rg && rg.last3Goals != null ? l3n / (rg.last3Goals + 2) : 0;
    const formShare = recentShare != null ? Math.max(recentShare, 0.8 * last3Share) : null;
    const share = p.recentOnly ? 0.8 * formShare : formShare != null ? 0.5 * seasonShare + 0.5 * formShare : seasonShare;
    // En forme : 3 buts sur les 6 derniers matchs, OU une série en cours (2 buts sur les 3 derniers)
    const last3 = l3n;
    const hot = recent != null && rg && (recent >= 3 || last3 >= 2 || (recent >= 2 && rg.games <= 4));
    // Retour de longue absence : aucune titularisation sur les 6 derniers matchs (blessure, suspension…)
    // → pas encore à 100 % : on ne le cible pas comme buteur
    const recXI = m.recentXI && m.recentXI[side];
    const returning = !p.recentOnly && recXI && recXI.length >= 5 && !recXI.slice(0, 6).some(xi => xi.some(x => samePlayer({ name: x.n }, p)));
    // Poste : compo officielle, sinon ses dernières titularisations, sinon le classement des buteurs
    // (G gardien, D défenseur, M milieu, F attaquant) — un défenseur à 2 buts n'est pas un buteur régulier
    const xiP = official && lu.startXI.find(x => samePlayer(x, p));
    const recP = recXI && recXI.flat().find(x => samePlayer({ name: x.n }, p));
    const line = (xiP && lineOf(xiP.pos)) || (recP && recP.l) || lineOf(p.pos) || '';
    return { ...p, team: m[side].name, status, line, reason: inj ? inj.reason : (status === 'absent' ? 'Hors groupe' : ''), share: Math.min(share, 0.7), recent, recentGames: rg ? rg.games : null, last3, hot, returning: !!returning };
  });

  // Impact offensif : part des buts de l'équipe que représentent les absents
  const weight = { absent: 0.6, remplacant: 0.35, incertain: 0.25 };
  let factor = 1;
  const missing = [];
  players.forEach(p => {
    if (weight[p.status]) {
      factor *= 1 - weight[p.status] * p.share;
      missing.push(p);
    }
  });
  // Absents qui ne sont pas des buteurs (défenseurs, gardiens...) : léger impact défensif
  const otherOut = injuries.filter(i => !pool.some(p => samePlayer(i, p)) && !/question|doubt/i.test(i.type || ''));
  // Rotation au dernier match : si l'équipe a laissé au repos au moins 3 titulaires habituels,
  // l'équipe type est attendue aujourd'hui (joueurs frais, même avec peu de jours de repos)
  let rested = null;
  const rec = m.recentXI && m.recentXI[side];
  if (rec && rec.length >= 4) {
    const cnt = new Map();
    rec.forEach(xi => xi.forEach(p => cnt.set(p.n, (cnt.get(p.n) || 0) + 1)));
    const regs = [...cnt.entries()].filter(([, n]) => n >= Math.ceil(rec.length * 0.6)).map(([n]) => n);
    const out = regs.filter(n => !rec[0].some(p => samePlayer({ name: p.n }, { name: n })));
    if (regs.length >= 8 && out.length >= 3) rested = { count: out.length, names: out.slice(0, 5) };
  }
  // Turn-over : titulaires habituels (5 derniers matchs) absents de la compo officielle, ligne par ligne,
  // quel que soit leur poste (un défenseur forfait non signalé par la liste des blessés est rattrapé ici)
  let rotation = null, attF = 1, defF = 1;
  if (official) {
    const squad = (m.squad && m.squad[side]) || [];
    const fromSquad = n => squad.find(s => samePlayer({ name: s.n }, { name: n }));
    const inXI = n => lu.startXI.some(x => samePlayer(x, { name: n }));
    const recent = m.recentXI && m.recentXI[side];
    const prev = m.lastXI && m.lastXI[side];
    let regulars = null, of = 1;
    // Équipe type = les 11 joueurs les plus titularisés de la SAISON, toutes compétitions réunies
    // (pas le dernier match, qui peut être un match de rotation en coupe)
    const xi11 = seasonXI(m, side);
    if (xi11) {
      of = xi11.games;
      regulars = xi11.xi;
    } else if (recent && recent.length >= 3) {
      // À défaut d'effectif : les joueurs les plus souvent titulaires sur les 8 derniers matchs
      of = recent.length;
      const cnt = new Map();
      recent.forEach(xi => xi.forEach(p => { const c = cnt.get(p.n) || { n: p.n, l: p.l, starts: 0 }; c.starts++; if (!c.l) c.l = p.l; cnt.set(p.n, c); }));
      regulars = [...cnt.values()].filter(c => c.starts >= Math.ceil(of * 0.6));
    } else if (prev && prev.length >= 11) {
      regulars = prev.map(n => ({ n: typeof n === 'string' ? n : n.n, l: typeof n === 'string' ? '' : n.l, starts: 1 }));
    }
    if (regulars) {
      // Importance de chaque absent : cadre (titulaire dans 80 % des matchs de la saison ou plus), gardien n° 1, ou buteur important
      const scorerShare = n => { const p = players.find(x => samePlayer(x, { name: n })); return p ? p.share : 0; };
      const out = regulars.filter(r => !inXI(r.n)).map(r => {
        const sq = fromSquad(r.n);
        const l = r.l || (sq && sq.l) || '';
        // (un gardien de coupe, titulaire une fois sur deux, n'est pas un cadre)
        const key = (l === 'G' && (of < 4 || r.starts / of >= 0.75)) || (of >= 4 && r.starts / of >= 0.8) || scorerShare(r.n) >= 0.15;
        return { n: r.n, l, starts: r.starts, key, bench: (lu.subs || []).some(x => samePlayer(x, { name: r.n })) };
      });
      const inn = lu.startXI.filter(x => !regulars.some(r => samePlayer(x, { name: r.n }))).map(x => {
        const sq = fromSquad(x.name);
        // Poste absent de la compo : celui de ses derniers matchs
        const rp = !x.pos && recent ? recent.flat().find(p => samePlayer({ name: p.n }, x)) : null;
        return { n: x.name, l: lineOf(x.pos) || (sq && sq.l) || (rp && rp.l) || '', apps: sq ? sq.apps : null };
      });
      // Poids du turn-over : un cadre compte pour 1, un titulaire « habituel » mais pas indiscutable pour 0,5
      const weight = out.reduce((s, o) => s + (o.key ? 1 : 0.5), 0);
      rotation = { changes: out.length, out, inn, of, keyOut: out.filter(o => o.key).length, weight, season: !!xi11 };
      // Effet sur les buts : défense remaniée = l'adversaire marque plus ; attaque remaniée = on marque moins
      // (les buteurs absents sont déjà comptés plus haut : on ne les compte pas deux fois)
      const notScorer = o => !pool.some(p => samePlayer(p, { name: o.n }));
      const rookie = l => inn.filter(x => x.l && l.includes(x.l) && x.apps != null && x.apps <= 2).length;
      const defOut = out.filter(o => o.l === 'G').length * 1.5 + out.filter(o => o.l === 'D').length;
      const attOut = out.filter(o => o.l === 'F' && notScorer(o)).length + out.filter(o => o.l === 'M' && notScorer(o)).length * 0.5;
      defF = 1 + Math.min(0.12, 0.025 * defOut + 0.02 * rookie('GD'));
      attF = 1 - Math.min(0.12, 0.03 * attOut + 0.02 * rookie('MF'));
      // Gros turn-over (5 titulaires habituels absents ou plus) : l'équipe perd ses automatismes,
      // au-delà des postes un par un (bilan du 22/10 : Juventus, Marseille, Brighton n'ont pas gagné)
      if (weight >= 4) { attF *= 0.95; defF *= 1.03; }
    }
  }
  return { official, players, missing, otherOut, rotation, rested, absFactor: Math.max(factor, 0.6), factor: Math.max(factor, 0.6) * attF, defPenalty: Math.min(1.2, (1 + Math.min(otherOut.length * 0.03, 0.12)) * defF) };
}

// --- 3. Forme -----------------------------------------------------------------
export function formPoints(f) {
  return (f || '').slice(-5).split('').reduce((s, c) => s + (c === 'W' ? 3 : c === 'D' ? 1 : 0), 0);
}
function formFactor(f) {
  if (!f) return 1;
  const n = Math.min(f.length, 5);
  return 1 + 0.08 * ((formPoints(f) / (3 * n)) - 0.5);
}

// --- 4. Analyse complète --------------------------------------------------------
export function analyzeMatch(m) {
  const base = baseExpectedGoals(m);
  const ph = teamPresence(m, 'home'), pa = teamPresence(m, 'away');

  // m.adj : ajustement selon le comportement face au niveau de l'adversaire du jour (±15 % max)
  const adj = m.adj || {};
  let lh = base.lh * ph.factor * formFactor(m.form && m.form.home) * pa.defPenalty * (adj.home || 1);
  let la = base.la * pa.factor * formFactor(m.form && m.form.away) * ph.defPenalty * (adj.away || 1);
  // Coupe d'Europe entre équipes de niveau proche : l'avantage du terrain pèse plus que d'habitude
  // (bilan du 22/10 : Braga 2-0 Gand, Monaco 3-0 Fribourg, Hoffenheim 3-0 Lyon, Sturm 1-0 Marseille, tous donnés à l'extérieur)
  const Lv = m.level;
  if (m.comp && m.comp.type === 'europe' && Lv && Lv.home && Lv.away && !Lv.home.unknown && !Lv.away.unknown
    && Math.abs(Lv.home.S - Lv.away.S) < 8) { lh *= HOME_EURO; la /= HOME_EURO; }
  // Cotes du jour connues : on mélange notre estimation avec celle du marché (les gros écarts
  // sont presque toujours des erreurs du modèle ; seuls les écarts modérés restent des « bonnes cotes »)
  const mk = marketTargets(m.odds);
  let modelP = null;
  if (mk) {
    const o0 = outcome(lh, la);
    modelP = { home: o0.home, draw: o0.draw, away: o0.away, o25: over25(o0.m) };
    const fit = fitTargets(
      MARKET_MIX * mk.pH + (1 - MARKET_MIX) * o0.home,
      MARKET_MIX * mk.pA + (1 - MARKET_MIX) * o0.away,
      mk.pO == null ? null : MARKET_MIX * mk.pO + (1 - MARKET_MIX) * modelP.o25,
    );
    lh = fit[0]; la = fit[1];
  }
  const o = outcome(lh, la);
  const M = o.m;

  const sum = f => { let s = 0; for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) if (f(h, a)) s += M[h][a]; return s; };
  const over = n => sum((h, a) => h + a > n);
  const btts = sum((h, a) => h > 0 && a > 0);

  const scores = [];
  for (let h = 0; h <= 5; h++) for (let a = 0; a <= 5; a++) scores.push({ h, a, p: M[h][a] });
  scores.sort((x, y) => y.p - x.p);

  const odds = m.odds || {};
  const h2h = odds.h2h || {}, tot = (odds.totals && odds.totals['2.5']) || {}, bt = odds.btts || {};
  const H = m.home.name, A = m.away.name;
  const markets = [
    { key: '1', label: `Victoire ${H}`, p: o.home, odd: h2h.home },
    { key: 'N', label: 'Match nul', p: o.draw, odd: h2h.draw },
    { key: '2', label: `Victoire ${A}`, p: o.away, odd: h2h.away },
    { key: '1N', label: `${H} ou nul`, p: o.home + o.draw },
    { key: 'N2', label: `${A} ou nul`, p: o.away + o.draw },
    { key: 'O15', label: 'Plus de 1,5 buts', p: over(1.5) },
    { key: 'O25', label: 'Plus de 2,5 buts', p: over(2.5), odd: tot.over },
    { key: 'U25', label: 'Moins de 2,5 buts', p: 1 - over(2.5), odd: tot.under },
    { key: 'O35', label: 'Plus de 3,5 buts', p: over(3.5) },
    { key: 'BTTS', label: 'Les deux équipes marquent', p: btts, odd: bt.yes },
    { key: 'NBTTS', label: 'Une équipe au moins ne marque pas', p: 1 - btts, odd: bt.no },
    { key: 'U15', label: 'Moins de 1,5 but', p: 1 - over(1.5) },
    { key: 'H2G', label: `${H} marque 2 buts ou plus`, p: 1 - pmf(0, lh) - pmf(1, lh) },
    { key: 'A2G', label: `${A} marque 2 buts ou plus`, p: 1 - pmf(0, la) - pmf(1, la) },
    { key: 'O45', label: 'Plus de 4,5 buts', p: over(4.5) },
    { key: 'H3+', label: `${H} gagne par 3 buts d'écart ou plus`, p: sum((h, a) => h - a >= 3) },
    { key: 'A3+', label: `${A} gagne par 3 buts d'écart ou plus`, p: sum((h, a) => a - h >= 3) },
    { key: 'BTTSO25', label: 'Les deux équipes marquent et plus de 2,5 buts', p: sum((h, a) => h > 0 && a > 0 && h + a > 2) },
    // Double chance « protégée » + buts : pour monter la cote d'une double chance
    { key: '1NU35', label: `${H} ou nul et moins de 3,5 buts`, p: sum((h, a) => h >= a && h + a <= 3) },
    { key: 'N2U35', label: `${A} ou nul et moins de 3,5 buts`, p: sum((h, a) => a >= h && h + a <= 3) },
    { key: '1NO15', label: `${H} ou nul et plus de 1,5 buts`, p: sum((h, a) => h >= a && h + a >= 2) },
    { key: 'N2O15', label: `${A} ou nul et plus de 1,5 buts`, p: sum((h, a) => a >= h && h + a >= 2) },
    { key: 'H3G', label: `${H} marque 3 buts ou plus`, p: 1 - pmf(0, lh) - pmf(1, lh) - pmf(2, lh) },
    { key: 'A3G', label: `${A} marque 3 buts ou plus`, p: 1 - pmf(0, la) - pmf(1, la) - pmf(2, la) },
    // Paris moins évidents : écart, combinaisons résultat + buts
    { key: 'H2+', label: `${H} gagne par 2 buts d'écart ou plus`, p: sum((h, a) => h - a >= 2) },
    { key: 'A2+', label: `${A} gagne par 2 buts d'écart ou plus`, p: sum((h, a) => a - h >= 2) },
    { key: '1O25', label: `${H} gagne et plus de 2,5 buts`, p: sum((h, a) => h > a && h + a > 2) },
    { key: '2O25', label: `${A} gagne et plus de 2,5 buts`, p: sum((h, a) => a > h && h + a > 2) },
    { key: '1BTTS', label: `${H} gagne et les deux équipes marquent`, p: sum((h, a) => h > a && a > 0) },
    { key: '2BTTS', label: `${A} gagne et les deux équipes marquent`, p: sum((h, a) => a > h && h > 0) },
    { key: '1CS', label: `${H} gagne sans encaisser`, p: sum((h, a) => h > a && a === 0) },
    { key: '2CS', label: `${A} gagne sans encaisser`, p: sum((h, a) => a > h && h === 0) },
  ].map(x => ({ ...x, edge: x.odd ? x.p * x.odd - 1 : null, minOdd: minOdd(x.p) }));
  // Pari « facile » : trop probable pour rapporter quelque chose (cote d'environ 1,50 ou moins),
  // simple victoire d'un gros favori, ou double chance du favori
  const homeFav = o.home >= o.away;
  markets.forEach(x => {
    x.easy = x.p >= 0.66 || (['1', '2'].includes(x.key) && x.p >= 0.6)
      || (x.key === '1N' && homeFav) || (x.key === 'N2' && !homeFav);
  });

  // Buteurs : part des buts du joueur x buts attendus de l'équipe x temps de jeu probable
  // (un titulaire est souvent remplacé avant la fin, d'où 0,9)
  const presenceMult = { titulaire: 0.9, probable: 0.8, incertain: 0.45, remplacant: 0.3, absent: 0 };
  // Les buts habituels des absents se reportent sur les joueurs présents (division par pres.absFactor)
  const scorerList = (pres, lambda, team) => pres.players
    .filter(p => p.status !== 'absent' && (p.goals >= 2 || p.recent >= 2))
    .map(p => {
      // Plafond à 60 % de chances de marquer : le maximum réaliste, même pour un grand attaquant
      // Défenseur : ses buts viennent surtout des coups de pied arrêtés, moins réguliers (× 0,75)
      const mu = Math.min(0.92, lambda * Math.min(p.share / pres.absFactor, 0.7) * presenceMult[p.status] * (p.returning ? 0.5 : 1) * (p.hot ? 1.2 : 1) * (p.line === 'D' ? 0.75 : 1));
      return { ...p, team, p1: 1 - Math.exp(-mu), p2: 1 - Math.exp(-mu) * (1 + mu) };
    })
    .sort((x, y) => y.p1 - x.p1).slice(0, 4);
  const scorers = { home: scorerList(ph, lh, H), away: scorerList(pa, la, A) };

  const ctx = { m, base, lh, la, o, ph, pa, markets, scores, scorers, overs: { o25: over(2.5), o35: over(3.5) }, btts, mk, modelP };
  const verdict = buildVerdict(ctx);
  return {
    lh, la, method: base.method, idx: base.idx, sources: base.sources, marketNow: mk, modelP,
    p: { home: o.home, draw: o.draw, away: o.away },
    markets, scores: scores.slice(0, 6), scorers,
    // Nombre total de buts : plus parlant que les scores exacts (qui sont tous peu probables un par un)
    goalDist: [
      { t: '0-1', p: 1 - over(1.5) }, { t: '2', p: over(1.5) - over(2.5) },
      { t: '3', p: over(2.5) - over(3.5) }, { t: '4+', p: over(3.5) },
    ],
    presence: { home: ph, away: pa },
    verdict, tips: verdict.tips, text: buildText(ctx, verdict),
  };
}

// Cote minimale à exiger pour jouer un pari : 1,40, et jamais moins que sa cote juste (1 ÷ probabilité).
// La piste suit l'ANALYSE : on ne l'écarte pas parce qu'elle est probable ; c'est la cote du bookmaker
// (que l'utilisateur vérifie) qui décide. Seuls les paris à plus de 85 % sont écartés : jamais payés 1,40.
// MAX_P = 0,71 : au-delà, la cote juste passe sous 1,40 (« Victoire PSG » à 1,30) : on ne la propose pas
export const MIN_ODD = 1.4, MAX_P = 0.71;
export const minOdd = p => p > 0 ? Math.max(MIN_ODD, Math.ceil(100 / p) / 100) : 99;

// --- 5. Verdict : à jouer / à surveiller / trop imprévisible --------------------
function buildVerdict(c) {
  const { o, markets, ph, pa } = c;
  const gap = Math.abs(o.home - o.away);
  const fav = Math.max(o.home, o.away);
  // --- Profil du match, puis stratégie adaptée ---
  // On ne propose JAMAIS de pari évident (plus de 80 %) : on vise la ligne la plus ambitieuse qui reste probable
  // (ex. « plus de 3,5 buts » plutôt que « plus de 1,5 » dans un match à buts).
  const H = c.m.home.name, A = c.m.away.name, tot = c.lh + c.la;
  const favSide = o.home >= o.away ? 'home' : 'away', favName = favSide === 'home' ? H : A;
  const dominant = gap >= 0.3, F = favSide === 'home' ? { r: ['H2+', '1O25', '1'], g: ['H3G', 'H2G'], cs: ['1CS', '1'] } : { r: ['A2+', '2O25', '2'], g: ['A3G', 'A2G'], cs: ['2CS', '2'] };
  // Profil jugé par rapport à la NORME de la compétition (ex. ~3 buts en Ligue des champions, ~2,7 en Ligue 1)
  const ref = c.m.comp && c.m.comp.type === 'europe' ? EURO_AVG.avgHome + EURO_AVG.avgAway
    : c.m.stats && c.m.stats.avgHome ? c.m.stats.avgHome + c.m.stats.avgAway : 2.7;
  // (« festival » durci : seulement 47 % de réussite au bilan du 21/10, contre 89 % pour « ouvert »)
  const profile = tot >= Math.max(3.6, ref * 1.25) ? 'festival' : tot >= Math.max(2.7, ref * 1.02) ? 'ouvert'
    : tot <= Math.min(2.3, ref * 0.8) ? 'ferme' : 'equilibre';
  const byKey = k => markets.find(x => x.key === k);
  // Cote d'au moins 1,40 (réelle si on l'a, sinon estimée) : pas de pari « sûr » qui ne rapporte rien
  const ok = x => x && x.p <= MAX_P && (!x.odd || x.odd >= MIN_ODD) && (x.edge == null || x.edge > -0.05);
  // Dans une famille rangée de la plus ambitieuse à la plus sûre : la plus ambitieuse à 55 % ou plus, sinon à 45 % ou plus
  const pick = keys => { const l = keys.map(byKey).filter(ok); return l.find(x => x.p >= 0.55) || l.filter(x => x.p >= 0.45).sort((a, b) => b.p - a.p)[0] || null; };
  // --- Le match sous tous ses angles : résultat, buts, les deux marquent, buts d'une équipe, combinés ---
  // Arguments hors statistiques pour départager un match serré : forme réelle, repos / rotation, fatigue, absents
  // Coupe : l'équipe qui reçoit vient d'un championnat plus fort, sans gros turn-over ni fatigue.
  // Dans un match équilibré, l'avantage du terrain fait alors pencher vers « victoire ou nul » à domicile
  // (bilan du 21/10 : Betis – Feyenoord 1-0, on avait joué « Feyenoord ou nul »).
  const Lv = c.m.level;
  const homeLeague = !!(Lv && Lv.home && Lv.away && !Lv.home.unknown && (Lv.home.coef || 0) >= (Lv.away.coef || 0) + 5);
  const homeFresh = !bigTurn(ph.rotation) && !(c.m.fatigue && c.m.fatigue.home && c.m.fatigue.home.tired);
  const homeLean = homeLeague && homeFresh && fav < 0.55;
  const edgeOf = side => {
    let e = 0;
    if (side === 'home' && homeLeague && homeFresh) e += 1;
    const p = c.m.perf && c.m.perf[side], f = c.m.fatigue && c.m.fatigue[side], pr = side === 'home' ? ph : pa;
    if (p && ['malchanceuse', 'en pleine bourre'].includes(p.label)) e += 1;
    if (p && ['chanceuse', 'en galère'].includes(p.label)) e -= 1;
    if (f && f.tired) e -= 1; // fatigue RELATIVE (2 jours de repos de moins que l'adversaire)
    if (pr.rested) e += 1;
    // Forme pondérée par le niveau des adversaires (5 derniers matchs, toutes compétitions)
    const rf = c.m.recentForm && c.m.recentForm[side];
    if (rf && ['solide', 'au-dessus'].includes(rf.label)) e += 1;
    if (rf && ['inquiétante', 'en dessous'].includes(rf.label)) e -= 1;
    if (pr.missing.some(x => x.status === 'absent' && x.share >= 0.15)) e -= 1;
    return e;
  };
  const lean = favSide === 'home' ? (edgeOf('home') >= edgeOf('away') ? 'home' : 'away') : (edgeOf('away') >= edgeOf('home') ? 'away' : 'home');
  const S = s => s === 'home' ? { win: '1', big: 'H2+', big3: 'H3+', dc: '1N', o25: '1O25', btts: '1BTTS', g3: 'H3G', g2: 'H2G', cs: '1CS' } : { win: '2', big: 'A2+', big3: 'A3+', dc: 'N2', o25: '2O25', btts: '2BTTS', g3: 'A3G', g2: 'A2G', cs: '2CS' };
  // --- L'analyse en trois étapes, chacune découle de la précédente ---
  // ① LE RÉSULTAT, toujours en premier : favori net = victoire (avec écart si c'est très net) ;
  //    favori moins net = double chance ; match serré = double chance du côté qui a les arguments
  const pick2 = (keys, min) => keys.map(byKey).filter(ok).find(x => x.p >= min) || null;
  let resSide = favSide, result;
  // Favori qui fait tourner (5 titulaires habituels absents ou plus) : il gagne moins souvent mais perd rarement
  // → on le protège avec le nul (bilan du 22/10 : 3 victoires sur 8, 1 seule défaite)
  const favRot = (favSide === 'home' ? ph : pa).rotation;
  // (un très gros favori, 68 % et plus malgré la rotation, reste traité normalement : sa double chance ne rapporte rien)
  const favTurn = bigTurn(favRot) && fav < 0.68;
  if (fav >= 0.55 && favTurn) result = pick([S(favSide).dc]);
  if (!result && fav >= 0.55 && !favTurn) result = pick([S(favSide).big, S(favSide).win]);
  // Favori écrasant (victoire sous 1,40) : on joue ce qui est plus excitant et découle de sa victoire
  if (!result && fav >= 0.55 && !favTurn) result = pick2([S(favSide).big3, S(favSide).big, S(favSide).o25, S(favSide).g3, S(favSide).btts, S(favSide).cs], 0.45);
  if (!result && homeLean) { const t = pick(['1N']); if (t) { resSide = 'home'; result = { ...t, homeEdge: true }; } }
  if (!result && fav >= 0.42 && fav < 0.55) result = pick([S(favSide).dc]);
  if (!result) { resSide = lean; result = pick([S(lean).dc]); }
  const isDC = result && ['1N', 'N2'].includes(result.key);
  // ② LES BUTS, selon le profil du match
  // Favori net face à une équipe qui marque peu : le favori gagne souvent sans encaisser (2-0, 3-0).
  // On joue alors les buts DU FAVORI plutôt que « plus de 2,5 » ou « les deux marquent »
  // (bilan du 22/10 : « favori marque 2 buts ou plus » 8/10, contre 5/9 pour « plus de 2,5 »)
  const clearFav = fav >= 0.58;
  const goals = profile === 'ferme' ? pick(['U15', 'U25'])
    : clearFav ? (pick([S(favSide).g3, S(favSide).g2]) || pick(profile === 'equilibre' ? ['O25'] : ['O35', 'O25']))
    : profile === 'equilibre' ? pick(['BTTS', 'O25'])
    : pick(['O45', 'O35', 'O25']);
  // ③ CE QUI EN DÉCOULE, pour monter la cote (40 % et plus)
  const derived = [];
  if (result) {
    const R = resSide === 'home' ? { u35: '1NU35', o15: '1NO15' } : { u35: 'N2U35', o15: 'N2O15' };
    if (profile === 'ferme') derived.push(isDC ? pick2([R.u35], 0.4) : pick2([S(resSide).cs], 0.4));      // favori protégé, peu de buts
    else if (isDC) derived.push(pick2([R.o15], 0.45));                                                     // double chance + des buts
    else {
      // Favori net : il gagne souvent sans encaisser ; sinon il gagne dans un match à buts
      derived.push(pick2(clearFav ? [S(resSide).cs, S(resSide).o25] : [S(resSide).o25, S(resSide).btts], 0.42));
      if ((resSide === 'home' ? c.lh : c.la) >= 1.6) derived.push(pick([S(resSide).g3, S(resSide).g2]));    // le favori marque beaucoup
    }
  }
  if ((profile === 'festival' || profile === 'ouvert') && !clearFav) derived.push(pick2(['BTTSO25'], 0.45));
  if (profile === 'festival' && goals) {
    const next = { O25: 'O35', O35: 'O45' }[goals.key] && byKey({ O25: 'O35', O35: 'O45' }[goals.key]);
    if (next && next.p >= 0.45 && ok(next)) derived.push({ ...next, label: `${next.label} (audacieux)` });
  }
  const tips = [];
  [[result, 'result'], [goals, 'goals'], ...derived.map(d => [d, 'derived'])].forEach(([t, k]) => {
    if (t && !tips.some(x => x.key === t.key)) tips.push({ ...t, angle: k });
  });
  tips.splice(4); // résultat, buts, et au plus 2 paris qui en découlent

  // Buteurs : seulement dans les équipes qui doivent marquer (1,2 but attendu ou plus), jamais dans un match fermé
  const scoring = s => (s === 'home' ? c.lh : c.la) >= 1.2;
  // Match fermé : peu de buts attendus, donc aucun pari buteur
  // (et jamais un joueur qui revient d'une longue absence)
  const sc = profile === 'ferme' ? [] : [...c.scorers.home.filter(() => scoring('home')), ...c.scorers.away.filter(() => scoring('away'))]
    .filter(p => !p.returning && p.line !== 'D' && p.line !== 'G').sort((a, b) => b.p1 - a.p1); // jamais un défenseur en pari buteur
  // Pari buteur : à partir de 30 % (cote d'environ 3), titulaire confirmé en priorité
  const scorerTip = sc.find(p => p.status === 'titulaire' && p.p1 >= 0.3 && p.p1 < 0.7) || sc.find(p => p.p1 >= 0.3 && p.p1 < 0.7);
  if (scorerTip) tips.push({ key: 'SC', label: `${scorerTip.name} buteur${scorerTip.status === 'titulaire' ? ' (titulaire)' : ''}`, p: scorerTip.p1, edge: null, minOdd: minOdd(scorerTip.p1), team: scorerTip.team, player: scorerTip.name, hot: scorerTip.hot, recent: scorerTip.recent, recentGames: scorerTip.recentGames, last3: scorerTip.last3 });
  // Joueur en série (2 buts sur ses 3 derniers matchs…) : proposé dès 22 %, cote d'environ 4,5
  const hotTip = sc.find(p => p.hot && p !== scorerTip && p.p1 >= 0.22 && p.status !== 'remplacant');
  if (hotTip) tips.push({ key: 'SC', label: `${hotTip.name} buteur (en série 🔥)`, p: hotTip.p1, edge: null, minOdd: minOdd(hotTip.p1), team: hotTip.team, player: hotTip.name, hot: true, recent: hotTip.recent, recentGames: hotTip.recentGames, last3: hotTip.last3 });
  // Buteur double chance : « X ou Y marque » avec les deux meilleurs buteurs présents
  // (on suppose les deux événements indépendants : légèrement optimiste si les deux jouent ensemble)
  const duo = sc.filter(p => p.p1 >= 0.25 && p.status !== 'remplacant' && p.status !== 'incertain').slice(0, 2);
  if (duo.length === 2) {
    const pd = 1 - (1 - duo[0].p1) * (1 - duo[1].p1);
    if (pd >= 0.45 && pd <= MAX_P) tips.push({ key: 'SCD', label: `${duo[0].name} ou ${duo[1].name} buteur`, p: pd, edge: null, minOdd: minOdd(pd), duo: duo.map(p => ({ name: p.name, team: p.team, p1: p.p1, goals: p.goals, status: p.status })) });
  }
  // Doublé : seulement quand on attend beaucoup de buts de cette équipe
  const dbl = (profile === 'festival' || dominant) ? sc.find(p => p.p2 >= 0.15) : null;
  if (dbl) tips.push({ key: 'SC2', label: `${dbl.name} doublé (pari osé)`, p: dbl.p2, edge: null, minOdd: minOdd(dbl.p2), player: dbl.name });

  // --- Solidité de chaque piste (1 à 5) : pas seulement sa probabilité, mais la qualité de ce qui la soutient ---
  const nG2 = x => x && x.home && x.away ? Math.min(x.home.p, x.away.p) : 0;
  const games = Math.max(nG2(c.m.stats), nG2(c.m.domStats));
  const official2 = ph.official && pa.official;
  const mkGap = c.mk && c.modelP ? Math.abs(c.modelP.home - c.mk.pH) : null;
  const bigRot = [ph, pa].some(pr => bigTurn(pr.rotation));
  const lvlTight = c.m.level && c.m.level.home && c.m.level.away && Math.abs(c.m.level.home.S - c.m.level.away.S) < 5;
  tips.forEach(t => {
    const scorer = String(t.key).startsWith('SC');
    let s = 1.5 + Math.max(0, Math.min(2.5, (t.p - 0.45) / 0.1));            // probabilité : 45 % → 1,5 ; 60 % → 3 ; 70 % → 4
    s += games >= 4 ? 0.75 : games >= 3 ? 0.25 : games < 2 ? -0.75 : 0;       // assez de matchs pour y croire
    if (official2) s += 0.5;                                                  // compos officielles connues
    if (mkGap != null) s += mkGap < 0.08 ? 0.5 : mkGap > 0.15 ? -0.5 : 0;     // d'accord (ou pas) avec les bookmakers
    if (bigRot) s -= 0.5;                                                     // gros turn-over : moins prévisible
    if (t.angle === 'derived') s -= 0.5;                                      // pari combiné : deux conditions à remplir
    if (t.angle === 'result' && lvlTight && c.m.comp && c.m.comp.type !== 'league') s -= 0.5; // coupe, niveaux proches
    if (['O35', 'O45'].includes(t.key) || /audacieux/.test(t.label || '')) s -= 0.5; // lignes ambitieuses : souvent ratées
    if (mkGap == null) s = Math.min(s, 4);                                    // sans cote de bookmaker pour confirmer : 4/5 au plus
    if (scorer) s = Math.min(s, 3);                                           // un buteur n'est jamais « très sûr »
    t.solid = Math.max(1, Math.min(5, Math.round(s)));
  });

  // Le plan en une phrase
  const n1 = x => x.toFixed(1).replace('.', ',');
  const plan = {
    festival: `🎆 Festival de buts attendu (${n1(tot)} buts) : on vise les buts${dominant ? ` et les buteurs de ${favName}` : ' des deux côtés'}.`,
    ouvert: `⚡ Match ouvert (${n1(tot)} buts attendus) : ${byKey('BTTS').p >= 0.55 ? 'les deux équipes devraient marquer' : 'des buts, surtout côté ' + favName}.`,
    equilibre: `⚖️ Match ${gap < 0.12 ? 'serré' : 'équilibré'} (${n1(tot)} buts attendus) : ${dominant ? `${favName} favori` : gap >= 0.15 ? `léger avantage ${favName}` : 'pas de favori net, prudence'}.`,
    ferme: `🔒 Match fermé (${n1(tot)} buts attendus) : peu de buts, on évite les paris buteur.`,
  }[profile];
  // Les paris évidents, cités seulement pour expliquer pourquoi on les écarte
  const easy = markets.filter(x => x.easy && x.p >= 0.6 && ['1', '2', 'O15', 'U25', 'O25', '1N', 'N2'].includes(x.key)).sort((a, b) => b.p - a.p).slice(0, 2);

  const values = markets.filter(x => x.edge != null && x.edge > 0.06 && x.p > 0.3);
  // Indice d'intérêt sur 100 : force de la meilleure piste NON évidente,
  // cotes intéressantes et fiabilité des infos (compositions officielles ou non)
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const mainTips = tips.filter(t => !String(t.key).startsWith('SC'));
  const bestP = Math.max(0, ...mainTips.map(t => t.p));
  const secondP = mainTips.length > 1 ? Math.min(...mainTips.slice(0, 2).map(t => t.p)) : 0;
  let score = clamp01((bestP - 0.45) / 0.2) * 55 + clamp01((secondP - 0.45) / 0.2) * 10;
  score += Math.min(values.length * 8 + Math.max(0, ...values.map(v => v.edge)) * 50, 20);
  score += (ph.official && pa.official) ? 15 : (ph.official || pa.official) ? 8 : 3;
  if (c.base.method === 'defaut') score -= 25;
  // Peu de matchs joués à domicile / à l'extérieur : chiffres fragiles
  const s = c.m.stats, ds = c.m.domStats, nG = x => x && x.home && x.away ? Math.min(x.home.p, x.away.p) : 0;
  const few = !!s && Math.max(nG(s), nG(ds)) < 4;
  if (few) score -= 8;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const obvious = fav >= 0.6;
  let code = 'skip', label = obvious ? 'Trop évident' : 'Trop imprévisible';
  if (score >= 60) { code = 'play'; label = 'Intéressant'; }
  else if (score >= 30) { code = 'watch'; label = 'À surveiller'; }
  // La solidité de la meilleure piste départage les verdicts (et pas seulement sa probabilité)
  const maxSolid = Math.max(0, ...mainTips.map(t => t.solid || 0));
  if (code === 'play' && maxSolid >= 5) label = 'Base solide';
  else if (code === 'play' && maxSolid <= 3) { code = 'watch'; label = 'À surveiller'; }
  else if (code === 'watch' && maxSolid >= 4 && score >= 50) { code = 'play'; label = 'Intéressant'; }
  else if (code === 'watch' && maxSolid <= 2) { code = 'skip'; label = 'Trop fragile'; }
  // Sans statistiques, aucune piste n'a de sens
  if (c.base.method === 'defaut') {
    tips.length = 0;
    return { code: 'skip', label: 'Pas de statistiques', score: 0, tips, flags: [], values: [], obvious: false, easy: [] };
  }

  // Étiquettes, chacune avec son explication (affichée quand on appuie dessus)
  const dogName = o.home >= o.away ? A : H;
  const hs = s && s.home, as = s && s.away, per = (x, n) => n ? (x / n).toFixed(1).replace('.', ',') : '–';
  const venueLine = hs && as ? `${H} marque ${per(hs.gf, hs.p)} et encaisse ${per(hs.ga, hs.p)} but par match à domicile ; ${A} marque ${per(as.gf, as.p)} et encaisse ${per(as.ga, as.p)} à l'extérieur.` : '';
  const totG = (c.lh + c.la).toFixed(1).replace('.', ',');
  const flags = [];
  if (gap >= 0.35) flags.push({ t: 'Gros écart', k: 'gap', why: `${favName} gagne dans ${pct(fav)} des cas, ${dogName} dans ${pct(Math.min(o.home, o.away))}. ${venueLine}` });
  if (gap < 0.12) flags.push({ t: 'Match serré', k: 'tight', why: `${H} ${pct(o.home)}, nul ${pct(o.draw)}, ${A} ${pct(o.away)} : aucun favori net, le résultat est risqué. ${venueLine}` });
  if (c.overs.o25 >= 0.6) flags.push({ t: 'Match à buts', k: 'goals', why: `${totG} buts attendus (${c.lh.toFixed(1).replace('.', ',')} pour ${H}, ${c.la.toFixed(1).replace('.', ',')} pour ${A}). Plus de 2,5 buts : ${pct(c.overs.o25)}, les deux marquent : ${pct(c.btts)}. ${venueLine}` });
  if (c.overs.o25 <= 0.4) flags.push({ t: 'Match fermé', k: 'closed', why: `Seulement ${totG} buts attendus. Moins de 2,5 buts : ${pct(1 - c.overs.o25)}. ${venueLine}` });
  const bigOut = [...ph.missing, ...pa.missing].filter(p => p.share >= 0.15 && p.status !== 'incertain');
  if (bigOut.length) flags.push({ t: `${bigOut.length} gros absent${bigOut.length > 1 ? 's' : ''}`, k: 'absent', why: bigOut.map(p => `${p.name} (${p.team || ''}${p.status === 'remplacant' ? ', sur le banc' : ''}) : ${p.goals} buts, ${pct(p.share)} des buts de son équipe.`).join(' ') + ' L\'attaque concernée est revue à la baisse.' });
  if (values.length) flags.push({ t: 'Cote intéressante', k: 'value', why: values.map(x => `${x.label} : cote ${x.odd.toFixed(2).replace('.', ',')}, alors qu'on l'estime à ${pct(x.p)} (cote juste ${(1 / x.p).toFixed(2).replace('.', ',')}).`).join(' ') });
  if ((c.m.tierFlags || []).length) flags.push({ t: 'Forme trompeuse', k: 'value', why: c.m.tierFlags.map(t => t.replace(/^Forme trompeuse : /, '')).join(' ') });
  ['home', 'away'].forEach(side => {
    const p = c.m.perf && c.m.perf[side];
    if (!p || !p.label) return;
    const name = c.m[side].name, n = p.n, f1 = x => x.toFixed(1).replace('.', ',');
    const facts = `${f1(p.sotF)} tirs cadrés par match pour, ${f1(p.sotA)} contre, ${Math.round(p.poss)} % de possession sur ses ${n} derniers matchs.`;
    const lbl = { malchanceuse: `${name} malchanceuse`, chanceuse: `${name} chanceuse`, 'en pleine bourre': `${name} en feu`, 'en galère': `${name} en galère` }[p.label];
    const why = { malchanceuse: 'Elle se crée plus d\'occasions que ses résultats ne le montrent : ses résultats devraient s\'améliorer.', chanceuse: 'Ses résultats sont meilleurs que son jeu : attention au retour sur terre.', 'en pleine bourre': 'Elle domine ses matchs et les gagne.', 'en galère': 'Elle subit ses matchs et les perd.' }[p.label];
    if (lbl) flags.push({ t: lbl, k: p.label === 'chanceuse' || p.label === 'en galère' ? 'warn' : 'value', why: `${why} ${facts}` });
  });
  // Raison du verdict, en clair (affichée sur la fiche)
  const official = ph.official && pa.official;
  let reason;
  if (code === 'play') reason = ['piste solide', official && 'compos officielles', values.length && 'cote intéressante'].filter(Boolean).join(' · ');
  else if (code === 'watch') reason = !official && bestP >= 0.6 ? 'piste solide, en attente des compos officielles'
    : bestP < 0.6 ? `meilleure piste à ${pct(bestP)} : pas assez nette (60 % minimum)`
    : few ? 'peu de matchs joués : chiffres encore fragiles' : 'pas assez de marge sur les cotes';
  else reason = obvious ? 'favori trop évident, rien d\'intéressant à côté' : 'trop serré ou imprévisible';
  if (obvious) flags.push({ t: 'Favori évident', k: 'gap', why:`${favName} gagne dans ${pct(fav)} des cas : la victoire simple est trop mal payée pour être intéressante. Les pistes cherchent un angle à côté (écart, buts).` });
  return { code, label, score, reason, plan, profile, tips: tips.slice(0, 7), flags, values, obvious, easy };
}

// --- 6. Texte d'analyse --------------------------------------------------------
const pct = p => `${Math.round(p * 100)} %`;
const list = arr => arr.length <= 1 ? arr.join('') : arr.slice(0, -1).join(', ') + ' et ' + arr[arr.length - 1];

function buildText(c, v) {
  const { m, o, ph, pa, lh, la } = c;
  const H = m.home.name, A = m.away.name;
  const out = [];

  // Favori
  const favName = o.home >= o.away ? H : A, favP = Math.max(o.home, o.away);
  if (Math.abs(o.home - o.away) < 0.12) out.push(`Match très équilibré : ${H} ${pct(o.home)}, nul ${pct(o.draw)}, ${A} ${pct(o.away)}. Aucun favori net.`);
  else if (favP >= 0.6) out.push(`${favName} est nettement favori (${pct(favP)} de chances de gagner).`);
  else out.push(`${favName} part légèrement favori (${pct(favP)}), mais le nul reste possible (${pct(o.draw)}).`);

  // Forces attaque / défense
  if (c.base.idx) {
    const { attH, defH, attA, defA } = c.base.idx;
    const desc = (v, good) => v >= 1.2 ? (good ? 'très solide' : 'redoutable') : v <= 0.8 ? (good ? 'fragile' : 'peu efficace') : 'dans la moyenne';
    out.push(`À domicile, ${H} a une attaque ${desc(attH, false)} et une défense ${desc(2 - defH, true)}. À l'extérieur, ${A} a une attaque ${desc(attA, false)} et une défense ${desc(2 - defA, true)}.`);
  } else if (c.base.method === 'prediction') {
    out.push('Pas de classement commun aux deux équipes (match de coupe) : l\'estimation se base sur la prédiction de la source de données.');
  } else {
    out.push('Pas de statistiques pour cette compétition dans l\'offre gratuite : aucune piste n\'est proposée. Utilisez votre projet Claude pour l\'analyser.');
  }

  if (m.stats && m.stats.home && m.stats.away && Math.min(m.stats.home.p, m.stats.away.p) < 4) {
    out.push(`Attention : seulement ${m.stats.home.p} matchs à domicile pour ${H} et ${m.stats.away.p} à l'extérieur pour ${A}. Les chiffres sont encore fragiles.`);
  }

  // Forme
  if (m.form && (m.form.home || m.form.away)) {
    const fp = f => formPoints(f);
    const fh = fp(m.form.home), fa = fp(m.form.away);
    if (Math.abs(fh - fa) >= 5) out.push(`Dynamique favorable à ${fh > fa ? H : A} (${fh > fa ? fh : fa} points sur les 5 derniers matchs contre ${fh > fa ? fa : fh}).`);
  }

  // Niveau des adversaires (gros / moyens / faibles)
  (m.tierText || []).forEach(t => out.push(t));

  // Absences
  const absText = (team, pres) => {
    const big = pres.missing.filter(p => p.status === 'absent');
    const bench = pres.missing.filter(p => p.status === 'remplacant');
    const doubt = pres.missing.filter(p => p.status === 'incertain');
    const parts = [];
    if (big.length) parts.push(`${team} est privé de ${list(big.map(p => `${p.name} (${p.goals} buts, ${pct(p.share)} des buts de l'équipe)`))}`);
    if (bench.length) parts.push(`${list(bench.map(p => p.name))} ${bench.length > 1 ? 'commencent' : 'commence'} sur le banc côté ${team} : attendez-vous à ${bench.length > 1 ? 'leur' : 'son'} entrée en seconde période`);
    if (doubt.length) parts.push(`${list(doubt.map(p => p.name))} ${doubt.length > 1 ? 'sont incertains' : 'est incertain'} côté ${team}`);
    const noPool = !pres.players.length;
    if (pres.otherOut.length >= (noPool ? 1 : 2)) parts.push(`${noPool ? 'Absents' : `${pres.otherOut.length} autres absents`} côté ${team} : ${list(pres.otherOut.slice(0, 4).map(p => p.name))}`);
    return parts;
  };
  const abs = [...absText(H, ph), ...absText(A, pa)];
  if (abs.length) out.push(abs.join('. ') + '.');
  else if (!ph.players.length && !pa.players.length) out.push('Aucun absent connu pour ce match pour l\'instant.');
  else out.push(ph.official && pa.official ? 'Compositions officielles : aucun buteur important ne manque.' : 'Pas d\'absence majeure signalée parmi les buteurs pour l\'instant.');

  // Buts
  const tg = lh + la;
  let goals = `Buts attendus : ${lh.toFixed(1)} pour ${H}, ${la.toFixed(1)} pour ${A} (${tg.toFixed(1)} au total). `;
  if (c.overs.o25 >= 0.6) goals += `Profil de match à buts : plus de 2,5 buts à ${pct(c.overs.o25)}.`;
  else if (c.overs.o25 <= 0.4) goals += `Profil de match fermé : moins de 2,5 buts à ${pct(1 - c.overs.o25)}.`;
  else goals += `Nombre de buts incertain (plus de 2,5 buts à ${pct(c.overs.o25)}).`;
  goals += ` Les deux équipes marquent : ${pct(c.btts)}.`;
  out.push(goals);

  // Buteurs
  const sc = [...c.scorers.home, ...c.scorers.away].sort((a, b) => b.p1 - a.p1);
  if (!sc.length) out.push('Buteurs : pas de classement des buteurs disponible pour ce match.');
  if (sc.length) {
    const top = sc.slice(0, 3).map(p => `${p.name} (${pct(p.p1)})`);
    let t = `Buteurs à surveiller : ${list(top)}.`;
    const dbl = sc.filter(p => p.p2 >= 0.1);
    if (dbl.length) t += ` Possible doublé pour ${list(dbl.slice(0, 2).map(p => `${p.name} (${pct(p.p2)})`))}.`;
    out.push(t);
  }

  // Conclusion
  if (v.values.length) out.push(`Cote intéressante : ${list(v.values.map(x => `${x.label} à ${x.odd.toFixed(2)} (estimé à ${pct(x.p)})`))}.`);
  if (v.easy.length) out.push(`Pari évident écarté : ${list(v.easy.map(x => `${x.label} (${pct(x.p)})`))}. Trop probable pour rapporter quelque chose.`);
  if (v.tips.length) out.push(`Pistes à aller chercher : ${list(v.tips.map(t => `${t.label} (${pct(t.p)})`))}.`);
  if (v.code === 'play') out.push('Verdict : il y a quelque chose à faire sur ce match.');
  else if (v.code === 'watch') out.push('Verdict : à surveiller, attendez les compositions ou une meilleure cote.');
  else if (v.obvious) out.push('Verdict : favori trop évident et pas d\'angle solide à côté, mieux vaut passer.');
  else out.push('Verdict : match trop serré ou imprévisible, mieux vaut passer.');
  if (!ph.official || !pa.official) out.push('Compositions officielles pas encore publiées : l\'analyse sera mise à jour automatiquement.');
  return out;
}
