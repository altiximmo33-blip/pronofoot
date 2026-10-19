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
const shrink = (v, n) => (v * n + 1 * PRIOR) / (n + PRIOR);

// --- 1. Buts attendus de base ------------------------------------------------
function baseExpectedGoals(m) {
  const s = m.stats;
  if (s && s.home && s.away && s.home.p > 0 && s.away.p > 0) {
    let attH = s.home.gf / s.home.p / s.avgHome, defH = s.home.ga / s.home.p / s.avgAway;
    let attA = s.away.gf / s.away.p / s.avgAway, defA = s.away.ga / s.away.p / s.avgHome;
    let nH = s.home.p, nA = s.away.p;
    // Toute la saison (domicile + extérieur) quand elle est connue
    const ts = m.teamStats;
    if (ts && ts.home && ts.away && ts.home.away && ts.away.home && ts.home.away.p > 0 && ts.away.home.p > 0) {
      const L = (s.avgHome + s.avgAway) / 2;
      const all = (t, k) => (t.home[k] + t.away[k]) / (t.home.p + t.away.p) / L;
      const w = VENUE_WEIGHT;
      attH = w * attH + (1 - w) * all(ts.home, 'gf'); defH = w * defH + (1 - w) * all(ts.home, 'ga');
      attA = w * attA + (1 - w) * all(ts.away, 'gf'); defA = w * defA + (1 - w) * all(ts.away, 'ga');
      nH = ts.home.home.p + ts.home.away.p; nA = ts.away.home.p + ts.away.away.p;
    }
    attH = shrink(attH, nH); defH = shrink(defH, nH); attA = shrink(attA, nA); defA = shrink(defA, nA);
    return {
      lh: s.avgHome * HOME_BOOST * GOAL_LEVEL * attH * defA, la: s.avgAway * GOAL_LEVEL * attA * defH, method: 'stats',
      idx: { attH, defH, attA, defA },
    };
  }
  const pc = m.apiPrediction && m.apiPrediction.percent;
  if (pc && pc.home + pc.away > 0) return { ...fitToPercent(pc), method: 'prediction' };
  return { lh: 1.45, la: 1.15, method: 'defaut' };
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

// --- 2. Absences et remplaçants ------------------------------------------------
function teamPresence(m, side) {
  const lu = m.lineups && m.lineups[side];
  const official = !!(lu && lu.status === 'officielle' && lu.startXI && lu.startXI.length);
  const injuries = (m.injuries && m.injuries[side]) || [];
  const teamGoals = Math.max((m.teamGoals && m.teamGoals[side]) || 0, 1);
  const pool = (m.scorers && m.scorers[side]) || [];

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
    return { ...p, status, reason: inj ? inj.reason : (status === 'absent' ? 'Hors groupe' : ''), share: Math.min(p.goals / teamGoals, 0.7) };
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
  return { official, players, missing, otherOut, factor: Math.max(factor, 0.6), defPenalty: 1 + Math.min(otherOut.length * 0.03, 0.12) };
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
  const lh = base.lh * ph.factor * formFactor(m.form && m.form.home) * pa.defPenalty * (adj.home || 1);
  const la = base.la * pa.factor * formFactor(m.form && m.form.away) * ph.defPenalty * (adj.away || 1);
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
    // Paris moins évidents : écart, combinaisons résultat + buts
    { key: 'H2+', label: `${H} gagne par 2 buts d'écart ou plus`, p: sum((h, a) => h - a >= 2) },
    { key: 'A2+', label: `${A} gagne par 2 buts d'écart ou plus`, p: sum((h, a) => a - h >= 2) },
    { key: '1O25', label: `${H} gagne et plus de 2,5 buts`, p: sum((h, a) => h > a && h + a > 2) },
    { key: '2O25', label: `${A} gagne et plus de 2,5 buts`, p: sum((h, a) => a > h && h + a > 2) },
    { key: '1BTTS', label: `${H} gagne et les deux équipes marquent`, p: sum((h, a) => h > a && a > 0) },
    { key: '2BTTS', label: `${A} gagne et les deux équipes marquent`, p: sum((h, a) => a > h && h > 0) },
    { key: '1CS', label: `${H} gagne sans encaisser`, p: sum((h, a) => h > a && a === 0) },
    { key: '2CS', label: `${A} gagne sans encaisser`, p: sum((h, a) => a > h && h === 0) },
  ].map(x => ({ ...x, edge: x.odd ? x.p * x.odd - 1 : null }));
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
  const scorerList = (pres, lambda, team) => pres.players
    .filter(p => p.status !== 'absent')
    .map(p => {
      const mu = lambda * p.share * presenceMult[p.status];
      return { ...p, team, p1: 1 - Math.exp(-mu), p2: 1 - Math.exp(-mu) * (1 + mu) };
    })
    .sort((x, y) => y.p1 - x.p1).slice(0, 4);
  const scorers = { home: scorerList(ph, lh, H), away: scorerList(pa, la, A) };

  const ctx = { m, base, lh, la, o, ph, pa, markets, scores, scorers, overs: { o25: over(2.5), o35: over(3.5) }, btts };
  const verdict = buildVerdict(ctx);
  return {
    lh, la, method: base.method, idx: base.idx,
    p: { home: o.home, draw: o.draw, away: o.away },
    markets, scores: scores.slice(0, 6), scorers,
    presence: { home: ph, away: pa },
    verdict, tips: verdict.tips, text: buildText(ctx, verdict),
  };
}

