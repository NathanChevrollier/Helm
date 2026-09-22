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

### 1.8 Organisation des pages : chaque vue a sa propre grammaire

Il n'y a pas de gabarit de page commun, donc chaque onglet se lit différemment.

| Vue | En-tête | Zone de contenu |
|---|---|---|
| Accueil | titre dans le contenu | grille figée `1fr 360px`, indicateurs en `grid-cols-4` |
| Serveurs, Docker, Supervision | `<header … px-6 pt-4>` | cartes, une zone de défilement |
| Sites, Sécurité, Sauvegardes, Tunnels | `<header … px-6 py-4>` | deux à quatre zones de défilement |
| Fichiers, Journaux | aucun en-tête | barre d'outils propre à la vue, colonne latérale |
| Terminal | barre d'onglets + barre d'outils | panneaux |

Trois conséquences concrètes :

- **Le titre de la page n'est pas au même endroit** d'une vue à l'autre, et parfois absent : on
  perd le repère en changeant d'onglet.
- **Les actions de page ne sont pas au même endroit** : tantôt dans l'en-tête à droite, tantôt au
  milieu du contenu (le bouton Actualiser de l'Accueil est dans le flux).
- **Plusieurs ascenseurs par page** (jusqu'à quatre dans Sécurité,
  [Security.tsx](../apps/desktop/src/views/Security.tsx)) : la molette agit sur une zone qu'on n'a
  pas choisie, et le contenu peut défiler sous un en-tête qui, lui, ne bouge pas.

**Pistes** : un gabarit unique `PageLayout` — bandeau de titre (titre, sous-titre, actions à
droite, barre d'onglets secondaire éventuelle) puis **une seule** zone de défilement ; les colonnes
latérales gardent la leur, jamais plus. Cartes et tableaux prennent la même gouttière (24 px) et le
même espacement vertical.

### 1.9 Rien ne s'adapte à la largeur

L'app n'a pratiquement aucun point de rupture : sur tout le front, deux usages de `xl:`, et rien en
`sm:`, `md:` ou `lg:`. Le reste est figé :

- grilles `grid-cols-4` (indicateurs de l'Accueil), `grid-cols-6`, `grid-cols-2` quelle que soit la
  largeur de la fenêtre ;
- colonnes de tableau en pixels : `200px … 150px 110px` pour la liste de l'Accueil ;
- panneaux et champs à largeur fixe : colonne latérale de l'Accueil à 360 px, champ de recherche à
  440 px, panneau Fichiers du terminal à 288 px (celui-ci désormais réglable à la souris) ;
- barres d'outils sur une seule ligne, sans repli.

Ce que ça donne : sous ~1100 px les barres d'outils débordent et les cartes deviennent illisibles ;
au-delà de ~1700 px les lignes de tableau s'étirent sans que rien ne remplisse l'espace, et l'œil
ne relie plus le début et la fin d'une ligne.

**Pistes** :

- fixer trois paliers — **compact** (< 1200 px), **normal**, **large** (> 1700 px) — et s'y tenir
  partout plutôt que d'ajuster vue par vue ;
- grilles en `repeat(auto-fit, minmax(…))` au lieu d'un nombre de colonnes figé ;
- colonnes de tableau en fractions avec une largeur minimale, nombres alignés à droite ;
- barres d'outils qui replient leurs groupes secondaires derrière « … » quand la place manque
  (même mécanisme qu'en 1.2) ;
- largeur de lecture plafonnée pour les contenus textuels (audit, journaux, réglages) ;
- colonnes latérales (Accueil, Journaux, Fichiers du terminal) repliables et de largeur retenue,
  comme le panneau Fichiers ;
- vérifier chaque écran à 1100, 1440 et 1920 px.

## 2. Ordre de traitement

Chaque phase est indépendante et livrable seule.

1. **Fondations** (peu visible, débloque le reste) : anneau de focus, plancher de taille des
   cibles, composant de squelette, règle d'erreur écrite. Fichiers : `components/ui.tsx`, `App.tsx`.
2. **Navigation** : libellés dans la colonne d'icônes, en-tête `Serveur · Section`, distinction
   visuelle pastilles serveur / onglets de terminal.
3. **Gabarit de page** : `PageLayout` commun (titre, actions, une seule zone de défilement),
   appliqué vue par vue en commençant par Sécurité et Accueil, les plus morcelées.
4. **Barres d'outils** : regroupement et débordement « … », en commençant par le terminal, puis
   Docker et Sites.
5. **Adaptation à la largeur** : trois paliers, grilles `auto-fit`, colonnes en fractions,
   panneaux latéraux repliables. Se fait après le gabarit, sinon on adapte deux fois.
6. **Listes et tableaux** : densité homogène (hauteur de ligne, alignement des nombres à droite,
   actions toujours au même endroit), tri et filtre au même endroit dans toutes les vues.
7. **Vocabulaire et micro-copie** : lexique appliqué, infobulles revues, messages d'erreur qui
   disent quoi faire.

## 3. À vérifier avant de commencer

- Faire les copies d'écran avant/après sur : Accueil, Serveurs, Terminal (divisé + panneau
  Fichiers), Docker, Bases de données, Sécurité.
- Tester en thème clair autant qu'en thème sombre : les deux jeux de couleurs existent
  ([index.css](../apps/desktop/src/index.css)) mais le clair est peu éprouvé.
- Vérifier chaque écran à 1100, 1440 et 1920 px : c'est en dessous de ~1100 px que les barres
  d'outils débordent, et au-delà de ~1700 px que les tableaux s'étirent dans le vide.
