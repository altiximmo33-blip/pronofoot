# PronoFoot

Analyse automatique des matchs de foot, sans paris évidents.

- **Page d'analyse** : https://altiximmo33-blip.github.io/pronofoot/
- **Robot** : `.github/workflows/collecte.yml` lance `scripts/collect.mjs` toutes les 15 minutes.
  - Vers 7h : programme du jour, bilans domicile/extérieur, niveau des adversaires (gros, moyens, faibles), buteurs, absents.
  - À partir d'1 h avant chaque match : compositions officielles, puis notification sur le téléphone (ntfy).
- **Sauvegardes** : chaque journée est archivée dans `docs/data/archive/`.

## Secrets GitHub nécessaires
- `APIFOOTBALL_KEY` : clé API-Football (offre gratuite : 100 requêtes par jour)
- `FOOTBALLDATA_KEY` : clé football-data.org (offre gratuite)
- `NTFY_TOPIC` : nom du canal de notifications ntfy

## Relancer la collecte à la main
Onglet **Actions**, puis **Collecte PronoFoot**, puis **Run workflow**. Mettez « oui » pour refaire la collecte du jour.

## Limites de l'offre gratuite
- Statistiques complètes pour : Ligue 1, Premier League, Championship, Liga, Serie A, Bundesliga, Eredivisie, Liga Portugal, Ligue des champions.
- Les autres compétitions sont listées sans statistiques détaillées.
