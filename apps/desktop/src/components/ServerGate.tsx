// Porte d'entrée des sections propres à un serveur (Supervision, Fichiers, Docker…).
// Avant, chaque vue remplaçait toute la page par « Non connecté » ou « Connexion… » : on perdait
// le titre, le serveur concerné et le moyen de réparer. Ici l'en-tête reste, et l'état explique
// ce qui se passe avec les boutons qui débloquent.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, PlugZap, ServerOff } from "lucide-react";
import { ensureConnected, useApp } from "../lib/store";
import { useShell } from "../lib/shell";
import type { ServerView } from "../lib/api";
import type { GuideId } from "../lib/guides";
import PageLayout from "./PageLayout";
import { Button, EmptyState, StatusDot } from "./ui";
import { useDoctor } from "./ConnectionDoctor";

type Phase = "connecting" | "ready" | "failed";

/** Rappel du serveur affiché au-dessus du titre des pages. */
export function ServerContext({ server }: { server: ServerView }) {
  return (
    <span className="flex items-center gap-1.5">
      <StatusDot tone={server.connected ? "ok" : "muted"} />
      <span className="font-medium text-fg/85">{server.name}</span>
    </span>
  );
}

export default function ServerGate({ title, guide, children }: { title: string; guide?: GuideId; children: (serverId: string, server: ServerView) => ReactNode }) {
  const serverId = useApp((s) => s.activeServerId);
  const server = useApp((s) => s.servers.find((x) => x.id === s.activeServerId));
  const setSwitcher = useShell((s) => s.setSwitcherOpen);
  const setSection = useApp((s) => s.setSection);
  const [phase, setPhase] = useState<Phase>("connecting");

  const connect = useCallback(
    async (force = false) => {
      if (!serverId) return;
      setPhase("connecting");
      setPhase((await ensureConnected(serverId, { force })) ? "ready" : "failed");
    },
    [serverId],
  );

  useEffect(() => {
    if (!serverId) return;
    // Déjà connecté : pas d'écran intermédiaire.
    if (useApp.getState().servers.find((x) => x.id === serverId)?.connected) setPhase("ready");
    void connect();
  }, [serverId, connect]);

  if (!serverId || !server) {
    return (
      <PageLayout title={title} guide={guide}>
        <EmptyState
          icon={<ServerOff />}
          title="Aucun serveur sélectionné"
          action={
            <>
              <Button variant="primary" onClick={() => setSwitcher(true)}>
                Choisir un serveur
              </Button>
              <Button onClick={() => setSection("servers")}>Gérer les serveurs</Button>
            </>
          }
        >
          Cette section agit sur un serveur précis. Choisis-le en haut de la barre latérale.
        </EmptyState>
      </PageLayout>
    );
  }

  if (phase !== "ready") {
    return (
      <PageLayout title={title} guide={guide} context={<ServerContext server={server} />} subtitle={`${server.username}@${server.host}`}>
        {phase === "connecting" ? (
          <EmptyState icon={<Loader2 className="animate-spin" />} title={`Connexion à ${server.name}…`}>
            Ouverture de la session SSH. Les fenêtres de validation (clé d'hôte, mot de passe) s'affichent si besoin.
          </EmptyState>
        ) : (
          <EmptyState
            icon={<PlugZap />}
            title={`${server.name} n'est pas connecté`}
            action={
              <>
                <Button variant="primary" onClick={() => void connect(true)}>
                  Se connecter
                </Button>
                <Button onClick={() => useDoctor.getState().open(server.id)}>Diagnostiquer</Button>
                <Button variant="ghost" onClick={() => setSwitcher(true)}>
                  Changer de serveur
                </Button>
              </>
            }
          >
            La connexion n'a pas abouti ou a été annulée. « Diagnostiquer » vérifie le réseau, le port SSH et un éventuel bannissement fail2ban.
          </EmptyState>
        )}
      </PageLayout>
    );
  }

  return <>{children(serverId, server)}</>;
}
