// « Mes paris » : ce que vous avez réellement joué (pari simple ou combiné), avec la cote du bookmaker et la mise.
// La page compare la cote à notre cote juste, marque le pari gagné / perdu toute seule après les matchs,
// et calcule le bénéfice réel. Gardé sur ce téléphone (pas d'envoi ailleurs).
import { load, save } from './store.js';
import { tipResult, espnLiveScore, ESPN_CODES } from './core.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = x => `${x < 0 ? '−' : ''}${Math.abs(x).toFixed(2).replace('.', ',')} €`;
const num = s => parseFloat(String(s || '').replace(',', '.'));
const KEY = 'bets-v1';
let bets = load(KEY, []);
const keep = () => save(KEY, bets);
export const allBets = () => bets;

// ---------- 1. La cote vaut-elle le coup ? ----------
// Cote juste = 1 ÷ probabilité (produit des probabilités pour un combiné). Votre cote au-dessus = avantage pour vous.
export function valueText(fairOdd, odd) {
  if (!odd || !(odd > 1)) return { k: '', t: `Cote juste ≈ ${fairOdd.toFixed(2).replace('.', ',')}. Tapez la cote du bookmaker pour savoir si elle vaut le coup.` };
  const ev = odd / fairOdd - 1;   // rendement espéré du pari d'après nos probabilités
  const pct = `${ev > 0 ? '+' : ''}${Math.round(ev * 100)} %`;
  if (ev >= 0.05) return { k: 'ok', t: `✓ Vaut le coup : le bookmaker paie plus que le risque (cote juste ${fairOdd.toFixed(2).replace('.', ',')}, rendement espéré ${pct}).` };
  if (ev > -0.05) return { k: '', t: `≈ Cote correcte, sans avantage (cote juste ${fairOdd.toFixed(2).replace('.', ',')}, ${pct}).` };
  return { k: 'bad', t: `✗ Trop mal payé : le bookmaker paie moins que le risque (cote juste ${fairOdd.toFixed(2).replace('.', ',')}, rendement espéré ${pct}).` };
}

// ---------- 2. Enregistrer un pari ----------
// legs : [{ m, tip }] (match du jour + pari) ; odd : cote totale du bookmaker ; stake : mise en euros
export function addBet(legs, odd, stake) {
  odd = num(odd); stake = num(stake);
  if (!legs.length || !(odd > 1) || !(stake > 0)) return 'Indiquez la cote du bookmaker (ex. 2,40) et votre mise (ex. 5).';
  bets.unshift({
    id: Date.now().toString(36), at: Date.now(), odd, stake, status: 'open',
    fair: legs.reduce((a, x) => a / x.tip.p, 1),
    legs: legs.map(x => ({ id: x.m.id, af: x.m.comp && x.m.comp.af, comp: x.m.comp && x.m.comp.name, home: x.m.home.name, away: x.m.away.name,
      kickoff: x.m.kickoff, key: x.tip.key, label: x.tip.label, p: x.tip.p, res: null, score: null })),
  });
  keep();
  return null;
}
export function removeBet(id) { bets = bets.filter(b => b.id !== id); keep(); }
// Résultat donné à la main (buteur, match ajouté depuis Claude, score introuvable)
export function setBet(id, status) { const b = bets.find(x => x.id === id); if (b) { b.status = status; b.manual = true; keep(); } }

