# Faux VPS de test : sshd + nginx + sudo + client Docker (branché sur un démon Docker privé, voir docker-compose.yml).
# tmux, restic et ufw ne sont volontairement PAS installés : ça permet de tester les installations depuis Helm.
FROM ubuntu:24.04

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       openssh-server nginx sudo ca-certificates curl procps iproute2 openssl python3 \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# root/helm et deploy/deploy (sudoer avec mot de passe), comme sur un vrai VPS.
RUN echo 'root:helm' | chpasswd \
    && useradd -m -s /bin/bash -G sudo deploy \
    && echo 'deploy:deploy' | chpasswd \
    && mkdir -p /run/sshd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config

# Un site d'exemple en reverse proxy + un faux certificat, pour tester le module Sites.
COPY demo.conf /etc/nginx/sites-available/demo.example.com
RUN ln -s /etc/nginx/sites-available/demo.example.com /etc/nginx/sites-enabled/ \
    && mkdir -p /etc/letsencrypt/live/demo.example.com \
    && openssl req -x509 -newkey rsa:2048 -nodes -days 45 -subj "/CN=demo.example.com" \
       -keyout /etc/letsencrypt/live/demo.example.com/privkey.pem \
       -out /etc/letsencrypt/live/demo.example.com/fullchain.pem

# Projet compose de démo (port publié sur toutes les interfaces, à « restreindre » depuis Helm).
COPY whoami-compose.yml /opt/whoami/docker-compose.yml

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
CMD ["/entrypoint.sh"]
