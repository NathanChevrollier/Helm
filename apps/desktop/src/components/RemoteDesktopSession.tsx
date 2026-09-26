// Session de bureau à distance affichée dans Helm, sans client externe.
//
// Le rendu et les entrées sont assurés par le composant web d'IronRDP (WebAssembly) ; Helm lui
// fournit l'adresse du pont local, le jeton et les identifiants, et ajoute la barre d'outils :
// Ctrl+Alt+Suppr, presse-papiers, taille d'affichage, disposition du clavier, plein écran, et
// transfert de fichiers par le presse-papiers RDP (copier sur la machine → enregistrer sur le PC,
// envoyer ou déposer un fichier du PC → le coller sur la machine). Le texte et les images passent
// déjà par le presse-papiers automatique du composant.
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { FileInfo, RdpFileTransferProvider as TransferProvider, TransferProgress } from "@devolutions/iron-remote-desktop-rdp";
import { ClipboardPaste, FileDown, FileUp, Keyboard, Maximize2, Minimize2, Power, RefreshCw, ScanLine, Type, X } from "lucide-react";
import { useRdp } from "../lib/rdp";
import { useApp } from "../lib/store";
import { formatBytes } from "../lib/api";
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
  /** À appeler avant `connect()` : active le transfert de fichiers par le presse-papiers. */
  enableFileTransfer?: (provider: TransferProvider) => TransferProvider;
}

/** Chargement unique du module WebAssembly : il pèse plusieurs méga-octets. */
let modulePret: Promise<{
  Backend: unknown;
  displayControl: (b: boolean) => unknown;
  FileTransfer: typeof TransferProvider;
}> | null = null;

function chargerClient() {
  modulePret ??= (async () => {
    const [rdp] = await Promise.all([import("@devolutions/iron-remote-desktop-rdp"), import("@devolutions/iron-remote-desktop")]);
    await rdp.init("info");
    return { Backend: rdp.Backend, displayControl: rdp.displayControl, FileTransfer: rdp.RdpFileTransferProvider };
  })();
  return modulePret;
}