// ---------- 3. Résultats automatiques ----------
// Score final : celui que la page connaît déjà (matchs du jour), sinon ESPN à la date du match
const boards = {};
async function finalScore(leg, live) {
  const s = live && live[leg.id];
  if (s && s.state === 'post') return s;
  if (Date.now() - leg.kickoff < 2.5 * 3600000) return null;
  const code = ESPN_CODES[leg.af];
  if (!code) return null;
  const day = new Date(leg.kickoff).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' }).replace(/-/g, '');
  try {
    boards[code + day] = boards[code + day] || await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard?dates=${day}`).then(r => r.json());
    const f = espnLiveScore(boards[code + day], leg.home, leg.away);
    return f && f.state === 'post' ? f : null;
  } catch { return null; }
}
export async function settleBets(live) {
  let changed = false;
  for (const b of bets.filter(b => b.status === 'open' && !b.manual)) {
    for (const leg of b.legs.filter(l => l.res == null)) {
      if (String(leg.key).startsWith('SC')) continue;   // buteur : à marquer à la main
      const f = await finalScore(leg, live);
      if (!f) continue;
      leg.score = `${f.h}-${f.a}`;
      leg.res = tipResult(leg.key, f.h, f.a);
      changed = true;
    }
    if (b.legs.some(l => l.res === false)) { b.status = 'lost'; changed = true; }
    else if (b.legs.every(l => l.res === true)) { b.status = 'won'; changed = true; }
  }
  if (changed) keep();
  return changed;
}

// ---------- 4. L'onglet « Mes paris » ----------
// Libellés génériques des types de paris (pour savoir lesquels vous rapportent)
const GEN = { '1': 'Victoire domicile', '2': 'Victoire extérieur', N: 'Nul', '1N': 'Domicile ou nul', N2: 'Extérieur ou nul',
  O15: '+1,5 buts', O25: '+2,5 buts', O35: '+3,5 buts', U25: '−2,5 buts', U45: '−4,5 buts', BTTS: 'Les 2 marquent', NBTTS: 'Une équipe ne marque pas',
  H1G: 'Domicile marque', A1G: 'Extérieur marque', H2G: 'Domicile marque 2+', A2G: 'Extérieur marque 2+', H3G: 'Domicile marque 3+', A3G: 'Extérieur marque 3+',
  'H2+': 'Domicile gagne par 2+', 'A2+': 'Extérieur gagne par 2+', '1O25': 'Dom. gagne et +2,5', '2O25': 'Ext. gagne et +2,5',
  '1CS': 'Dom. gagne sans encaisser', '2CS': 'Ext. gagne sans encaisser', BTTSO25: '2 marquent et +2,5', SC: 'Buteur', SCD: 'Buteur X ou Y', SC2: 'Doublé' };
const profit = b => (b.status === 'won' ? b.stake * (b.odd - 1) : b.status === 'lost' ? -b.stake : 0);
function summary(list) {
  const done = list.filter(b => b.status !== 'open');
  const staked = done.reduce((s, b) => s + b.stake, 0), net = done.reduce((s, b) => s + profit(b), 0), won = done.filter(b => b.status === 'won').length;
  return { n: done.length, open: list.length - done.length, staked, net, won, roi: staked ? net / staked : 0 };
}
export function betsHtml() {
  if (!bets.length) return `<div class="bets"><div class="combo-card"><p><b>Aucun pari enregistré pour l'instant.</b></p>
    <p class="small muted">Ajoutez des pronostics à « Mon combiné perso » (bouton ＋ sur une fiche, un rond vert ou le Conseil du jour), puis touchez « 💶 J'ai joué ce pari » : tapez la cote du bookmaker et votre mise. La page vous dira si la cote vaut le coup, puis marquera le pari gagné ou perdu toute seule.</p></div></div>`;
  const S = summary(bets), simple = summary(bets.filter(b => b.legs.length === 1)), combo = summary(bets.filter(b => b.legs.length > 1));
  const line = (title, x) => x.n ? `<tr><td class="tb-team"><span>${title}</span></td><td>${x.n}</td><td>${x.won}/${x.n}</td><td>${eur(x.staked)}</td><td><b class="${x.net >= 0 ? 'go' : 'bad'}">${eur(x.net)}</b></td><td>${Math.round(x.roi * 100)} %</td></tr>` : '';
  // Réussite par type de pari (chaque sélection, simple ou dans un combiné)
  const byType = {};
  bets.forEach(b => b.legs.forEach(l => { if (l.res == null) return; const k = GEN[l.key] || l.key; const x = byType[k] = byType[k] || { n: 0, ok: 0 }; x.n++; if (l.res) x.ok++; }));
  const STATUS = { open: '⏳ En cours', won: '✅ Gagné', lost: '❌ Perdu' };
  return `<div class="bets">
    <div class="combo-card best">
      <div class="combo-card-head"><b>💶 Mon bilan</b><span class="small muted">${S.n} pari${S.n > 1 ? 's' : ''} terminé${S.n > 1 ? 's' : ''}${S.open ? ` · ${S.open} en cours` : ''}</span></div>
      <p class="bets-net ${S.net >= 0 ? 'go' : 'bad'}">${eur(S.net)}</p>
      <p class="small muted">Misé ${eur(S.staked)} · ${S.won} gagné${S.won > 1 ? 's' : ''} sur ${S.n} · rendement ${Math.round(S.roi * 100)} % (bénéfice ÷ mises)</p>
      <div class="tb-wrap"><table class="tb"><thead><tr><th class="tb-team">Type</th><th>Paris</th><th>Gagnés</th><th>Misé</th><th>Bénéfice</th><th>Rend.</th></tr></thead>
        <tbody>${line('Simples', simple)}${line('Combinés', combo)}</tbody></table></div>
      ${Object.keys(byType).length ? `<p class="small"><b>Vos sélections par type :</b> ${Object.entries(byType).sort((a, b) => b[1].n - a[1].n).map(([k, x]) => `${esc(k)} ${x.ok}/${x.n}`).join(' · ')}</p>` : ''}
    </div>
    ${bets.map(b => `<div class="combo-card bet ${b.status}">
      <div class="bet-head"><b>${STATUS[b.status]}</b><span class="small muted">${new Date(b.at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} · ${b.legs.length === 1 ? 'simple' : `combiné ${b.legs.length}`}</span></div>
      <ul class="combo-mini">${b.legs.map(l => `<li><span class="c-time">${l.res === true ? '✓' : l.res === false ? '✗' : '·'}</span><span class="cm-txt"><span class="c-names">${esc(l.home)} – ${esc(l.away)}${l.score ? ` <b>${esc(l.score)}</b>` : ''}</span><small>${esc(l.label)} · ${Math.round(l.p * 100)} %</small></span></li>`).join('')}</ul>
      <div class="combo-total"><span>Mise ${eur(b.stake)} · cote ${b.odd.toFixed(2).replace('.', ',')}</span><span>${b.status === 'open' ? `gain possible ${eur(b.stake * b.odd)}` : `<b>${eur(profit(b))}</b>`}</span></div>
      <p class="small ${valueText(b.fair, b.odd).k === 'ok' ? 'go' : 'muted'}">${esc(valueText(b.fair, b.odd).t)}</p>
      <div class="bet-actions">${b.status === 'open' ? `<button class="link" data-bet="won" data-id="${b.id}">Marquer gagné</button><button class="link" data-bet="lost" data-id="${b.id}">Marquer perdu</button>` : ''}<button class="link muted" data-bet="del" data-id="${b.id}">Supprimer</button></div>
    </div>`).join('')}
    <p class="small muted">Gardé sur ce téléphone. Résultat automatique dès que le score final est connu ; les paris buteur et les matchs ajoutés depuis Claude se marquent à la main.</p>
  </div>`;
}
