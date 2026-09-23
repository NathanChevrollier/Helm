// Session de bureau à distance affichée dans Helm, sans client externe.
//
// Le rendu et les entrées sont assurés par le composant web d'IronRDP (WebAssembly) ; Helm lui
// fournit l'adresse du pont local, le jeton et les identifiants, et ajoute la barre d'outils :
// Ctrl+Alt+Suppr, presse-papiers, plein écran, ajustement de l'image, déconnexion.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Keyboard, Maximize2, Minimize2, Power, RefreshCw, ScanLine } from "lucide-react";
import { useRdp } from "../lib/rdp";
import { useApp } from "../lib/store";
import { Button, FOCUS_RING, IconButton } from "./ui";

/** Méthodes du composant web utilisées ici (le paquet expose ses types, on ne garde que l'utile). */
interface UserInteraction {
  configBuilder: () => {
    withUsername: (v: string) => unknown;
    withPassword: (v: string) => unknown;
    withDestination: (v: string) => unknown;
    withProxyAddress: (v: string) => unknown;
    withAuthToken: (v: string) => unknown;
    withServerDomain: (v: string) => unknown;
    withDesktopSize: (v: { width: number; height: number }) => unknown;
    withExtension: (v: unknown) => unknown;
    build: () => unknown;
  };
  connect: (config: unknown) => Promise<unknown>;
  ctrlAltDel: () => void;
  ctrlC: () => void;
  ctrlV: () => void;
  shutdown: () => void;
  setScale: (scale: number) => void;
  setEnableClipboard: (enable: boolean) => void;
  setVisibility: (state: boolean) => void;
  resize: (width: number, height: number, scale?: number) => void;
  onWarningCallback: (cb: (message: string) => void) => void;
}

/** Chargement unique du module WebAssembly : il pèse plusieurs méga-octets. */
let modulePret: Promise<{ Backend: unknown; displayControl: (b: boolean) => unknown }> | null = null;

function chargerClient() {
  modulePret ??= (async () => {
    const [rdp] = await Promise.all([import("@devolutions/iron-remote-desktop-rdp"), import("@devolutions/iron-remote-desktop")]);
    await rdp.init("info");
    return { Backend: rdp.Backend, displayControl: rdp.displayControl };
  })();
  return modulePret;
}

