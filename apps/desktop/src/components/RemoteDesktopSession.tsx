// Session de bureau à distance affichée dans Helm, sans client externe.
//
// Le rendu et les entrées sont assurés par le composant web d'IronRDP (WebAssembly) ; Helm lui
// fournit l'adresse du pont local, le jeton et les identifiants, et ajoute la barre d'outils :
// Ctrl+Alt+Suppr, presse-papiers, taille d'affichage, disposition du clavier, plein écran.
import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Keyboard, Maximize2, Minimize2, Power, RefreshCw, ScanLine, Type } from "lucide-react";
import { useRdp } from "../lib/rdp";
import { Button, IconButton } from "./ui";

/** Taille d'affichage (valeurs du composant web). */
const ECHELLE_AJUSTEE = 1;
const ECHELLE_REELLE = 3;

/** Méthodes du composant web utilisées ici. */
interface ConfigBuilder {
  withUsername: (v: string) => ConfigBuilder;
  withPassword: (v: string) => ConfigBuilder;
  withDestination: (v: string) => ConfigBuilder;
  withProxyAddress: (v: string) => ConfigBuilder;
  withAuthToken: (v: string) => ConfigBuilder;
  withServerDomain: (v: string) => ConfigBuilder;
  withDesktopSize: (v: { width: number; height: number }) => ConfigBuilder;
  withExtension: (v: unknown) => ConfigBuilder;
  build: () => unknown;
}

/** Session en cours : `run()` ne rend la main qu'à la fin de la session. */
interface NewSessionInfo {
  run: () => Promise<{ reason: () => string }>;
}

interface UserInteraction {
  configBuilder: () => ConfigBuilder;
  connect: (config: unknown) => Promise<NewSessionInfo>;
  ctrlAltDel: () => void;
  ctrlC: () => void;
  ctrlV: () => void;
  metaKey: () => void;
  shutdown: () => void;
  setScale: (scale: number) => void;
  setEnableClipboard: (enable: boolean) => void;
  setEnableAutoClipboard: (enable: boolean) => void;
  setKeyboardUnicodeMode: (useUnicode: boolean) => void;
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
  const hote = useRef<HTMLDivElement>(null);
  const uiRef = useRef<UserInteraction | null>(null);
  const [plein, setPlein] = useState(false);
  const [ajuste, setAjuste] = useState(true);
  // Clavier : en mode Unicode, les caractères partent tels quels — indispensable pour un clavier
  // français (AltGr, accents) quand la machine distante est en disposition différente.
  const [unicode, setUnicode] = useState(true);

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
          ui.setEnableClipboard(true);
          // Le presse-papiers suit dans les deux sens, comme dans un client RDP courant.
          ui.setEnableAutoClipboard(true);
          ui.setKeyboardUnicodeMode(true);

          const config = ui
            .configBuilder()
            .withUsername(session.username)
            .withPassword(session.password)
            .withDestination(session.destination)
            .withProxyAddress(session.proxyUrl)
            .withAuthToken(session.token)
            .withDesktopSize({ width: session.width, height: session.height })
            // Redimensionnement dynamique : la machine suit la taille de la fenêtre.
            .withExtension(displayControl(true));
          if (session.domain) config.withServerDomain(session.domain);

          ui.connect(config.build()).then(
            async (info) => {
              if (annule) return;
              setState({ kind: "connecte" });
              // `run()` ne rend la main qu'à la fin de la session (fermeture, déconnexion, erreur).
              try {
                const fin = await info.run();
                if (!annule) setState({ kind: "ferme", message: fin.reason() || "Session terminée." });
              } catch (e) {
                if (!annule) setState({ kind: "erreur", message: messageErreur(e) });
              }
            },
            (e: unknown) => !annule && setState({ kind: "erreur", message: messageErreur(e) }),
          );
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

  // La machine distante suit la taille de la zone d'affichage (un envoi après la fin du geste).
  useEffect(() => {
    if (state.kind !== "connecte" || !hote.current) return;
    const cible = hote.current;
    let minuteur: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (minuteur) clearTimeout(minuteur);
      minuteur = setTimeout(() => {
        const { width, height } = cible.getBoundingClientRect();
        if (width > 100 && height > 100) uiRef.current?.resize(Math.round(width), Math.round(height));
      }, 300);
    });
    observer.observe(cible);
    return () => {
      if (minuteur) clearTimeout(minuteur);
      observer.disconnect();
    };
  }, [state.kind]);

  // Échap quitte le plein écran ; le reste du clavier appartient à la machine distante.
  useEffect(() => {
    if (!plein) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPlein(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [plein]);

  if (!desktop) return null;
  const connecte = state.kind === "connecte";
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
        <span className="truncate text-xs text-muted">
          {desktop.username}@{desktop.host}
          {session?.viaTunnel ? " · via un tunnel SSH" : ""} · {etat}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton title="Envoyer Ctrl+Alt+Suppr" disabled={!connecte} onClick={() => uiRef.current?.ctrlAltDel()}>
            <Keyboard size={15} />
          </IconButton>
          <IconButton title="Coller dans la machine (Ctrl+V)" disabled={!connecte} onClick={() => uiRef.current?.ctrlV()}>
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton
            title={unicode ? "Clavier : caractères (adapté au clavier français) — cliquer pour envoyer les touches brutes" : "Clavier : touches brutes — cliquer pour envoyer les caractères"}
            className={unicode ? "text-accent" : ""}
            disabled={!connecte}
            onClick={() => {
              const suivant = !unicode;
              setUnicode(suivant);
              uiRef.current?.setKeyboardUnicodeMode(suivant);
            }}
          >
            <Type size={15} />
          </IconButton>
          <IconButton
            title={ajuste ? "Afficher à la taille réelle" : "Ajuster à la fenêtre"}
            disabled={!connecte}
            onClick={() => {
              const suivant = !ajuste;
              setAjuste(suivant);
              uiRef.current?.setScale(suivant ? ECHELLE_AJUSTEE : ECHELLE_REELLE);
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
                    Vérifie que le Bureau à distance est activé sur la machine, que le compte a le droit de s'y connecter, et — si tu passes par
                    un serveur — que celui-ci joint bien {desktop.host}:{desktop.port}.
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

function messageErreur(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const o = e as { backtrace?: () => string; kind?: () => string } | null;
  if (o && typeof o.backtrace === "function") return o.backtrace();
  return "Connexion impossible.";
}
