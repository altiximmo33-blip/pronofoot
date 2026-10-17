import { COMPETITIONS } from './config.js';
import * as E from './engine.js';
const { state, onChange, start, loadAll, toggleHidden, clearAlerts, saveSettings, testKeys } = E;
import { load, save } from './store.js';
import { topPicks } from './core.js';

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = p => `${Math.round(p * 100)} %`;
const odd = o => o ? o.toFixed(2) : '–';
const expanded = new Set();   // analyse complète ouverte
const opened = new Set();     // fiche complète ouverte (sinon fiche courte)
const openSkips = new Set();  // créneaux dont les matchs sans intérêt sont dépliés
let tab = 'matches';
let seenAlerts = load('seenAlerts', 0);

// --- Navigation ---------------------------------------------------------------
function showTab(t) {
  tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== 'view-' + t; });
  if (t === 'settings') renderSettings();
  if (t === 'alerts') { seenAlerts = state.alerts.length ? state.alerts[0].t : 0; save('seenAlerts', seenAlerts); }
  render();
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });
document.addEventListener('click', e => {
  const g = e.target.closest('[data-goto]');
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

// --- Filtres ------------------------------------------------------------------
['#f-search', '#f-comp', '#f-verdict', '#f-sort', '#f-hidden'].forEach(s => $(s).addEventListener('input', renderMatches));
$('#btn-refresh').addEventListener('click', () => loadAll());
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
  const live = s.mode === 'live' && s.afKey;
  $('#demo-banner').hidden = !!live && !state.bannerHtml;
  if (state.bannerHtml) {
    $('#demo-banner').innerHTML = state.bannerHtml;
  }
  $('#error').hidden = !state.error;
  $('#error').textContent = state.error ? 'Erreur de chargement : ' + state.error : '';
  const next = state.kind === 'auto' ? 'compos cherchées toutes les 5 min, de 45 à 20 min avant chaque match' : nextCheck();
  $('#status').innerHTML = [
    state.kind === 'auto' ? '<span class="pill live">● Robot automatique</span>' : live ? '<span class="pill live">● Données réelles</span>' : state.kind === 'today' ? '<span class="pill live">● Matchs réels du jour</span>' : '<span class="pill demo">● Mode démo</span>',
    state.loading ? '<span>Chargement…</span>' : state.lastUpdate ? `<span>Mis à jour à ${new Date(state.lastUpdate).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>` : '',
    next ? `<span>Prochaine vérification : ${esc(next)}</span>` : '',
    state.quota.af != null ? `<span>API-Football : ${state.quota.af} requêtes restantes</span>` : '',
    state.quota.odds != null ? `<span>Cotes : ${state.quota.odds} crédits</span>` : '',
  ].join('');
  $('#btn-notify').textContent = s.notify && window.Notification && Notification.permission === 'granted' ? '🔔 Notifications activées' : '🔕 Activer les notifications';

  const unread = state.alerts.filter(a => a.t > seenAlerts).length;
  $('#c-alerts').textContent = tab === 'alerts' ? '' : (unread || '');
  if (tab === 'alerts') { seenAlerts = state.alerts.length ? state.alerts[0].t : seenAlerts; save('seenAlerts', seenAlerts); }

  fillCompFilter();
  renderMatches();
  renderAlerts();
  renderResults();
}

function nextCheck() {
  const now = Date.now();
  let best = null;
  state.matches.filter(m => m.status === 'NS').forEach(m => {
    const ph = state.phase[m.id] || {};
    const off = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
    const cands = [];
    if (!ph.trend) cands.push([m.kickoff - 60 * 60000, 'tendances']);
    if (!off) cands.push([Math.max(m.kickoff - 40 * 60000, (ph.lineupTry || 0) + 5 * 60000), 'compositions']);
    cands.forEach(([t, what]) => { if (!best || t < best[0]) best = [Math.max(t, now), what, m]; });
  });
  if (!best) return '';
  const mins = Math.round((best[0] - now) / 60000);
  return `${best[1]} ${best[2].home.name}–${best[2].away.name} ${mins <= 1 ? 'dans 1 min' : `dans ${fmtDelay(mins)}`}`;
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
function renderMatches() {
  const q = $('#f-search').value.trim().toLowerCase();
  const comp = $('#f-comp').value, verdict = $('#f-verdict').value, sort = $('#f-sort').value, showHidden = $('#f-hidden').checked;
  const all = state.matches.filter(m => m.status !== 'FT');
  const hiddenCount = all.filter(m => state.hidden.has(m.id)).length;
  $('#c-hidden').textContent = hiddenCount ? `(${hiddenCount})` : '';

  let list = all.filter(m => {
    const a = state.analyses[m.id];
    if (!a) return false;
    if (!showHidden && state.hidden.has(m.id)) return false;
    if (comp && String(m.comp.af) !== comp) return false;
    if (verdict && a.verdict.code !== verdict) return false;
    if (q && !(`${m.home.name} ${m.away.name} ${m.comp.name}`.toLowerCase().includes(q))) return false;
    return true;
  });
  list.sort(sort === 'score'
    ? (x, y) => state.analyses[y.id].verdict.score - state.analyses[x.id].verdict.score
    : (x, y) => x.kickoff - y.kickoff);

  const visible = all.filter(m => !state.hidden.has(m.id));
  const n = c => visible.filter(m => state.analyses[m.id] && state.analyses[m.id].verdict.code === c).length;
  const lineupsDone = visible.filter(m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle').length;
  $('#c-matches').textContent = visible.length || '';
  $('#summary').innerHTML = `
    <div class="stat"><b>${visible.length}</b><span>matchs suivis</span></div>
    <div class="stat"><b style="color:var(--go)">${n('play')}</b><span>intéressants</span></div>
    <div class="stat"><b style="color:var(--warn)">${n('watch')}</b><span>à surveiller</span></div>
    <div class="stat"><b style="color:var(--skip)">${n('skip')}</b><span>sans intérêt (évidents ou imprévisibles)</span></div>
    <div class="stat"><b>${lineupsDone}</b><span>compos officielles</span></div>`;

  if (!list.length) {
    $('#match-list').innerHTML = `<div class="empty-state">${state.loading ? 'Chargement des matchs…' : 'Aucun match ne correspond.'}</div>`;
    return;
  }
  const top = (!q && !comp && !verdict) ? topHtml(all.filter(m => !state.hidden.has(m.id))) : '';
  if (sort !== 'slot') { $('#match-list').innerHTML = top + list.map(cardHtml).join(''); return; }
  $('#match-list').innerHTML = top + groupSlots(list).map(slotHtml).join('');
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
  return a.tips.filter(t => t.key !== 'SC2').sort((x, y) => y.p - x.p)[0] || null;
}

function slotHtml(slot) {
  const time = new Date(slot.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const ranked = slot.matches.map(m => ({ m, t: bestTip(m) }))
    .sort((x, y) => (y.t ? y.t.p : -1) - (x.t ? x.t.p : -1));
  const picks = ranked.filter(x => x.t);
  const main = ranked.filter(x => state.analyses[x.m.id].verdict.code !== 'skip');
  const skipped = ranked.filter(x => state.analyses[x.m.id].verdict.code === 'skip');
  const showSkips = openSkips.has(String(slot.start));
  const combo = k => {
    const sel = picks.slice(0, k);
    if (sel.length < k) return '';
    const p = sel.reduce((acc, x) => acc * x.t.p, 1);
    return `<li><b>${k === 2 ? 'Prudent' : 'Ambitieux'} (${pct(p)})</b> : ${sel.map(x => `${esc(x.m.home.name)}–${esc(x.m.away.name)} → ${esc(x.t.label)}`).join(' + ')}</li>`;
  };
  const official = slot.matches.filter(m => m.lineups && m.lineups.home && m.lineups.home.status === 'officielle').length;
  return `<section class="slot">
    <div class="slot-head">
      <h2>Créneau ${time}</h2>
      <span class="muted small">${slot.matches.length} match${slot.matches.length > 1 ? 's' : ''} · compos officielles ${official}/${slot.matches.length}</span>
    </div>
    ${picks.length >= 2 ? `<div class="slot-summary"><div><div class="tips-title">Combinés du créneau (probabilité = produit des pistes)</div><ul class="slot-combos">${combo(2)}${combo(3)}</ul></div></div>` : ''}
    ${!picks.length ? '<p class="small muted">Aucune piste non évidente dans ce créneau.</p>' : ''}
    <div class="match-list">${main.map(x => cardHtml(x.m)).join('')}</div>
    ${skipped.length ? `<button class="link muted skip-toggle" data-act="skips" data-slot="${slot.start}">${showSkips ? '▲ Replier' : '▼ Voir'} les ${skipped.length} match${skipped.length > 1 ? 's' : ''} sans intérêt (évidents, imprévisibles ou sans statistiques)</button>
      ${showSkips ? `<div class="match-list">${skipped.map(x => cardHtml(x.m)).join('')}</div>` : ''}` : ''}
  </section>`;
}

// Top du jour : uniquement les pistes jugées fiables (le nombre varie, parfois aucune)
function topHtml(list) {
  const top = topPicks(list, state.analyses, state.bilanRates || {});
  const rate = state.bilanTop;
  const head = `<div class="top-head"><h2>Top du jour</h2>${rate && rate.n ? `<span class="small muted">Réussite du top sur les jours passés : <b>${pct(rate.ok / rate.n)}</b> (${rate.ok}/${rate.n})</span>` : ''}</div>`;
  if (!top.length) {
    return `<section class="topday">${head}<p class="small muted">Aucune piste assez fiable pour l'instant. Le top se remplit quand les statistiques sont solides et que les compositions sont connues.</p></section>`;
  }
  return `<section class="topday">${head}
    <ol class="top-list">${top.map(x => {
      const time = new Date(x.m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const why = (state.analyses[x.m.id].verdict.flags || []).slice(0, 2).map(f => f.t).join(' · ');
      return `<li><button class="top-item" data-open="${esc(x.m.id)}">
        <span class="c-time">${time}</span>
        <span class="c-teams"><b>${esc(x.m.home.name)} – ${esc(x.m.away.name)}</b><small>${esc(x.tip.label)}${why ? ' · ' + esc(why) : ''}</small></span>
        <span class="top-p"><b>${pct(x.tip.p)}</b><small>${x.official ? '✓ compos' : 'provisoire'}</small></span>
      </button></li>`;
    }).join('')}</ol>
    <p class="small muted">« Provisoire » : en attente des compositions officielles, qui peuvent changer la piste.</p>
  </section>`;
}

$('#match-list').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'skips') { const k = b.dataset.slot; openSkips.has(k) ? openSkips.delete(k) : openSkips.add(k); renderMatches(); return; }
  const card = b.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  if (b.dataset.act === 'open') { opened.add(id); renderMatches(); }
  if (b.dataset.act === 'close') { opened.delete(id); expanded.delete(id); renderMatches(); }
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

// Fiche courte (par défaut) : heure, équipes, verdict, meilleure piste. Un appui ouvre la fiche complète.
function compactHtml(m) {
  const a = state.analyses[m.id], v = a.verdict;
  const t = bestTip(m);
  const time = new Date(m.kickoff).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const official = m.lineups && m.lineups.home && m.lineups.home.status === 'officielle';
  const abs = ((m.injuries && m.injuries.home) || []).length + ((m.injuries && m.injuries.away) || []).length;
  const chips = [
    official ? '<span class="chip ok">✓ Compos</span>' : '',
    ...v.flags.slice(0, 2).map(f => `<span class="chip">${esc(f.t)}</span>`),
    abs ? `<span class="chip">${abs} absent${abs > 1 ? 's' : ''}</span>` : '',
    m.source === 'claude' ? '<span class="chip">via Claude</span>' : '',
  ].join('');
  return `<article class="card compact v-${v.code}${state.hidden.has(m.id) ? ' is-hidden' : ''}" data-id="${esc(m.id)}">
    <button class="compact-main" data-act="open" aria-label="Ouvrir la fiche du match">
      <span class="c-time">${time}</span>
      <span class="c-teams"><span class="c-names">${esc(m.home.name)} – ${esc(m.away.name)}</span><small>${m.comp.flag} ${esc(m.comp.name)}</small></span>
      <span class="badge ${v.code}">${esc(v.label)}</span>
    </button>
    <div class="c-line">${t ? `<span>${esc(t.label)}</span><b>${pct(t.p)}</b>` : `<span class="muted">${v.code === 'skip' ? 'Aucune piste retenue' : 'Pas de piste solide'}</span>`}</div>
    ${chips ? `<div class="c-chips">${chips}</div>` : ''}
  </article>`;
}

function cardHtml(m) {
  if (!opened.has(m.id)) return compactHtml(m);
  const a = state.analyses[m.id];
  const v = a.verdict;
  const o = (m.odds && m.odds.h2h) || {};
  const edge = k => { const mk = a.markets.find(x => x.key === k); return mk && mk.edge > 0.06 ? ' val' : ''; };
  const logo = t => t.logo ? `<img src="${esc(t.logo)}" alt="">` : '';
  const flagClass = { gap: '', tight: 'warn', goals: 'goals', closed: '', absent: 'absent', value: 'value' };
  const isOpen = expanded.has(m.id);
  const hidden = state.hidden.has(m.id);
  return `
  <article class="card v-${v.code}${hidden ? ' is-hidden' : ''}" data-id="${esc(m.id)}">
    <div class="card-main">
      <div>
        <div class="meta"><span>${m.comp.flag} ${esc(m.comp.name)}${m.round ? ' · ' + esc(m.round) : ''}</span><span class="kick">${kickLabel(m)}</span></div>
        <div class="teams">
          <div>${logo(m.home)}${esc(m.home.name)}${formHtml(m.form && m.form.home)}</div><div class="xg">${a.lh.toFixed(1)} buts att.</div>
          <div>${logo(m.away)}${esc(m.away.name)}${formHtml(m.form && m.form.away)}</div><div class="xg">${a.la.toFixed(1)} buts att.</div>
        </div>
        ${m.note ? `<p class="small" style="margin:8px 0 0">${esc(m.note)}</p>` : ''}
        <div class="chips">${lineupChip(m)}${v.flags.map(f => `<span class="chip ${flagClass[f.k]}">${esc(f.t)}</span>`).join('')}</div>
      </div>
      <div>
        <div class="verdict" style="color:var(--${v.code === 'play' ? 'go' : v.code === 'watch' ? 'warn' : 'skip'})">
          <span class="badge ${v.code}">${esc(v.label)}</span>
          <div class="gauge"><i style="width:${v.score}%"></i></div><span class="score-num">${v.score}/100</span>
        </div>
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
        <div class="tips-title">Pistes</div>
        <ul class="tips">${a.tips.length ? [...a.tips].sort((x, y) => y.p - x.p).slice(0, 4).map(t => `<li class="${t.edge > 0.06 ? 'value' : ''}"><span>${esc(t.label)}</span><b>${pct(t.p)}${t.odd ? ` · ${odd(t.odd)}` : ''}</b></li>`).join('') : '<li class="empty">Rien de solide sur ce match.</li>'}</ul>
      </div>
    </div>
    ${compareHtml(m, a)}
    <div class="card-foot">
      <span><button class="link" data-act="toggle">${isOpen ? 'Masquer l\'analyse ▲' : 'Analyse complète ▼'}</button> <button class="link muted" data-act="close">Réduire</button></span>
      <span>${m.source === 'claude' ? '<button class="link muted" data-act="remove">🗑 Retirer</button> ' : ''}<button class="link muted" data-act="hide">${hidden ? '👁 Réafficher ce match' : '🚫 Masquer ce match'}</button></span>
    </div>
    ${isOpen ? detailHtml(m, a) : ''}
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

  // Les deux duels qui comptent pour CE match
  const duel = (att, attS, attVenue, def, defS, defVenue, lambda) => {
    const x = perMatch(attS, attVenue, 'gf'), y = perMatch(defS, defVenue, 'ga');
    let tag = ['mid', 'autour d\'1 but'];
    if (lambda >= 1.7) tag = ['hot', 'devrait marquer'];
    else if (lambda >= 1.3) tag = ['warm', 'bonnes chances de marquer'];
    else if (lambda <= 0.9) tag = ['cold', 'aura du mal à marquer'];
    const facts = [
      x != null ? `${att} marque <b>${x.toFixed(2)}</b>/match ${attVenue === 'home' ? 'à domicile' : 'à l\'extérieur'}` : '',
      y != null ? `${def} encaisse <b>${y.toFixed(2)}</b>/match ${defVenue === 'home' ? 'à domicile' : 'à l\'extérieur'}` : '',
    ].filter(Boolean).join(' · ');
    return `<div class="duel"><span class="duel-tag ${tag[0]}">${att} ${tag[1]}</span><span class="duel-facts">${facts}</span><span class="duel-xg">${lambda.toFixed(1)} but${lambda >= 2 ? 's' : ''} att.</span></div>`;
  };
  const total = a.lh + a.la;
  const o25 = a.markets.find(x => x.key === 'O25').p;
  const totalTag = o25 >= 0.6 ? ['hot', 'Match à buts'] : o25 <= 0.4 ? ['cold', 'Match fermé'] : ['mid', 'Nombre de buts incertain'];

  return `<div class="compare">
    <div class="cmp-wrap"><table class="cmp">
      <thead>
        <tr><th></th><th class="num">${H}<span class="role">à domicile</span></th><th class="num">${A}<span class="role">à l'extérieur</span></th></tr>
      </thead>
      <tbody>
        <tr><th scope="row">Buts marqués / match</th>${cell(H_, 'home', 'gf', 'homeGf')}${cell(A_, 'away', 'gf', 'awayGf')}</tr>
        <tr><th scope="row">Buts encaissés / match</th>${cell(H_, 'home', 'ga', 'homeGa')}${cell(A_, 'away', 'ga', 'awayGa')}</tr>
        <tr><th scope="row">Victoires</th>${wins(H_, 'home')}${wins(A_, 'away')}</tr>
      </tbody>
    </table></div>
    <div class="duels">
      ${duel(H, ts.home, 'home', A, ts.away, 'away', a.lh)}
      ${duel(A, ts.away, 'away', H, ts.home, 'home', a.la)}
      <div class="duel total"><span class="duel-tag ${totalTag[0]}">${totalTag[1]}</span><span class="duel-facts">Plus de 2,5 buts : <b>${pct(o25)}</b> · les deux marquent : <b>${pct(a.markets.find(x => x.key === 'BTTS').p)}</b></span><span class="duel-xg">${total.toFixed(1)} buts att.</span></div>
    </div>
    <p class="cmp-legend">Seuls comptent ${H} à domicile et ${A} à l'extérieur. <span class="val hot">rouge</span> = bien au-dessus de la moyenne du championnat, <span class="val cold">bleu</span> = bien en dessous. Le rang est celui de l'équipe dans son championnat.</p>
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

function detailHtml(m, a) {
  const stLabel = { titulaire: 'Titulaire', probable: 'Probable', incertain: 'Incertain', remplacant: 'Remplaçant', absent: 'Absent' };
  const scorers = [...a.scorers.home, ...a.scorers.away].sort((x, y) => y.p1 - x.p1);
  const absences = side => {
    const p = a.presence[side];
    const rows = [...p.missing.map(x => ({ name: x.name, why: x.reason || stLabel[x.status], st: x.status, imp: `${x.goals} buts (${pct(x.share)})` })),
      ...p.otherOut.map(x => ({ name: x.name, why: x.reason || 'Absent', st: 'absent', imp: '' }))];
    return rows.length ? rows.map(r => `<tr><td>${esc(r.name)}</td><td><span class="st ${r.st}">${esc(stLabel[r.st])}</span></td><td class="small muted">${esc(r.why)}</td><td class="num small">${esc(r.imp)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">Aucune absence signalée</td></tr>';
  };
  const lineup = side => {
    const lu = m.lineups && m.lineups[side];
    const team = m[side];
    if (!lu || !lu.startXI) return `<div><b>${esc(team.name)}</b><p class="muted small">Pas encore disponible.</p></div>`;
    const pool = (m.scorers && m.scorers[side]) || [];
    const inj = (m.injuries && m.injuries[side]) || [];
    const isStar = p => pool.slice(0, 2).some(s => s.name === p.name || (s.id && s.id === p.id));
    const isOut = p => lu.status !== 'officielle' && inj.some(i => i.name === p.name || (i.id && i.id === p.id));
    return `<div><b>${esc(team.name)}</b> <span class="muted small">${esc(lu.formation || '')} · ${lu.status === 'officielle' ? 'officielle' : 'probable'}</span>
      <ol>${lu.startXI.map(p => `<li class="${isStar(p) ? 'star' : ''} ${isOut(p) ? 'out' : ''}"><span class="pos">${esc(p.pos || '')}</span>${esc(p.name)}${isStar(p) ? ' ⭐' : ''}</li>`).join('')}</ol>
      ${lu.subs && lu.subs.length ? `<p class="small muted">Banc : ${lu.subs.map(p => esc(p.name)).join(', ')}</p>` : ''}</div>`;
  };
  const hist = (m.odds && m.odds.history) || [];
  return `
  <div class="detail">
    <div class="box wide analysis"><h4>Analyse</h4>${a.text.map(t => `<p>${esc(t)}</p>`).join('')}</div>
    <div class="box"><h4>Paris et probabilités</h4>
      <table><tr><th>Pari</th><th class="num">Proba</th><th class="num">Cote</th><th class="num">Valeur</th></tr>
      ${a.markets.map(x => `<tr class="${x.edge > 0.06 ? 'value' : ''}"><td>${esc(x.label)}</td><td class="num">${pct(x.p)}</td><td class="num">${odd(x.odd)}</td><td class="num">${x.edge == null ? '' : `<span class="${x.edge > 0.06 ? 'edge' : 'muted'}">${x.edge > 0 ? '+' : ''}${Math.round(x.edge * 100)} %</span>`}</td></tr>`).join('')}
      </table>
      <p class="small muted">Cote juste = 1 / probabilité. « Valeur » positive : la cote proposée est plus haute que ce que notre estimation justifie.</p>
    </div>
    <div class="box"><h4>Buteurs à surveiller</h4>
      ${scorers.length ? `<table><tr><th>Joueur</th><th>Statut</th><th class="num">Buts</th><th class="num">Marque</th><th class="num">Doublé</th></tr>
      ${scorers.map(p => `<tr><td>${esc(p.name)}<div class="small muted">${esc(p.team)}</div></td><td><span class="st ${p.status}">${stLabel[p.status]}</span></td><td class="num">${p.goals}</td><td class="num"><b>${pct(p.p1)}</b></td><td class="num">${pct(p.p2)}</td></tr>`).join('')}</table>` : '<p class="muted">Données buteurs indisponibles pour cette compétition.</p>'}
      <h4 style="margin-top:14px">Scores les plus probables</h4>
      <div class="scores">${a.scores.map(s => `<span>${s.h}-${s.a}<small>${pct(s.p)}</small></span>`).join('')}</div>
    </div>
    <div class="box"><h4>Absences – ${esc(m.home.name)}</h4><table>${absences('home')}</table>
      <h4 style="margin-top:14px">Absences – ${esc(m.away.name)}</h4><table>${absences('away')}</table></div>
    <div class="box"><h4>Compositions</h4><div class="lineups">${lineup('home')}${lineup('away')}</div></div>
    <div class="box"><h4>Forces (indice 1 = moyenne du championnat)</h4>
      ${a.idx ? `<table><tr><th></th><th class="num">Attaque</th><th class="num">Défense*</th></tr>
        <tr><td>${esc(m.home.name)} à domicile</td><td class="num">${a.idx.attH.toFixed(2)}</td><td class="num">${a.idx.defH.toFixed(2)}</td></tr>
        <tr><td>${esc(m.away.name)} à l'extérieur</td><td class="num">${a.idx.attA.toFixed(2)}</td><td class="num">${a.idx.defA.toFixed(2)}</td></tr></table>
        <p class="small muted">* Défense : plus le chiffre est bas, plus l'équipe est solide.</p>`
        : `<p class="muted">${a.method === 'prediction' ? 'Match de coupe : estimation à partir de la prédiction de la source.' : 'Statistiques indisponibles.'}</p>`}
      ${m.apiPrediction && m.apiPrediction.advice ? `<p class="small"><b>Conseil de la source :</b> ${esc(m.apiPrediction.advice)}</p>` : ''}
      ${m.h2h && m.h2h.length ? `<h4 style="margin-top:12px">Confrontations directes</h4><table>${m.h2h.map(g => `<tr><td class="small muted">${new Date(g.date).toLocaleDateString('fr-FR')}</td><td>${esc(g.home)} – ${esc(g.away)}</td><td class="num"><b>${esc(g.score)}</b></td></tr>`).join('')}</table>` : ''}
    </div>
    ${tierHtml(m)}
    <div class="box"><h4>Évolution des cotes 1 N 2</h4>
      ${hist.length ? `<table><tr><th>Heure</th><th class="num">1</th><th class="num">N</th><th class="num">2</th></tr>${hist.map(h => `<tr><td class="small muted">${new Date(h.t).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</td><td class="num">${odd(h.home)}</td><td class="num">${odd(h.draw)}</td><td class="num">${odd(h.away)}</td></tr>`).join('')}</table>` : '<p class="muted">Pas encore d\'historique.</p>'}
    </div>
  </div>`;
}

// --- Résultats : ce qui a marché, ce qui a raté et pourquoi -----------------------
// Libellés génériques des types de paris (sans noms d'équipes)
const KEY_LABEL = {
  '1': 'Victoire à domicile', 'N': 'Match nul', '2': 'Victoire à l\'extérieur', '1N': 'Domicile ou nul', 'N2': 'Extérieur ou nul',
  O15: 'Plus de 1,5 buts', O25: 'Plus de 2,5 buts', U25: 'Moins de 2,5 buts', O35: 'Plus de 3,5 buts', U15: 'Moins de 1,5 but',
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
  el.innerHTML = `
    <div class="summary">
      <div class="stat"><b>${pct(ok / all.length)}</b><span>pistes réussies (${ok}/${all.length})</span></div>
      <div class="stat"><b>${top.n ? pct(top.ok / top.n) : '–'}</b><span>réussite du top du jour${top.n ? ` (${top.ok}/${top.n})` : ''}</span></div>
      <div class="stat"><b>${b.days.length}</b><span>jour${b.days.length > 1 ? 's' : ''} suivis</span></div>
    </div>
    <div class="rank-grid">
      <div class="box"><h4>Par type de pari</h4><table><tr><th>Pari</th><th class="num">Joués</th><th class="num">Réussite</th></tr>
        ${rates.map(([k, x]) => `<tr><td>${esc(KEY_LABEL[k] || k)}</td>${rateCell(x.ok, x.n)}</tr>`).join('')}</table>
        <p class="small muted">Un type de pari qui réussit moins de 45 % du temps (sur au moins 10 essais) est retiré du top du jour.</p></div>
      <div class="box"><h4>Par compétition</h4><table><tr><th>Compétition</th><th class="num">Joués</th><th class="num">Réussite</th></tr>
        ${Object.entries(byComp).sort((x, y) => y[1].n - x[1].n).map(([c, x]) => `<tr><td>${esc(c)}</td>${rateCell(x.ok, x.n)}</tr>`).join('')}</table></div>
    </div>
    ${b.days.slice(0, 7).map(d => `<div class="box day"><h4>${new Date(d.date + 'T12:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
      ${d.matches.map(m => `<div class="res-match"><div><b>${esc(m.home)} ${esc(m.score)} ${esc(m.away)}</b> <span class="muted small">${esc(m.comp)} · attendu ${esc(m.exp)}${m.top ? ' · TOP' : ''}</span></div>
        <ul>${m.picks.map(p => `<li class="${p.ok ? 'ok' : 'ko'}">${p.ok ? '✓' : '✗'} ${esc(p.label)} <span class="muted">(${pct(p.p)})</span>${p.why ? `<div class="small muted">Pourquoi : ${esc(p.why)}</div>` : ''}</li>`).join('')}</ul></div>`).join('')}
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
