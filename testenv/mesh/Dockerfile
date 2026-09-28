# Serveur de test « membre d'un réseau privé » : pas de systemd, WireGuard à installer par Zenytt.
# Le module WireGuard vient du noyau de l'hôte (Docker Desktop, runners GitHub) : NET_ADMIN suffit.
FROM debian:bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo iproute2 iputils-ping procps \
    && mkdir -p /run/sshd \
    && echo 'root:zenytt' | chpasswd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config \
    && useradd -m -s /bin/bash -G sudo deploy && echo 'deploy:deploy' | chpasswd
# Listes apt gardées : Zenytt doit pouvoir installer wireguard-tools sans apt-get update.
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
