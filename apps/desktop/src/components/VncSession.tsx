// Session VNC affichée dans Helm, sans client externe.
//
// Le rendu et les entrées sont assurés par noVNC ; Helm lui donne l'adresse du pont local (qui
// relaie le protocole RFB, à travers un tunnel SSH si la machine passe par un serveur) et ajoute
// la barre d'outils : Ctrl+Alt+Suppr, presse-papiers, qualité d'image, taille, lecture seule,
// plein écran.
//
// VNC ne chiffre souvent rien : c'est le tunnel SSH qui protège l'écran et le mot de passe quand
// la machine est hors du réseau local. L'interface le rappelle dès qu'une connexion est directe.
import { useEffect, useRef, useState } from "react";
import type RFB from "@novnc/novnc";
import { ClipboardPaste, Eye, Gauge, Keyboard, Maximize2, Minimize2, Power, RefreshCw, ScanLine, ShieldAlert } from "lucide-react";
import { readClipboard, writeClipboard } from "../lib/clipboard";
import { useRdp } from "../lib/rdp";
import { Button, IconButton, Select } from "./ui";

/**
 * Préréglages de qualité. noVNC demande au serveur une qualité JPEG et un niveau de compression :
 * sur une ligne lente, une image plus légère vaut mieux qu'un écran qui rame.
 */
const QUALITES = [
  { id: "latence", label: "Basse latence", qualite: 3, compression: 9, aide: "image allégée, pour une connexion lente ou mobile" },
  { id: "equilibre", label: "Équilibrée", qualite: 6, compression: 2, aide: "le réglage par défaut de noVNC" },
  { id: "max", label: "Qualité maximale", qualite: 9, compression: 0, aide: "sans perte visible, pour le réseau local" },
] as const;
type QualiteId = (typeof QUALITES)[number]["id"];

