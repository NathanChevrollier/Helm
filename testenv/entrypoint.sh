#!/bin/sh
# Branche le client Docker sur le démon privé du faux VPS, prépare des applications de démo,
# puis lance nginx et sshd.

# Socket du démon Docker-in-Docker, partagé par volume.
for _ in $(seq 1 60); do
    [ -S /var/run/dind/docker.sock ] && break
    sleep 1
done
ln -sf /var/run/dind/docker.sock /var/run/docker.sock
chgrp sudo /var/run/dind/docker.sock 2>/dev/null && chmod g+rw /var/run/dind/docker.sock

nginx
/usr/sbin/sshd -e

# Applications de démo (idempotent : relancer le conteneur ne les duplique pas).
seed() {
    # Cible du site demo.example.com (vhost nginx déjà présent).
    docker inspect demo-app >/dev/null 2>&1 || docker run -d --name demo-app --restart unless-stopped -p 127.0.0.1:8081:80 nginx:alpine
    # Projet compose avec un port publié sur toutes les interfaces : pour tester « Restreindre ».
    (cd /opt/whoami && docker compose up -d)
    # Base MariaDB avec un volume : pour tester les sauvegardes, les tunnels et la restauration.
    docker inspect demo-db >/dev/null 2>&1 || docker run -d --name demo-db --restart unless-stopped \
        -e MARIADB_ROOT_PASSWORD=demo -e MARIADB_DATABASE=boutique -v demo-db-data:/var/lib/mysql \
        -p 127.0.0.1:3306:3306 mariadb:11
}
seed > /var/log/helm-seed.log 2>&1 &

# Le conteneur vit tant que sshd tourne.
exec tail -f /dev/null
