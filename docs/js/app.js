import { COMPETITIONS } from './config.js';
import * as E from './engine.js';
const { state, onChange, start, loadAll, toggleHidden, clearAlerts, saveSettings, testKeys } = E;
import { load, save } from './store.js';
import { renderTables, loadTables, duelHtml, duelClick, bindDuelMarks, searchTeams, teamCardHtml } from './tables.js';
import { topPicks, tipResult, bestSlot, rotationText, levelGap, statGames, teamProfile, keyNames, bigTurn, seasonXI, similarity, ESPN_CODES } from './core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = p => `${Math.round(p * 100)} %`;
const odd = o => o ? o.toFixed(2) : '–';
const expanded = new Set();   // analyse complète ouverte
const opened = new Set();     // fiche complète ouverte (sinon fiche courte)
const openSkips = new Set();  // créneaux dont les matchs sans intérêt sont dépliés
let showPast = false;         // matchs terminés (repliés par défaut)

// Favoris : gardés sur ce téléphone pour la journée (indépendants des actualisations)
const parisToday = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const favs = new Set((() => { const f = load('favs', null); return f && f.date === parisToday() ? f.ids : []; })());
function toggleFav(id) {
  favs.has(id) ? favs.delete(id) : favs.add(id);
  save('favs', { date: parisToday(), ids: [...favs] });
}
let tab = 'matches';
let seenAlerts = load('seenAlerts', 0);

// --- Navigation ---------------------------------------------------------------
function showTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + t; });
  if (t === 'settings') renderSettings();
  // Classements : les équipes du jour sont signalées d'un point
  if (t === 'tables') renderTables($('#tables'), state.matches.flatMap(m => [m.home.name, m.away.name]));
  if (t === 'alerts') { seenAlerts = state.alerts.length ? state.alerts[0].t : 0; save('seenAlerts', seenAlerts); }
  render();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

// --- Filtres ------------------------------------------------------------------
['#f-search', '#f-comp', '#f-verdict', '#f-sort', '#f-hidden', '#q-team'].forEach(s => $(s).addEventListener('input', renderMatches));
// Classements : chargés une fois au démarrage (fiches de match, recherche), puis la page se redessine
loadTables(() => renderMatches());
// Actualiser : recharge aussi les fichiers de l'application (remplace le vidage du cache)
$('#btn-refresh').addEventListener('click', () => window.pfUpdate ? window.pfUpdate(true) : loadAll());
$('#btn-clear-alerts').addEventListener('click', clearAlerts);
$('#btn-notify').addEventListener('click', async () => {
  if (!('Notification' in window)) return alert('Votre navigateur ne gère pas les notifications.');
  const p = await Notification.requestPermission();
  saveSettings({ notify: p === 'granted' });
  render();
});

// --- Rendu général ------------------------------------------------------------
function render() {
  const s = state.settings;
  $('#demo-banner').hidden = !state.bannerHtml;
  $('#demo-banner').style.display = state.bannerHtml ? '' : 'none';
  $('#demo-banner').innerHTML = state.bannerHtml || '';
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error ? 'Erreur de chargement : ' + state.error : '';
  // En-tête réduit au strict nécessaire : l'heure de la dernière vérification du robot
  const hm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const checked = state.lastRun ? state.lastRun.at : state.lastUpdate;
  $('#status').innerHTML = state.loading ? '<span>Chargement…</span>'
    : checked ? `<span>${state.lastRun && !state.lastRun.ok ? '⚠' : '✓'} À jour · ${hm(checked)}</span>` : '';
  $('#btn-notify').textContent = s.notify && window.Notification && Notification.permission === 'granted' ? '🔔 Notifications activées' : '🔕 Activer les notifications';

  const unread = state.alerts.filter(a => a.t > seenAlerts).length;
  $('#c-alerts').textContent = tab === 'alerts' ? '' : (unread || '');
  if (tab === 'alerts') { seenAlerts = state.alerts.length ? state.alerts[0].t : seenAlerts; save('seenAlerts', seenAlerts); }

  fillCompFilter();
  renderMatches();
  renderAlerts();
  renderResults();
}

function fmtDelay(mins) {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h} h ${String(m).padStart(2, '0')}`;
}

function fillCompFilter() {
  const sel = $('#f-comp'), cur = sel.value;
  const comps = [...new Map(state.matches.map(m => [m.comp.af, m.comp])).values()];
  const opts = ['<option value="">Toutes les compétitions</option>']
    .concat(comps.map(c => `<option value="${c.af}">${c.flag} ${esc(c.country)} – ${esc(c.name)} (${state.matches.filter(m => m.comp.af === c.af).length})</option>`));
  const html = opts.join('');
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; sel.value = cur; }
}

// --- Liste des matchs ---------------------------------------------------------
const noAcc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function renderMatches() {
  // Recherche d'équipe (barre du haut) ou recherche des filtres : sans tenir compte des accents
  const qt = $('#q-team').value.trim();
  const q = noAcc(qt || $('#f-search').value.trim());
  const comp = $('#f-comp').value, verdict = $('#f-verdict').value, sort = $('#f-sort').value, showHidden = $('#f-hidden').checked;
  // Les matchs terminés restent affichés (avec le score final et le résultat des pistes)
  const all = state.matches;
  const hiddenCount = all.filter(m => state.hidden.has(m.id)).length;
  $('#c-hidden').textContent = hiddenCount ? `(${hiddenCount})` : '';

  let list = all.filter(m => {
    const a = state.analyses[m.id];
    if (!a) return false;
    if (!showHidden && state.hidden.has(m.id)) return false;
    if (comp && String(m.comp.af) !== comp) return false;
    if (verdict && a.verdict.code !== verdict) return false;
    if (q && !noAcc(`${m.home.name} ${m.away.name} ${qt ? '' : m.comp.name}`).includes(q)) return false;
    return true;
  });
  list.sort(sort === 'score'
    ? (x, y) => state.analyses[y.id].verdict.score - state.analyses[x.id].verdict.score
    : (x, y) => x.kickoff - y.kickoff);

  const visible = all.filter(m => !state.hidden.has(m.id));
  const n = c => visible.filter(m => state.analyses[m.id] && state.analyses[m.id].verdict.code === c).length;
  const lineupsDone = visible.filter(m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle').length;
  $('#c-matches').textContent = visible.length || '';
  $('#summary').innerHTML = `<p class="sum-line"><b>${visible.length}</b> matchs · <b class="go">${n('play')}</b> intéressant${n('play') > 1 ? 's' : ''} · <b class="warn">${n('watch')}</b> à surveiller · ${lineupsDone} compo${lineupsDone > 1 ? 's' : ''} officielle${lineupsDone > 1 ? 's' : ''}</p>`;

  // Recherche d'une équipe : sa fiche (classement, forme, domicile / extérieur), puis son match du jour, ouvert
  if (qt) {
    if (list.length === 1) opened.add(list[0].id);
    const found = qt.length >= 3 ? searchTeams(qt) : [];
    const cards = found.map(t => teamCardHtml(t.code, t.id)).join('');
    const none = qt.length < 3 ? '<p class="small muted">Tapez au moins 3 lettres.</p>'
      : !list.length ? `<div class="empty-state">Pas de match aujourd'hui pour « ${esc(qt)} ».</div>` : '';
    $('#match-list').innerHTML = `<section class="search-res">${cards}${none}</section>${list.length ? `<div class="match-list">${list.map(cardHtml).join('')}</div>` : ''}`;
    bindDuelMarks($('#match-list'));
    return;
  }
  if (!list.length) {
    $('#match-list').innerHTML = `<div class="empty-state">${state.loading ? 'Chargement des matchs…' : 'Aucun match ne correspond.'}</div>`;
    return;
  }
  const visibleAll = all.filter(m => !state.hidden.has(m.id));
  const top = (!q && !comp && !verdict) ? favHtml() + planHtml(visibleAll) : '';
  // Un match en cours reste à sa place (avec le score en direct) ; terminé, il passe dans la section du bas
  const upcoming = list.filter(m => !isFinished(m)), past = list.filter(isFinished);
  const final = m => { const s = state.live[m.id]; return s && s.state === 'post' ? s : null; };
  const won = past.filter(m => { const t = bestTip(m), s = final(m); return t && s && tipResult(t.key, s.h, s.a); }).length;
  const played = past.filter(m => bestTip(m) && final(m)).length;
  const pastHtml = past.length ? `<section class="past">
    <button class="past-head" data-act="past"><span>✅ Matchs terminés (${past.length})${played ? ` · pistes gagnées ${won}/${played}` : ''}</span><span>${showPast ? '▲' : '▼'}</span></button>
    ${showPast ? `<div class="match-list">${past.sort((a, b) => a.kickoff - b.kickoff).map(cardHtml).join('')}</div>` : ''}</section>` : '';
  const body = !upcoming.length ? '<div class="empty-state">Plus aucun match à venir aujourd\'hui.</div>'
    : sort !== 'slot' ? upcoming.map(cardHtml).join('') : groupSlots(upcoming).map(slotHtml).join('');
  $('#match-list').innerHTML = top + body + pastHtml;
  bindDuelMarks($('#match-list'));
}