export default function RemoteDesktopSession() {
  const { desktop, session, state, setState, close } = useRdp();
  const notify = useApp((s) => s.notify);
  const hote = useRef<HTMLDivElement>(null);
  const uiRef = useRef<UserInteraction | null>(null);
  const [plein, setPlein] = useState(false);
  const [ajuste, setAjuste] = useState(true);

  // Montage du composant web et connexion, une fois la session ouverte côté Rust.
  useEffect(() => {
    if (!session || !hote.current) return;
    let annule = false;
    const conteneur = hote.current;

    void (async () => {
      try {
        const { Backend, displayControl } = await chargerClient();
        if (annule) return;
        const el = document.createElement("iron-remote-desktop") as HTMLElement & { module?: unknown };
        el.setAttribute("scale", "fit");
        el.setAttribute("flexcenter", "true");
        el.style.width = "100%";
        el.style.height = "100%";
        el.module = Backend;
        el.addEventListener("ready", (event) => {
          const ui = (event as CustomEvent<UserInteraction>).detail;
          uiRef.current = ui;
          ui.onWarningCallback((m) => console.warn("[RDP]", m));
          const suite = ui.configBuilder();
          suite.withUsername(session.username);
          suite.withPassword(session.password);
          suite.withDestination(session.destination);
          suite.withProxyAddress(session.proxyUrl);
          suite.withAuthToken(session.token);
          if (session.domain) suite.withServerDomain(session.domain);
          suite.withDesktopSize({ width: session.width, height: session.height });
          // Redimensionnement dynamique : la machine suit la taille de la fenêtre.
          suite.withExtension(displayControl(true));
          ui.setEnableClipboard(true);
          ui.connect(suite.build()).then(
            () => !annule && setState({ kind: "connecte" }),
            (e: unknown) => !annule && setState({ kind: "erreur", message: messageErreur(e) }),
          );
        });
        el.addEventListener("sessionterminated", (event) => {
          const detail = (event as CustomEvent<{ reason?: string }>).detail;
          if (!annule) setState({ kind: "ferme", message: detail?.reason ?? "Session terminée par la machine distante." });
        });
        conteneur.appendChild(el);
      } catch (e) {
        if (!annule) setState({ kind: "erreur", message: messageErreur(e) });
      }
    })();

    return () => {
      annule = true;
      uiRef.current?.shutdown();
      uiRef.current = null;
      conteneur.replaceChildren();
    };
  }, [session, setState]);

  // Échap quitte le plein écran ; le reste du clavier appartient à la machine distante.
  useEffect(() => {
    if (!plein) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlein(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plein]);

  if (!desktop) return null;

  const etat =
    state.kind === "connecte"
      ? "connecté"
      : state.kind === "connexion"
        ? "connexion…"
        : state.kind === "ouverture"
          ? "ouverture du pont…"
          : state.kind === "erreur"
            ? "échec"
            : "terminée";

  return (
    <div className={`${plein ? "fixed inset-0 z-50" : "absolute inset-0"} flex flex-col bg-bg`}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="font-medium">{desktop.name}</span>
        <span className="text-xs text-muted">
          {desktop.username}@{desktop.host}
          {session?.viaTunnel ? " · via un tunnel SSH" : ""} · {etat}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton title="Envoyer Ctrl+Alt+Suppr" disabled={state.kind !== "connecte"} onClick={() => uiRef.current?.ctrlAltDel()}>
            <Keyboard size={15} />
          </IconButton>
          <IconButton title="Coller dans la machine (Ctrl+V)" disabled={state.kind !== "connecte"} onClick={() => uiRef.current?.ctrlV()}>
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton
            title={ajuste ? "Afficher à la taille réelle" : "Ajuster à la fenêtre"}
            disabled={state.kind !== "connecte"}
            onClick={() => {
              const suivant = !ajuste;
              setAjuste(suivant);
              // 1 = ajusté à la fenêtre, 2 = taille réelle (valeurs du composant).
              uiRef.current?.setScale(suivant ? 1 : 2);
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
        <div ref={hote} className={`size-full ${state.kind === "connecte" ? "" : "invisible"}`} />

        {state.kind !== "connecte" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            {(state.kind === "ouverture" || state.kind === "connexion") && (
              <>
                <RefreshCw size={28} className="animate-spin text-accent" />
                <p className="text-sm text-muted">
                  {state.kind === "ouverture" ? "Préparation de la connexion…" : `Connexion à ${desktop.host}…`}
                </p>
              </>
            )}
            {(state.kind === "erreur" || state.kind === "ferme") && (
              <>
                <p className={`max-w-lg text-sm ${state.kind === "erreur" ? "text-danger" : "text-muted"}`}>{state.message}</p>
                <div className="flex gap-2">
                  <Button
                    icon={<RefreshCw size={13} />}
                    onClick={() => {
                      void useRdp.getState().open(desktop);
                    }}
                  >
                    Réessayer
                  </Button>
                  <Button variant="ghost" onClick={close}>
                    Fermer
                  </Button>
                </div>
                {state.kind === "erreur" && (
                  <button
                    className={`text-xs text-muted underline ${FOCUS_RING}`}
                    onClick={() => notify("Le client externe reste disponible depuis la fiche du bureau à distance.", "info")}
                  >
                    Pourquoi ?
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function messageErreur(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const o = e as { backtrace?: () => string; kind?: () => string } | null;
  if (o && typeof o.backtrace === "function") return o.backtrace();
  return "Connexion impossible.";
}