/** Enregistre sur le PC un fichier reçu de la machine distante (le nom est assaini côté Rust). */
async function enregistrer(dossier: string, nom: string, blob: Blob): Promise<string> {
  const octets = new Uint8Array(await blob.arrayBuffer());
  return invoke<string>("save_binary_file", octets, {
    headers: { "x-helm-dir": encodeURIComponent(dossier), "x-helm-name": encodeURIComponent(nom) },
  });
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
  /** Transfert de fichiers : fournisseur du composant, fichiers copiés sur la machine, progression. */
  const transfertRef = useRef<TransferProvider | null>(null);
  const [fichiersDistants, setFichiersDistants] = useState<FileInfo[] | null>(null);
  const [progression, setProgression] = useState<{ nom: string; pct: number; sens: "envoi" | "réception" } | null>(null);
  const [depot, setDepot] = useState(false);

  // Montage du composant web et connexion, une fois la session ouverte côté Rust.
  useEffect(() => {
    if (!session || !hote.current) return;
    let annule = false;
    const conteneur = hote.current;

    void (async () => {
      try {
        const { Backend, displayControl, FileTransfer } = await chargerClient();
        if (annule) return;
        const el = document.createElement("iron-remote-desktop") as HTMLElement & { module?: unknown };
        el.setAttribute("scale", "fit");
        el.setAttribute("flexcenter", "true");
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.display = "block";
        el.module = Backend;

        el.addEventListener("ready", (event) => {
          const detail = (event as CustomEvent).detail as (UserInteraction & { irgUserInteraction?: UserInteraction }) | undefined;
          const ui = (detail?.irgUserInteraction ?? detail) as UserInteraction;
          uiRef.current = ui;
          ui.onWarningCallback?.((m) => console.warn("[RDP]", m));
          ui.setEnableClipboard?.(true);
          // Le presse-papiers suit dans les deux sens, comme dans un client RDP courant.
          ui.setEnableAutoClipboard?.(true);
          ui.setKeyboardUnicodeMode?.(true);

          // Transfert de fichiers : à activer avant la connexion, sinon la machine ne l'annonce pas.
          if (ui.enableFileTransfer) {
            const transfert = new FileTransfer({ chunkSize: 64 * 1024 });
            transfertRef.current = ui.enableFileTransfer(transfert);
            const suivre = (sens: "envoi" | "réception") => (p: TransferProgress) =>
              !annule && setProgression(p.percentage >= 100 ? null : { nom: p.fileName, pct: Math.round(p.percentage), sens });
            transfert.on("files-available", (files) => !annule && setFichiersDistants(files.length > 0 ? files : null));
            transfert.on("download-progress", suivre("réception"));
            transfert.on("upload-progress", suivre("envoi"));
            transfert.on("upload-complete", (file) => {
              if (annule) return;
              setProgression(null);
              useApp.getState().notify(`« ${file.name} » est prêt : colle-le (Ctrl+V) dans l'explorateur de la machine.`, "success");
            });
            transfert.on("error", (e) => {
              if (annule) return;
              setProgression(null);
              useApp.getState().notify(`Transfert${e.fileName ? ` de « ${e.fileName} »` : ""} impossible : ${e.message}`, "error");
            });
          }

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
              ui.setVisibility?.(true);
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
      transfertRef.current?.dispose();
      transfertRef.current = null;
      setFichiersDistants(null);
      setProgression(null);
      uiRef.current?.shutdown?.();
      uiRef.current = null;
      conteneur.replaceChildren();
    };
  }, [session, setState]);

  // Fichiers glissés depuis l'explorateur du PC : Tauri les intercepte (le glisser-déposer HTML
  // ne reçoit rien), on relit donc leur contenu côté Rust avant de les confier au transfert.
  useEffect(() => {
    if (state.kind !== "connecte") return;
    let fin: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(async (event) => {
        const p = event.payload;
        if (p.type === "leave") return setDepot(false);
        const { x, y } = p.position;
        const el = document.elementFromPoint(x / window.devicePixelRatio, y / window.devicePixelRatio);
        const dedans = !!el && !!hote.current?.parentElement?.contains(el);
        if (p.type !== "drop") return setDepot(dedans);
        setDepot(false);
        if (!dedans || !transfertRef.current) return;
        try {
          const fichiers = await Promise.all(
            p.paths.map(async (chemin) => {
              const octets = await invoke<ArrayBuffer>("read_local_file", { path: chemin });
              return new File([octets], chemin.split(/[\\/]/).pop() || "fichier");
            }),
          );
          transfertRef.current.uploadFiles(fichiers);
        } catch (e) {
          useApp.getState().notify(e instanceof Error ? e.message : String(e), "error");
        }
      })
      .then((f) => (fin = f));
    return () => fin?.();
  }, [state.kind]);

  /** Enregistre sur le PC les fichiers copiés sur la machine distante. */
  const recevoir = async () => {
    const transfert = transfertRef.current;
    const fichiers = fichiersDistants;
    if (!transfert || !fichiers) return;
    const dossier = await openDialog({ directory: true, title: "Dossier où enregistrer les fichiers copiés" });
    if (typeof dossier !== "string") return;
    setFichiersDistants(null);
    const { notify } = useApp.getState();
    let ok = 0;
    // Les sous-dossiers d'une copie sont aplatis : le chemin vient de la machine distante et
    // n'est jamais utilisé pour créer des dossiers sur le PC.
    for (const [i, f] of fichiers.entries()) {
      try {
        const blob = await transfert.downloadFile(f, i).completion;
        await enregistrer(dossier, f.name, blob);
        ok++;
      } catch (e) {
        notify(`« ${f.name} » : ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
    setProgression(null);
    if (ok > 0) notify(`${ok} fichier(s) enregistré(s) dans ${dossier}.`, "success");
  };

  /** Choisit des fichiers du PC et les place dans le presse-papiers de la machine distante. */
  const envoyer = async () => {
    const transfert = transfertRef.current;
    if (!transfert) return;
    try {
      const fichiers = await transfert.showFilePicker({ multiple: true });
      if (fichiers.length > 0) transfert.uploadFiles(fichiers);
    } catch (e) {
      useApp.getState().notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // La machine distante suit la taille de la zone d'affichage (un envoi après la fin du geste).
  useEffect(() => {
    if (state.kind !== "connecte" || !hote.current) return;
    const cible = hote.current;
    let minuteur: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (minuteur) clearTimeout(minuteur);
      minuteur = setTimeout(() => {
        const { width, height } = cible.getBoundingClientRect();
        if (width > 100 && height > 100) {
          const w = Math.floor(width / 16) * 16;
          const h = Math.floor(height / 16) * 16;
          uiRef.current?.resize?.(w, h);
        }
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
          <IconButton title="Envoyer Ctrl+Alt+Suppr" disabled={!connecte} onClick={() => uiRef.current?.ctrlAltDel?.()}>
            <Keyboard size={15} />
          </IconButton>
          <IconButton title="Coller dans la machine (Ctrl+V)" disabled={!connecte} onClick={() => uiRef.current?.ctrlV?.()}>
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton
            title="Envoyer des fichiers du PC (puis Ctrl+V dans l'explorateur de la machine) — ou glisse-les sur la session"
            disabled={!connecte || !transfertRef.current}
            onClick={() => void envoyer()}
          >
            <FileUp size={15} />
          </IconButton>
          <IconButton
            title={unicode ? "Clavier : caractères (adapté au clavier français) — cliquer pour envoyer les touches brutes" : "Clavier : touches brutes — cliquer pour envoyer les caractères"}
            className={unicode ? "text-accent" : ""}
            disabled={!connecte}
            onClick={() => {
              const suivant = !unicode;
              setUnicode(suivant);
              uiRef.current?.setKeyboardUnicodeMode?.(suivant);
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
              uiRef.current?.setScale?.(suivant ? ECHELLE_AJUSTEE : ECHELLE_REELLE);
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

      {(fichiersDistants || progression) && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-accent/5 px-3 py-1.5 text-xs">
          {progression ? (
            <>
              <span className="min-w-0 truncate">
                {progression.sens === "envoi" ? "Envoi" : "Réception"} de « {progression.nom} »
              </span>
              <span className="h-1.5 w-40 overflow-hidden rounded-full bg-border">
                <span className="block h-full bg-accent transition-all" style={{ width: `${progression.pct}%` }} />
              </span>
              <span className="tabular-nums text-muted">{progression.pct} %</span>
            </>
          ) : (
            fichiersDistants && (
              <>
                <FileDown size={14} className="text-accent" />
                <span className="min-w-0 truncate">
                  {fichiersDistants.length} fichier(s) copié(s) sur la machine ({formatBytes(fichiersDistants.reduce((n, f) => n + f.size, 0))})
                </span>
                <Button size="sm" variant="primary" onClick={() => void recevoir()}>
                  Enregistrer sur le PC
                </Button>
                <button className="ml-auto text-muted hover:text-fg" title="Ignorer" onClick={() => setFichiersDistants(null)}>
                  <X size={13} />
                </button>
              </>
            )
          )}
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={hote} className={`size-full ${connecte ? "" : "invisible"}`} />
        {depot && (
          <div className="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-accent/10">
            <span className="flex items-center gap-2 rounded-md bg-panel px-3 py-2 text-sm shadow-lg">
              <FileUp size={15} className="text-accent" /> Déposer pour envoyer, puis Ctrl+V dans l'explorateur de la machine
            </span>
          </div>
        )}

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
