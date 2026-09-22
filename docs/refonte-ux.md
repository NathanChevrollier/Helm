# Refonte UX/UI — audit et plan

État des lieux de l'interface au 23/09/2026 (v0.4.0), défauts constatés et ordre de traitement.
Le but n'est pas un changement de style : c'est de rendre l'app lisible et prévisible quand on
gère plusieurs serveurs.

## 1. Ce qui ne va pas

### 1.1 On ne sait pas où on est (navigation)

Trois niveaux de navigation se superposent sans hiérarchie visible :

| Niveau | Où | Problème |
|---|---|---|
| Section | colonne d'icônes à gauche, 13 entrées | aucun libellé écrit : le nom n'apparaît qu'au survol ([App.tsx](../apps/desktop/src/App.tsx) `RailButton`) |
| Serveur | pastilles en haut | ressemble à des onglets mais n'en est pas : ça change le contexte de **toutes** les sections |
| Onglet de terminal | barre sous l'en-tête | vrais onglets, dessinés presque comme les pastilles serveur juste au-dessus |

Conséquences : on cherche l'icône de la section, on confond les deux rangées, et rien ne rappelle
« serveur X → section Y » une fois dans la page.

**Pistes** : libellés écrits dans la colonne (repliable, largeur retenue) ; en-tête de page qui
affiche `Serveur · Section` ; distinguer nettement pastille de serveur (arrondie, pastille d'état)
et onglet de terminal (carré, croix de fermeture).

### 1.2 Barres d'outils sans hiérarchie

La barre du terminal aligne 8 boutons de même poids : Diffuser, Rejoindre, Multi-serveurs,
Sessions, Diviser, Orientation, Fichiers, Snippets. Les actions rares (rejoindre un terminal
partagé) ont le même poids que les courantes (diviser, fichiers). Même défaut, à moindre échelle,
dans Docker et Sites.

**Pistes** : trois groupes séparés par un filet — *disposition* (Diviser, Orientation) ·
*panneaux* (Fichiers, Snippets) · *partage* (Diffuser, Rejoindre, Multi-serveurs, Sessions) rangé
derrière un bouton « … » ; libellés courts conservés, icônes seules seulement si l'espace manque.

### 1.3 États de chargement incohérents

- Sections : `Suspense fallback={null}` dans [App.tsx](../apps/desktop/src/App.tsx) → écran vide,
  puis apparition brutale.
- Bases de données : listes qui affichent « Chargement… » dans un `<select>`.
- Fichiers, Docker : rien, puis la liste.

**Pistes** : un composant de squelette unique (`<Skeleton rows>`), utilisé partout ; règle simple —
en dessous de 150 ms on n'affiche rien, au-delà un squelette de la forme finale.

### 1.4 Retours d'erreur dispersés

Trois mécanismes coexistent : `notify()` (toast), `error` affiché en rouge dans la page, et
`ask()` (dialogue). Le même incident (serveur injoignable) peut sortir sous deux formes selon la
vue.

**Pistes** : règle écrite — toast pour ce qui est passager et sans action, encart dans la page
pour ce qui bloque la vue (avec le bouton qui répare : « Se connecter », « Réessayer »), dialogue
seulement si une décision est nécessaire.

### 1.5 Densité et cibles de clic

- `IconButton` fait 28 px (`size-7`), certains 24 px (`size-6`) : sous les 32 px confortables, et
  ces boutons n'apparaissent qu'au survol dans les listes de fichiers.
- Beaucoup de texte à 11–13 px en `text-muted` (366 occurrences de `text-muted`), y compris pour
  des informations utiles (chemins, tailles, états).
- Les placeholders en `text-muted/60` passent sous le seuil de lisibilité.

**Pistes** : plancher à 32 px pour toute cible cliquable, 12 px minimum pour le texte porteur
d'information, `text-muted` réservé au secondaire réel.

### 1.6 Focus clavier

Seul `Input` a un style de focus (`focus:border-accent`). Les boutons, onglets et entrées de liste
n'ont pas d'anneau de focus visible : l'app n'est pas utilisable au clavier alors qu'elle a déjà
une palette (Ctrl+K) et des raccourcis configurables.

**Pistes** : `focus-visible:ring-2 ring-accent` sur les primitives de
[ui.tsx](../apps/desktop/src/components/ui.tsx), parcours au clavier vérifié sur les trois écrans
les plus utilisés.

### 1.7 Vocabulaire

« Snippets » (anglais) à côté de « Diffuser », « Rejoindre », « Sessions ». « RDS » employé pour du
bureau à distance. Les titres de colonnes et d'actions mélangent infinitif et nom.

**Pistes** : lexique court en tête de ce document, appliqué partout ; actions à l'infinitif.

## 2. Ordre de traitement

Chaque phase est indépendante et livrable seule.

1. **Fondations** (peu visible, débloque le reste) : anneau de focus, plancher de taille des
   cibles, composant de squelette, règle d'erreur écrite. Fichiers : `components/ui.tsx`, `App.tsx`.
2. **Navigation** : libellés dans la colonne d'icônes, en-tête `Serveur · Section`, distinction
   visuelle pastilles serveur / onglets de terminal.
3. **Barres d'outils** : regroupement et débordement « … », en commençant par le terminal, puis
   Docker et Sites.
4. **Listes et tableaux** : densité homogène (hauteur de ligne, alignement des nombres à droite,
   actions toujours au même endroit), tri et filtre au même endroit dans toutes les vues.
5. **Vocabulaire et micro-copie** : lexique appliqué, infobulles revues, messages d'erreur qui
   disent quoi faire.

## 3. À vérifier avant de commencer

- Faire les copies d'écran avant/après sur : Accueil, Serveurs, Terminal (divisé + panneau
  Fichiers), Docker, Bases de données, Sécurité.
- Tester en thème clair autant qu'en thème sombre : les deux jeux de couleurs existent
  ([index.css](../apps/desktop/src/index.css)) mais le clair est peu éprouvé.
- Vérifier à 1280 px de large : c'est là que les barres d'outils débordent.
