// Classements : classement, forme, plus / moins de buts, les deux équipes marquent.
// Calculé sur le téléphone à partir des résultats de la saison enregistrés par le robot (data/tables.json),
// avec les mêmes filtres que Flashscore : global / domicile / extérieur, derniers matchs, ligne de buts.
// Sert à trois endroits : l'onglet « Classements », la fiche d'un match (les deux équipes seulement) et la recherche.
import { load, save } from './store.js';
import { similarity, ESPN_CODES } from './core.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VIEWS = [['table', 'Classement'], ['form', 'Forme'], ['att', 'Attaque'], ['def', 'Défense'], ['ou', 'Plus / moins'], ['btts', 'Les 2 marquent']];
const VENUES = [['all', 'Global'], ['home', 'Domicile'], ['away', 'Extérieur']];
// Sur combien de matchs on calcule (les plus récents d'abord)
const LASTS = [[5, '5 derniers matchs'], [10, '10 derniers'], [15, '15 derniers'], [0, 'Toute la saison']];
const LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const n1 = x => x.toFixed(1).replace('.', ',');
const pc = (a, b) => (b ? `${Math.round(100 * a / b)} %` : '–');
const lineTxt = l => String(l).replace('.', ',');

let data = null, loading = null, failed = false;
// Choix gardés sur le téléphone : un jeu pour l'onglet, un autre pour les fiches de match
const opt = Object.assign({ league: 'fra.1', view: 'table', venue: 'all', last: 5, line: 2.5 }, load('tables-opt', {}));
const dopt = Object.assign({ view: 'form', venue: 'side', last: 5, line: 2.5 }, load('duel-opt', {}));