export default function VncSession() {
  const { desktop, vnc, state, setState, close } = useRdp();
  const hote = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [plein, setPlein] = useState(false);
  const [ajuste, setAjuste] = useState(true);
  const [lecture, setLecture] = useState(false);
  const [qualite, setQualite] = useState<QualiteId>("equilibre");
  const [nomDistant, setNomDistant] = useState<string | null>(null);

  // Connexion, une fois la session ouverte côté Rust (tunnel et pont prêts).
  useEffect(() => {
    if (!vnc || !hote.current) return;
    let annule = false;
    const conteneur = hote.current;

    void (async () => {
      try {
        // noVNC est chargé à la demande : il n'alourdit pas l'ouverture de l'app.
        const { default: RfbClass } = await import("@novnc/novnc");
        if (annule) return;
        const rfb = new RfbClass(conteneur, vnc.url, {
          shared: true,
          credentials: { username: vnc.username || undefined, password: vnc.password || undefined },
        });
        rfbRef.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.background = "var(--color-bg)";
        const q = QUALITES.find((x) => x.id === "equilibre")!;
        rfb.qualityLevel = q.qualite;
        rfb.compressionLevel = q.compression;

        rfb.addEventListener("connect", () => {
          if (annule) return;
          setState({ kind: "connecte" });
          rfb.focus();
        });
        rfb.addEventListener("disconnect", (e) => {
          if (annule) return;
          const propre = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
          setState(propre ? { kind: "ferme", message: "Session terminée." } : { kind: "erreur", message: "La connexion VNC a été interrompue." });
        });
        rfb.addEventListener("securityfailure", (e) => {
          if (annule) return;
          const d = (e as CustomEvent<{ status: number; reason?: string }>).detail;
          setState({ kind: "erreur", message: d?.reason ? `Authentification refusée : ${d.reason}` : "Authentification refusée par la machine (mot de passe VNC incorrect ?)." });
        });
        // La machine demande des identifiants alors qu'aucun n'est enregistré dans Helm.
        rfb.addEventListener("credentialsrequired", (e) => {
          if (annule) return;
          const types = (e as CustomEvent<{ types: string[] }>).detail?.types ?? [];
          const manque = types.filter((t) => (t === "password" && !vnc.password) || (t === "username" && !vnc.username));
          if (manque.length === 0) {
            rfb.sendCredentials({ username: vnc.username, password: vnc.password });
            return;
          }
          setState({
            kind: "erreur",
            message: `La machine demande ${manque.includes("username") ? "un utilisateur et " : ""}un mot de passe VNC : enregistre-les dans le profil du bureau, puis réessaie.`,
          });
          rfb.disconnect();
        });
        // Texte copié sur la machine distante → presse-papiers du PC.
        rfb.addEventListener("clipboard", (e) => {
          const texte = (e as CustomEvent<{ text: string }>).detail?.text;
          if (texte) void writeClipboard(texte).catch(() => {});
        });
        rfb.addEventListener("desktopname", (e) => setNomDistant((e as CustomEvent<{ name: string }>).detail?.name ?? null));
      } catch (e) {
        if (!annule) setState({ kind: "erreur", message: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      annule = true;
      try {
        rfbRef.current?.disconnect();
      } catch {
        /* déjà fermée */
      }
      rfbRef.current = null;
      conteneur.replaceChildren();
    };
  }, [vnc, setState]);

  // Échap quitte le plein écran ; le reste du clavier appartient à la machine distante.
  useEffect(() => {
    if (!plein) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlein(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plein]);

  if (!desktop) return null;
  const connecte = state.kind === "connecte";
  const etat = { connecte: "connecté", connexion: "connexion…", ouverture: "ouverture du pont…", erreur: "échec", ferme: "terminée" }[state.kind];

  const choisirQualite = (id: QualiteId) => {
    const q = QUALITES.find((x) => x.id === id)!;
    setQualite(id);
    if (rfbRef.current) {
      rfbRef.current.qualityLevel = q.qualite;
      rfbRef.current.compressionLevel = q.compression;
    }
  };

  return (
    <div className={`${plein ? "fixed inset-0 z-50" : "absolute inset-0"} flex flex-col bg-bg`}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="font-medium">{desktop.name}</span>
        <span className="truncate text-xs text-muted">
          VNC · {nomDistant ?? desktop.host}
          {vnc?.viaTunnel ? " · via un tunnel SSH" : ""} · {etat}
        </span>
        {vnc && !vnc.viaTunnel && (
          <span className="flex items-center gap-1 text-[11px] text-warn" title="VNC ne chiffre généralement rien : hors du réseau local, passe par un serveur SSH (profil du bureau).">
            <ShieldAlert size={12} /> non chiffré
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          <label className="mr-1 flex items-center gap-1 text-xs text-muted" title={QUALITES.find((q) => q.id === qualite)?.aide}>
            <Gauge size={14} />
            <Select size="sm" value={qualite} disabled={!connecte} onChange={choisirQualite} aria-label="Qualité d'image" options={QUALITES.map((q) => ({ value: q.id, label: q.label }))} />
          </label>
          <IconButton title="Envoyer Ctrl+Alt+Suppr" disabled={!connecte || lecture} onClick={() => rfbRef.current?.sendCtrlAltDel()}>
            <Keyboard size={15} />
          </IconButton>
          <IconButton
            title="Envoyer le presse-papiers du PC à la machine"
            disabled={!connecte || lecture}
            onClick={async () => {
              const texte = await readClipboard().catch(() => "");
              if (texte) rfbRef.current?.clipboardPasteFrom(texte);
            }}
          >
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton
            title={lecture ? "Lecture seule : cliquer pour reprendre la main" : "Passer en lecture seule (ni clavier ni souris envoyés)"}
            className={lecture ? "text-accent" : ""}
            disabled={!connecte}
            onClick={() => {
              const suivant = !lecture;
              setLecture(suivant);
              if (rfbRef.current) rfbRef.current.viewOnly = suivant;
            }}
          >
            <Eye size={15} />
          </IconButton>
          <IconButton
            title={ajuste ? "Afficher à la taille réelle" : "Ajuster à la fenêtre"}
            disabled={!connecte}
            onClick={() => {
              const suivant = !ajuste;
              setAjuste(suivant);
              if (rfbRef.current) {
                rfbRef.current.scaleViewport = suivant;
                rfbRef.current.clipViewport = !suivant;
              }
            }}
          >
            <ScanLine size={15} />
          </IconButton>
          <IconButton title={plein ? "Quitter le plein écran (Échap)" : "Plein écran"} onClick={() => setPlein((v) => !v)}>
            {plein ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </IconButton>
          <Button size="sm" variant="danger" icon={<Power size={13} />} onClick={close}>
            Déconnecter
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={hote} className={`size-full ${connecte ? "" : "invisible"}`} />

        {!connecte && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            {(state.kind === "ouverture" || state.kind === "connexion") && (
              <>
                <RefreshCw size={28} className="animate-spin text-accent" />
                <p className="text-sm text-muted">{state.kind === "ouverture" ? "Préparation de la connexion…" : `Connexion à ${desktop.host}…`}</p>
              </>
            )}
            {(state.kind === "erreur" || state.kind === "ferme") && (
              <>
                <p className={`max-w-xl text-sm leading-relaxed ${state.kind === "erreur" ? "text-danger" : "text-muted"}`}>{state.message}</p>
                {state.kind === "erreur" && (
                  <p className="max-w-xl text-xs leading-relaxed text-muted">
                    Vérifie qu'un serveur VNC tourne sur la machine (x11vnc, TigerVNC, wayvnc, Partage d'écran de macOS…), qu'il écoute sur le port{" "}
                    {desktop.port} et — si tu passes par un serveur — que celui-ci joint bien {desktop.host}:{desktop.port}.
                  </p>
                )}
                <div className="flex gap-2">
                  <Button icon={<RefreshCw size={13} />} onClick={() => void useRdp.getState().open(desktop)}>
                    Réessayer
                  </Button>
                  <Button variant="ghost" onClick={close}>
                    Fermer
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
