# Helm Discord Bot

Bot Discord autonome pour centraliser les suggestions et signalements de bugs de Helm dans GitHub.

## Fonctionnalités

- `/setup-feedback` publie deux panneaux interactifs dans les salons configurés par ID.
- Les boutons et `/bug` / `/suggestion` ouvrent des modales Discord natives.
- Chaque retour crée une issue GitHub avec le label `bug` ou `enhancement`, le lien vers l'auteur Discord et son avatar.
- La roadmap maintient un seul embed à jour avec les cartes du GitHub Project v2 (`Brainstorming`, `In Progress`, `Test`, `Done`), y compris les issues terminées.
- `/helm status` affiche le ping, l'uptime et la dernière release GitHub de Helm.
- `/sync-roadmap` force la mise à jour du panneau et `/roadmap` affiche les chantiers en privé.
- Les commandes sont enregistrées au niveau de `GUILD_ID`, donc disponibles immédiatement sur le serveur ciblé.

## Pré-requis

- Node.js 22 LTS ou Docker.
- Un bot créé dans le [Discord Developer Portal](https://discord.com/developers/applications).
- Les intents privilégiés ne sont pas nécessaires: le bot utilise seulement `Guilds`.
- Le bot doit avoir les permissions `View Channels`, `Send Messages`, `Embed Links` et `Use Application Commands` dans les deux salons.
- Le token GitHub doit être un fine-grained token limité au dépôt Helm avec `Issues: Read and write` et `Projects: Read` si le mode Project v2 est utilisé.

## Configuration locale

```powershell
Copy-Item .env.example .env
# Renseigner les secrets et identifiants dans .env
pnpm install
pnpm --filter helm-discord-bot typecheck
pnpm --filter helm-discord-bot test
pnpm --filter helm-discord-bot dev
```

Une fois connecté, exécuter `/setup-feedback` avec un membre qui dispose de `Manage Server`.

Pour la roadmap, crée un salon dédié et copie son ID dans `ROADMAP_CHANNEL_ID`. Le bot crée ou
retrouve son embed dans les 50 derniers messages, puis l'édite à intervalle régulier. Tu peux
forcer une mise à jour avec `/sync-roadmap`. Si `GITHUB_PROJECT_NUMBER` est renseigné, les
colonnes du Project v2 sont utilisées directement; sinon le bot utilise les labels configurés.

## Configuration des secrets

| Variable                        | Rôle                                                   |
| ------------------------------- | ------------------------------------------------------ |
| `DISCORD_TOKEN`                 | Token privé du bot Discord; ne jamais le publier.      |
| `CLIENT_ID`                     | Application ID du bot Discord.                         |
| `GUILD_ID`                      | ID du serveur où enregistrer les commandes.            |
| `GITHUB_TOKEN`                  | Fine-grained token GitHub limité aux issues du dépôt.  |
| `GITHUB_OWNER`                  | Propriétaire du dépôt, par défaut `NathanChevrollier`. |
| `GITHUB_REPO`                   | Nom du dépôt, par défaut `Helm`.                       |
| `GITHUB_PROJECT_NUMBER`         | Numéro du Project v2; active la lecture des colonnes.  |
| `SUGGESTION_CHANNEL_ID`         | ID Discord du salon de suggestions.                    |
| `BUG_CHANNEL_ID`                | ID Discord du salon de bugs.                           |
| `ROADMAP_CHANNEL_ID`            | ID Discord du salon où publier le panneau roadmap.     |
| `ROADMAP_MESSAGE_ID`            | ID facultatif du message à éditer directement.         |
| `ROADMAP_SYNC_INTERVAL_MINUTES` | Intervalle de synchronisation, 15 minutes par défaut.  |
| `GITHUB_BUG_LABEL`              | Label appliqué aux bugs.                               |
| `GITHUB_SUGGESTION_LABEL`       | Label appliqué aux suggestions.                        |
| `GITHUB_BRAINSTORMING_LABEL`    | Label des idées, `brainstorming` par défaut.           |
| `GITHUB_IN_PROGRESS_LABEL`      | Label des issues en cours, `in-progress` par défaut.   |
| `GITHUB_TEST_LABEL`             | Label des issues en test, `test` par défaut.           |
| `GITHUB_DONE_LABEL`             | Label des issues terminées, `done` par défaut.         |

## Déploiement Docker

Créer `.env` à partir de `.env.example`, puis depuis ce dossier:

```bash
docker compose up -d --build
docker compose logs -f helm-discord-bot
docker compose down
```

Le conteneur tourne en utilisateur non-root, sans port exposé, avec un système de fichiers en lecture seule et redémarrage automatique. Le fichier `.env` reste sur le serveur et n'est jamais copié dans l'image.

## Structure

```text
src/
  commands/       Définitions des slash commands
  config/         Validation Zod de l'environnement
  events/         ready et interactionCreate
  services/       Formatage du feedback et client GitHub
  types/          Contrats métier
```

## Limites et exploitation

Les issues sont créées immédiatement après la soumission de la modale. Une erreur GitHub est renvoyée à l'utilisateur sans exposer le token; une nouvelle soumission peut être faite après correction. Le bot est stateless: aucun contenu n'est conservé localement et aucun stockage n'est requis pour un redémarrage.