// Chargement des résultats (une fois), puis rappel pour redessiner la page
export function loadTables(onReady) {
  if (data || failed) return Promise.resolve(data);
  if (!loading) {
    loading = fetch(`data/tables.json?t=${Date.now()}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null)).then(d => { data = d && d.leagues ? d : null; failed = !data; })
      .catch(() => { failed = true; });
  }
  return loading.then(() => { if (onReady) onReady(); return data; });
}

// Statistiques d'une équipe sur ses matchs filtrés (lieu, derniers matchs)
function teamStats(L, id, o) {
  let list = L.matches.filter(m => m[1] === id || m[2] === id)
    .filter(m => o.venue === 'all' || (o.venue === 'home' ? m[1] === id : m[2] === id))
    .sort((x, y) => y[0] - x[0]);  // le plus récent d'abord
  if (o.view !== 'table' && o.last) list = list.slice(0, o.last);
  const s = { id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, over: 0, btts: 0, cs: 0, fts: 0, marks: [] };
  for (const m of list) {
    const home = m[1] === id, f = home ? m[3] : m[4], a = home ? m[4] : m[3];
    s.p++; s.gf += f; s.ga += a;
    if (a === 0) s.cs++;   // match sans encaisser
    if (f === 0) s.fts++;  // match sans marquer
    const r = f > a ? 'V' : f === a ? 'N' : 'D';
    s[{ V: 'w', N: 'd', D: 'l' }[r]]++;
    const over = m[3] + m[4] > o.line, btts = m[3] > 0 && m[4] > 0;
    if (over) s.over++;
    if (btts) s.btts++;
    const opp = L.teams[home ? m[2] : m[1]];
    const tip = `${home ? 'Dom.' : 'Ext.'} ${new Date(m[0] * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} · ${opp ? opp[0] : ''} ${m[3]}-${m[4]}`;
    s.marks.push({ r, over, btts, f, a, tip });
  }
  s.pts = s.w * 3 + s.d;
  s.diff = s.gf - s.ga;
  return s;
}
const SORT = {
  table: (a, b) => b.pts - a.pts || b.diff - a.diff || b.gf - a.gf,
  form: (a, b) => b.pts - a.pts || b.diff - a.diff || b.gf - a.gf,
  // Attaque : le plus de buts marqués par match en tête ; défense : le moins de buts encaissés par match en tête
  att: (a, b) => b.gf / (b.p || 1) - a.gf / (a.p || 1) || b.gf - a.gf,
  def: (a, b) => a.ga / (a.p || 1) - b.ga / (b.p || 1) || b.cs - a.cs,
  ou: (a, b) => b.over / (b.p || 1) - a.over / (a.p || 1) || (b.gf + b.ga) / (b.p || 1) - (a.gf + a.ga) / (a.p || 1),
  btts: (a, b) => b.btts / (b.p || 1) - a.btts / (a.p || 1) || b.p - a.p,
};
// Rang d'une équipe dans le classement de la stat regardée (ex. plus de 1,5 buts à domicile, 5 derniers matchs)
function rankIn(L, id, o) {
  const rows = Object.keys(L.teams).map(t => teamStats(L, t, o)).filter(s => s.p).sort(SORT[o.view]);
  return { rank: rows.findIndex(s => s.id === id) + 1, size: rows.length };
}
// Rang de chaque équipe dans le classement général (toute la saison, tous lieux)
function ranks(L) {
  const rows = Object.keys(L.teams).map(id => teamStats(L, id, { view: 'table', venue: 'all', last: 0, line: 2.5 })).filter(s => s.p).sort(SORT.table);
  return new Map(rows.map((s, i) => [s.id, i + 1]));
}

// Pastilles des 5 derniers matchs (le plus récent à gauche, comme Flashscore)
function marksHtml(s, view) {
  return s.marks.slice(0, 5).map(k => {
    // Attaque : buts marqués dans chaque match ; défense : buts encaissés (vert = bon, rouge = mauvais)
    if (view === 'att') return `<i class="mk ${k.f >= 2 ? 'V' : k.f === 1 ? 'N' : 'D'}" title="${esc(k.tip)}">${k.f}</i>`;
    if (view === 'def') return `<i class="mk ${k.a === 0 ? 'V' : k.a === 1 ? 'N' : 'D'}" title="${esc(k.tip)}">${k.a}</i>`;
    if (view === 'ou') return `<i class="mk ${k.over ? 'V' : 'D'}" title="${esc(k.tip)}">${k.over ? '+' : '−'}</i>`;
    if (view === 'btts') return `<i class="mk ${k.btts ? 'V' : 'D'}" title="${esc(k.tip)}">${k.btts ? 'O' : 'N'}</i>`;
    return `<i class="mk ${k.r}" title="${esc(k.tip)}">${k.r}</i>`;
  }).join('');
}
const HEAD = o => ({
  table: '<th>MJ</th><th>V</th><th>N</th><th>D</th><th>B</th><th>Diff</th><th>Pts</th>',
  form: '<th>MJ</th><th>V</th><th>N</th><th>D</th><th>B</th><th>Pts</th>',
  att: '<th>MJ</th><th>Buts</th><th>/match</th><th>0 but</th>',
  def: '<th>MJ</th><th>Encaissés</th><th>/match</th><th>0 encaissé</th>',
  ou: `<th>MJ</th><th>+${lineTxt(o.line)}</th><th>−</th><th>%</th><th>B/M</th>`,
  btts: '<th>MJ</th><th>Oui</th><th>Non</th><th>%</th>',
}[o.view]);
const CELLS = (s, o) => ({
  table: `<td>${s.p}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gf}:${s.ga}</td><td>${s.diff > 0 ? '+' : ''}${s.diff}</td><td><b>${s.pts}</b></td>`,
  form: `<td>${s.p}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gf}:${s.ga}</td><td><b>${s.pts}</b></td>`,
  att: `<td>${s.p}</td><td>${s.gf}</td><td><b>${s.p ? n1(s.gf / s.p) : '–'}</b></td><td>${s.fts}</td>`,
  def: `<td>${s.p}</td><td>${s.ga}</td><td><b>${s.p ? n1(s.ga / s.p) : '–'}</b></td><td>${s.cs}</td>`,
  ou: `<td>${s.p}</td><td><b>${s.over}</b></td><td>${s.p - s.over}</td><td>${pc(s.over, s.p)}</td><td>${s.p ? n1((s.gf + s.ga) / s.p) : '–'}</td>`,
  btts: `<td>${s.p}</td><td><b>${s.btts}</b></td><td>${s.p - s.btts}</td><td>${pc(s.btts, s.p)}</td>`,
}[o.view]);
// Logo en petit format (40 px) : beaucoup plus léger sur un forfait mobile que l'original en 500 px
const small = u => { const p = /^https:\/\/a\.espncdn\.com(\/i\/teamlogos\/[^?]+\.png)$/.exec(u || ''); return p ? `https://a.espncdn.com/combiner/i?img=${p[1]}&w=40&h=40` : (u || ''); };
const teamCell = (t, extra = '') => `<td class="tb-team">${t[1] ? `<img src="${esc(small(t[1]))}" alt="" loading="lazy">` : ''}<span>${esc(t[0])}</span>${extra}</td>`;
const seg = (o, key, items, attr) => `<div class="tb-seg">${items.map(([v, label]) => `<button class="${String(o[key]) === String(v) ? 'on' : ''}" ${attr}="${key}" data-v="${v}">${label}</button>`).join('')}</div>`;

// Retrouve une équipe dans un championnat : identifiant ESPN si on l'a, sinon le nom le plus ressemblant
function findTeam(L, name, espnId) {
  if (espnId && L.teams[espnId]) return String(espnId);
  let best = null, bs = 0;
  for (const [id, t] of Object.entries(L.teams)) { const s = similarity(name, t[0]); if (s > bs) { bs = s; best = id; } }
  return bs >= 0.5 ? best : null;
}
// Championnat d'une équipe pour un match : celui du match, ou en coupe celui de l'équipe (niveau calculé par le robot)
function leagueOf(m, side) {
  const own = m.level && m.level[side] && m.level[side].slug;
  const code = (m.comp && m.comp.type === 'league' && ESPN_CODES[m.comp.af]) || own;
  return code && data && data.leagues[code] ? code : null;
}

// ---------- 1. L'onglet « Classements » ----------
export async function renderTables(el, todayTeams = []) {
  if (!data && !failed) { el.innerHTML = '<p class="muted">Chargement des classements…</p>'; await loadTables(); }
  if (!data) { el.innerHTML = '<p class="muted">Classements pas encore disponibles : le robot les prépare à son prochain passage (toutes les 6 heures).</p>'; return; }
  const codes = Object.keys(data.leagues);
  if (!data.leagues[opt.league]) opt.league = codes[0];
  const L = data.leagues[opt.league];
  const plays = name => todayTeams.some(t => similarity(t, name) >= 0.6);
  const rows = Object.keys(L.teams).map(id => teamStats(L, id, opt)).filter(s => s.p).sort(SORT[opt.view]);
  const all = L.matches.length, overAll = L.matches.filter(m => m[3] + m[4] > opt.line).length, bttsAll = L.matches.filter(m => m[3] > 0 && m[4] > 0).length;
  const goalsAll = L.matches.reduce((s, m) => s + m[3] + m[4], 0);
  const venueTxt = opt.venue === 'home' ? ' à domicile' : opt.venue === 'away' ? ' à l\'extérieur' : '';
  const note = {
    table: `Toute la saison${venueTxt}.`,
    form: `${opt.last ? `${opt.last} derniers matchs` : 'Toute la saison'}${venueTxt}, classés aux points.`,
    att: `${opt.last ? `${opt.last} derniers matchs` : 'Toute la saison'}${venueTxt} : buts marqués par match (la meilleure attaque en tête). Moyenne du championnat : ${n1(goalsAll / (all || 1) / 2)} but par équipe et par match.`,
    def: `${opt.last ? `${opt.last} derniers matchs` : 'Toute la saison'}${venueTxt} : buts encaissés par match (la meilleure défense en tête). « 0 encaissé » = matchs sans prendre de but.`,
    ou: `Matchs à plus de ${lineTxt(opt.line)} buts. Moyenne du championnat : ${pc(overAll, all)} des matchs, ${n1(goalsAll / (all || 1))} buts par match.`,
    btts: `Les deux équipes ont marqué. Moyenne du championnat : ${pc(bttsAll, all)} des matchs.`,
  }[opt.view];
  el.innerHTML = `<div class="tables">
    <select class="tb-league" data-tb="league">${codes.map(c => `<option value="${c}"${c === opt.league ? ' selected' : ''}>${esc(data.leagues[c].name)}</option>`).join('')}</select>
    ${seg(opt, 'view', VIEWS, 'data-tb')}${seg(opt, 'venue', VENUES, 'data-tb')}
    ${opt.view !== 'table' ? seg(opt, 'last', LASTS, 'data-tb') : ''}
    ${opt.view === 'ou' ? seg(opt, 'line', LINES.map(l => [l, lineTxt(l)]), 'data-tb') : ''}
    <p class="small muted">${esc(note)}</p>
    <div class="tb-wrap"><table class="tb">
      <thead><tr><th>#</th><th class="tb-team">Équipe</th>${HEAD(opt)}<th class="tb-marks">${opt.view === 'table' || opt.view === 'form' ? 'Forme' : opt.view === 'att' ? 'Buts marqués' : opt.view === 'def' ? 'Buts encaissés' : '5 derniers'}</th></tr></thead>
      <tbody>${rows.map((s, i) => `<tr><td class="tb-rank">${i + 1}</td>${teamCell(L.teams[s.id], plays(L.teams[s.id][0]) ? '<i class="tb-today" title="Joue aujourd\'hui">●</i>' : '')}${CELLS(s, opt)}<td class="tb-marks">${marksHtml(s, opt.view)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="tb-detail" hidden></p>
    <p class="small muted">Pastilles : le match le plus récent à gauche (touchez-en une pour voir le score). ● = joue aujourd'hui. Mis à jour ${new Date(data.at).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
  </div>`;
  el.querySelectorAll('[data-tb]').forEach(b => {
    b.addEventListener(b.tagName === 'SELECT' ? 'change' : 'click', () => {
      const k = b.dataset.tb, v = b.tagName === 'SELECT' ? b.value : b.dataset.v;
      opt[k] = ['last', 'line'].includes(k) ? Number(v) : v;
      save('tables-opt', opt);
      renderTables(el, todayTeams);
    });
  });
  bindMarks(el);
}
function bindMarks(el) {
  el.querySelectorAll('.mk').forEach(i => i.addEventListener('click', e => {
    e.stopPropagation();
    const box = i.closest('.tables, .vs-table').querySelector('.tb-detail');
    const team = i.closest('tr').querySelector('.tb-team span').textContent;
    box.textContent = `${team} : ${i.title}`;
    box.hidden = false;
  }));
}

// ---------- 2. La fiche d'un match : seulement les deux équipes ----------
// « venue: side » = chaque équipe dans son contexte (domicile pour l'une, extérieur pour l'autre)
export function duelHtml(m) {
  if (!data) return failed ? '' : '<p class="small muted">Chargement des classements…</p>';
  const rows = ['home', 'away'].map(side => {
    const code = leagueOf(m, side);
    if (!code) return null;
    const L = data.leagues[code];
    const id = findTeam(L, m[side].name, m.espn && m.espn[side]);
    if (!id) return null;
    const venue = dopt.venue === 'side' ? side : dopt.venue;
    const o = { ...dopt, venue };
    // Rang dans LE classement regardé (même stat, même lieu, mêmes derniers matchs), pas le classement général
    const { rank, size } = rankIn(L, id, o);
    return { side, L, code, id, s: teamStats(L, id, o), rank, size };
  });
  if (!rows[0] && !rows[1]) return '<p class="small muted">Pas de classement disponible pour ces équipes.</p>';
  const cup = rows[0] && rows[1] && rows[0].code !== rows[1].code;
  const VEN = [['side', 'Dom. / Ext.'], ['all', 'Global'], ['home', 'Domicile'], ['away', 'Extérieur']];
  const venueTxt = { side: `${m.home.name} à domicile, ${m.away.name} à l'extérieur`, all: 'tous les matchs', home: 'à domicile', away: 'à l\'extérieur' }[dopt.venue];
  return `<div class="vs-table">
    ${seg(dopt, 'view', VIEWS, 'data-duel')}${seg(dopt, 'venue', VEN, 'data-duel')}
    ${dopt.view !== 'table' ? seg(dopt, 'last', LASTS, 'data-duel') : ''}
    ${dopt.view === 'ou' ? seg(dopt, 'line', LINES.map(l => [l, lineTxt(l)]), 'data-duel') : ''}
    <p class="small muted">${esc(dopt.view === 'table' ? 'Toute la saison' : dopt.last ? `${dopt.last} derniers matchs` : 'Toute la saison')}, ${esc(venueTxt)}${cup ? ' · chaque équipe dans son championnat' : ''}. # = rang dans ce classement (${esc({ table: 'classement', form: 'forme', att: 'attaque', def: 'défense', ou: `plus de ${lineTxt(dopt.line)} buts`, btts: 'les deux équipes marquent' }[dopt.view])}${dopt.venue === 'side' ? ', à domicile pour l\'une, à l\'extérieur pour l\'autre' : ''}).</p>
    <div class="tb-wrap"><table class="tb">
      <thead><tr><th>#</th><th class="tb-team">Équipe</th>${HEAD(dopt)}<th class="tb-marks">${dopt.view === 'table' || dopt.view === 'form' ? 'Forme' : dopt.view === 'att' ? 'Buts marqués' : dopt.view === 'def' ? 'Buts encaissés' : '5 derniers'}</th></tr></thead>
      <tbody>${rows.filter(Boolean).map(r => `<tr><td class="tb-rank">${r.rank || '–'}<small>/${r.size}</small></td>${teamCell(r.L.teams[r.id], cup ? `<small class="muted"> ${esc(r.L.name)}</small>` : '')}${CELLS(r.s, dopt)}<td class="tb-marks">${marksHtml(r.s, dopt.view)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="tb-detail" hidden></p>
  </div>`;
}
// Clic sur un filtre de la fiche : renvoie true si c'était pour nous (la page se redessine alors)
export function duelClick(e) {
  const b = e.target.closest('[data-duel]');
  if (!b) return false;
  const k = b.dataset.duel;
  dopt[k] = ['last', 'line'].includes(k) ? Number(b.dataset.v) : b.dataset.v;
  save('duel-opt', dopt);
  return true;
}
export function bindDuelMarks(root) { root.querySelectorAll('.vs-table').forEach(bindMarks); }

// ---------- 2 bis. Face-à-face : l'équipe qui reçoit À DOMICILE contre l'équipe qui se déplace À L'EXTÉRIEUR ----------
// Toute la saison, chaque équipe dans son contexte. Voyants : 🟢 favorable, 🔴 défavorable, ⚪ rien de net.
// Attaque / défense jugées par rapport à la moyenne du championnat (1,0 = dans la moyenne).
function venueAvg(L) {
  const n = L.matches.length || 1;
  return { home: L.matches.reduce((s, m) => s + m[3], 0) / n, away: L.matches.reduce((s, m) => s + m[4], 0) / n };
}
function faceData(m) {
  if (!data) return null;
  const side = sd => {
    const code = leagueOf(m, sd);
    if (!code) return null;
    const L = data.leagues[code], id = findTeam(L, m[sd].name, m.espn && m.espn[sd]);
    if (!id) return null;
    const venue = sd;
    const o = { view: 'form', venue, last: 0, line: 2.5 };
    const st = teamStats(L, id, o);
    if (st.p < 3) return null;
    const avg = venueAvg(L);
    // Buts marqués à ce lieu comparés à la moyenne du championnat à ce lieu ; encaissés comparés aux buts de l'adversaire type
    const att = (st.gf / st.p) / (sd === 'home' ? avg.home : avg.away);
    const def = (st.ga / st.p) / (sd === 'home' ? avg.away : avg.home);
    const lines = {};
    for (const l of [1.5, 2.5, 3.5]) lines[l] = teamStats(L, id, { ...o, line: l }).over / st.p;
    return { L, id, name: m[sd].name, st, att, def, btts: st.btts / st.p, lines,
      attRank: rankIn(L, id, { view: 'att', venue, last: 0, line: 2.5 }), defRank: rankIn(L, id, { view: 'def', venue, last: 0, line: 2.5 }) };
  };
  const H = side('home'), A = side('away');
  return H && A ? { H, A } : null;
}
// Voyant d'un duel attaque / défense : attaque forte contre défense qui prend beaucoup = 🟢 ; l'inverse = 🔴
const duelLight = (att, def) => (att >= 1.2 && def >= 1.15 ? 'g' : att <= 0.8 && def <= 0.85 ? 'r' : att >= 1.2 || def >= 1.25 ? 'y' : att <= 0.75 || def <= 0.75 ? 'o' : 'n');
const LIGHT = { g: '🟢', y: '🟡', n: '⚪', o: '🟠', r: '🔴' };
// Seuils des lignes de buts (moyenne des deux équipes, chacune dans son contexte)
const LINE_TH = { 1.5: [0.82, 0.6], 2.5: [0.65, 0.4], 3.5: [0.45, 0.2], btts: [0.65, 0.4] };
const lineLight = (k, v) => (v >= LINE_TH[k][0] ? 'g' : v <= LINE_TH[k][1] ? 'r' : 'n');
const ord = r => `${r}${r === 1 ? 'er' : 'e'}`;

// Les alertes les plus nettes, en une phrase chacune (affichées aussi sur la fiche courte)
export function faceAlerts(m) {
  const f = faceData(m);
  if (!f) return [];
  const { H, A } = f, out = [];
  const duel = (X, Y, xPlace, yPlace) => {
    const l = duelLight(X.att, Y.def);
    if (l === 'g') out.push([3, `🟢 Attaque de ${X.name} ${xPlace} (${ord(X.attRank.rank)}) contre défense de ${Y.name} ${yPlace} (${ord(Y.defRank.rank)} sur ${Y.defRank.size}) : ${X.name} devrait marquer`]);
    if (l === 'r') out.push([3, `🔴 ${X.name} marque peu ${xPlace} (${ord(X.attRank.rank)}) et ${Y.name} défend bien ${yPlace} (${ord(Y.defRank.rank)}) : peu de buts de ${X.name}`]);
  };
  duel(H, A, 'à domicile', 'à l\'extérieur');
  duel(A, H, 'à l\'extérieur', 'à domicile');
  const p = v => Math.round(v * 100);
  for (const [k, label] of [[2.5, '+2,5 buts'], ['btts', 'Les deux marquent'], [1.5, '+1,5 buts'], [3.5, '+3,5 buts']]) {
    const hv = k === 'btts' ? H.btts : H.lines[k], av = k === 'btts' ? A.btts : A.lines[k], l = lineLight(k, (hv + av) / 2);
    if (l === 'g' && hv >= LINE_TH[k][0] - 0.1 && av >= LINE_TH[k][0] - 0.1) out.push([2, `🟢 ${label} : ${p(hv)} % des matchs de ${H.name} à domicile, ${p(av)} % de ${A.name} à l'extérieur`]);
    if (l === 'r' && hv <= LINE_TH[k][1] + 0.1 && av <= LINE_TH[k][1] + 0.1) out.push([2, `🔴 ${label} : seulement ${p(hv)} % des matchs de ${H.name} à domicile, ${p(av)} % de ${A.name} à l'extérieur`]);
  }
  return out.sort((x, y) => y[0] - x[0]).map(x => x[1]).slice(0, 3);
}

// Signaux VERTS seulement, sous forme exploitable pour proposer le pari qui va avec :
// { kind: 'att', side: 'home' | 'away', why } = une équipe devrait marquer ; { kind: 'line', key: 'O15' | 'O25' | 'O35' | 'BTTS', why }
export function faceSignals(m) {
  const f = faceData(m);
  if (!f) return [];
  const { H, A } = f, out = [], p = v => Math.round(v * 100);
  if (duelLight(H.att, A.def) === 'g') out.push({ kind: 'att', side: 'home', why: `${H.name} marque beaucoup à domicile (${ord(H.attRank.rank)}), ${A.name} encaisse beaucoup à l'extérieur (${ord(A.defRank.rank)})` });
  if (duelLight(A.att, H.def) === 'g') out.push({ kind: 'att', side: 'away', why: `${A.name} marque beaucoup à l'extérieur (${ord(A.attRank.rank)}), ${H.name} encaisse beaucoup à domicile (${ord(H.defRank.rank)})` });
  for (const [k, key] of [[2.5, 'O25'], ['btts', 'BTTS'], [3.5, 'O35'], [1.5, 'O15']]) {
    const hv = k === 'btts' ? H.btts : H.lines[k], av = k === 'btts' ? A.btts : A.lines[k];
    if (lineLight(k, (hv + av) / 2) === 'g' && hv >= LINE_TH[k][0] - 0.1 && av >= LINE_TH[k][0] - 0.1)
      out.push({ kind: 'line', key, why: `${p(hv)} % des matchs de ${H.name} à domicile, ${p(av)} % de ${A.name} à l'extérieur` });
  }
  return out;
}

// Le tableau face-à-face complet (fiche du match)
export function faceHtml(m) {
  const f = faceData(m);
  if (!f) return data ? '' : '<p class="small muted">Chargement des classements…</p>';
  const { H, A } = f;
  const n1 = x => x.toFixed(1).replace('.', ','), p = v => `${Math.round(v * 100)} %`;
  const att = X => `<b>${n1(X.st.gf / X.st.p)}</b> marqués/m · ${ord(X.attRank.rank)}`;
  const def = X => `<b>${n1(X.st.ga / X.st.p)}</b> encaissés/m · ${ord(X.defRank.rank)}`;
  // Une ligne par comparaison : voyant + titre, puis les deux équipes côte à côte (lisible sur téléphone)
  const row = (light, label, left, right) => `<div class="fc-row"><div class="fc-head">${LIGHT[light]} ${label}</div>
    <div class="fc-vals"><span><small>${esc(H.name)} · dom.</small>${left}</span><span><small>${esc(A.name)} · ext.</small>${right}</span></div></div>`;
  const lines = [[1.5, '+1,5 buts'], [2.5, '+2,5 buts'], [3.5, '+3,5 buts'], ['btts', 'Les 2 marquent']].map(([k, label]) => {
    const hv = k === 'btts' ? H.btts : H.lines[k], av = k === 'btts' ? A.btts : A.lines[k];
    return row(lineLight(k, (hv + av) / 2), label, p(hv), p(av));
  }).join('');
  const alerts = faceAlerts(m);
  return `<div class="face">
    ${alerts.length ? `<div class="face-alerts">${alerts.map(t => `<p>${esc(t)}</p>`).join('')}</div>` : '<p class="small muted">Rien de très marqué entre ces deux équipes.</p>'}
    <div class="fc-list">
      ${row(duelLight(H.att, A.def), `Attaque de ${esc(H.name)} contre défense de ${esc(A.name)}`, att(H), def(A))}
      ${row(duelLight(A.att, H.def), `Attaque de ${esc(A.name)} contre défense de ${esc(H.name)}`, def(H), att(A))}
      ${lines}
    </div>
    <p class="small muted">Toute la saison : ${esc(H.name)} dans ses ${H.st.p} matchs à domicile, ${esc(A.name)} dans ses ${A.st.p} matchs à l'extérieur${Math.min(H.st.p, A.st.p) < 5 ? ' (peu de matchs : à prendre avec prudence)' : ''}. Rangs : classement à domicile ou à l'extérieur du championnat. 🟢 favorable · 🟡 un des deux signes · ⚪ rien de net · 🔴 défavorable.</p>
  </div>`;
}

// ---------- 3. La recherche : fiche d'une équipe ----------
// Toutes les équipes connues dont le nom ressemble à la recherche → [{ code, id, name }]
export function searchTeams(q) {
  if (!data || q.length < 3) return [];
  const out = [];
  const nq = q.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [code, L] of Object.entries(data.leagues)) {
    for (const [id, t] of Object.entries(L.teams)) {
      const nt = t[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (nt.includes(nq) || similarity(q, t[0]) >= 0.7) out.push({ code, id, name: t[0] });
    }
  }
  return out.slice(0, 4);
}
// Fiche d'une équipe : rang, forme, domicile / extérieur, buts, plus de 2,5, les deux marquent
export function teamCardHtml(code, id) {
  const L = data.leagues[code], t = L.teams[id];
  const rank = ranks(L).get(id), size = Object.keys(L.teams).length;
  const S = (venue, last) => teamStats(L, id, { view: 'form', venue, last, line: 2.5 });
  const all = S('all', 0), home = S('home', 0), away = S('away', 0), f5 = S('all', 5);
  const line = (label, s) => s.p ? `<tr><td class="tb-team"><span>${label}</span></td><td>${s.p}</td><td>${s.w}-${s.d}-${s.l}</td><td>${s.gf}:${s.ga}</td><td>${pc(s.over, s.p)}</td><td>${pc(s.btts, s.p)}</td></tr>` : '';
  return `<div class="team-card">
    <div class="team-card-head">${t[1] ? `<img src="${esc(small(t[1]))}" alt="">` : ''}<b>${esc(t[0])}</b><span class="small muted">${esc(L.name)} · ${rank}${rank === 1 ? 'er' : 'e'} sur ${size} · ${all.pts} pts</span></div>
    <p class="small">5 derniers matchs : ${marksHtml(f5, 'form')} <span class="muted">(le plus récent à gauche)</span></p>
    <div class="tb-wrap"><table class="tb">
      <thead><tr><th class="tb-team">Saison</th><th>MJ</th><th>V-N-D</th><th>B</th><th>+2,5</th><th>2 marq.</th></tr></thead>
      <tbody>${line('Global', all)}${line('Domicile', home)}${line('Extérieur', away)}</tbody>
    </table></div>
  </div>`;
}
