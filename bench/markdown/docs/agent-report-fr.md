---
title: "Analyse trimestrielle : ventes T3 2026"
author: Équipe Données
subject: Synthèse des ventes du troisième trimestre
keywords: [ventes, trimestre, synthèse]
lang: fr
---

# Analyse trimestrielle : ventes T3 2026

> [!NOTE]
> Ce rapport a été produit à partir des exportations du 1er octobre 2026. Les montants sont hors taxes.

## Résumé

Le chiffre d'affaires du trimestre atteint **1 284 000 €**, en hausse de 12,4 % sur un an. La marge brute progresse moins vite (+8,1 %) : la hausse des coûts logistiques en absorbe une partie[^logistique]. Trois points ressortent :

1. La région **Maghreb** devient la deuxième du groupe, devant l'Europe du Nord.
2. Le panier moyen recule légèrement, de 84 € à 81 €.
3. Le taux de réachat à 90 jours passe de 31 % à 36 % :tada:.

## Chiffres par région

| Région | CA T3 2026 | CA T3 2025 | Évolution | Part |
|:-------|-----------:|-----------:|----------:|-----:|
| France | 612 000 € | 571 000 € | +7,2 % | 47,7 % |
| Maghreb | 254 000 € | 189 000 € | +34,4 % | 19,8 % |
| Europe du Nord | 231 000 € | 226 000 € | +2,2 % | 18,0 % |
| Afrique de l'Ouest | 118 000 € | 92 000 € | +28,3 % | 9,2 % |
| Autres | 69 000 € | 64 000 € | +7,8 % | 5,3 % |
| **Total** | **1 284 000 €** | **1 142 000 €** | **+12,4 %** | **100 %** |

## Méthode

La croissance annuelle composée se calcule sur les quatre derniers trimestres :

$$
\text{TCAC} = \left( \frac{V_{\text{fin}}}{V_{\text{début}}} \right)^{1/n} - 1
$$

Pour la région Maghreb, avec $V_{\text{début}} = 189\,000$ et $V_{\text{fin}} = 254\,000$ sur $n = 1$ an, on obtient un TCAC de $34{,}4\,\%$. L'écart-type des ventes hebdomadaires, \(\sigma = \sqrt{\frac{1}{N}\sum_{i=1}^{N}(x_i - \bar{x})^2}\), reste stable autour de 4 200 €.

> [!WARNING]
> Les chiffres de l'Afrique de l'Ouest portent sur 11 semaines : le site de Dakar a ouvert le 14 juillet.

## Requête utilisée

```sql
SELECT region,
       SUM(montant_ht) AS ca,
       COUNT(DISTINCT client_id) AS clients
FROM ventes
WHERE date_vente BETWEEN '2026-07-01' AND '2026-09-30'
GROUP BY region
ORDER BY ca DESC;
```

## Actions proposées

- [x] Renforcer le stock de l'entrepôt de Casablanca avant le T4
- [x] Renégocier le contrat de transport Europe du Nord
- [ ] Tester une offre groupée pour remonter le panier moyen
  - [ ] Choisir les trois produits du lot
  - [ ] Mesurer sur quatre semaines, avec un groupe témoin
- [ ] Préparer la saison des fêtes

> [!TIP]
> Le groupe témoin doit représenter au moins 10 % des visiteurs pour que l'écart soit lisible en quatre semaines.

## Annexe : définitions

- **Chiffre d'affaires** : somme des montants hors taxes des commandes livrées.
- **Taux de réachat** : part des clients du trimestre précédent qui ont recommandé dans les 90 jours.

---

Questions : écrire à l'équipe Données ou ouvrir un ticket dans l'outil interne.

[^logistique]: Les tarifs du transporteur principal ont augmenté de 6 % au 1er juillet 2026.
