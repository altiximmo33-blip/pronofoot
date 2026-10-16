// Compétitions suivies.
// af   = identifiant API-Football (https://www.api-football.com)
// odds = clé de sport The Odds API (ignorée si le service ne la propose pas)
export const COMPETITIONS = [
  // Europe
  { af: 2,   name: 'Ligue des champions', country: 'Europe', flag: '🇪🇺', type: 'europe', odds: 'soccer_uefa_champs_league' },
  { af: 3,   name: 'Ligue Europa', country: 'Europe', flag: '🇪🇺', type: 'europe', odds: 'soccer_uefa_europa_league' },
  { af: 848, name: 'Ligue Conférence', country: 'Europe', flag: '🇪🇺', type: 'europe', odds: 'soccer_uefa_europa_conference_league' },
  // France
  { af: 61,  name: 'Ligue 1', country: 'France', flag: '🇫🇷', type: 'league', odds: 'soccer_france_ligue_one' },
  { af: 62,  name: 'Ligue 2', country: 'France', flag: '🇫🇷', type: 'league', odds: 'soccer_france_ligue_two' },
  { af: 66,  name: 'Coupe de France', country: 'France', flag: '🇫🇷', type: 'cup', odds: 'soccer_france_coupe_de_france' },
  // Angleterre
  { af: 39,  name: 'Premier League', country: 'Angleterre', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'league', odds: 'soccer_epl' },
  { af: 40,  name: 'Championship', country: 'Angleterre', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'league', odds: 'soccer_efl_champ' },
  { af: 45,  name: 'FA Cup', country: 'Angleterre', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'cup', odds: 'soccer_fa_cup' },
  { af: 48,  name: 'League Cup', country: 'Angleterre', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', type: 'cup', odds: 'soccer_england_efl_cup' },
  // Espagne
  { af: 140, name: 'Liga', country: 'Espagne', flag: '🇪🇸', type: 'league', odds: 'soccer_spain_la_liga' },
  { af: 143, name: 'Coupe du Roi', country: 'Espagne', flag: '🇪🇸', type: 'cup', odds: 'soccer_spain_copa_del_rey' },
  // Italie
  { af: 135, name: 'Serie A', country: 'Italie', flag: '🇮🇹', type: 'league', odds: 'soccer_italy_serie_a' },
  { af: 137, name: 'Coupe d\'Italie', country: 'Italie', flag: '🇮🇹', type: 'cup', odds: 'soccer_italy_coppa_italia' },
  // Allemagne
  { af: 78,  name: 'Bundesliga', country: 'Allemagne', flag: '🇩🇪', type: 'league', odds: 'soccer_germany_bundesliga' },
  { af: 79,  name: '2. Bundesliga', country: 'Allemagne', flag: '🇩🇪', type: 'league', odds: 'soccer_germany_bundesliga2' },
  { af: 81,  name: 'Coupe d\'Allemagne', country: 'Allemagne', flag: '🇩🇪', type: 'cup', odds: 'soccer_germany_dfb_pokal' },
  // Autres pays
  { af: 88,  name: 'Eredivisie', country: 'Pays-Bas', flag: '🇳🇱', type: 'league', odds: 'soccer_netherlands_eredivisie' },
  { af: 94,  name: 'Liga Portugal', country: 'Portugal', flag: '🇵🇹', type: 'league', odds: 'soccer_portugal_primeira_liga' },
  { af: 144, name: 'Pro League', country: 'Belgique', flag: '🇧🇪', type: 'league', odds: 'soccer_belgium_first_div' },
  { af: 207, name: 'Super League', country: 'Suisse', flag: '🇨🇭', type: 'league', odds: 'soccer_switzerland_superleague' },
  { af: 203, name: 'Süper Lig', country: 'Turquie', flag: '🇹🇷', type: 'league', odds: 'soccer_turkey_super_league' },
  { af: 179, name: 'Premiership', country: 'Écosse', flag: '🏴󠁧󠁢󠁳󠁣󠁴󠁿', type: 'league', odds: 'soccer_spl' },
  { af: 218, name: 'Bundesliga', country: 'Autriche', flag: '🇦🇹', type: 'league', odds: 'soccer_austria_bundesliga' },
  { af: 197, name: 'Super League', country: 'Grèce', flag: '🇬🇷', type: 'league', odds: 'soccer_greece_super_league' },
  { af: 119, name: 'Superliga', country: 'Danemark', flag: '🇩🇰', type: 'league', odds: 'soccer_denmark_superliga' },
];

export const compByAf = Object.fromEntries(COMPETITIONS.map(c => [c.af, c]));

// Calendrier des vérifications automatiques (en minutes avant le coup d'envoi)
export const SCHEDULE = {
  trendsAt: 60,        // H-60 : blessés, suspendus, mouvements de cotes
  lineupsFrom: 40,     // à partir de H-40 : recherche des compositions officielles
  lineupsEvery: 5,     // puis toutes les 5 minutes jusqu'à leur publication
  dayRefreshHours: 3,  // rechargement du programme du jour
};
