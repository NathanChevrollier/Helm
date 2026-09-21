# Deuxième faux VPS, fidèle à un VPS Debian réel : c'est lui qui a révélé les bugs que le premier
# (Ubuntu, connexion en root) masquait.
#   - Debian 12, SSH sur un port non standard (6666), root interdit en SSH ;
#   - utilisateur admin/admin, sudo AVEC mot de passe ; /usr/sbin absent de son PATH ;
#   - fail2ban actif : 3 échecs en 10 min = bannissement de 10 min (vraie règle iptables) ;
#   - nginx et ufw installés (ufw inactif), sans tmux ni Docker.
FROM debian:12

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       openssh-server rsyslog nginx sudo ufw fail2ban iptables python3-systemd procps iproute2 ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash -G sudo admin \
    && echo 'admin:admin' | chpasswd \
    && echo 'root:root-interdit-en-ssh' | chpasswd \
    && mkdir -p /run/sshd \
    && sed -i 's/^#\?Port .*/Port 6666/; s/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && printf 'LogLevel VERBOSE\n' > /etc/ssh/sshd_config.d/10-test.conf \
    && sed -i 's/^module(load="imklog")/#&/' /etc/rsyslog.conf

COPY jail.local /etc/fail2ban/jail.local
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 6666
CMD ["/entrypoint.sh"]