// --- 5. Verdict : à jouer / à surveiller / trop imprévisible --------------------
function buildVerdict(c) {
  const { o, markets, ph, pa } = c;
  const gap = Math.abs(o.home - o.away);
  const fav = Math.max(o.home, o.away);
  // Pistes : uniquement des paris qui ne sont PAS évidents (probabilité entre 40 et 70 %),
  // une sur le résultat, une sur les buts, une sur un buteur
  // Retirés des pistes après le bilan du week-end (trop d'échecs) : match nul, double chance,
  // moins de 2,5 / 1,5 buts, « une équipe ne marque pas ». Ils restent dans le tableau des probabilités.
  const RESULT = ['1', '2', 'H2+', 'A2+', '1O25', '2O25', '1BTTS', '2BTTS', '1CS', '2CS'];
  const GOALS = ['O25', 'O35', 'BTTS', 'H2G', 'A2G'];
  const playable = x => !x.easy && (x.p >= 0.4 || (x.edge != null && x.edge > 0.06 && x.p > 0.3));
  const best = keys => markets.filter(x => keys.includes(x.key) && playable(x)).sort((a, b) => (b.edge || 0) - (a.edge || 0) || b.p - a.p)[0];
  const tips = [best(RESULT), best(GOALS)].filter(Boolean);
  const sc = [...c.scorers.home, ...c.scorers.away].sort((a, b) => b.p1 - a.p1);
  const scorerTip = sc.find(p => p.p1 >= 0.35 && p.p1 < 0.7);
  if (scorerTip) tips.push({ key: 'SC', label: `${scorerTip.name} buteur`, p: scorerTip.p1, edge: null });
  const dbl = sc.find(p => p.p2 >= 0.12);
  if (dbl) tips.push({ key: 'SC2', label: `${dbl.name} doublé (pari osé)`, p: dbl.p2, edge: null });
  // Les paris évidents, cités seulement pour expliquer pourquoi on les écarte
  const easy = markets.filter(x => x.easy && x.p >= 0.6 && ['1', '2', 'O15', 'U25', 'O25', '1N', 'N2'].includes(x.key)).sort((a, b) => b.p - a.p).slice(0, 2);

  const values = markets.filter(x => x.edge != null && x.edge > 0.06 && x.p > 0.3);
  // Indice d'intérêt sur 100 : force de la meilleure piste NON évidente,
  // cotes intéressantes et fiabilité des infos (compositions officielles ou non)
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const mainTips = tips.filter(t => t.key !== 'SC' && t.key !== 'SC2');
  const bestP = Math.max(0, ...mainTips.map(t => t.p));
  const secondP = mainTips.length > 1 ? Math.min(...mainTips.slice(0, 2).map(t => t.p)) : 0;
  let score = clamp01((bestP - 0.45) / 0.2) * 55 + clamp01((secondP - 0.45) / 0.2) * 10;
  score += Math.min(values.length * 8 + Math.max(0, ...values.map(v => v.edge)) * 50, 20);
  score += (ph.official && pa.official) ? 15 : (ph.official || pa.official) ? 8 : 3;
  if (c.base.method === 'defaut') score -= 25;
  // Peu de matchs joués à domicile / à l'extérieur : chiffres fragiles
  const s = c.m.stats, few = s && s.home && s.away && Math.min(s.home.p, s.away.p) < 4;
  if (few) score -= 8;
  score = Math.round(Math.max(0, Math.min(100, score)));

  const obvious = fav >= 0.6;
  let code = 'skip', label = obvious ? 'Trop évident' : 'Trop imprévisible';
  if (score >= 60) { code = 'play'; label = 'Intéressant'; }
  else if (score >= 30) { code = 'watch'; label = 'À surveiller'; }
  // Sans statistiques, aucune piste n'a de sens
  if (c.base.method === 'defaut') {
    tips.length = 0;
    return { code: 'skip', label: 'Pas de statistiques', score: 0, tips, flags: [], values: [], obvious: false, easy: [] };
  }

  const flags = [];
  if (gap >= 0.35) flags.push({ t: 'Gros écart', k: 'gap' });
  if (gap < 0.12) flags.push({ t: 'Match serré', k: 'tight' });
  if (c.overs.o25 >= 0.6) flags.push({ t: 'Match à buts', k: 'goals' });
  if (c.overs.o25 <= 0.4) flags.push({ t: 'Match fermé', k: 'closed' });
  const bigOut = [...ph.missing, ...pa.missing].filter(p => p.share >= 0.15 && p.status !== 'incertain');
  if (bigOut.length) flags.push({ t: `${bigOut.length} gros absent${bigOut.length > 1 ? 's' : ''}`, k: 'absent' });
  if (values.length) flags.push({ t: 'Cote intéressante', k: 'value' });
  if (few) flags.push({ t: 'Peu de matchs', k: 'tight' });
  if ((c.m.tierFlags || []).length) flags.push({ t: 'Forme trompeuse', k: 'value' });

  if (obvious) flags.push({ t: 'Favori évident', k: 'gap' });
  return { code, label, score, tips: tips.slice(0, 4), flags, values, obvious, easy };
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
