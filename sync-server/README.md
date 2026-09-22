# helm-sync

Petit serveur qui permet à plusieurs installations de Helm (PC fixe, portable…) de partager leurs
réglages : serveurs, banque d'identifiants, clés d'hôte approuvées, snippets, tunnels et, si tu
le choisis, les secrets.

Le serveur ne voit jamais rien en clair : Helm chiffre tout (AES-256-GCM) avec ta **phrase de
passe de synchronisation**, qui ne quitte pas tes PC. Le serveur garde seulement la dernière
version chiffrée et un numéro de révision, et refuse tout contenu non chiffré.

> Pas envie d'héberger un serveur ? Dans Helm, choisis plutôt la synchronisation par **fichier**,
> dans un dossier déjà synchronisé (OneDrive, Dropbox, Syncthing, partage réseau).

## Installation sur le VPS (Docker + nginx)

```sh
# 1. Copier ce dossier sur le VPS, par exemple dans /opt/helm-sync
cd /opt/helm-sync

# 2. Générer un jeton (un par personne ; plusieurs jetons = plusieurs espaces séparés)
echo "HELM_SYNC_TOKENS=$(openssl rand -hex 32)" > .env
chmod 600 .env

# 3. Construire et lancer (écoute uniquement sur 127.0.0.1:8091)
docker compose up -d --build

# 4. Sous-domaine en HTTPS : adapter nginx.conf.example (domaine, port), puis
sudo cp nginx.conf.example /etc/nginx/sites-available/sync.exemple.fr
sudo ln -s /etc/nginx/sites-available/sync.exemple.fr /etc/nginx/sites-enabled/
sudo certbot certonly --nginx -d sync.exemple.fr
sudo nginx -t && sudo systemctl reload nginx
```

Vérifie que le port 8091 est libre (`ss -ltn | grep 8091`) ; sinon change-le dans
`docker-compose.yml` et dans le bloc nginx.

## Dans Helm

Réglages → Préférences → **Synchronisation** : mode « Serveur », adresse
`https://sync.exemple.fr`, le jeton du fichier `.env`, et une phrase de passe (la même sur tous
tes PC). Helm synchronise au démarrage, toutes les 5 minutes et sur demande.

## API

| Méthode | Chemin      | Rôle                                                                 |
| ------- | ----------- | -------------------------------------------------------------------- |
| GET     | `/health`   | État du service (sans jeton).                                        |
| GET     | `/v1/state` | Dernière version : `{ rev, updated, data }`, 404 s'il n'y a rien.    |
| PUT     | `/v1/state` | `{ baseRev, data }` : enregistré si `baseRev` est la révision actuelle, sinon 409. |

Authentification : en-tête `Authorization: Bearer <jeton>`.

## Sauvegarde

Les données sont dans le volume `helm-sync-data` (un fichier par jeton). Elles sont chiffrées :
les sauvegarder ne pose pas de problème de confidentialité, mais sans la phrase de passe elles
sont illisibles, y compris pour toi.