// Toucher une ligne du top ouvre la fiche du match et y descend
$('#match-list').addEventListener('click', e => {
  const b = e.target.closest('[data-open]');
  if (!b) return;
  const id = b.dataset.open;
  opened.add(id);
  renderMatches();
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// Cote d'un pari. On ne la devine pas : on dit la cote MINIMALE à exiger chez le bookmaker
// (1,40, et jamais moins que la cote juste = 1 ÷ probabilité). Si on a la vraie cote, on la compare.
const fmtOdd = o => o.toFixed(2).replace('.', ',');
const needOdd = t => Math.max(1.4, Math.ceil(100 / Math.max(t.p, 0.01)) / 100);
const oddTxt = t => {
  if (!t || !t.p) return '';
  const need = needOdd(t);
  if (t.odd) return `cote ${fmtOdd(t.odd)} ${t.odd >= need ? '✓' : '✗ trop basse'}`;
  return `jouable dès ${fmtOdd(need)}`;
};
// Solidité d'une piste (1 à 5) : probabilité, volume de stats, compos, accord avec les bookmakers, turn-over…
const SOLID_TXT = ['', 'fragile', 'moyenne', 'correcte', 'solide', 'très solide'];
const solidTxt = t => t && t.solid ? `<span class="solid s${t.solid}" title="Solidité ${t.solid}/5 : ${SOLID_TXT[t.solid]}">${'■'.repeat(t.solid)}${'□'.repeat(5 - t.solid)}</span>` : '';
// Joueur en forme : série en cours (buts sur les 3 derniers matchs) ou total des 6 derniers
const hotTxt = p => p.last3 >= 2 ? `${p.last3} buts sur ses 3 derniers matchs` : `${p.recent} buts sur ses ${p.recentGames} derniers matchs`;
const isFinished = m => ['FT', 'AET', 'PEN'].includes(m.status);

// --- Regroupement par créneau horaire, classement et combinés ---------------------
function groupSlots(matches) {
  const slots = [];
  [...matches].sort((a, b) => a.kickoff - b.kickoff).forEach(m => {
    const last = slots[slots.length - 1];
    if (last && m.kickoff - last.start <= 30 * 60000) last.matches.push(m);
    else slots.push({ start: m.kickoff, matches: [m] });
  });
  return slots;
}

// Meilleure piste d'un match (hors doublé), utilisée pour classer et combiner
function bestTip(m) {
  const a = state.analyses[m.id];
  if (!a || a.verdict.code === 'skip') return null;
  // La piste phare suit le profil du match (dans un festival de buts : la ligne de buts), pas le plus gros pourcentage
  const main = a.tips.filter(t => !String(t.key).startsWith('SC') && !/audacieux/.test(t.label));
  return main[0] || a.tips.filter(t => t.key !== 'SC2' && t.key !== 'SCD')[0] || null;
}

// --- Tireurs de penalty (mémoire du robot), confrontés aux compos officielles ------------
const lastName = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/).pop();
function penInfo(m, side) {
  const list = m.pens && m.pens[side];
  if (!list || !list.length) return null;
  const lu = m.lineups && m.lineups[side];
  const xi = lu && lu.status === 'officielle' && lu.startXI ? lu.startXI : null;
  const inXI = n => xi && xi.some(x => lastName(x.name) === lastName(n));
  const main = list[0], rec = p => `${p.ok}/${p.att}`;
  if (!xi) return { k: '', main, t: `🎯 Penalty ${m[side].name} : ${main.name} (${rec(main)} cette saison)` };
  if (inXI(main.name)) return { k: 'ok', main, t: `🎯 Penalty ${m[side].name} : ${main.name} titulaire ✓ (${rec(main)})` };
  const next = list.find(p => inXI(p.name));
  return { k: 'bad', main: next || null, t: `🎯 Penalty ${m[side].name} : ${main.name} pas titulaire${next ? ` → ${next.name} (${rec(next)}) devrait tirer` : ', tireur inconnu'}` };
}

function slotHtml(slot) {
  const time = new Date(slot.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  // Dans un créneau : les plus intéressants d'abord (verdict, puis solidité et probabilité de la meilleure piste)
  const interest = m => { const a = state.analyses[m.id], t = bestTip(m); return a.verdict.score + (t ? (t.solid || 0) * 5 + t.p * 10 : 0); };
  const ranked = [...slot.matches].sort((a, b) => interest(b) - interest(a) || a.kickoff - b.kickoff).map(m => ({ m, t: bestTip(m) }));
  const main = ranked.filter(x => state.analyses[x.m.id].verdict.code !== 'skip');
  const skipped = ranked.filter(x => state.analyses[x.m.id].verdict.code === 'skip');
  const showSkips = openSkips.has(String(slot.start));
  const nPlay = slot.matches.filter(m => state.analyses[m.id].verdict.code === 'play').length;
  const official = slot.matches.filter(m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle').length;
  return `<section class="slot">
    <div class="slot-head">
      <h2>${time}</h2>
      <span class="muted small">${slot.matches.length} match${slot.matches.length > 1 ? 's' : ''}${nPlay ? ` · <b class="go">${nPlay} à jouer</b>` : ''} · compos ${official}/${slot.matches.length}</span>
    </div>
    ${!main.length ? '<p class="small muted">Aucune piste non évidente dans ce créneau.</p>' : ''}
    <div class="match-list">${main.map(x => cardHtml(x.m)).join('')}</div>
    ${skipped.length ? `<button class="link muted skip-toggle" data-act="skips" data-slot="${slot.start}">${showSkips ? '▲ Replier' : '▼ Voir'} les ${skipped.length} match${skipped.length > 1 ? 's' : ''} sans intérêt (évidents, imprévisibles ou sans statistiques)</button>
      ${showSkips ? `<div class="match-list">${skipped.map(x => cardHtml(x.m)).join('')}</div>` : ''}` : ''}
  </section>`;
}

// Combinés du jour. Toutes les sélections sont rangées par horaire, pour les retrouver facilement chez le bookmaker.
// Chaque sélection peut être retirée (✕) ; « Mon combiné perso » se remplit avec le bouton ＋ des fiches.
const TIER_RANK = { gros: 3, moyen: 2, faible: 1 };
const byTime = (x, y) => x.m.kickoff - y.m.kickoff;
const hhmmFr = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// Retraits et combiné perso : gardés sur ce téléphone pour la journée
const dayLoad = k => { const v = load(k, null); return v && v.date === parisToday() ? v.data : null; };
const dropped = dayLoad('combo-drop') || {};   // { idDuCombiné: [idsDesMatchs] }
let perso = dayLoad('combo-perso') || [];      // [{ id, key, label, p }]
const saveDropped = () => save('combo-drop', { date: parisToday(), data: dropped });
const savePerso = () => save('combo-perso', { date: parisToday(), data: perso });
const inPerso = (id, key) => perso.some(x => x.id === id && (key == null || x.key === key));
function togglePerso(m, tip) {
  if (inPerso(m.id, tip.key)) perso = perso.filter(x => !(x.id === m.id && x.key === tip.key));
  else perso = [...perso.filter(x => x.id !== m.id), { id: m.id, key: tip.key, label: tip.label, p: tip.p }];
  savePerso();
}

// Raisons d'un favori, en une ligne : bilan, forme, niveau, absents vérifiés ou non
const FORM_FR = { W: 'V', D: 'N', L: 'D' };
function favReasons(m, side) {
  const other = side === 'home' ? 'away' : 'home';
  const ts = m.teamStats || {}, me = ts[side] && ts[side][side], opp = ts[other] && ts[other][other];
  const r = [];
  // Coupe : niveau des deux équipes dans leur championnat, plutôt que les 1 ou 2 matchs de la compétition
  if (m.level) {
    const lv = L => `${L.league}${L.rank ? `, ${L.rank}${L.rank === 1 ? 'er' : 'e'}` : ''}`, g = levelGap(m);
    r.push(lv(m.level[side]), `${m[other].name} : ${lv(m.level[other])}`);
    if (g) r.push(g.size === 'faible' ? '⚠ niveau proche' : `écart ${g.size}`);
    const inj = (m.injuries && m.injuries[side]) || [];
    r.push(m.injChecked ? (inj.length ? `${inj.length} absent${inj.length > 1 ? 's' : ''} (aucun buteur clé)` : '✓ pas d\'absent signalé') : '⚠ absents pas encore vérifiés');
    return r;
  }
  if (me && me.p && me.w != null) r.push(`${me.w}/${me.p} victoires ${side === 'home' ? 'à domicile' : 'à l\'extérieur'}`);
  if (opp && opp.p && opp.w != null) r.push(`${m[other].name} ${opp.w}/${opp.p} ${other === 'home' ? 'à domicile' : 'à l\'extérieur'}`);
  const f = m.form && m.form[side];
  if (f) r.push(`forme ${f.slice(-5).split('').map(c => FORM_FR[c] || c).join('')}`);
  if (m.tiers && m.tiers[other] === 'faible') r.push('adversaire faible');
  const inj = (m.injuries && m.injuries[side]) || [];
  r.push(m.injChecked ? (inj.length ? `${inj.length} absent${inj.length > 1 ? 's' : ''} (aucun buteur clé)` : '✓ pas d\'absent signalé') : '⚠ absents pas encore vérifiés');
  return r;
}
// Peut-on compter sur ce favori ? Pas de buteur clé absent, pas de fatigue de coupe d'Europe, adversaire pas plus fort
function solidFav(m, a, side) {
  const other = side === 'home' ? 'away' : 'home';
  // Coupe : niveau du championnat de chaque équipe ; sinon niveau dans le classement de la compétition
  if (m.level) { if (m.level[side].S < m.level[other].S) return false; }
  else {
    const tF = m.tiers && TIER_RANK[m.tiers[side]], tO = m.tiers && TIER_RANK[m.tiers[other]];
    if (tF && tO && tF < tO) return false;
  }
  if (a.presence[side].players.some(x => x.status === 'absent' && x.share >= 0.15)) return false;
  const rot = a.presence[side].rotation;
  if (bigTurn(rot)) return false;
  const f = m.fatigue && m.fatigue[side];
  return !(f && f.tired);
}
// Assez de matchs pour se fier aux stats (en coupe, le niveau du championnat compense un peu le petit nombre)
const usable = m => m.status === 'NS' && m.stats && state.analyses[m.id] && statGames(m) >= (m.level ? 3 : 4);

// 🛡️ Favoris du jour : tous les favoris qui devraient gagner sauf surprise (60 % et plus), même avant les compos
function favLegs(list) {
  return list.filter(usable).map(m => {
    const a = state.analyses[m.id], side = a.p.home >= a.p.away ? 'home' : 'away', p = a.p[side];
    if (p < 0.6 || !solidFav(m, a, side)) return null;
    const odd = m.odds && m.odds.h2h && m.odds.h2h[side];
    return { m, tip: { key: side === 'home' ? '1' : '2', label: `Victoire ${m[side].name}`, p, odd }, reasons: favReasons(m, side) };
  }).filter(Boolean).sort(byTime);
}
// 🏠 Spécial domicile : victoires à domicile de 55 à 90 %
function homeLegs(list) {
  return list.filter(usable).map(m => {
    const a = state.analyses[m.id], p = a.p.home;
    if (p < 0.55 || p > 0.9 || !solidFav(m, a, 'home')) return null;
    return { m, tip: { key: '1', label: `Victoire ${m.home.name}`, p, odd: m.odds && m.odds.h2h && m.odds.h2h.home }, reasons: favReasons(m, 'home') };
  }).filter(Boolean).sort(byTime);
}
// 🧱 Base solide : pour chaque match, la piste la plus SOLIDE (4/5 ou plus), pas forcément la plus probable
function solidLegs(list) {
  return list.filter(usable).map(m => {
    const a = state.analyses[m.id];
    if (a.verdict.code === 'skip') return null;
    const t = a.tips.filter(x => !String(x.key).startsWith('SC') && (x.solid || 0) >= 4)
      .sort((x, y) => y.solid - x.solid || y.p - x.p)[0];
    return t ? { m, tip: t, reasons: [`solidité ${t.solid}/5`, a.verdict.plan ? a.verdict.plan.replace(/\s*:.*$/, '') : ''].filter(Boolean) } : null;
  }).filter(Boolean).sort(byTime);
}
// Les N sélections les plus solides parmi une liste, remises dans l'ordre des horaires
const strongest = (legs, n) => [...legs].sort((x, y) => y.tip.solid - x.tip.solid || y.tip.p - x.tip.p).slice(0, n).sort(byTime);
// ✍️ Mon combiné perso : probabilités recalculées à chaque actualisation
function persoLegs() {
  return perso.map(x => {
    const m = state.matches.find(y => y.id === x.id), a = m && state.analyses[m.id];
    if (!m || !a) return null;
    const mk = a.markets.find(k => k.key === x.key) || a.tips.find(t => t.key === x.key);
    return { m, tip: { key: x.key, label: x.label, p: mk ? mk.p : x.p, odd: mk && mk.odd }, reasons: [], perso: true };
  }).filter(Boolean).sort(byTime);
}

// 💰 Plan du jour : deux petits combinés « faciles » (cote ≈ 3, sans match en commun)
// et un gros coup (cote ≈ 400 à 600) pour tenter le gros gain avec une petite mise.
const PLAN_STAKE = 5, SMALL_ODD = 2.8, BIG_MAX = 14, PLAN_GAINS = [300, 500, 2000];
const fairOdd = legs => legs.reduce((a, x) => a / x.tip.p, 1);
function planDuJour(list) {
  const cand = list.filter(m => usable(m) && m.kickoff > Date.now()).map(m => {
    const a = state.analyses[m.id];
    if (a.verdict.code === 'skip') return null;
    const main = a.tips.filter(x => !String(x.key).startsWith('SC') && x.p >= 0.45);
    const safe = [...main].sort((x, y) => (y.solid || 0) - (x.solid || 0) || y.p - x.p)[0];
    // Version plus audacieuse, pour le gros coup seulement : la plus grosse cote parmi les pistes encore probables
    // Autres pistes solides du match (3/5 et plus), utilisables pour ajuster la cote d'un combiné
    const all = main.filter(x => x === safe || (x.p >= 0.5 && (x.solid || 0) >= 3));
    return safe ? { m, safe, all } : null;
  }).filter(Boolean);
  // Les compos officielles départagent deux pistes de même solidité
  const rank = (x, y) => (y.safe.solid || 0) - (x.safe.solid || 0) || isOff(y.m) - isOff(x.m) || y.safe.p - x.safe.p;
  // Petits combinés : les pistes les plus solides (4/5 et plus), 2 ou 3 par combiné jusqu'à une cote d'environ 3
  const sure = cand.filter(c => (c.safe.solid || 0) >= 4).sort(rank);
  const smalls = [];
  let i = 0;
  for (let k = 0; k < 2; k++) {
    const legs = [];
    while (i < sure.length && legs.length < 3 && fairOdd(legs) < SMALL_ODD) { legs.push({ m: sure[i].m, tip: sure[i].safe }); i++; }
    if (legs.length >= 2) smalls.push(legs.sort(byTime));
  }
  // Gros coup : les pistes solides (3/5 et plus) jusqu'à la cote visée ; s'il en manque,
  // les moins solides passent en version audacieuse (cote plus haute)
  const pool = cand.filter(c => (c.safe.solid || 0) >= 3).sort(rank);
  // Combiné visant une cote précise : les pistes les plus solides tant qu'on ne dépasse pas la cible,
  // puis une finition (ajouter un match, ou passer un match sur une autre de ses pistes solides) pour s'en approcher
  const build = target => {
    const legs = [], rest = [];
    for (const c of pool) {
      if (legs.length < BIG_MAX && fairOdd(legs) / c.safe.p <= target * 1.15) legs.push({ m: c.m, tip: c.safe, c });
      else rest.push(c);
    }
    const gapOf = o => Math.abs(Math.log(o / target));
    for (let n = 0; n < 10 && gapOf(fairOdd(legs)) > Math.log(1.1); n++) {
      const cur = fairOdd(legs);
      let best = null;
      const consider = (o, act) => { const g = gapOf(o); if (!best || g < best.g) best = { g, act }; };
      if (legs.length < BIG_MAX) for (const c of rest) if (!legs.some(l => l.c === c)) for (const t of c.all) consider(cur / t.p, () => legs.push({ m: c.m, tip: t, c }));
      legs.forEach((l, i) => l.c.all.forEach(t => { if (t.key !== l.tip.key) consider(cur * l.tip.p / t.p, () => { legs[i] = { ...l, tip: { ...t, bold: t.p < l.c.safe.p } }; }); }));
      if (!best || best.g >= gapOf(cur)) break;
      best.act();
    }
    return gapOf(fairOdd(legs)) <= Math.log(1.3) ? legs.sort(byTime) : [];
  };
  // Gros coup : un seul combiné, pour le gain choisi (300 €, 500 € ou 2 000 € pour la mise)
  const big = build(planGain / PLAN_STAKE);
  return { smalls, big: big.length >= 5 ? big : [] };
}

// Compos officielles connues pour les deux équipes
const isOff = m => !!(m.lineups && m.lineups.home && m.lineups.home.status === 'officielle' && m.lineups.away && m.lineups.away.status === 'officielle');
// Gain visé par le gros coup (mémorisé sur le téléphone)
let planGain = (() => { const v = +load('plan-gain', 500); return PLAN_GAINS.includes(v) ? v : 500; })();

// ⏰ Spécial créneau : dans le prochain créneau chargé, un combiné qui MÉLANGE les angles
// (un résultat, un match à buts, un buteur), une piste par match, compos officielles en priorité
function mixLegs(matches, n) {
  const opts = [];
  for (const m of matches) {
    const a = state.analyses[m.id];
    if (!a || a.verdict.code === 'skip') continue;
    for (const t of a.tips) {
      const sc = String(t.key).startsWith('SC');
      if (t.key === 'SC2' || (!sc && t.angle === 'derived')) continue;
      // Buteur : titulaire seul s'il est bien placé (35 % et plus), sinon « X ou Y » si la double chance est belle (50 % et plus)
      if (sc && !(t.key === 'SCD' ? t.p >= 0.5 : t.p >= 0.35 && (/titulaire/.test(t.label) || !isOff(m)))) continue;
      if (!sc && (t.solid || 0) < 3) continue;
      const kind = sc ? 'buteur' : t.angle === 'result' ? 'résultat' : 'buts';
      opts.push({ m, tip: t, kind, score: (t.solid || 2) + t.p + (isOff(m) ? 0.5 : 0) });
    }
  }
  opts.sort((x, y) => y.score - x.score);
  const legs = [], used = new Set(), count = {}, cap = { 'résultat': 2, buts: 2, buteur: 1 };
  const take = o => { legs.push(o); used.add(o.m.id); count[o.kind] = (count[o.kind] || 0) + 1; };
  // D'abord un pari de chaque sorte, puis les plus solides
  for (const kind of ['résultat', 'buts', 'buteur']) { const o = opts.find(o => o.kind === kind && !used.has(o.m.id)); if (o && legs.length < n) take(o); }
  for (const o of opts) { if (legs.length >= n) break; if (!used.has(o.m.id) && (count[o.kind] || 0) < cap[o.kind]) take(o); }
  return legs.sort(byTime);
}
function planHtml(list) {
  const P = planDuJour(list);
  const up = list.filter(m => usable(m) && m.kickoff > Date.now());
  const pTxt = p => p >= 0.01 ? pct(p) : `${(p * 100).toFixed(2).replace('.', ',')} %`;
  const euros = o => Math.round(PLAN_STAKE * o).toLocaleString('fr-FR');
  // Une ligne par sélection : heure, match, pari, probabilité (✓ = compos officielles)
  const li = x => `<li><span class="c-time">${hhmmFr(x.m.kickoff)}</span><span class="cm-txt"><span class="c-names">${esc(x.m.home.name)} – ${esc(x.m.away.name)}${isOff(x.m) ? ' <span class="ok-mark" title="Compos officielles">✓</span>' : ''}</span><small><b>${esc(x.tip.label)}</b>${x.tip.bold ? ' 🎲' : ''} · dès ${fmtOdd(needOdd(x.tip))}</small></span><b>${pct(x.tip.p)}</b></li>`;
  const total = legs => { const o = fairOdd(legs); return `<div class="combo-total"><span><b>${pTxt(1 / o)}</b> de réussite</span><span>cote ≈ <b>${o.toFixed(o >= 100 ? 0 : 1).replace('.', ',')}</b> · ${PLAN_STAKE} € → <b>${euros(o)} €</b></span></div>`; };

  // La journée en une ligne : vaut-elle un combiné ?
  const solidN = up.filter(m => state.analyses[m.id].tips.some(t => !String(t.key).startsWith('SC') && (t.solid || 0) >= 4)).length;
  const offN = up.filter(isOff).length;
  const mood = solidN >= 8 ? '🔥 Grosse journée : de quoi faire un beau combiné'
    : solidN >= 4 ? '👍 Journée correcte : petit combiné conseillé'
    : solidN >= 2 ? '🤏 Journée calme : petit combiné seulement' : '✋ Peu de pistes solides : mieux vaut s\'abstenir';

  // ⏰ Spécial créneau : le prochain créneau d'au moins 3 matchs
  const slot = groupSlots(up).find(s => s.matches.length >= 3);
  let slotCard = '';
  if (slot) {
    const legs = mixLegs(slot.matches, 4);
    const off = slot.matches.filter(isOff).length, n = slot.matches.length;
    const status = off === n ? '✓ Toutes les compos sont officielles : à jouer maintenant.'
      : `⏳ Compos officielles : ${off}/${n}. Elles tombent environ 1 h avant (vers ${hhmmFr(slot.start - 3600000)}) ; le combiné se met à jour tout seul.`;
    if (legs.length >= 2) slotCard = `<div class="combo-card best">
      ${cardHead('c-slot', `⏰ Spécial ${hhmmFr(slot.start)} · ${n} matchs`, 'Un pari par match, en mélangeant résultat, buts et buteur.')}
      ${isFold('c-slot') ? '' : `<p class="small ${off === n ? 'go' : 'muted'}">${status}</p>
      <ul class="combo-mini">${legs.map(li).join('')}</ul>${total(legs)}`}</div>`;
  }
  const smallCard = P.smalls.length ? `<div class="combo-card">
      ${cardHead('c-small', '😌 Petit combiné', 'Les pistes les plus solides de la journée, cote ≈ 3.')}
      ${isFold('c-small') ? '' : P.smalls.map((legs, k) => `${P.smalls.length > 1 ? `<p class="step small"><b>${k ? 'Ou bien ②' : '①'}</b></p>` : ''}<ul class="combo-mini">${legs.map(li).join('')}</ul>${total(legs)}`).join('')}
    </div>` : '';
  const bigCard = `<div class="combo-card">
      ${cardHead('c-big', '🚀 Gros coup', 'Petite mise, gros gain : il passe rarement.')}
      ${isFold('c-big') ? '' : `<div class="gain-pick">${PLAN_GAINS.map(g => `<button class="chip tap${g === planGain ? ' on' : ''}" data-act="plan-gain" data-v="${g}">${g.toLocaleString('fr-FR')} €</button>`).join('')}</div>
      ${P.big.length ? `<details class="big-legs"><summary>${P.big.length} sélections (voir)</summary><ul class="combo-mini">${P.big.map(li).join('')}</ul></details>${total(P.big)}`
        : '<p class="small muted">Pas assez de pistes solides pour viser ce gain.</p>'}`}
    </div>`;
  const persoCard = perso.length ? combosHtml(list, 'perso') : '';
  return `<section class="combos plan">
    <div class="top-head fold-head" data-act="fold" data-key="plan"><h2>🎯 Combinés du jour</h2>${foldIc('plan')}</div>
    ${isFold('plan') ? '' : `<p class="day-mood"><b>${mood}</b><br><span class="small muted">${up.length} matchs à venir · ${solidN} pistes solides · ${offN} compo${offN > 1 ? 's' : ''} officielle${offN > 1 ? 's' : ''}</span></p>
    <div class="combo-grid">${slotCard}${smallCard}${bigCard}${persoCard}</div>
    <p class="small muted">✓ = compos officielles. « dès 1,45 » : cote minimale à trouver chez le bookmaker. Touchez un pronostic (＋) sur une fiche pour faire votre propre combiné. Touchez un titre pour le replier.</p>
    <details class="more-combos"><summary>📚 Plus de combinés (top du jour, base solide, favoris, domicile, buteurs…)</summary>
      ${topHtml(list)}${combosHtml(list, 'others')}
    </details>`}
  </section>`;
}

// Sections repliables : un appui sur le titre replie ou déplie (mémorisé sur le téléphone)
const folded = new Set(load('folded', []));
const isFold = k => folded.has(k);
function toggleFold(k) { folded.has(k) ? folded.delete(k) : folded.add(k); save('folded', [...folded]); }
const foldIc = k => `<span class="fold-ic">${isFold(k) ? '▸' : '▾'}</span>`;
const cardHead = (k, title, sub) => `<div class="combo-card-head fold-head" data-act="fold" data-key="${k}"><b>${title}</b>${foldIc(k)}${isFold(k) || !sub ? '' : `<span class="small muted">${esc(sub)}</span>`}</div>`;

// only : 'perso' = seulement « Mon combiné perso » ; 'others' = tous les autres (repliés sous « Plus de combinés »)
function combosHtml(list, only) {
  const slot = bestSlot(list, state.analyses);
  // Buteurs regroupés par match : une ligne par match, avec ses options (buteurs seuls, puis « X ou Y » double chance)
  const scorers = list.filter(m => m.status === 'NS' && m.stats && state.analyses[m.id]).map(m => {
    const a = state.analyses[m.id];
    // Pas de buteur dans un match fermé, ni dans une équipe qui ne devrait pas marquer
    if (a.verdict.profile === 'ferme') return null;
    const scoring = sd => (sd === 'home' ? a.lh : a.la) >= 1.2;
    const pool = [...(scoring('home') ? a.scorers.home : []), ...(scoring('away') ? a.scorers.away : [])];
    const singles = pool.filter(p => !p.returning && p.line !== 'D' && p.line !== 'G' && (p.p1 >= 0.3 || (p.hot && p.p1 >= 0.22))).sort((x, y) => y.p1 - x.p1).slice(0, 3).map(p => {
      const pen = ['home', 'away'].map(s => penInfo(m, s)).some(x => x && x.main && lastName(x.main.name) === lastName(p.name));
      return { label: `${p.name} buteur${p.hot ? ' 🔥' : ''}`, p: p.p1, info: `${p.team}${p.goals ? ` · ${p.goals} but${p.goals > 1 ? 's' : ''}${p.played ? ` en ${p.played} match${p.played > 1 ? 's' : ''}` : ''}` : ''}${p.hot ? ` · ${hotTxt(p)}` : ''}${p.status === 'titulaire' ? ' · titulaire ✓' : ''}${pen ? ' · 🎯 penalties' : ''}` };
    });
    const duo = a.tips.find(x => x.key === 'SCD');
    const dbl = a.tips.find(x => x.key === 'SC2');
    const options = [...singles,
      ...(duo ? [{ label: `🎲 ${duo.label}`, p: duo.p, info: 'double chance : un des deux suffit' }] : []),
      ...(dbl ? [{ label: `💥 ${dbl.label.replace(' (pari osé)', '')}`, p: dbl.p, info: 'beaucoup de buts attendus : pari osé, grosse cote' }] : [])];
    return options.length ? { m, options, best: Math.max(...options.map(o => o.p)), tip: { p: 1 } } : null;
  }).filter(Boolean).sort((x, y) => y.best - x.best).slice(0, 8).sort(byTime);

  // Les cartes restent toujours visibles, avec un message quand il n'y a rien de solide
  const cards = [
    { id: 'solid', title: '🧱 Base solide', rule: 'Une piste par match, choisie pour sa SOLIDITÉ (■ sur 5 : assez de matchs joués, accord avec les bookmakers, compos, pas de gros turn-over), pas seulement pour sa probabilité. En bas : le combiné conseillé (les 4 plus solides) et le gros combiné (les 8 plus solides).', sel: solidLegs(list), best: true, tiers: [4, 8], empty: 'Aucune piste à 4/5 de solidité pour la suite de la journée.' },
    { id: 'fav', title: '🛡️ Favoris du jour', rule: 'Avant même les compos : les favoris qui devraient gagner sauf surprise (60 % et plus), sans buteur clé absent ni fatigue de coupe d\'Europe, face à un adversaire pas plus fort. Retirez ceux que vous ne sentez pas avec ✕.', sel: favLegs(list), empty: 'Aucun favori assez sûr pour la suite de la journée.' },
    { id: 'dom', title: '🏠 Spécial domicile', rule: 'Les victoires à domicile de 55 à 90 %, avec les mêmes contrôles (absents, fatigue, niveau de l\'adversaire).', sel: homeLegs(list), empty: 'Aucun favori à domicile assez solide pour la suite de la journée.' },
    { id: 'perso', title: '✍️ Mon combiné perso', rule: 'Vos propres choix : touchez un pronostic (＋) sur la fiche d\'un match pour l\'ajouter ici. ✕ pour le retirer.', sel: persoLegs(), empty: 'Vide pour l\'instant : touchez un pronostic (＋) sur les matchs de votre choix.' },
    slot ? { id: 'slot', title: `⏰ Meilleur créneau : ${hhmmFr(slot.start)}`, rule: `Le plus de matchs analysés à la même heure. À jouer vers ${hhmmFr(slot.betAt)}, quand les compos sont connues (${slot.official}/${slot.count} officielles).`, sel: [...slot.legs].sort(byTime) }
      : { id: 'slot', title: '⏰ Meilleur créneau', rule: 'Le plus de matchs analysés à la même heure, à jouer 15 min avant avec les compos.', sel: [], empty: 'Pas de créneau avec au moins 2 pistes solides pour la suite de la journée.' },
    { id: 'but', title: '⚽ Buteurs, match par match', rule: 'À jouer en simple, pas en combiné. Choisissez UNE option par match. 🎲 = buteur double chance (« X ou Y marque »). Cote juste ≈ 1 ÷ probabilité (30 % → 3,3).', sel: scorers, single: true, grouped: true, empty: 'Aucun buteur à 30 % ou plus pour la suite de la journée.' },
  ];

  const card = c => {
    const off = new Set(c.perso || c.single ? [] : dropped[c.id] || []);
    const active = c.sel.filter(x => !off.has(x.m.id)), removed = c.sel.length - active.length;
    const head = cardHead(`c-${c.id}`, c.title, c.rule);
    if (isFold(`c-${c.id}`)) return `<div class="combo-card${c.best ? ' best' : ''}">${head}</div>`;
    if (!c.sel.length) return `<div class="combo-card empty">${head}<p class="small muted">${esc(c.empty)}</p></div>`;
    if (c.grouped) {
      return `<div class="combo-card">${head}
        <ul class="combo-mini grouped">${c.sel.map(x => `<li><span class="c-time">${hhmmFr(x.m.kickoff)}</span><span class="cm-txt"><span class="c-names">${esc(x.m.home.name)} – ${esc(x.m.away.name)}</span>
          ${x.options.map(o => `<span class="opt"><span><b>${esc(o.label)}</b><small> · ${esc(o.info)} · ${oddTxt(o)}</small></span><b>${pct(o.p)}</b></span>`).join('')}</span></li>`).join('')}</ul>
      </div>`;
    }
    const p = active.reduce((acc, x) => acc * x.tip.p, 1);
    const oddAll = active.length && active.every(x => x.tip.odd) ? active.reduce((acc, x) => acc * x.tip.odd, 1) : null;
    const dropBtn = x => c.single ? '' : c.id === 'perso'
      ? `<button class="drop" data-act="perso-del" data-mid="${esc(x.m.id)}" data-key="${esc(x.tip.key)}" aria-label="Retirer de mon combiné">✕</button>`
      : `<button class="drop" data-act="drop" data-combo="${c.id}" data-mid="${esc(x.m.id)}" aria-label="Retirer du combiné">✕</button>`;
    return `<div class="combo-card${c.best ? ' best' : ''}">
      ${head}
      <ul class="combo-mini">${active.map(x => `<li><span class="c-time">${hhmmFr(x.m.kickoff)}</span><span class="cm-txt"><span class="c-names">${esc(x.m.home.name)} – ${esc(x.m.away.name)}</span><small><b>${esc(x.tip.label)}</b> · ${oddTxt(x.tip)}${x.reasons && x.reasons.length ? ' · ' + esc(x.reasons.join(' · ')) : ''}</small></span><b>${pct(x.tip.p)}${c.tiers ? ' ' + solidTxt(x.tip) : ''}</b>${dropBtn(x)}</li>`).join('')}</ul>
      ${removed ? `<p class="small muted">${removed} sélection${removed > 1 ? 's' : ''} retirée${removed > 1 ? 's' : ''} · <button class="link" data-act="undrop" data-combo="${c.id}">↺ tout remettre</button></p>` : ''}
      ${c.tiers ? c.tiers.filter((n, i) => active.length >= (i ? n - 2 : 2) && (i === 0 || active.length > c.tiers[0])).map((n, i) => {
        const legs = strongest(active, n), pp = legs.reduce((acc, x) => acc * x.tip.p, 1);
        return `<div class="combo-total"><span>${i ? '🚀 Gros combiné' : '✅ Combiné conseillé'} : ${legs.length} sélections · <b>${pp >= 0.01 ? pct(pp) : '< 1 %'}</b><br><small class="muted">${esc(legs.map(x => `${hhmmFr(x.m.kickoff)} ${x.m.home.name}–${x.m.away.name} : ${x.tip.label}`).join(' · '))}</small></span><span>cote juste ≈ <b>${(1 / pp).toFixed(1).replace('.', ',')}</b></span></div>`;
      }).join('') : ''}
      ${c.single || c.tiers || !active.length ? '' : `<div class="combo-total"><span>${active.length} sélection${active.length > 1 ? 's' : ''} · <b>${p >= 0.01 ? pct(p) : '< 1 %'}</b></span><span>${oddAll ? `cote bookmaker ≈ <b>${oddAll.toFixed(1).replace('.', ',')}</b>` : `cote juste ≈ <b>${(1 / p).toFixed(1).replace('.', ',')}</b>`}</span></div>`}
    </div>`;
  };
  if (only === 'perso') return card(cards.find(c => c.id === 'perso'));
  const shown = only === 'others' ? cards.filter(c => c.id !== 'perso' && c.sel.length) : cards;
  return `<section class="combos">
    <div class="combo-grid">${shown.map(card).join('') || '<p class="small muted">Rien de plus pour la suite de la journée.</p>'}</div>
    <p class="small muted">Les probabilités se multiplient : plus le combiné est long, plus le gain est gros et plus les chances sont faibles. Vos retraits et votre combiné perso restent sur ce téléphone jusqu'à minuit.</p>
  </section>`;
}

// Mes favoris : les matchs choisis, en haut de page, avec la demande d'analyse approfondie pour Claude
function favHtml() {
  const list = state.matches.filter(m => favs.has(m.id)).sort((a, b) => a.kickoff - b.kickoff);
  if (!list.length) return '';
  return `<section class="favs">
    <div class="top-head fold-head" data-act="fold" data-key="favs"><h2>⭐ Mes favoris (${list.length})</h2>${foldIc('favs')}</div>
    ${isFold('favs') ? '' : `<div class="match-list">${list.map(cardHtml).join('')}</div>
    <div class="fav-actions">
      <button class="btn" data-act="copyfav">🔎 Analyse approfondie avec Claude</button>
      <span class="small muted" id="fav-msg">Copie une demande prête à coller dans Claude, avec ces matchs et les chiffres du robot. Recollez ensuite son bloc PRONOFOOT avec « ＋ Ajouter ».</span>
    </div>`}
  </section>`;
}

// Demande d'analyse approfondie pour Claude : ce que le robot ne voit pas
function favPrompt() {
  const list = state.matches.filter(m => favs.has(m.id)).sort((a, b) => a.kickoff - b.kickoff);
  const lines = list.map(m => {
    const a = state.analyses[m.id];
    const time = new Date(m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const s = m.stats;
    const stats = s ? `${m.home.name} à domicile : ${s.home.p} matchs, ${s.home.gf} buts marqués, ${s.home.ga} encaissés ; ${m.away.name} à l'extérieur : ${s.away.p} matchs, ${s.away.gf} marqués, ${s.away.ga} encaissés.` : 'Pas de statistiques côté robot.';
    const tips = a.tips.filter(t => t.key !== 'SC2').sort((x, y) => y.p - x.p).slice(0, 3).map(t => `${t.label} (${Math.round(t.p * 100)} %)`).join(', ');
    const lu = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle' ? 'compositions officielles connues' : 'compositions pas encore officielles';
    return `- ${time} · ${m.comp.name} · ${m.home.name} – ${m.away.name}\n  Chiffres du robot : ${stats}\n  Pistes du robot : ${tips || 'aucune'} (verdict : ${a.verdict.label}, ${lu}).`;
  });
  return `Analyse approfondie (mes favoris du jour). Pour chacun de ces matchs, va plus loin que les statistiques :
${lines.join('\n')}

Pour chaque match, cherche ce que les chiffres ne montrent pas : actualité des dernières 48 h (blessures de dernière minute, suspensions, retours), déclarations des entraîneurs, rotation probable (coupe d'Europe ou match important à venir), enjeu et motivation (classement, derby, maintien), confrontations directes récentes, conditions (météo, terrain, voyage).
Puis dis clairement si tu CONFIRMES ou CONTREDIS les pistes du robot, avec la raison en une phrase, et propose au besoin une meilleure piste non évidente (entre 40 et 66 %).
Réponse courte : 5 lignes maximum par match. Termine par le bloc PRONOFOOT de ces matchs (avec "note" = ton avis en une phrase).`;
}

async function copyFavPrompt(btn) {
  const text = favPrompt();
  const msg = $('#fav-msg');
  try { await navigator.clipboard.writeText(text); msg.textContent = '✓ Demande copiée : collez-la dans votre projet Claude.'; }
  catch {
    // Copie refusée par le téléphone : on affiche le texte à sélectionner à la main
    msg.innerHTML = `Copie automatique refusée : appuyez longuement dans le texte ci-dessous, « Tout sélectionner », puis « Copier ».<textarea class="fav-prompt" readonly rows="8">${esc(text)}</textarea>`;
  }
}

// Top du jour : uniquement les pistes jugées fiables (le nombre varie, parfois aucune)
function topHtml(list) {
  const top = topPicks(list, state.analyses, state.bilanRates || {});
  const rate = state.bilanTop;
  const head = `<div class="top-head"><h2>🏆 Top du jour</h2>${rate && rate.n ? `<span class="small muted">Réussite les jours passés : <b>${pct(rate.ok / rate.n)}</b> (${rate.ok}/${rate.n})</span>` : ''}</div>`;
  if (!top.length) {
    return `<section class="topday">${head}<p class="small muted">Aucune piste assez fiable pour l'instant. Le top se remplit quand les statistiques sont solides et que les compositions sont connues.</p></section>`;
  }
  // Combiné du jour : les 3 pistes les plus sûres du top (★), affichées comme le reste dans l'ordre des horaires
  const stars = new Set(top.length >= 2 ? top.slice(0, 3).map(x => x.m.id) : []);
  const starSel = top.filter(x => stars.has(x.m.id));
  const p = starSel.reduce((acc, x) => acc * x.tip.p, 1);
  return `<section class="topday">${head}
    <ol class="top-list">${[...top].sort((x, y) => x.m.kickoff - y.m.kickoff).map(x => {
      const time = new Date(x.m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const why = (state.analyses[x.m.id].verdict.flags || []).slice(0, 2).map(f => f.t).join(' · ');
      return `<li><button class="top-item${stars.has(x.m.id) ? ' star' : ''}" data-open="${esc(x.m.id)}">
        <span class="c-time">${time}</span>
        <span class="c-teams"><b>${stars.has(x.m.id) ? '★ ' : ''}${esc(x.m.home.name)} – ${esc(x.m.away.name)}</b><small>${esc(x.tip.label)}${why ? ' · ' + esc(why) : ''}</small></span>
        <span class="top-p"><b>${pct(x.tip.p)}</b><small>${x.official ? '✓ compos' : 'provisoire'}</small></span>
      </button></li>`;
    }).join('')}</ol>
    ${starSel.length >= 2 ? `<div class="combo-total star-total"><span>★ Combiné du jour : ${starSel.length} sélections · <b>${pct(p)}</b></span><span>cote ≈ <b>${(1 / p).toFixed(1).replace('.', ',')}</b></span></div>` : ''}
    <p class="small muted">${starSel.length >= 2 ? `★ = les ${starSel.length} pistes les plus sûres. ` : ''}« Provisoire » : compos pas encore officielles.</p>
  </section>`;
}

$('#match-list').addEventListener('click', e => {
  // Filtres du classement dans une fiche de match (forme, plus / moins, domicile…)
  if (duelClick(e)) { renderMatches(); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'fold') { toggleFold(b.dataset.key); renderMatches(); return; }
  if (b.dataset.act === 'skips') { const k = b.dataset.slot; openSkips.has(k) ? openSkips.delete(k) : openSkips.add(k); renderMatches(); return; }
  if (b.dataset.act === 'copyfav') { copyFavPrompt(b); return; }
  if (b.dataset.act === 'past') { showPast = !showPast; renderMatches(); return; }
  if (b.dataset.act === 'plan-gain') { planGain = +b.dataset.v; save('plan-gain', planGain); renderMatches(); return; }
  if (b.dataset.act === 'fav') { toggleFav(b.closest('.card').dataset.id); renderMatches(); return; }
  // Combinés : retirer / remettre une sélection, combiné perso
  if (b.dataset.act === 'drop') { const c = b.dataset.combo; dropped[c] = [...new Set([...(dropped[c] || []), b.dataset.mid])]; saveDropped(); renderMatches(); return; }
  if (b.dataset.act === 'undrop') { delete dropped[b.dataset.combo]; saveDropped(); renderMatches(); return; }
  if (b.dataset.act === 'perso-del') { perso = perso.filter(x => !(x.id === b.dataset.mid && x.key === b.dataset.key)); savePerso(); renderMatches(); return; }
  if (b.dataset.act === 'perso') {
    const m = state.matches.find(x => x.id === b.closest('.card').dataset.id), a = m && state.analyses[m.id];
    if (!m || !a) return;
    // Piste précise (bouton ＋ d'une piste), sinon la meilleure piste du match, sinon la victoire du favori
    const main = a.verdict.code === 'skip' ? null : a.tips.filter(x => !String(x.key).startsWith('SC')).sort((x, y) => y.p - x.p)[0];
    const t = (b.dataset.key && a.tips.find(x => x.key === b.dataset.key)) || main
      || (a.p.home >= a.p.away ? { key: '1', label: `Victoire ${m.home.name}`, p: a.p.home } : { key: '2', label: `Victoire ${m.away.name}`, p: a.p.away });
    if (!b.dataset.key && inPerso(m.id)) { perso = perso.filter(x => x.id !== m.id); savePerso(); } else togglePerso(m, t);
    renderMatches(); return;
  }
  if (b.dataset.act === 'why') {
    const id = b.closest('.card').dataset.id, f = b.dataset.flag;
    whyOpen.get(id) === f ? whyOpen.delete(id) : whyOpen.set(id, f);
    renderMatches(); return;
  }
  const card = b.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (b.dataset.act === 'open') { opened.add(id); renderMatches(); }
  if (b.dataset.act === 'close') {
    opened.delete(id); expanded.delete(id); renderMatches();
    // On revient sur la fiche refermée, pour ne pas se retrouver loin dans la page
    const c = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
    if (c) c.scrollIntoView({ block: 'start' });
  }
  if (b.dataset.act === 'toggle') { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderMatches(); }
  if (b.dataset.act === 'hide') toggleHidden(id);
  if (b.dataset.act === 'remove' && E.removeExtra) E.removeExtra(id);
});

// --- Ajout de matchs analysés par Claude (version en ligne uniquement) ---------------
const addPanel = $('#add-panel');
if (addPanel && E.addExtras) {
  $('#btn-add').addEventListener('click', () => { addPanel.hidden = !addPanel.hidden; $('#add-msg').textContent = ''; if (!addPanel.hidden) $('#add-text').focus(); });
  $('#add-cancel').addEventListener('click', () => { addPanel.hidden = true; });
  $('#add-paste').addEventListener('click', async () => {
    try { $('#add-text').value = await navigator.clipboard.readText(); }
    catch { $('#add-msg').textContent = 'Collage automatique refusé par le téléphone : appuyez longuement dans la zone, puis « Coller ».'; }
  });
  $('#add-ok').addEventListener('click', () => {
    try {
      const n = E.addExtras($('#add-text').value);
      $('#add-text').value = '';
      addPanel.hidden = true;
      $('#add-msg').textContent = '';
      alertBanner(`${n} match${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} depuis Claude.`);
    } catch (err) { $('#add-msg').textContent = err.message; }
  });
}
function alertBanner(text) {
  const el = $('#add-done');
  if (!el) return;
  el.textContent = text; el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 5000);
}

function kickLabel(m) {
  const mins = Math.round((m.kickoff - Date.now()) / 60000);
  const time = new Date(m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const day = new Date(m.kickoff).toDateString() === new Date().toDateString() ? '' : new Date(m.kickoff).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) + ' ';
  if (m.status === 'LIVE' || ['1H', '2H', 'HT', 'ET', 'P'].includes(m.status)) return `<span class="live">● En cours</span>`;
  if (mins <= 60 && mins > 0) return `${time} · <span class="soon">dans ${mins} min</span>`;
  return `${day}${time}${mins > 0 && mins < 1440 ? ` · dans ${fmtDelay(mins)}` : ''}`;
}

const formHtml = f => f ? `<span class="form">${f.slice(-5).split('').map(c => `<i class="${c}">${{ W: 'V', D: 'N', L: 'D' }[c] || c}</i>`).join('')}</span>` : '';

function lineupChip(m) {
  const h = m.lineups && m.lineups.home, a = m.lineups && m.lineups.away;
  if (h && a && h.status === 'officielle' && a.status === 'officielle') return '<span class="chip ok">✓ Compos officielles</span>';
  const mins = (m.kickoff - Date.now()) / 60000;
  if (mins <= 40 && mins > 0) return '<span class="chip warn">⏳ Compos attendues</span>';
  return '<span class="chip">Compos probables</span>';
}

// Motifs d'absence (API-Football donne des libellés en anglais)
function reasonFr(r) {
  const s = String(r || '');
  const map = [
    [/red card/i, 'carton rouge'], [/yellow card/i, 'accumulation de cartons jaunes'], [/suspen/i, 'suspendu'],
    [/knee/i, 'genou'], [/ankle/i, 'cheville'], [/hamstring/i, 'ischio-jambiers'], [/thigh/i, 'cuisse'], [/calf/i, 'mollet'],
    [/groin/i, 'adducteurs'], [/muscle|muscular/i, 'blessure musculaire'], [/back/i, 'dos'], [/foot/i, 'pied'], [/shoulder/i, 'épaule'],
    [/concussion|head/i, 'commotion'], [/illness|sick/i, 'malade'], [/knock/i, 'coup'], [/injury/i, 'blessure'],
    [/international|national team/i, 'sélection'], [/personal|family/i, 'raison personnelle'], [/doubt|questionable/i, 'incertain'],
  ];
  const hit = map.find(([re]) => re.test(s));
  return hit ? hit[1] : s;
}
const isSuspension = r => /red card|yellow card|suspen/i.test(String(r || ''));

// Infos clés d'un match : suspensions, absents importants, buteur clé titulaire ou sur le banc
function keyInfo(m, a) {
  const out = [];
  for (const side of ['home', 'away']) {
    const team = m[side].name;
    const inj = (m.injuries && m.injuries[side]) || [];
    const pres = a.presence[side];
    // Suspendus (buteurs ou non)
    inj.filter(i => isSuspension(i.reason)).slice(0, 2)
      .forEach(i => out.push({ k: 'bad', t: `🟥 ${team} : ${i.name} suspendu (${reasonFr(i.reason)})` }));
    // Buteurs importants absents ou incertains
    pres.players.filter(p => (p.status === 'absent' || p.status === 'incertain') && p.share >= 0.15 && !inj.some(i => i.name === p.name && isSuspension(i.reason)))
      .slice(0, 2).forEach(p => out.push({ k: 'bad', t: `⚠ ${team} : ${p.name} ${p.status === 'incertain' ? 'incertain' : 'absent'} (${p.goals} buts, ${Math.round(p.share * 100)} % des buts)` }));
    // Meilleur buteur de l'équipe : titulaire confirmé, sur le banc, ou à suivre
    // (jamais un défenseur ni un gardien, même s'il a marqué sur coups de pied arrêtés)
    const star = pres.players.filter(p => p.line !== 'D' && p.line !== 'G').sort((x, y) => y.goals - x.goals)[0];
    if (star && star.goals >= 2) {
      const sc = [...a.scorers.home, ...a.scorers.away].find(s => s.name === star.name);
      const chance = sc ? ` · ${Math.round(sc.p1 * 100)} % de marquer` : '';
      if (star.status === 'titulaire') out.push({ k: 'ok', t: `✓ ${team} : ${star.name} titulaire (${star.goals} buts${chance})` });
      else if (star.status === 'remplacant') out.push({ k: 'bad', t: `⚠ ${team} : ${star.name} sur le banc (${star.goals} buts)` });
      else if (star.status === 'probable' && sc && sc.p1 >= 0.35) out.push({ k: '', t: `Buteur à suivre : ${star.name} (${team}, ${star.goals} buts${chance})` });
    }
  }
  // Turn-over (compo officielle comparée au dernier match) et fatigue (coupe d'Europe, peu de repos)
  for (const side of ['home', 'away']) {
    // Coupe : écart de niveau entre les deux équipes (une seule fois, en tête)
    if (side === 'home') { const g = levelGap(m); if (g) out.unshift({ k: g.warn ? 'bad' : '', t: g.text }); }
    const f = m.fatigue && m.fatigue[side];
    const rot = rotationText(m, a.presence[side], side);
    if (rot) out.unshift({ k: rot.level === 'bad' ? 'bad' : '', t: rot.long });
    if (f && f.rotated) { /* avait fait tourner : pas de fatigue (dit dans la lecture du match) */ }
    else if (f && f.tired) out.push({ k: 'bad', t: `😓 ${m[side].name} moins reposé : ${f.rest} jour${f.rest > 1 ? 's' : ''} de repos, ${f.gap} de moins que l'adversaire${f.euro ? ` (${f.euro.comp}${f.euro.away ? ' à l\'extérieur' : ''} ${f.lastDay})` : ''}` });

  }
  // Tireurs de penalty : affichés dès que les compos officielles sont connues
  if (m.lineups && m.lineups.home && m.lineups.home.status === 'officielle') {
    for (const side of ['home', 'away']) { const p = penInfo(m, side); if (p) out.push({ k: p.k === 'bad' ? 'bad' : '', t: p.t }); }
  }
  // Autres absents (sans détail) pour situer l'ampleur
  const known = new Set(out.map(o => o.t));
  const others = ['home', 'away'].map(s => ((m.injuries && m.injuries[s]) || []).filter(i => !isSuspension(i.reason) && ![...known].some(t => t.includes(i.name))).length);
  if (others[0] + others[1] >= 3) out.push({ k: '', t: `Autres absents : ${others[0]} côté ${m.home.name}, ${others[1]} côté ${m.away.name}` });
  return out.slice(0, 8);
}

// Encadré rouge « Attention » : ce qui doit faire réfléchir avant de jouer
function alertBoxHtml(infos) {
  const bad = infos.filter(i => i.k === 'bad');
  return bad.length ? `<div class="alert-box"><b>⚠ Attention</b><ul>${bad.map(i => `<li>${esc(i.t)}</li>`).join('')}</ul></div>` : '';
}
const goodInfosHtml = infos => {
  const good = infos.filter(i => i.k !== 'bad');
  return good.length ? `<ul class="c-infos">${good.map(i => `<li class="${i.k}">${esc(i.t)}</li>`).join('')}</ul>` : '';
};

// Étiquettes cliquables : un appui affiche l'explication juste en dessous
const whyOpen = new Map();
const FLAG_CLASS = { gap: '', tight: 'warn', goals: 'goals', closed: '', absent: 'absent', value: 'value', warn: 'warn' };
function flagsHtml(m, a, max) {
  const flags = a.verdict.flags.filter(f => !/gros absent/.test(f.t)).slice(0, max);
  const cur = whyOpen.get(m.id), open = flags.find(f => f.t === cur);
  return {
    chips: flags.map(f => `<button class="chip tap ${FLAG_CLASS[f.k] || ''}${cur === f.t ? ' on' : ''}" data-act="why" data-flag="${esc(f.t)}">${esc(f.t)} <span class="i">ⓘ</span></button>`).join(''),
    box: open ? `<div class="why-box"><b>${esc(open.t)} :</b> ${esc(open.why || '')}</div>` : '',
  };
}

// Score en direct (ESPN) et état de la meilleure piste : en bonne voie / gagnée / perdue
function liveHtml(m, t) {
  const s = state.live && state.live[m.id];
  if (!s || s.state === 'pre') return '';
  const score = `${s.h} - ${s.a}`;
  const ok = t ? tipResult(t.key, s.h, s.a) : null;
  const tipState = ok == null ? ''
    : s.state === 'post' ? (ok ? '<b class="tip-ok">✓ piste gagnée</b>' : '<b class="tip-ko">✗ piste perdue</b>')
    : (ok ? '<span class="tip-ok">✓ en bonne voie</span>' : '<span class="muted">pas encore</span>');
  return `<div class="c-live ${s.state}">
    <span>${s.state === 'in' ? `🔴 ${esc(s.clock)}` : 'Terminé'}</span><b>${score}</b>${tipState}
  </div>`;
}

// 🔄 Bandeau turn-over, bien visible : quelle équipe fait tourner, qui en profite, avec quelles conséquences
function rotBanner(m, a) {
  const f1 = x => x.toFixed(1).replace('.', ',');
  // Gros turn-over seulement (les cadres comptent plus que les remplaçants habituels) : en dessous, c'est dit dans la fiche
  const sides = ['home', 'away'].filter(sd => bigTurn(a.presence[sd].rotation));
  if (!sides.length) return '';
  if (sides.length === 2) {
    const [h, w] = sides.map(sd => a.presence[sd].rotation.changes);
    return `<div class="rot-banner"><b>🔄 Les deux équipes font tourner</b> (${h} et ${w} titulaires absents) → match plus imprévisible, prudence sur le résultat.</div>`;
  }
  const sd = sides[0], other = sd === 'home' ? 'away' : 'home', r = a.presence[sd].rotation;
  const big = keyNames(a.presence[sd], r.out.map(o => o.n));
  // L'équipe qui tourne peut rester favorite (gros écart de niveau) : on le dit tel quel
  const fav = a.p[other] >= a.p[sd] ? other : sd;
  const lam = fav === 'home' ? a.lh : a.la;
  const cons = [fav === other ? `${m[other].name} favorisé (${pct(a.p[other])} de victoire)`
    : `${m[sd].name} reste favori (${pct(a.p[sd])}) mais affaibli : ${m[other].name} ou nul ${pct(a.p[other] + a.p.draw)}`];
  if (fav === other && lam >= 1.6) cons.push(`devrait marquer beaucoup (${f1(lam)} buts attendus)`);
  else if (a.lh + a.la >= 3) cons.push(`des buts attendus (${f1(a.lh + a.la)})`);
  // Buteur de l'équipe favorite, présent et pas défenseur
  const sc = a.scorers[fav].find(p => !p.returning && p.line !== 'D' && p.line !== 'G' && p.p1 >= 0.3);
  if (sc) cons.push(`buteur : ${sc.name} (${pct(sc.p1)})`);
  const kc = r.keyOut != null && r.of > 1 ? (r.keyOut ? `, dont ${r.keyOut} cadre${r.keyOut > 1 ? 's' : ''}` : '') : '';
  return `<div class="rot-banner"><b>🔄 ${esc(m[sd].name)} fait tourner : ${r.changes} titulaires absents${esc(kc)}${big.length ? ` (${esc(big.join(', '))})` : ''}</b><br>→ ${esc(cons.join(' · '))}</div>`;
}

// Nos pronostics du match, à toucher pour les ajouter à « Mon combiné perso » (un pari par match)
function picksHtml(m, a, max) {
  const tips = a.tips.filter(t => t.key !== 'SC2').slice(0, max);
  if (!tips.length) return '';
  return `<div class="picks"><span class="picks-label">Touchez pour l'ajouter à votre combiné :</span>${tips.map(t => {
    const on = inPerso(m.id, t.key);
    return `<button class="pick${on ? ' on' : ''}" data-act="perso" data-key="${esc(t.key)}" aria-pressed="${on}">${on ? '✓' : '＋'} ${esc(t.label)} <b>${pct(t.p)}</b></button>`;
  }).join('')}</div>`;
}

// Fiche courte (par défaut) : heure, équipes, verdict, meilleure piste. Un appui ouvre la fiche complète.
function compactHtml(m) {
  const a = state.analyses[m.id], v = a.verdict;
  const t = bestTip(m);
  const time = new Date(m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  const abs = ((m.injuries && m.injuries.home) || []).length + ((m.injuries && m.injuries.away) || []).length;
  const mins = (m.kickoff - Date.now()) / 60000;
  const compos = official ? '<span class="chip ok">✓ Compos officielles</span>'
    : mins <= 45 && mins > 0 ? '<span class="chip warn">⏳ Compos attendues</span>'
    : '<span class="chip">Compos probables</span>';
  const done = isFinished(m);
  const fl = flagsHtml(m, a, 3);
  const chips = done ? '' : compos + fl.chips;
  // Fiche courte : le gros turn-over est déjà dans le bandeau ; « Attention » limité à 3 lignes (le reste dans la fiche)
  const banner = done ? '' : rotBanner(m, a);
  const infos0 = done ? [] : keyInfo(m, a).filter(i => !(banner && /^🔄/.test(i.t)));
  const infos = [...infos0.filter(i => i.k === 'bad').slice(0, 3), ...infos0.filter(i => i.k !== 'bad').slice(0, 2)];
  const favBtn = `<button class="fav-btn${favs.has(m.id) ? ' on' : ''}" data-act="fav" aria-pressed="${favs.has(m.id)}">${favs.has(m.id) ? '★ Favori' : '☆ Favori'}</button>`;
  return `<article class="card compact v-${v.code}${done ? ' is-done' : ''}${state.hidden.has(m.id) ? ' is-hidden' : ''}" data-id="${esc(m.id)}">
    <button class="compact-main" data-act="open" aria-label="Ouvrir la fiche du match">
      <span class="c-time">${time}</span>
      <span class="c-teams"><span class="c-names">${esc(m.home.name)} – ${esc(m.away.name)}</span><small>${m.comp.flag} ${esc(m.comp.name)}</small></span>
      <span class="badge ${v.code}">${esc(v.label)}</span>
    </button>
    ${liveHtml(m, t)}
    ${banner}
    ${!done && v.code !== 'skip' && a.tips.length ? '' : `<div class="c-line">${t ? `<span>${esc(t.label)} <span class="muted">· ${oddTxt(t)}</span>${t.edge > 0.06 ? ' <b class="tip-ok">bonne cote</b>' : ''}</span><b>${pct(t.p)} ${solidTxt(t)}</b>` : `<span class="muted">${v.code === 'skip' ? 'Aucune piste retenue' : 'Pas de piste solide'}</span>`}</div>`}
    ${!done ? keyPoints(m, a).slice(0, 2).map(l => `<div class="c-plan">${esc(l)}</div>`).join('') : ''}
    ${done || v.code === 'skip' ? '' : picksHtml(m, a, 4)}
    ${!done && v.reason ? `<div class="c-reason ${v.code}">${v.code === 'play' ? '✅' : v.code === 'watch' ? '⏳' : '✋'} ${esc(v.reason)}</div>` : ''}
    ${alertBoxHtml(infos)}${goodInfosHtml(infos)}
    <div class="c-chips">${chips}${favBtn}</div>
    ${done ? '' : fl.box}
  </article>`;
}

function cardHtml(m) {
  if (!opened.has(m.id)) return compactHtml(m);
  const a = state.analyses[m.id];
  const v = a.verdict;
  const o = (m.odds && m.odds.h2h) || {};
  const edge = k => { const mk = a.markets.find(x => x.key === k); return mk && mk.edge > 0.06 ? ' val' : ''; };
  const logo = t => t.logo ? `<img src="${esc(t.logo)}" alt="">` : '';
  const hidden = state.hidden.has(m.id);
  const fl = flagsHtml(m, a, 8);
  const infos = keyInfo(m, a);
  // Dans l'ordre de l'analyse : la piste phare du profil d'abord, puis les compléments et les buteurs
  const tips = [...a.tips].slice(0, 6);
  return `
  <article class="card v-${v.code}${hidden ? ' is-hidden' : ''}" data-id="${esc(m.id)}">
    <div class="card-top"><button class="link close-top" data-act="close">✕ Fermer</button></div>
    ${rotBanner(m, a)}
    <div class="card-main">
      <div>
        <div class="meta"><span>${m.comp.flag} ${esc(m.comp.name)}${m.round ? ' · ' + esc(m.round) : ''}</span><span class="kick">${kickLabel(m)}</span></div>
        <div class="teams">
          <div>${logo(m.home)}${esc(m.home.name)}${formHtml(m.form && m.form.home)}</div><div class="xg">${a.lh.toFixed(1)} buts att.</div>
          <div>${logo(m.away)}${esc(m.away.name)}${formHtml(m.form && m.form.away)}</div><div class="xg">${a.la.toFixed(1)} buts att.</div>
        </div>
        ${m.note ? `<p class="small" style="margin:8px 0 0">${esc(m.note)}</p>` : ''}
        <div class="chips">${lineupChip(m)}${fl.chips}</div>
        ${fl.box}
      </div>
      <div>
        <div class="verdict" style="color:var(--${v.code === 'play' ? 'go' : v.code === 'watch' ? 'warn' : 'skip'})">
          <span class="badge ${v.code}">${esc(v.label)}</span>
          <div class="gauge"><i style="width:${v.score}%"></i></div><span class="score-num">${v.score}/100</span>
        </div>
        ${v.reason ? `<div class="c-reason ${v.code} in-card">${esc(v.reason)}</div>` : ''}
        <div class="probs">
          <div class="h" style="flex:${a.p.home}">${pct(a.p.home)}</div>
          <div class="d" style="flex:${a.p.draw}">${pct(a.p.draw)}</div>
          <div class="a" style="flex:${a.p.away}">${pct(a.p.away)}</div>
        </div>
        <div class="odds-row"><span>Victoire ${esc(m.home.name)}</span><span>Nul</span><span>Victoire ${esc(m.away.name)}</span></div>
        ${m.odds ? `<div class="odds-row">
          <span class="${edge('1')}">1 <b>${odd(o.home)}</b></span><span class="${edge('N')}">N <b>${odd(o.draw)}</b></span><span class="${edge('2')}">2 <b>${odd(o.away)}</b></span>
        </div>` : ''}
      </div>
      <div>
        <div class="tips-title">🎯 Nos pronostics <span class="small muted">· ＋ pour l'ajouter à votre combiné</span></div>
        <ul class="tips">${tips.length ? tips.map(t => `<li class="${t.edge > 0.06 ? 'value' : ''}"><span>${esc(t.label)} <span class="muted">· ${oddTxt(t)}</span>${t.edge > 0.06 ? ' <b class="tip-ok">bonne cote</b>' : ''}<small class="why">${esc(tipWhy(t, m, a))}</small></span><b>${pct(t.p)}</b>${t.key === 'SC2' ? '' : `<button class="tip-add${inPerso(m.id, t.key) ? ' on' : ''}" data-act="perso" data-key="${esc(t.key)}" aria-label="Ajouter à mon combiné">${inPerso(m.id, t.key) ? '✓ Ajouté' : '＋ Ajouter'}</button>`}</li>`).join('') : '<li class="empty">Rien de solide sur ce match.</li>'}</ul>
      </div>
    </div>
    ${readingHtml(m, a)}
    ${(() => {
      // Ce que la lecture du match dit déjà (turn-over, écart de niveau, buteurs) n'est pas répété en dessous
      const rest = infos.filter(i => !/^(👥|🔄|🏆|😓|Buteur à suivre|✓ .* titulaire \()/.test(i.t));
      return rest.length ? `<div class="card-infos">${alertBoxHtml(rest)}${goodInfosHtml(rest)}</div>` : '';
    })()}
    ${compareHtml(m, a)}
    ${detailHtml(m, a)}
    <div class="close-sticky"><button class="btn" data-act="close">▲ Refermer la fiche</button></div>
    <div class="card-foot">
      <span><button class="link" data-act="close">▲ Réduire</button></span>
      <span>${m.source === 'claude' ? '<button class="link muted" data-act="remove">🗑 Retirer</button> ' : ''}<button class="link muted" data-act="hide">${hidden ? '👁 Réafficher ce match' : '🚫 Masquer ce match'}</button></span>
    </div>
  </article>`;
}

// Comparatif domicile / extérieur des deux équipes du match
const ord = r => r === 1 ? '1er' : r + 'e';

function compareHtml(m, a) {
  const ts = m.teamStats;
  const H = esc(m.home.name), A = esc(m.away.name);
  if (!ts || (!ts.home && !ts.away)) {
    return '<div class="compare"><p class="muted small">Pas de bilan domicile / extérieur pour ces deux équipes (championnat non suivi).</p></div>';
  }
  // Moyenne du championnat pour la case concernée
  const avgFor = (s, venue, key) => {
    if (!s || !s.avg) return null;
    const homeGoals = s.avg.avgHome, awayGoals = s.avg.avgAway;
    if (venue === 'home') return key === 'gf' ? homeGoals : awayGoals;
    return key === 'gf' ? awayGoals : homeGoals;
  };
  const perMatch = (s, venue, key) => s && s[venue] && s[venue].p ? s[venue][key] / s[venue].p : null;
  // Uniquement l'équipe qui reçoit À DOMICILE et l'équipe qui se déplace À L'EXTÉRIEUR
  const cell = (s, venue, key, rankKey) => {
    const v = perMatch(s, venue, key);
    if (v == null) return '<td class="num">–</td>';
    const avg = avgFor(s, venue, key);
    const heat = avg ? (v >= avg * 1.2 ? 'hot' : v <= avg * 0.8 ? 'cold' : '') : '';
    const r = s.ranks && s.ranks[rankKey];
    return `<td class="num"><span class="val ${heat}">${v.toFixed(2)}</span><small>${s[venue][key]} en ${s[venue].p} match${s[venue].p > 1 ? 's' : ''}${r ? ` · ${ord(r)}/${s.n}` : ''}</small></td>`;
  };
  const wins = (s, venue) => s && s[venue] && s[venue].p && s[venue].w != null
    ? `<td class="num"><span class="val">${Math.round(s[venue].w / s[venue].p * 100)} %</span><small>${s[venue].w} sur ${s[venue].p}</small></td>` : '<td class="num">–</td>';
  const H_ = ts.home, A_ = ts.away;

  const xgCell = l => `<td class="num"><span class="val">${l.toFixed(1).replace('.', ',')}</span></td>`;
  // Nombre total de buts du match (cohérent avec les paris « plus de 2,5 / 3,5 buts »)
  const maxD = Math.max(...a.goalDist.map(d => d.p));
  const dist = a.goalDist.map(d => `<div class="gd${d.p === maxD ? ' best' : ''}"><i style="height:${Math.max(3, Math.round(d.p / maxD * 56))}px"></i><b>${pct(d.p)}</b><span>${d.t} but${d.t === '0-1' ? '' : 's'}</span></div>`).join('');
  // Fiabilité : nombre de matchs et sources utilisées
  const src = a.sources || {};
  const srcList = [src.goals && 'buts réels', src.xg && 'xG', (src.market || a.marketNow) && 'cotes des bookmakers'].filter(Boolean);
  const nH = H_ && H_.home ? H_.home.p : 0, nA = A_ && A_.away ? A_.away.p : 0;
  const champ = !m.level ? '' : m.statsSource === 'championnat'
    ? ` <b>Match de coupe : chiffres du championnat de chaque équipe (${esc(m.level.home.league)} / ${esc(m.level.away.league)}), corrigés selon l'écart de niveau.</b>`
    : m.statsSource === 'mixte' ? ` <b>Match de coupe : ces chiffres de la compétition sont mélangés à 50/50 avec ceux du championnat de chaque équipe (${esc(m.level.home.league)} / ${esc(m.level.away.league)}), puis corrigés selon l'écart de niveau.</b>` : '';
  const reliab = `Basé sur ${nH} match${nH > 1 ? 's' : ''} de ${H} à domicile et ${nA} de ${A} à l'extérieur${srcList.length ? ` · sources : ${srcList.join(', ')}` : ''}.${Math.min(nH, nA) < 4 ? ' <b>Peu de matchs : chiffres encore fragiles.</b>' : ''}${champ}`;

  return `<div class="compare">
    <h4 class="sec-title">📊 Les chiffres du match</h4>
    <div class="cmp-wrap"><table class="cmp">
      <thead>
        <tr><th></th><th class="num">${H}<span class="role">à domicile</span></th><th class="num">${A}<span class="role">à l'extérieur</span></th></tr>
      </thead>
      <tbody>
        <tr><th scope="row">Buts marqués / match</th>${cell(H_, 'home', 'gf', 'homeGf')}${cell(A_, 'away', 'gf', 'awayGf')}</tr>
        <tr><th scope="row">Buts encaissés / match</th>${cell(H_, 'home', 'ga', 'homeGa')}${cell(A_, 'away', 'ga', 'awayGa')}</tr>
        <tr><th scope="row">Victoires</th>${wins(H_, 'home')}${wins(A_, 'away')}</tr>
        <tr class="xg-row"><th scope="row">Buts attendus aujourd'hui</th>${xgCell(a.lh)}${xgCell(a.la)}</tr>
      </tbody>
    </table></div>
    <div class="goal-dist"><div class="gd-title">Nombre de buts dans le match</div><div class="gd-bars">${dist}</div></div>
    <p class="cmp-legend"><span class="val hot">rouge</span> = bien au-dessus de la moyenne du championnat, <span class="val cold">bleu</span> = bien en dessous. ${reliab}</p>
  </div>`;
}

// Comportement contre les gros / moyens / faibles et 5 derniers matchs
function tierHtml(m) {
  if (!m.tierStats || !m.recent) return '';
  const label = { gros: 'Gros', moyen: 'Moyens', faible: 'Faibles' };
  const team = side => {
    const s = m.tierStats[side];
    const rows = ['gros', 'moyen', 'faible'].map(k => {
      const x = s[k];
      return `<tr class="${m.tiers && m.tiers[side === 'home' ? 'away' : 'home'] === k ? 'value' : ''}"><td>${label[k]}</td><td class="num">${x.p}</td><td class="num">${x.p ? (x.pts / x.p).toFixed(1) : '–'}</td><td class="num">${x.p ? `${(x.gf / x.p).toFixed(1)} – ${(x.ga / x.p).toFixed(1)}` : '–'}</td></tr>`;
    }).join('');
    const recent = m.recent[side].map(g => {
      const r = g.gf > g.ga ? 'V' : g.gf === g.ga ? 'N' : 'D';
      return `<li><b>${r} ${g.gf}-${g.ga}</b> vs ${esc(g.opp)} <span class="muted">(${g.tier}, ${g.venue})</span></li>`;
    }).join('');
    return `<div><b>${esc(m[side].name)}</b> <span class="muted small">(${m.tiers ? m.tiers[side] : ''})</span>
      <table><tr><th>Contre</th><th class="num">J</th><th class="num">Pts/m</th><th class="num">Buts /m</th></tr>${rows}</table>
      <ul class="recent">${recent}</ul></div>`;
  };
  return `<div class="box wide"><h4>Contre les gros, les moyens, les faibles (8 derniers matchs)</h4>
    <div class="lineups">${team('home')}${team('away')}</div>
    <p class="small muted">Ligne surlignée : le niveau de l'adversaire du jour.</p></div>`;
}

function trendHtml(m) {
  const h = m.odds && m.odds.history;
  if (!h || h.length < 2) return '';
  const f = h[0], l = h[h.length - 1];
  const arrow = (x, y) => y < x * 0.97 ? '↘' : y > x * 1.03 ? '↗' : '→';
  return `Tendance : 1 ${arrow(f.home, l.home)} · 2 ${arrow(f.away, l.away)}`;
}

// --- Analyse détaillée, écrite comme un commentaire ----------------------------------
const TIER_ONE = { gros: 'gros', moyen: 'équipe moyenne', faible: 'équipe faible' };
const TIER_MANY = { gros: 'gros', moyen: 'équipes moyennes', faible: 'équipes faibles' };
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;

// Une phrase claire sur la forme et le niveau des adversaires récents
function tierSentences(m, side) {
  const rec = (m.recent && m.recent[side]) || [];
  if (!rec.length) return [];
  const name = m[side].name;
  const by = { gros: { v: 0, n: 0, d: 0, t: 0 }, moyen: { v: 0, n: 0, d: 0, t: 0 }, faible: { v: 0, n: 0, d: 0, t: 0 } };
  rec.forEach(g => { const b = by[g.tier] || by.moyen; b.t++; b[g.gf > g.ga ? 'v' : g.gf === g.ga ? 'n' : 'd']++; });
  const parts = ['gros', 'moyen', 'faible'].filter(k => by[k].t).map(k => {
    const b = by[k];
    const res = [b.v && plural(b.v, 'victoire', 'victoires'), b.n && plural(b.n, 'nul', 'nuls'), b.d && plural(b.d, 'défaite', 'défaites')].filter(Boolean).join(', ');
    return `${b.t} ${b.t > 1 ? TIER_MANY[k] : TIER_ONE[k]} (${res})`;
  });
  const out = [`Sur ses ${rec.length} derniers matchs, ${name} a affronté ${parts.join(', ')}.`];
  const losses = rec.filter(g => g.gf < g.ga), wins = rec.filter(g => g.gf > g.ga);
  if (losses.length >= 2 && losses.every(g => g.tier === 'gros')) out.push(`Ses défaites sont toutes venues contre des gros : sa baisse de résultats est à relativiser.`);
  else if (wins.length >= 3 && wins.every(g => g.tier === 'faible')) out.push(`Ses victoires sont toutes venues contre des équipes faibles : sa bonne forme est à relativiser.`);
  else if (by.gros.t >= 3) out.push(`Calendrier récent difficile, avec ${by.gros.t} gros affrontés.`);
  // Face au niveau de l'adversaire du jour (8 derniers matchs)
  const oppTier = m.tiers && m.tiers[side === 'home' ? 'away' : 'home'];
  const s = oppTier && m.tierStats && m.tierStats[side] && m.tierStats[side][oppTier];
  if (s && s.p >= 2) {
    const ppm = s.pts / s.p;
    const verdict = ppm >= 2 ? 'à l\'aise' : ppm <= 0.8 ? 'en difficulté' : 'dans la moyenne';
    out.push(`Face aux ${TIER_MANY[oppTier]} (le niveau de ${m[side === 'home' ? 'away' : 'home'].name} aujourd'hui), ${name} est ${verdict} : ${ppm.toFixed(1)} point par match, ${(s.gf / s.p).toFixed(1)} but marqué et ${(s.ga / s.p).toFixed(1)} encaissé en moyenne sur ${s.p} matchs.`);
  }
  return out;
}

// Pourquoi une piste est proposée, en une phrase
function tipWhy(t, m, a) {
  const H = m.home.name, A = m.away.name, tot = (a.lh + a.la).toFixed(1).replace('.', ',');
  const scoreH = Math.round((1 - Math.exp(-a.lh)) * 100), scoreA = Math.round((1 - Math.exp(-a.la)) * 100);
  if (t.key === 'O35') return `${tot} buts attendus : 4 buts ou plus dans ${pct(a.goalDist[3].p)} des cas.`;
  if (t.key === 'BTTSO25') return `${H} marque dans ${pct(1 - Math.exp(-a.lh))} des cas, ${A} dans ${pct(1 - Math.exp(-a.la))}, ${tot} buts attendus.`;
  if (['1NU35', 'N2U35', '1NO15', 'N2O15'].includes(t.key)) {
    const sd = t.key.startsWith('1') ? H : A, dc = a.markets.find(x => x.key === (t.key.startsWith('1') ? '1N' : 'N2'));
    const add = t.key.endsWith('U35') ? 'au plus 3 buts dans un match fermé' : 'au moins 2 buts dans le match';
    return `On garde la protection « ${sd} ou nul » (${dc ? pct(dc.p) : ''}) et on ajoute ${add} : cote plus haute que la double chance seule.`;
  }
  if (t.homeEdge && m.level) return `Match équilibré, mais ${m.home.name} joue à domicile, vient d'un championnat plus fort (${m.level.home.league} contre ${m.level.away.league}) et sans gros turn-over : l'avantage du terrain fait pencher de son côté, le nul en sécurité (${pct(t.p)}).`;
  if (['1N', 'N2'].includes(t.key)) {
    const sd = t.key === '1N' ? 'home' : 'away', st = m.stats && m.stats[sd];
    return `${m[sd].name} ne perd que dans ${pct(1 - t.p)} des cas${st && st.p ? ` (${st.w != null ? `${st.w} victoire${st.w > 1 ? 's' : ''} sur ${st.p} ` : ''}${sd === 'home' ? 'à domicile' : 'à l\'extérieur'})` : ''} : la sécurité du nul en plus.`;
  }
  if (t.key === 'O45') return `${tot} buts attendus : vrai festival possible, 5 buts ou plus dans ${pct(t.p)} des cas.`;
  if (t.key === 'H3G') return `${H} devrait marquer environ ${a.lh.toFixed(1).replace('.', ',')} buts.`;
  if (t.key === 'A3G') return `${A} devrait marquer environ ${a.la.toFixed(1).replace('.', ',')} buts.`;
  if (['U25', 'U15'].includes(t.key)) return `Seulement ${tot} buts attendus : match fermé.`;
  if (t.key === 'NBTTS') return `${a.lh < a.la ? H : A} a du mal à marquer (${(Math.min(a.lh, a.la)).toFixed(1).replace('.', ',')} but attendu).`;
  if (t.key === 'SC' && t.hot) return `En forme : ${hotTxt(t)}.`;
  if (['O25', 'O15'].includes(t.key)) return `${tot} buts attendus : 3 buts ou plus dans ${pct(a.goalDist[2].p + a.goalDist[3].p)} des cas.`;
  if (['U25', 'U15'].includes(t.key)) return `Seulement ${tot} buts attendus : deux équipes qui marquent peu.`;
  if (t.key === 'BTTS') return `${H} marque dans ${scoreH} % des cas, ${A} dans ${scoreA} %.`;
  if (t.key === 'NBTTS') return `${scoreH < scoreA ? H : A} a du mal à marquer (${Math.min(scoreH, scoreA)} % de chances).`;
  if (t.key === 'H2G') return `${H} devrait marquer environ ${a.lh.toFixed(1).replace('.', ',')} buts.`;
  if (t.key === 'A2G') return `${A} devrait marquer environ ${a.la.toFixed(1).replace('.', ',')} buts.`;
  if (t.key === 'SCD' && t.duo) {
    const d = t.duo.map(p => `${p.name} ${pct(p.p1)}${p.status === 'titulaire' ? ' (titulaire)' : ''}`).join(' et ');
    return `Il suffit qu'un des deux marque : ${d}. Pari « buteur double chance ».`;
  }
  if (t.key === 'SC' || t.key === 'SC2') {
    const p = [...a.scorers.home, ...a.scorers.away].find(x => t.label.startsWith(x.name));
    return p ? `${p.goals} but${p.goals > 1 ? 's' : ''} cette saison pour ${p.team}${p.status === 'titulaire' ? ', titulaire confirmé' : ', compo pas encore confirmée'}.` : 'Buteur principal de son équipe.';
  }
  if (['1N', 'N2'].includes(t.key)) return `L'outsider a de quoi accrocher le nul : écart faible entre les deux équipes.`;
  // Paris sur le résultat : l'attaque de l'équipe visée contre la défense adverse, dans ce contexte domicile / extérieur
  const s = m.stats, f = x => x.toFixed(1).replace('.', ',');
  const awaySide = ['2', 'A2+', '2O25', '2BTTS', '2CS'].includes(t.key);
  if (s && s.home && s.away && s.home.p && s.away.p) {
    return awaySide
      ? `${A} marque ${f(s.away.gf / s.away.p)} but par match à l'extérieur, ${H} en encaisse ${f(s.home.ga / s.home.p)} à domicile.`
      : `${H} marque ${f(s.home.gf / s.home.p)} but par match à domicile, ${A} en encaisse ${f(s.away.ga / s.away.p)} à l'extérieur.`;
  }
  return `${H} ${pct(a.p.home)} · nul ${pct(a.p.draw)} · ${A} ${pct(a.p.away)}.`;
}

// --- Lecture du match : le profil, ce qui l'explique, et ce qu'on joue en conséquence ------------
// « Ce qui ressort » : 3 lignes à lire en 5 secondes — le rapport de force, le contexte clé, ce qu'on retient
function keyPoints(m, a) {
  const H = m.home.name, A = m.away.name, v = a.verdict;
  const lines = [];
  // 1) Le résultat, en une réponse (les chiffres restent dans « Le détail »)
  const favH = a.p.home >= a.p.away, fav = favH ? H : A, pFav = Math.max(a.p.home, a.p.away);
  const g0 = levelGap(m), lvl = g0 && g0.size !== 'faible' && (g0.gap >= 0) === favH ? `, plus de niveau (${(favH ? m.level.home : m.level.away).league})` : '';
  if (pFav >= 0.72) lines.push(`💪 ${fav} grand favori${lvl} : sa victoire est trop évidente pour être payée, on joue ce qui en découle.`);
  else if (pFav >= 0.55) lines.push(`💪 ${fav} favori${lvl}.`);
  else if (pFav >= 0.42) lines.push(`↗️ Léger avantage ${fav}, le nul reste possible.`);
  else lines.push(`⚖️ Match ouvert : ${H} ${pct(a.p.home)} · nul ${pct(a.p.draw)} · ${A} ${pct(a.p.away)}.`);
  // 2) Les buts : le profil du match
  if (v.plan) lines.push(v.plan);
  // 2) Le contexte qui peut tout changer (une seule chose, la plus importante)
  const ctx = [];
  for (const sd of ['home', 'away']) {
    const pr = a.presence[sd], fa = m.fatigue && m.fatigue[sd], name = m[sd].name;
    const rot = rotationText(m, pr, sd);
    if (rot && (bigTurn(pr.rotation) || pr.rotation.keyOut >= 2)) ctx.push([3, `${name} remaniée (${pr.rotation.changes} titulaires habituels absents)`]);
    const keyOut = pr.missing.filter(x => x.status === 'absent' && x.share >= 0.2);
    if (keyOut.length) ctx.push([3, `${name} sans ${keyOut.map(x => x.name).join(', ')}, son buteur principal`]);
    if (fa && fa.rotated && fa.rest <= 4) ctx.push([2, `${name} avait fait tourner au dernier match : équipe type fraîche`]);
    else if (fa && fa.tired) ctx.push([2, `${name} moins reposé (${fa.rest} jours de repos, ${fa.gap} de moins que l'adversaire)`]);
    const hot = pr.players.find(x => x.hot && x.status !== 'absent' && !x.returning);
    if (hot) ctx.push([1, `${hot.name} en série (${hotTxt(hot)})`]);
    const rf = m.recentForm && m.recentForm[sd];
    if (rf && rf.label && rf.text) ctx.push([['inquiétante', 'défaites logiques', 'flatteuse'].includes(rf.label) ? 3 : 2, `${name} : ${rf.text}`]);
  }
  const g = levelGap(m);
  if (g && g.size !== 'faible') ctx.push([2, g.text.replace(/^🏆\s*/, '').split(' : ')[0] + ` (${g.gap >= 0 ? H : A} au-dessus)`]);
  if (ctx.length) lines.push(`📌 ${ctx.sort((x, y) => y[0] - x[0]).slice(0, 2).map(x => x[1]).join(' · ')}.`);
  // 3) Ce qu'on retient : résultat, buts, buteur
  const pickA = k => a.tips.find(t => t.angle === k);
  const sc = a.tips.find(t => t.key === 'SC');
  const keep = [pickA('result'), pickA('goals'), sc].filter(Boolean).map(t => `${t.label.replace(' (titulaire)', '')} (${pct(t.p)})`);
  if (keep.length) lines.push(`🎯 À retenir : ${keep.join(' · ')}.`);
  return lines;
}

function readingHtml(m, a) {
  const v = a.verdict, H = m.home.name, A = m.away.name;
  const f1 = x => x.toFixed(1).replace('.', ',');
  const ordinal = r => r === 1 ? '1re' : `${r}e`;
  // En coupe, les chiffres du championnat (plus de matchs) parlent davantage que ceux de la compétition
  const s = m.domStats || m.stats, ts = m.domTeamStats || m.teamStats, champ = !!m.domStats || m.statsSource === 'championnat';

  // Les arguments de chaque équipe, dans son contexte (à domicile pour l'une, à l'extérieur pour l'autre)
  const teamArgs = sd => {
    const name = m[sd].name, other = sd === 'home' ? 'away' : 'home', venue = sd === 'home' ? 'à domicile' : 'à l\'extérieur';
    const out = [];
    const st = s && s[sd], rk = ts && ts[sd] && ts[sd].ranks;
    // Profil de jeu (attaque, défense, domicile / extérieur, style, efficacité face aux xG), sinon les chiffres bruts
    const prof = teamProfile(m, sd);
    if (prof && (prof.tags.length || prof.xgNote)) out.push(...prof.tags, ...(prof.xgNote ? [prof.xgNote] : []));
    else if (st && st.p) {
      const gfR = rk && rk[sd === 'home' ? 'homeGf' : 'awayGf'], gaR = rk && rk[sd === 'home' ? 'homeGa' : 'awayGa'];
      out.push(`${f1(st.gf / st.p)} but${st.gf / st.p >= 2 ? 's' : ''} marqué${st.gf / st.p >= 2 ? 's' : ''} et ${f1(st.ga / st.p)} encaissé${st.ga / st.p >= 2 ? 's' : ''} par match ${venue}${gfR ? ` (${ordinal(gfR)} attaque, ${ordinal(gaR)} défense ${venue})` : ''}${champ ? ' en championnat' : ''}`);
    }
    if (m.level && m.level[sd]) { const L = m.level[sd]; out.push(`${L.league}${L.rank ? `, ${ordinal(L.rank)}` : ''}`); }
    // Forme sur les 5 derniers matchs (toutes compétitions), lue à la lumière du niveau des adversaires
    const rf = m.recentForm && m.recentForm[sd];
    if (rf) out.push(`5 derniers matchs : ${rf.games.map(g => `${g.r} ${g.score} ${g.opp}`).join(', ')}${rf.text ? ` → ${rf.text}` : ''}`);
    else {
      const fm = m.form && m.form[sd];
      if (fm) out.push(`forme ${fm.slice(-5).split('').map(c => ({ W: 'V', D: 'N', L: 'D' }[c] || c)).join('')}`);
    }
    const p = m.perf && m.perf[sd];
    if (p && p.label) out.push(p.label === 'malchanceuse' ? 'domine sans être récompensée' : p.label === 'chanceuse' ? 'gagne au-dessus de son jeu' : p.label);
    // Repos, fatigue, rotation
    const fa = m.fatigue && m.fatigue[sd], pr = a.presence[sd];
    if (fa && fa.rotated && fa.rest != null && fa.rest <= 4) out.push(`😴 a joué il y a ${fa.rest} j mais avait fait tourner (${fa.rotated} titulaires au repos) : équipe type fraîche`);
    else if (fa && fa.tired) out.push(`😓 ${fa.rest} j de repos, ${fa.gap} de moins que l'adversaire${fa.euro ? ` (${fa.euro.comp} ${fa.lastDay})` : ''}`);


    else if (pr.rested && !pr.official) out.push(`😴 avait fait tourner au dernier match : équipe type attendue`);
    // Absences et compo
    const rot = rotationText(m, pr, sd);
    if (rot) out.push(rot.short.replace(`${name} `, ''));
    else {
      const keyOut = pr.missing.filter(x => x.status === 'absent' && x.share >= 0.15).map(x => x.name);
      if (keyOut.length) out.push(`⚠ sans ${keyOut.join(', ')}`);
    }
    const hot = pr.players.filter(x => x.hot && x.status !== 'absent').slice(0, 2);
    if (hot.length) out.push(`🔥 ${hot.map(x => `${x.name} (${hotTxt(x)})`).join(', ')}`);
    // Retour de longue absence : on ne le cible pas comme buteur
    const back = pr.players.filter(x => x.returning && x.status !== 'absent' && x.goals >= 2);
    if (back.length) out.push(`↩️ ${back.map(x => x.name).join(', ')} : aucune titularisation sur les 6 derniers matchs (retour de blessure ?), pas de pari buteur sur ${back.length > 1 ? 'eux' : 'lui'}`);
    return `<p><b>${esc(name)}</b> · ${esc(out.join(' · ') || 'peu de données')}</p>`;
  };

  // L'analyse en étapes : ① résultat, ② buts, ③ ce qui en découle pour monter la cote, ④ buteurs
  const line = t => `<li>${esc(t.label)} <span class="muted">· ${pct(t.p)} · ${esc(oddTxt(t))}</span> ${solidTxt(t)}<br><small class="muted">${esc(tipWhy(t, m, a))}</small></li>`;
  const step = (title, list, empty) => `<p class="step"><b>${title}</b></p>${list.length ? `<ul class="angles">${list.map(line).join('')}</ul>` : `<p class="small muted">${empty}</p>`}`;
  const by = k => a.tips.filter(t => t.angle === k);
  const scorers = a.tips.filter(t => String(t.key).startsWith('SC'));

  const kp = keyPoints(m, a);
  return `<div class="reading"><h4 class="sec-title">⚡ Ce qui ressort</h4>
    ${kp.map(l => `<p class="kp">${esc(l)}</p>`).join('')}
    <h4 class="sec-title" style="margin-top:12px">🧠 Le détail</h4>
    ${teamArgs('home')}${teamArgs('away')}
    ${(() => { const g = levelGap(m); return g ? `<p>${esc(g.text.replace(/^🏆\s*/, ''))}</p>` : ''; })()}
    ${step('① Résultat', by('result'), Math.max(a.p.home, a.p.away) >= 0.72 ? 'Victoire du favori trop évidente (cote sous 1,40) : on la joue à travers ③.' : 'Trop serré pour se prononcer sur le résultat.')}
    <p class="small muted">${esc(H)} ${pct(a.p.home)} · nul ${pct(a.p.draw)} · ${esc(A)} ${pct(a.p.away)} — ${esc(H)} ou nul ${pct(a.p.home + a.p.draw)}, ${esc(A)} ou nul ${pct(a.p.away + a.p.draw)}.</p>
    ${step(`② Buts — ${esc(v.plan || '')}`, by('goals'), 'Pas de tendance nette sur les buts.')}
    ${step('③ Pour monter la cote', by('derived'), 'Rien de solide à ajouter.')}
    ${v.profile === 'ferme' ? '<p class="step"><b>④ Buteurs</b></p><p class="small muted">Match fermé : pas de pari buteur.</p>' : step('④ Buteurs', scorers, 'Pas de buteur assez sûr.')}
  </div>`;
}

// --- Compo dessinée sur un terrain ----------------------------------------------------
// Profondeur (0 = gardien … 4 = attaque) et côté (0 = gauche … 4 = droite) d'un poste ESPN / API-Football
function posDepth(pos) {
  const p = String(pos || '').toUpperCase();
  if (p === 'G' || p === 'GK') return 0;
  if (/^(LWB|RWB|WB)/.test(p)) return 1.5;
  if (p === 'D' || /^(CD|CB|SW|LB|RB)/.test(p)) return 1;
  if (/^(DM|CDM)/.test(p)) return 2;
  if (/^(AM|CAM)/.test(p)) return 3;
  if (/^(LW|RW)$/.test(p)) return 3.5;
  if (p === 'F' || /^(CF|ST|LF|RF|F-)/.test(p)) return 4;
  return 2.5; // M, CM, LM, RM…
}
function posSide(pos) {
  const p = String(pos || '').toUpperCase();
  if (/-L$/.test(p)) return 1; if (/-R$/.test(p)) return 3;
  if (/^L/.test(p)) return 0; if (/^R/.test(p)) return 4;
  return 2;
}
// Range les 11 titulaires en lignes (formation « 4-3-3 » si connue), de la défense à l'attaque
function pitchRows(xi, formation) {
  const gk = xi.filter(p => posDepth(p.pos) === 0).slice(0, 1);
  const field = xi.filter(p => !gk.includes(p)).map((p, i) => ({ ...p, i })).sort((a, b) => posDepth(a.pos) - posDepth(b.pos) || a.i - b.i);
  const counts = String(formation || '').split('-').map(Number).filter(n => n > 0);
  let rows = [];
  if (counts.length >= 2 && counts.reduce((s, n) => s + n, 0) === field.length) {
    let k = 0; rows = counts.map(n => { const r = field.slice(k, k + n); k += n; return r; });
  } else {
    const by = new Map();
    field.forEach(p => { const d = Math.round(posDepth(p.pos)); by.set(d, [...(by.get(d) || []), p]); });
    rows = [...by.keys()].sort().map(d => by.get(d));
  }
  return [gk, ...rows].map(r => [...r].sort((a, b) => posSide(a.pos) - posSide(b.pos)));
}
const shortName = n => { const w = String(n || '').trim().split(/\s+/); return w.length > 1 && w[w.length - 1].length > 2 ? w.slice(1).join(' ') : n; };

// Équipe type (compo probable) : les 11 joueurs les plus souvent titulaires sur les derniers matchs
function usualXI(m, side) {
  // D'abord les plus titularisés de la saison (toutes compétitions), sinon les 8 derniers matchs
  const s = seasonXI(m, side);
  if (s && s.xi.length === 11) return { xi: s.xi.map(p => ({ name: p.n, pos: p.l, starts: p.starts })), of: s.games, season: true };
  const rec = m.recentXI && m.recentXI[side];
  if (!rec || rec.length < 3) return null;
  const cnt = new Map();
  rec.forEach(xi => xi.forEach(p => { const c = cnt.get(p.n) || { name: p.n, pos: p.l, starts: 0 }; c.starts++; cnt.set(p.n, c); }));
  const all = [...cnt.values()].sort((a, b) => b.starts - a.starts);
  const gk = all.find(p => p.pos === 'G');
  const xi = [gk, ...all.filter(p => p !== gk)].filter(Boolean).slice(0, 11);
  return xi.length === 11 ? { xi, of: rec.length } : null;
}

function pitchHtml(m, a, side) {
  const lu = m.lineups && m.lineups[side];
  const official = lu && lu.status === 'officielle' && lu.startXI && lu.startXI.length >= 11;
  const usual = official ? null : usualXI(m, side);
  if (!official && !usual) return `<div class="pitch-wrap"><b>${esc(m[side].name)}</b><p class="small muted">Compo pas encore connue.</p></div>`;
  // Compo sans les postes (ça arrive avec ESPN) : poste deviné d'après les derniers matchs du joueur
  const recentLine = n => { for (const x of ((m.recentXI && m.recentXI[side]) || []).flat()) if (lastName(x.n) === lastName(n) && x.l) return x.l; return ''; };
  const xi = official ? lu.startXI.map(p => (p.pos ? p : { ...p, pos: recentLine(p.name) })) : usual.xi;
  const pres = a.presence[side], rot = pres.rotation;
  const hot = n => pres.players.find(p => p.hot && lastName(p.name) === lastName(n));
  const pen = penInfo(m, side), taker = pen && pen.main ? lastName(pen.main.name) : null;
  const isNew = n => official && rot && rot.inn.some(x => lastName(x.n) === lastName(n));
  const rows = pitchRows(xi, official ? lu.formation : null).reverse();
  const chip = p => `<span class="pl${isNew(p.name) ? ' new' : ''}">${esc(shortName(p.name))}${hot(p.name) ? ' 🔥' : ''}${taker && lastName(p.name) === taker ? ' 🎯' : ''}${isNew(p.name) ? '<i>hors équipe type</i>' : ''}</span>`;
  return `<div class="pitch-wrap">
    <div class="pitch-head"><b>${esc(m[side].name)}</b><span class="small muted">${official ? `${esc(lu.formation || '')} · officielle` : usual.season ? `équipe type : les plus titularisés (${usual.of} matchs de la saison)` : `équipe type (${usual.of} derniers matchs)`}</span></div>
    <div class="pitch">${rows.map(r => `<div class="prow">${r.map(chip).join('')}</div>`).join('')}</div>
    <p class="pitch-legend">🔥 en forme · 🎯 tireur de penalty${official ? ' · en jaune : hors équipe type' : ''}</p>
    ${official && rot && rot.changes ? (() => { const big = keyNames(pres, rot.out.map(o => o.n)); return `<p class="small"><b>${rot.changes} absent${rot.changes > 1 ? 's' : ''} de l'équipe type</b>${big.length ? ` dont ${esc(big.join(', '))}` : ''}</p>`; })() : ''}
    ${official && lu.subs && lu.subs.length ? `<p class="small muted">Banc : ${esc(lu.subs.map(p => shortName(p.name)).join(', '))}</p>` : ''}
  </div>`;
}

// Poste d'un buteur : un défenseur qui a marqué 2 buts n'est pas un buteur régulier
const POS_FR = { F: 'attaquant', M: 'milieu', D: 'défenseur ⚠ pas un buteur régulier', G: 'gardien' };

// Le détail, en rubriques repliées : on n'ouvre que ce qu'on veut vérifier
function detailHtml(m, a) {
  const H = m.home.name, A = m.away.name;
  const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  const lu = official ? m.lineups.home : null;
  const time = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // Forme et niveau des adversaires
  const formH = tierSentences(m, 'home'), formA = tierSentences(m, 'away');
  const formBody = formH.length || formA.length
    ? `${formH.map(t => `<p>${esc(t)}</p>`).join('')}${formA.length ? `<hr class="soft">${formA.map(t => `<p>${esc(t)}</p>`).join('')}` : ''}`
    : '<p class="muted">Pas de données sur les derniers matchs pour cette compétition.</p>';
  const notes = (m.notes || []).length ? `<hr class="soft">${m.notes.map(t => `<p>${esc(t)}</p>`).join('')}` : '';

  // Compositions et absents
  const hm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  // Absents : le nombre, et seulement les gros noms (buteurs importants)
  const absLine = side => {
    const inj = (m.injuries && m.injuries[side]) || [];
    if (!inj.length) return '';
    const big = keyNames(a.presence[side], inj.map(i => i.name));
    return `<p class="small"><b>${esc(m[side].name)} : ${inj.length} absent${inj.length > 1 ? 's' : ''}</b>${big.length ? ` dont ${esc(big.join(', '))}` : ''}</p>`;
  };
  const composBody = `${official ? `<p class="ok-line">✓ Analyse recalculée avec les compositions officielles${lu.source ? ` (${esc(lu.source)}${lu.at ? `, ${time(lu.at)}` : ''})` : ''}.</p>` : '<p class="muted small">Pas encore officielles : l\'analyse sera recalculée automatiquement dès leur sortie (à partir d\'1 h avant).</p>'}
    ${absLine('home')}${absLine('away')}
    <p class="small muted">${m.injChecked ? `Absents vérifiés à ${hm(m.injChecked)} (API-Football), puis revérifiés 3 h et 1 h avant le match.` : 'Absents pas encore vérifiés : revérification automatique 3 h et 1 h avant le match.'} À la sortie des compos, tout titulaire habituel manquant est signalé, quel que soit son poste.</p>
    <div class="pitches">${pitchHtml(m, a, 'home')}${pitchHtml(m, a, 'away')}</div>`;

  // Buteurs et probabilités
  const scorers = [...a.scorers.home, ...a.scorers.away].sort((x, y) => y.p1 - x.p1).slice(0, 6);
  const bookLine = a.marketNow && a.modelP
    ? `<p class="small">Bookmakers : ${esc(H)} ${pct(a.marketNow.pH)}, nul ${pct(a.marketNow.pD)}, ${esc(A)} ${pct(a.marketNow.pA)}. Nos stats seules : ${pct(a.modelP.home)} / ${pct(a.modelP.draw)} / ${pct(a.modelP.away)}. Le résultat affiché mélange les deux.</p>` : '';
  const easy = a.verdict.easy && a.verdict.easy.length ? `<p class="small muted">Écartés car trop évidents : ${esc(a.verdict.easy.map(x => `${x.label} (${pct(x.p)})`).join(', '))}.</p>` : '';

  const sec = (title, body, open) => `<details class="sec"${open ? ' open' : ''}><summary>${title}</summary><div class="sec-body">${body}</div></details>`;
  const pens = ['home', 'away'].map(s => penInfo(m, s)).filter(Boolean);
  const takers = new Set(pens.filter(p => p.main).map(p => lastName(p.main.name)));
  // Penalties de chaque équipe cette saison (tirés / marqués)
  const penTeam = ['home', 'away'].map(sd => {
    const l = (m.pens && m.pens[sd]) || [];
    const att = l.reduce((s, p) => s + p.att, 0), ok = l.reduce((s, p) => s + p.ok, 0);
    return att ? `${m[sd].name} : ${att} penalt${att > 1 ? 'ies' : 'y'} tiré${att > 1 ? 's' : ''}, ${ok} marqué${ok > 1 ? 's' : ''} cette saison` : '';
  }).filter(Boolean);
  const pensHtml = (penTeam.length ? `<p class="small"><b>Penalties :</b> ${esc(penTeam.join(' · '))}</p>` : '')
    + (pens.length ? `<ul class="c-infos flat">${pens.map(p => `<li class="${p.k}">${esc(p.t)}</li>`).join('')}</ul>` : '<p class="small muted">Tireurs de penalty pas encore connus pour ces équipes.</p>');
  return `
  <div class="detail">
    ${sec('📊 Classement et forme des deux équipes', duelHtml(m), true)}
    ${sec(`👥 Compositions${official ? ' <span class="chip ok">officielles</span>' : ' <span class="chip">équipe type</span>'}`, composBody, true)}
    ${scorers.length || pens.length ? sec('⚽ Buteurs et tireurs de penalty', `${pensHtml}<ul class="play-list">${scorers.map(p => `<li><div><b>${esc(p.name)}${takers.has(lastName(p.name)) ? ' 🎯' : ''}</b><span class="muted small">${esc(p.team)}${POS_FR[p.line] ? ` · ${POS_FR[p.line]}` : ''} · ${p.goals} but${p.goals > 1 ? 's' : ''}${p.played ? ` en ${p.played} match${p.played > 1 ? 's' : ''}` : ''} · ${{ titulaire: 'titulaire ✓', remplacant: 'sur le banc', incertain: 'incertain', probable: 'compo pas encore connue' }[p.status] || ''}${p.hot ? ` · 🔥 ${hotTxt(p)}` : ''}${p.p2 >= 0.1 ? ` · doublé ${pct(p.p2)}` : ''}</span></div><b class="p">${pct(p.p1)}</b></li>`).join('')}</ul>`) : ''}
    ${sec('📈 Forme, niveau des adversaires, fatigue', formBody + notes)}
    ${sec('🔢 Autres paris jouables', `${bookLine}<p class="small muted">Seulement les paris probables (45 % et plus) qui peuvent être payés 1,40 ou plus. « Jouable dès » : la cote minimale à trouver chez votre bookmaker.</p><table><tr><th>Pari</th><th class="num">Chance</th><th class="num">Jouable dès</th></tr>${a.markets.filter(x => x.p >= 0.45 && x.p <= 0.71).sort((x, y) => y.p - x.p).slice(0, 6).map(x => `<tr><td>${esc(x.label)}${x.odd ? ` <span class="muted small">(cote ${fmtOdd(x.odd)})</span>` : ''}</td><td class="num">${pct(x.p)}</td><td class="num">${fmtOdd(needOdd(x))}</td></tr>`).join('')}</table>`)}
    ${m.h2h && m.h2h.length ? sec('🤝 Confrontations directes', `<table>${m.h2h.map(g => `<tr><td class="small muted">${new Date(g.date).toLocaleDateString('fr-FR')}</td><td>${esc(g.home)} – ${esc(g.away)}</td><td class="num"><b>${esc(g.score)}</b></td></tr>`).join('')}</table>`) : ''}
  </div>`;
}

// --- Résultats : ce qui a marché, ce qui a raté et pourquoi -----------------------
// Libellés génériques des types de paris (sans noms d'équipes)
const KEY_LABEL = {
  '1': 'Victoire à domicile', 'N': 'Match nul', '2': 'Victoire à l\'extérieur', '1N': 'Domicile ou nul', 'N2': 'Extérieur ou nul',
  O15: 'Plus de 1,5 buts', O25: 'Plus de 2,5 buts', U25: 'Moins de 2,5 buts', O35: 'Plus de 3,5 buts', U15: 'Moins de 1,5 but',
  O45: 'Plus de 4,5 buts', 'H3+': 'Domicile gagne par 3+', 'A3+': 'Extérieur gagne par 3+', H3G: 'Domicile marque 3+', A3G: 'Extérieur marque 3+', BTTSO25: 'Les deux marquent + plus de 2,5',
  BTTS: 'Les deux équipes marquent', NBTTS: 'Une équipe ne marque pas', H2G: 'Domicile marque 2+', A2G: 'Extérieur marque 2+',
  'H2+': 'Domicile gagne par 2+', 'A2+': 'Extérieur gagne par 2+', '1O25': 'Domicile gagne + plus de 2,5', '2O25': 'Extérieur gagne + plus de 2,5',
  '1BTTS': 'Domicile gagne + les deux marquent', '2BTTS': 'Extérieur gagne + les deux marquent', '1CS': 'Domicile gagne sans encaisser', '2CS': 'Extérieur gagne sans encaisser',
};

function renderResults() {
  const el = $('#results');
  if (!el) return;
  const b = state.bilan;
  if (!b || !(b.days || []).length) {
    el.innerHTML = '<div class="empty-state">Pas encore de résultats. Chaque matin, le robot vérifie les pistes de la veille avec les vrais scores : le premier bilan apparaîtra demain.</div>';
    return;
  }
  const all = b.days.flatMap(d => d.matches.flatMap(m => m.picks));
  const ok = all.filter(p => p.ok).length;
  const top = state.bilanTop || { n: 0, ok: 0 };
  const rates = Object.entries(state.bilanRates || {}).sort((x, y) => y[1].n - x[1].n);
  const byComp = {};
  b.days.forEach(d => d.matches.forEach(m => m.picks.forEach(p => { const c = byComp[m.comp] = byComp[m.comp] || { n: 0, ok: 0 }; c.n++; if (p.ok) c.ok++; })));
  const rateCell = (o, n) => `<td class="num">${n}</td><td class="num"><b class="${o / n >= 0.55 ? 'good' : o / n < 0.45 ? 'bad' : ''}">${pct(o / n)}</b></td>`;
  // Paris buteur (suivis à part depuis le 20/10)
  const scAll = b.days.flatMap(d => d.matches.flatMap(m => m.scorerPicks || []));
  const scOk = scAll.filter(p => p.ok).length, scDuo = scAll.filter(p => p.key === 'SCD');
  // Causes des échecs (classées par le robot depuis le 20/10)
  const CAUSE = { rouge: ['🟥', 'carton rouge'], compo: ['👥', 'compo'], malchance: ['🍀', 'malchance'], stats: ['📊', 'erreur de stats'] };
  const causes = {};
  b.days.forEach(d => d.matches.forEach(m => { if (m.cause) causes[m.cause] = (causes[m.cause] || 0) + 1; }));
  const causeHtml = Object.keys(causes).length ? `<div class="box wide"><h4>Pourquoi les pistes ont raté</h4>
    <p>${Object.entries(CAUSE).filter(([k]) => causes[k]).map(([k, [i, l]]) => `${i} <b>${causes[k]}</b> ${l}`).join(' · ')}</p>
    <p class="small muted">Seules les vraies erreurs de stats corrigent la mémoire du robot. Un carton rouge, une compo inconnue ou un match dominé sans réussite ne sont pas des erreurs d'analyse.</p></div>` : '';
  el.innerHTML = `
    <div class="summary">
      <div class="stat"><b>${pct(ok / all.length)}</b><span>pistes réussies (${ok}/${all.length})</span></div>
      <div class="stat"><b>${top.n ? pct(top.ok / top.n) : '–'}</b><span>réussite du top du jour${top.n ? ` (${top.ok}/${top.n})` : ''}</span></div>
      <div class="stat"><b>${b.days.length}</b><span>jour${b.days.length > 1 ? 's' : ''} suivis</span></div>
      ${scAll.length ? `<div class="stat"><b>${pct(scOk / scAll.length)}</b><span>paris buteur réussis (${scOk}/${scAll.length})${scDuo.length ? ` · dont double chance ${scDuo.filter(p => p.ok).length}/${scDuo.length}` : ''}</span></div>` : ''}
    </div>
    ${causeHtml}
    <div class="rank-grid">
      <div class="box"><h4>Par type de pari</h4><table><tr><th>Pari</th><th class="num">Joués</th><th class="num">Réussite</th></tr>
        ${rates.map(([k, x]) => `<tr><td>${esc(KEY_LABEL[k] || k)}</td>${rateCell(x.ok, x.n)}</tr>`).join('')}</table>
        <p class="small muted">Un type de pari qui réussit moins de 45 % du temps (sur au moins 10 essais) est retiré du top du jour.</p></div>
      <div class="box"><h4>Par compétition</h4><table><tr><th>Compétition</th><th class="num">Joués</th><th class="num">Réussite</th></tr>
        ${Object.entries(byComp).sort((x, y) => y[1].n - x[1].n).map(([c, x]) => `<tr><td>${esc(c)}</td>${rateCell(x.ok, x.n)}</tr>`).join('')}</table></div>
    </div>
    ${b.days.slice(0, 7).map(d => `<div class="box day"><h4>${new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
      ${d.matches.map(m => `<div class="res-match"><div><b>${esc(m.home)} ${esc(m.score)} ${esc(m.away)}</b> <span class="muted small">${esc(m.comp)} · attendu ${esc(m.exp)}${m.top ? ' · TOP' : ''}</span>${m.cause && CAUSE[m.cause] ? ` <span class="chip">${CAUSE[m.cause][0]} ${CAUSE[m.cause][1]}</span>` : ''}</div>
        <ul>${m.picks.map(p => `<li class="${p.ok ? 'ok' : 'ko'}">${p.ok ? '✓' : '✗'} ${esc(p.label)} <span class="muted">(${pct(p.p)})</span>${p.why ? `<div class="small muted">Pourquoi : ${esc(p.why)}</div>` : ''}</li>`).join('')}${(m.scorerPicks || []).map(p => `<li class="${p.ok ? 'ok' : 'ko'}">${p.ok ? '✓' : '✗'} ⚽ ${esc(p.label)} <span class="muted">(${pct(p.p)})</span></li>`).join('')}</ul>${m.scorers && m.scorers.length ? `<div class="small muted">Buteurs : ${esc(m.scorers.join(', '))}</div>` : ''}</div>`).join('')}
    </div>`).join('')}
    <p class="small muted">Le robot retient, pour chaque équipe, l'écart entre les buts attendus et les buts réels sur ses 10 derniers matchs suivis, et corrige ses prochaines analyses (±15 % au maximum).</p>`;
}

// --- Alertes ------------------------------------------------------------------
function renderAlerts() {
  $('#alert-list').innerHTML = state.alerts.length ? state.alerts.map(a => `
    <div class="alert ${a.level}" data-match="${esc(a.matchId)}">
      <span class="t">${new Date(a.t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      <b>${a.level === 'go' ? '🟢 ' : a.level === 'warn' ? '⚠️ ' : ''}${esc(a.title)}</b>${esc(a.body)}
    </div>`).join('') : '<div class="empty-state">Aucune alerte pour le moment. Elles apparaissent 1 h avant chaque match puis à la publication des compositions.</div>';
}
$('#alert-list').addEventListener('click', e => {
  const el = e.target.closest('[data-match]');
  if (!el) return;
  expanded.add(el.dataset.match);
  showTab('matches');
  const card = document.querySelector(`.card[data-id="${CSS.escape(el.dataset.match)}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

// --- Paramètres ---------------------------------------------------------------
function renderSettings() {
  const s = state.settings;
  const countries = [...new Set(COMPETITIONS.map(c => c.country))];
  $('#view-settings').innerHTML = `
  <div class="settings">
    <div class="box">
      <h4>Source des données</h4>
      <div class="row">
        <label class="check"><input type="radio" name="mode" value="demo" ${s.mode !== 'live' ? 'checked' : ''}> Démo (données inventées)</label>
        <label class="check"><input type="radio" name="mode" value="live" ${s.mode === 'live' ? 'checked' : ''}> Données réelles</label>
      </div>
    </div>
    <div class="box">
      <h4>Clés API</h4>
      <label class="field">Clé API-Football (matchs, compositions, blessés, classements, buteurs)
        <input type="password" id="s-af" value="${esc(s.afKey)}" placeholder="Créez un compte sur dashboard.api-football.com" autocomplete="off"></label>
      <label class="field">Clé The Odds API (cotes Unibet et autres bookmakers)
        <input type="password" id="s-odds" value="${esc(s.oddsKey)}" placeholder="Créez un compte sur the-odds-api.com" autocomplete="off"></label>
      <div class="row"><button class="btn ghost" id="s-test">Tester les clés</button><span class="test-out" id="s-test-out"></span></div>
      <p class="small muted">Les clés restent sur votre ordinateur. Offre gratuite API-Football : 100 requêtes par jour, suffisant pour quelques championnats. Pour suivre toutes les compétitions en continu, prévoyez l'offre payante (environ 20 € par mois).</p>
    </div>
    <div class="box">
      <h4>Compétitions suivies</h4>
      <div class="row" style="margin-bottom:8px"><button class="btn ghost small" id="s-all">Tout cocher</button><button class="btn ghost small" id="s-none">Tout décocher</button></div>
      ${countries.map(ct => `<p class="small muted" style="margin:8px 0 4px"><b>${esc(ct)}</b></p><div class="comp-grid">
        ${COMPETITIONS.filter(c => c.country === ct).map(c => `<label><input type="checkbox" class="s-comp" value="${c.af}" ${s.comps.includes(c.af) ? 'checked' : ''}> ${c.flag} ${esc(c.name)}</label>`).join('')}</div>`).join('')}
    </div>
    <div class="row"><button class="btn" id="s-save">Enregistrer et recharger</button><span class="muted small" id="s-msg"></span></div>
  </div>`;
  $('#s-all').onclick = () => document.querySelectorAll('.s-comp').forEach(c => { c.checked = true; });
  $('#s-none').onclick = () => document.querySelectorAll('.s-comp').forEach(c => { c.checked = false; });
  $('#s-test').onclick = async () => {
    $('#s-test-out').textContent = 'Test en cours…';
    const r = await testKeys($('#s-af').value.trim(), $('#s-odds').value.trim());
    $('#s-test-out').textContent = [r.af && 'API-Football : ' + r.af, r.odds && 'Cotes : ' + r.odds].filter(Boolean).join('\n') || 'Saisissez au moins une clé.';
  };
  $('#s-save').onclick = async () => {
    const mode = document.querySelector('input[name=mode]:checked').value;
    const afKey = $('#s-af').value.trim();
    if (mode === 'live' && !afKey) { $('#s-msg').textContent = 'La clé API-Football est nécessaire pour les données réelles.'; return; }
    saveSettings({ mode, afKey, oddsKey: $('#s-odds').value.trim(), comps: [...document.querySelectorAll('.s-comp:checked')].map(c => +c.value) });
    $('#s-msg').textContent = 'Enregistré.';
    showTab('matches');
    await start();
  };
}

onChange(render);
setInterval(() => { if (tab === 'matches') renderMatches(); }, 30000);
start();
