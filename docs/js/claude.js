// Matchs ajoutés depuis Claude : Claude termine son analyse par un bloc de données
// (format « pronofoot »), que l'on colle dans la page. Les matchs sont gardés dans ce navigateur.
import { norm } from './model.js';

// Heure de Paris → horodatage, en tenant compte de l'heure d'été / d'hiver
function parisTime(date, hhmm) {
  const [h, m] = String(hhmm || '20:00').split(/[:h]/).map(x => parseInt(x, 10) || 0);
  const guess = Date.parse(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  const shown = new Date(guess).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).replace(' ', 'T') + 'Z';
  return guess - (Date.parse(shown) - guess);
}

const num = x => (typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'))) || 0;
const venue = v => (v ? { p: num(v.j), w: num(v.v), gf: num(v.bp), ga: num(v.bc) } : null);
const form = f => String(f || '').toUpperCase().replace(/V/g, 'W').replace(/N/g, 'D').replace(/[^WDL]/g, '').slice(-5);
const players = list => (list || []).map(x => Array.isArray(x) ? { name: x[0], goals: num(x[1]) } : { name: x.nom || x.name, goals: num(x.buts || x.goals) }).filter(p => p.name);
const absents = list => (list || []).map(x => {
  const [name, reason, status] = Array.isArray(x) ? x : [x.nom || x.name, x.raison || x.reason, x.statut || x.status];
  return { name, reason: reason || '', type: /incertain|doute|question/i.test(status || reason || '') ? 'Questionable' : 'Missing Fixture' };
}).filter(p => p.name);

// Extrait le bloc de données du texte collé (même s'il est entouré d'autre texte)
export function parsePasted(text) {
  const s = String(text || '');
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Aucun bloc de données trouvé. Copiez bien le bloc « PRONOFOOT » donné par Claude.');
  let data;
  try { data = JSON.parse(s.slice(start, end + 1)); } catch { throw new Error('Le bloc de données est incomplet ou abîmé. Recopiez-le en entier depuis Claude.'); }
  const list = data.matchs || data.matches;
  if (!Array.isArray(list) || !list.length) throw new Error('Le bloc ne contient aucun match.');
  const date = data.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
  return list.map((x, i) => toMatch(x, date, i));
}

function toMatch(x, date, i) {
  const H = x.domicile || x.home, A = x.exterieur || x.away;
  if (!H || !A) throw new Error(`Match n°${i + 1} : il manque le nom d'une équipe.`);
  const hv = venue(x.dom_a_domicile), av = venue(x.ext_a_lexterieur);
  const avg = x.moyenne_ligue ? { avgHome: num(x.moyenne_ligue.buts_domicile) || 1.45, avgAway: num(x.moyenne_ligue.buts_exterieur) || 1.15 } : { avgHome: 1.45, avgAway: 1.15 };
  const hasStats = hv && av && hv.p > 0 && av.p > 0;
  const lineup = (side) => {
    const c = x.compos || {};
    const l = c[side];
    return Array.isArray(l) && l.length ? { status: /offic/i.test(c.statut || '') ? 'officielle' : 'probable', startXI: l.map(n => ({ name: n })) } : null;
  };
  const sc = x.buteurs || {}, ab = x.absents || {}, fo = x.forme || {}, bt = x.buts_equipe || {};
  const comp = x.competition || 'Autre compétition';
  return {
    id: `claude-${date}-${norm(H)}-${norm(A)}`.replace(/\s+/g, '-'),
    source: 'claude', comp: { af: 'claude-' + norm(comp), name: comp, country: x.pays || '', flag: '🤖', type: 'league' },
    round: '', kickoff: parisTime(date, x.heure), status: 'NS', note: x.note ? `Ajouté depuis Claude : ${x.note}` : 'Ajouté depuis Claude.',
    home: { id: H, name: H }, away: { id: A, name: A },
    stats: hasStats ? { ...avg, home: hv, away: av } : null,
    teamStats: hasStats ? { home: { home: hv, away: { p: 0, w: 0, gf: 0, ga: 0 }, ranks: {}, n: null, avg }, away: { home: { p: 0, w: 0, gf: 0, ga: 0 }, away: av, ranks: {}, n: null, avg } } : null,
    form: { home: form(fo.domicile), away: form(fo.exterieur) },
    injuries: { home: absents(ab.domicile), away: absents(ab.exterieur) },
    scorers: { home: players(sc.domicile).map(p => ({ ...p, id: null, pos: 'A' })), away: players(sc.exterieur).map(p => ({ ...p, id: null, pos: 'A' })) },
    teamGoals: { home: num(bt.domicile) || (hv ? hv.gf * 2 : 0), away: num(bt.exterieur) || (av ? av.gf * 2 : 0) },
    lineups: { home: lineup('domicile'), away: lineup('exterieur') },
    tiers: x.niveau ? { home: x.niveau.domicile, away: x.niveau.exterieur } : null,
    tierText: x.niveau ? [`Niveau (selon Claude) : ${H} fait partie des ${x.niveau.domicile || '?'}, ${A} des ${x.niveau.exterieur || '?'}.`] : [],
    tierFlags: [], apiPrediction: null, odds: null, h2h: [],
  };
}

// Même affiche ? (pour remplacer un match du robot sans statistiques)
const same = (a, b) => {
  const k = s => norm(s).split(' ').filter(w => w.length > 2);
  const hit = (x, y) => k(x).some(w => k(y).some(v => v.startsWith(w.slice(0, 4)) || w.startsWith(v.slice(0, 4))));
  return hit(a.home.name, b.home.name) && hit(a.away.name, b.away.name);
};

// Fusionne : un match Claude remplace le même match du robot (en gardant les compos officielles du robot)
export function mergeExtras(robotMatches, extras) {
  const out = [...robotMatches];
  for (const e of extras) {
    const i = out.findIndex(m => m.source !== 'claude' && same(m, e) && Math.abs(m.kickoff - e.kickoff) < 3 * 3600000);
    if (i >= 0) {
      const r = out[i];
      const official = r.lineups && r.lineups.home && r.lineups.home.status === 'officielle';
      // Si le robot a des statistiques et Claude non, on garde le robot et on ajoute juste la note
      if (r.stats && !e.stats) { out[i] = { ...r, note: e.note }; continue; }
      out[i] = { ...e, kickoff: r.kickoff, lineups: official ? r.lineups : e.lineups, injuries: r.injuries.home.length || r.injuries.away.length ? r.injuries : e.injuries };
    } else {
      out.push(e);
    }
  }
  return out;
}
