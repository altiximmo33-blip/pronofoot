// Onglet « Classements » : classement, forme, plus / moins de buts, les deux équipes marquent.
// Calculé sur le téléphone à partir des résultats de la saison enregistrés par le robot (data/tables.json),
// avec les mêmes filtres que Flashscore : global / domicile / extérieur, derniers matchs, ligne de buts.
import { load, save } from './store.js';
import { similarity } from './core.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const VIEWS = [['table', 'Classement'], ['form', 'Forme'], ['ou', 'Plus / moins'], ['btts', 'Les 2 marquent']];
const VENUES = [['all', 'Global'], ['home', 'Domicile'], ['away', 'Extérieur']];
const LASTS = [[5, '5'], [10, '10'], [15, '15'], [0, 'Tout']];
const LINES = [0.5, 1.5, 2.5, 3.5, 4.5];

let data = null, loading = null, failed = false;
const opt = Object.assign({ league: 'fra.1', view: 'table', venue: 'all', last: 5, line: 2.5 }, load('tables-opt', {}));
const keep = () => save('tables-opt', opt);

async function fetchData() {
  if (data || loading) return loading;
  loading = fetch(`data/tables.json?t=${Date.now()}`, { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null)).then(d => { data = d; failed = !d; }).catch(() => { failed = true; });
  return loading;
}

// Statistiques d'une équipe sur ses matchs filtrés (lieu, derniers matchs)
function teamStats(L, id) {
  let list = L.matches.filter(m => m[1] === id || m[2] === id)
    .filter(m => opt.venue === 'all' || (opt.venue === 'home' ? m[1] === id : m[2] === id))
    .sort((x, y) => y[0] - x[0]);  // le plus récent d'abord
  // « Classement » : toute la saison ; les autres vues : les N derniers matchs (ou tous)
  if (opt.view !== 'table' && opt.last) list = list.slice(0, opt.last);
  const s = { id, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, over: 0, btts: 0, marks: [] };
  for (const m of list) {
    const home = m[1] === id, f = home ? m[3] : m[4], a = home ? m[4] : m[3];
    s.p++; s.gf += f; s.ga += a;
    const r = f > a ? 'V' : f === a ? 'N' : 'D';
    s[{ V: 'w', N: 'd', D: 'l' }[r]]++;
    const over = m[3] + m[4] > opt.line, btts = m[3] > 0 && m[4] > 0;
    if (over) s.over++;
    if (btts) s.btts++;
    const opp = L.teams[home ? m[2] : m[1]];
    const tip = `${home ? 'Dom.' : 'Ext.'} ${new Date(m[0] * 1000).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} · ${opp ? opp[0] : ''} ${m[3]}-${m[4]}`;
    s.marks.push({ r, over, btts, tip });
  }
  s.pts = s.w * 3 + s.d;
  s.diff = s.gf - s.ga;
  return s;
}

function sortRows(rows) {
  const by = {
    table: (a, b) => b.pts - a.pts || b.diff - a.diff || b.gf - a.gf,
    form: (a, b) => b.pts - a.pts || b.diff - a.diff || b.gf - a.gf,
    ou: (a, b) => b.over / (b.p || 1) - a.over / (a.p || 1) || (b.gf + b.ga) / (b.p || 1) - (a.gf + a.ga) / (a.p || 1),
    btts: (a, b) => b.btts / (b.p || 1) - a.btts / (a.p || 1) || b.p - a.p,
  }[opt.view];
  return rows.sort(by);
}

// Pastilles des 5 derniers matchs (le plus récent à gauche, comme Flashscore)
function marksHtml(s) {
  return s.marks.slice(0, 5).map(k => {
    if (opt.view === 'ou') return `<i class="mk ${k.over ? 'V' : 'D'}" title="${esc(k.tip)}">${k.over ? '+' : '−'}</i>`;
    if (opt.view === 'btts') return `<i class="mk ${k.btts ? 'V' : 'D'}" title="${esc(k.tip)}">${k.btts ? 'O' : 'N'}</i>`;
    return `<i class="mk ${k.r}" title="${esc(k.tip)}">${k.r}</i>`;
  }).join('');
}

const seg = (key, items) => `<div class="tb-seg">${items.map(([v, label]) => `<button class="${String(opt[key]) === String(v) ? 'on' : ''}" data-tb="${key}" data-v="${v}">${label}</button>`).join('')}</div>`;

export async function renderTables(el, todayTeams = []) {
  if (!data && !failed) { el.innerHTML = '<p class="muted">Chargement des classements…</p>'; await fetchData(); }
  if (!data || !data.leagues || !Object.keys(data.leagues).length) {
    el.innerHTML = '<p class="muted">Classements pas encore disponibles : le robot les prépare à son prochain passage (toutes les 6 heures).</p>';
    return;
  }
  const codes = Object.keys(data.leagues);
  if (!data.leagues[opt.league]) opt.league = codes[0];
  const L = data.leagues[opt.league];
  // Équipes qui jouent aujourd'hui (repérées par leur nom) : signalées par un point vert
  const plays = name => todayTeams.some(t => similarity(t, name) >= 0.6);
  const rows = sortRows(Object.keys(L.teams).map(id => teamStats(L, id)).filter(s => s.p));
  const n1 = x => x.toFixed(1).replace('.', ',');
  const pc = (a, b) => b ? `${Math.round(100 * a / b)} %` : '–';

  const head = {
    table: '<th>MJ</th><th>V</th><th>N</th><th>D</th><th>B</th><th>Diff</th><th>Pts</th>',
    form: '<th>MJ</th><th>V</th><th>N</th><th>D</th><th>B</th><th>Pts</th>',
    ou: `<th>MJ</th><th>+${String(opt.line).replace('.', ',')}</th><th>−</th><th>%</th><th>B/M</th>`,
    btts: '<th>MJ</th><th>Oui</th><th>Non</th><th>%</th>',
  }[opt.view];
  const cells = s => ({
    table: `<td>${s.p}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gf}:${s.ga}</td><td>${s.diff > 0 ? '+' : ''}${s.diff}</td><td><b>${s.pts}</b></td>`,
    form: `<td>${s.p}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gf}:${s.ga}</td><td><b>${s.pts}</b></td>`,
    ou: `<td>${s.p}</td><td><b>${s.over}</b></td><td>${s.p - s.over}</td><td>${pc(s.over, s.p)}</td><td>${n1((s.gf + s.ga) / s.p)}</td>`,
    btts: `<td>${s.p}</td><td><b>${s.btts}</b></td><td>${s.p - s.btts}</td><td>${pc(s.btts, s.p)}</td>`,
  }[opt.view]);
  // Logo en petit format (40 px) : beaucoup plus léger sur un forfait mobile que l'original en 500 px
  const small = u => { const p = /^https:\/\/a\.espncdn\.com(\/i\/teamlogos\/[^?]+\.png)$/.exec(u); return p ? `https://a.espncdn.com/combiner/i?img=${p[1]}&w=40&h=40` : u; };
  const teamCell = s => { const t = L.teams[s.id]; return `<td class="tb-team">${t[1] ? `<img src="${esc(small(t[1]))}" alt="" loading="lazy">` : ''}<span>${esc(t[0])}</span>${plays(t[0]) ? '<i class="tb-today" title="Joue aujourd\'hui">●</i>' : ''}</td>`; };

  // Moyenne du championnat pour situer les chiffres
  const all = L.matches.length, overAll = L.matches.filter(m => m[3] + m[4] > opt.line).length, bttsAll = L.matches.filter(m => m[3] > 0 && m[4] > 0).length;
  const goalsAll = L.matches.reduce((s, m) => s + m[3] + m[4], 0);
  const note = {
    table: `Toute la saison${opt.venue !== 'all' ? (opt.venue === 'home' ? ', matchs à domicile' : ', matchs à l\'extérieur') : ''}.`,
    form: `${opt.last ? `${opt.last} derniers matchs` : 'Toute la saison'}${opt.venue !== 'all' ? (opt.venue === 'home' ? ' à domicile' : ' à l\'extérieur') : ''}, classés aux points.`,
    ou: `Matchs à plus de ${String(opt.line).replace('.', ',')} buts. Moyenne du championnat : ${pc(overAll, all)} des matchs, ${n1(goalsAll / (all || 1))} buts par match.`,
    btts: `Les deux équipes ont marqué. Moyenne du championnat : ${pc(bttsAll, all)} des matchs.`,
  }[opt.view];

  el.innerHTML = `<div class="tables">
    <select class="tb-league" data-tb="league">${codes.map(c => `<option value="${c}"${c === opt.league ? ' selected' : ''}>${esc(data.leagues[c].name)}</option>`).join('')}</select>
    ${seg('view', VIEWS)}
    ${seg('venue', VENUES)}
    ${opt.view === 'form' || opt.view === 'ou' || opt.view === 'btts' ? seg('last', LASTS) : ''}
    ${opt.view === 'ou' ? seg('line', LINES.map(l => [l, String(l).replace('.', ',')])) : ''}
    <p class="small muted">${esc(note)}</p>
    <div class="tb-wrap"><table class="tb">
      <thead><tr><th>#</th><th class="tb-team">Équipe</th>${head}<th class="tb-marks">${opt.view === 'table' || opt.view === 'form' ? 'Forme' : '5 derniers'}</th></tr></thead>
      <tbody>${rows.map((s, i) => `<tr><td class="tb-rank">${i + 1}</td>${teamCell(s)}${cells(s)}<td class="tb-marks">${marksHtml(s)}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="tb-detail" hidden></p>
    <p class="small muted">Pastilles : le match le plus récent à gauche (touchez-en une pour voir le score). ● = joue aujourd'hui. Mis à jour ${new Date(data.at).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.</p>
  </div>`;

  // Choix (championnat, vue, lieu, derniers matchs, ligne) : gardés sur le téléphone
  el.querySelectorAll('[data-tb]').forEach(b => {
    const ev = b.tagName === 'SELECT' ? 'change' : 'click';
    b.addEventListener(ev, () => {
      const k = b.dataset.tb, v = b.tagName === 'SELECT' ? b.value : b.dataset.v;
      opt[k] = ['last', 'line'].includes(k) ? Number(v) : v;
      keep();
      renderTables(el, todayTeams);
    });
  });
  // Pastille touchée : le détail du match (sur téléphone, pas de survol)
  const detail = el.querySelector('.tb-detail');
  el.querySelectorAll('.mk').forEach(i => i.addEventListener('click', () => {
    const team = i.closest('tr').querySelector('.tb-team span').textContent;
    detail.textContent = `${team} : ${i.title}`;
    detail.hidden = false;
  }));
}
