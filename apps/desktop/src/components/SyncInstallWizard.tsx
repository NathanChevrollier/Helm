// Installation assistée du serveur de synchronisation : choix du serveur et du mode (privé par SSH,
// ou public en HTTPS), vérifications, installation, puis phrase de passe et code d'appairage.
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, KeyRound, Loader2, Lock, Globe, XCircle } from "lucide-react";
import { api, errorMessage, type SyncServerStatus, type SyncTunnel, type WebEngine } from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { useApp } from "../lib/store";
import { runSync } from "../lib/sync";
import { generatePassphrase, validDomain } from "../lib/syncSetup";
import { Button, CodeBlock, Field, Input, Modal, Segmented, Select } from "./ui";

const EMAIL_KEY = "zenytt.certbotEmail";

type Mode = "private" | "public";
type StepState = "pending" | "running" | "done" | "warn" | "error" | "skipped";
interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

/** Vérifications faites avant d'installer, affichées telles quelles. */
interface Checks {
  status: SyncServerStatus;
  /** Mode public : serveur web détecté et dossier de sa configuration. */
  web?: { engine: WebEngine; confRoot: string; certbot: boolean } | null;
  /** Mode public : adresse vers laquelle pointe le sous-domaine, et adresse du serveur. */
  dns?: { resolved: string | null; publicIp: string | null };
}

function readEmail(): string {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

export default function SyncInstallWizard({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const notify = useApp((s) => s.notify);
  const servers = useApp((s) => s.servers);
  const activeServerId = useApp((s) => s.activeServerId);
  const [serverId, setServerId] = useState(activeServerId ?? servers[0]?.id ?? "");
  const [mode, setMode] = useState<Mode>("private");
  const [domain, setDomain] = useState("");
  const [email, setEmail] = useState(readEmail);
  const [checks, setChecks] = useState<Checks | null>(null);
  const [checking, setChecking] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [phase, setPhase] = useState<"setup" | "install" | "passphrase" | "done">("setup");
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [generated, setGenerated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<{ url: string | null; tunnel: SyncTunnel | null } | null>(null);
  const [pairing, setPairing] = useState<string | null>(null);

  useEffect(() => {
    void api.syncGet().then((v) => setHasPassphrase(v.hasPassphrase));
  }, []);
  // Toute modification des choix invalide les vérifications déjà faites.
  useEffect(() => setChecks(null), [serverId, mode, domain]);

  const serverName = servers.find((s) => s.id === serverId)?.name ?? "";
  const canCheck = !!serverId && (mode === "private" || (validDomain(domain) && email.includes("@")));

  const check = async () => {
    setChecking(true);
    try {
      const status = await api.syncServerStatus(serverId);
      if (mode === "private") {
        setChecks({ status });
        return;
      }
      // Serveur web : nginx d'abord, Apache sinon.
      const nginx = await api.sitesState(serverId, "nginx").catch(() => null);
      const apache = nginx?.installed ? null : await api.sitesState(serverId, "apache").catch(() => null);
      const found = nginx?.installed ? { engine: "nginx" as const, state: nginx } : apache?.installed ? { engine: "apache" as const, state: apache } : null;
      const [resolved, plan] = await Promise.all([api.sitesResolve(serverId, domain.trim()).catch(() => null), api.sitesPlan(serverId).catch(() => null)]);
      setChecks({
        status,
        web: found && { engine: found.engine, confRoot: found.state.confRoot, certbot: found.state.certbot },
        dns: { resolved, publicIp: plan?.publicIp ?? null },
      });
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setChecking(false);
    }
  };

  const blocking = !checks ? "vérification à faire" : !checks.status.docker ? "Docker absent" : mode === "public" && !checks.web ? "serveur web absent" : null;

  const install = async () => {
    if (!checks) return;
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch {
      /* préférence non sauvegardée */
    }
    const d = domain.trim().toLowerCase();
    const list: Step[] = [
      { label: checks.status.installed ? `Mettre à jour le serveur de synchronisation sur ${serverName}` : `Installer le serveur de synchronisation sur ${serverName}`, state: "pending" },
      { label: `Publier ${d} (${checks.web?.engine ?? "nginx"})`, state: mode === "public" ? "pending" : "skipped" },
      { label: "Obtenir le certificat HTTPS (Let's Encrypt)", state: mode === "public" ? "pending" : "skipped" },
      { label: "Régler ce PC", state: "pending" },
    ];
    setSteps([...list]);
    setPhase("install");
    const update = (i: number, patch: Partial<Step>) => {
      list[i] = { ...list[i], ...patch };
      setSteps([...list]);
    };

    update(0, { state: "running" });
    let port: number;
    try {
      port = (await api.syncServerInstall(serverId)).port;
      update(0, { state: "done", detail: `Conteneur zenytt-sync en marche, sur 127.0.0.1:${port} du serveur (aucun port ouvert).` });
    } catch (e) {
      update(0, { state: "error", detail: errorMessage(e) });
      return;
    }

    let next: { url: string | null; tunnel: SyncTunnel | null } = { url: null, tunnel: { serverId, port } };
    if (mode === "public" && checks.web) {
      const { engine, confRoot } = checks.web;
      update(1, { state: "running" });
      try {
        const preview = await api.sitesPreview(d, port, undefined, engine, confRoot);
        const r = await api.sitesWrite(serverId, preview.path, preview.vhost, preview.link ?? undefined, engine, engine === "apache");
        if (!r.ok) throw new Error(`${engine} a refusé la configuration (rien n'a été modifié) :\n${r.log}`);
        update(1, { state: "done", detail: preview.path });
      } catch (e) {
        update(1, { state: "error", detail: `${errorMessage(e)}\nLa synchronisation reste utilisable en mode privé.` });
        update(3, { state: "running" });
        return finishTarget(next, update);
      }
      update(2, { state: "running" });
      try {
        await api.sitesCertbot(serverId, d, email, engine);
        update(2, { state: "done", detail: "Certificat installé, renouvellement automatique." });
        next = { url: `https://${d}`, tunnel: null };
      } catch (e) {
        update(2, {
          state: "warn",
          detail: `Le certificat n'a pas pu être obtenu : vérifie que ${d} pointe vers ce serveur, puis relance l'installation. En attendant, la synchronisation passe en privé par SSH.\n${errorMessage(e)}`,
        });
      }
    }
    update(3, { state: "running" });
    await finishTarget(next, update);
  };

  /** Enregistre la destination de la synchronisation, puis enchaîne sur la phrase de passe. */
  const finishTarget = async (next: { url: string | null; tunnel: SyncTunnel | null }, update: (i: number, patch: Partial<Step>) => void) => {
    try {
      const current = await api.syncGet();
      await api.syncSet({ mode: "server", url: next.url, tunnel: next.tunnel, includeSecrets: current.includeSecrets });
      setTarget(next);
      update(3, { state: "done", detail: next.url ? `Synchronisation par ${next.url}` : `Synchronisation privée par tunnel SSH vers ${serverName}` });
      if (hasPassphrase) {
        await runSync(true);
        setPhase("done");
        onDone();
      } else {
        setPhase("passphrase");
      }
    } catch (e) {
      update(3, { state: "error", detail: errorMessage(e) });
    }
  };

  const savePassphrase = async () => {
    if (passphrase !== confirm) return notify("Les deux phrases de passe ne correspondent pas.", "error");
    setSaving(true);
    try {
      const current = await api.syncGet();
      await api.syncSet({ mode: "server", url: target?.url ?? null, tunnel: target?.tunnel ?? null, includeSecrets: current.includeSecrets, passphrase });
      await runSync(true);
      setPhase("done");
      onDone();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const showPairing = async () => {
    try {
      setPairing(await api.syncPairingCode());
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const icon = (s: StepState) =>
    s === "done" ? <CheckCircle2 size={16} className="text-ok" /> :
    s === "error" ? <XCircle size={16} className="text-danger" /> :
    s === "warn" ? <AlertTriangle size={16} className="text-warn" /> :
    s === "running" ? <Loader2 size={16} className="animate-spin text-accent" /> :
    <span className="block size-4 rounded-full border border-border" />;

  const installing = steps?.some((s) => s.state === "running");
  const failed = steps?.some((s) => s.state === "error") && phase === "install" && !installing;

  return (
    <Modal
      title="Installer mon serveur de synchronisation"
      width="max-w-2xl"
      onClose={() => !installing && onClose()}
      footer={
        phase === "setup" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            {checks ? (
              <Button variant="primary" disabled={!!blocking} onClick={() => void install()}>
                {checks.status.installed ? "Mettre à jour et configurer" : "Installer"}
              </Button>
            ) : (
              <Button variant="primary" loading={checking} disabled={!canCheck} onClick={() => void check()}>
                Vérifier
              </Button>
            )}
          </>
        ) : phase === "passphrase" ? (
          <Button variant="primary" loading={saving} disabled={passphrase.length < 10 || passphrase !== confirm} onClick={() => void savePassphrase()}>
            Terminer
          </Button>
        ) : (
          <Button variant={phase === "done" ? "primary" : "ghost"} disabled={!!installing} onClick={onClose}>
            {failed ? "Fermer" : "Terminé"}
          </Button>
        )
      }
    >
      {phase === "setup" && (
        <div className="flex flex-col gap-4">
          <Field label="Serveur qui héberge la synchronisation">
            <Select value={serverId} onChange={setServerId} options={servers.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Segmented
            label="Accès"
            value={mode}
            onChange={setMode}
            options={[
              { value: "private", label: "Privé, par SSH" },
              { value: "public", label: "Public, en HTTPS" },
            ]}
          />
          <p className="text-xs leading-relaxed text-muted">
            {mode === "private" ? (
              <>
                <Lock size={12} className="mr-1 inline" />
                Aucun port ouvert, pas de nom de domaine : tes PC joignent le serveur par un tunnel SSH, comme leurs autres connexions. Le partage de terminal avec quelqu'un sans accès SSH demande le mode public.
              </>
            ) : (
              <>
                <Globe size={12} className="mr-1 inline" />
                Un sous-domaine en HTTPS : nécessaire pour partager un terminal avec quelqu'un qui n'a pas accès au serveur. Le sous-domaine doit déjà pointer vers ce serveur (enregistrement DNS).
              </>
            )}
          </p>
          {mode === "public" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Sous-domaine">
                <Input value={domain} placeholder="sync.mondomaine.fr" onChange={(e) => setDomain(e.target.value)} />
              </Field>
              <Field label="E-mail (avertissements Let's Encrypt)">
                <Input value={email} placeholder="toi@exemple.fr" onChange={(e) => setEmail(e.target.value)} />
              </Field>
            </div>
          )}
          {checks && <CheckList checks={checks} mode={mode} domain={domain.trim()} />}
        </div>
      )}

      {(phase === "install" || (phase !== "setup" && steps)) && phase !== "passphrase" && phase !== "done" && steps && <StepList steps={steps} icon={icon} />}

      {phase === "passphrase" && (
        <div className="flex flex-col gap-3">
          {steps && <StepList steps={steps} icon={icon} />}
          <p className="text-sm">
            Dernière étape : la <strong>phrase de passe</strong> qui chiffre tes réglages avant qu'ils quittent ce PC. Le serveur ne la connaît pas : perdue, les données synchronisées sont illisibles. Note-la dans ton gestionnaire de mots de passe.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phrase de passe" hint="10 caractères minimum, la même sur tous tes PC.">
              <Input type={generated ? "text" : "password"} className={generated ? "font-mono" : ""} value={passphrase} autoComplete="new-password" onChange={(e) => {
                setGenerated(false);
                setPassphrase(e.target.value);
              }} />
            </Field>
            <Field label="Confirmation">
              <Input type={generated ? "text" : "password"} className={generated ? "font-mono" : ""} value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              icon={<KeyRound size={13} />}
              onClick={() => {
                const p = generatePassphrase();
                setPassphrase(p);
                setConfirm(p);
                setGenerated(true);
              }}
            >
              En générer une
            </Button>
            {generated && (
              <Button size="sm" icon={<Copy size={13} />} onClick={() => void writeClipboard(passphrase).then(() => notify("Phrase de passe copiée : note-la maintenant", "success"))}>
                Copier
              </Button>
            )}
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="flex flex-col gap-3">
          {steps && <StepList steps={steps} icon={icon} />}
          <p className="text-sm">
            La synchronisation est en place. Sur tes autres PC : Réglages → Synchronisation → <strong>Rejoindre avec un code</strong>, puis colle le code ci-dessous et ta phrase de passe.
          </p>
          {pairing ? (
            <CodeBlock
              code={pairing}
              className="max-h-40 overflow-auto break-all"
              actions={
                <Button size="sm" icon={<Copy size={13} />} onClick={() => void writeClipboard(pairing).then(() => notify("Code copié", "success"))}>
                  Copier
                </Button>
              }
            />
          ) : (
            <Button className="self-start" icon={<KeyRound size={14} />} onClick={() => void showPairing()}>
              Afficher le code pour un autre PC
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

function StepList({ steps, icon }: { steps: Step[]; icon: (s: StepState) => React.ReactNode }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {steps
        .filter((s) => s.state !== "skipped")
        .map((s) => (
          <li key={s.label} className="flex gap-2.5 text-sm">
            <span className="mt-0.5 shrink-0">{icon(s.state)}</span>
            <span className="min-w-0">
              <span className="block">{s.label}</span>
              {s.detail && <span className="block whitespace-pre-wrap text-xs text-muted">{s.detail}</span>}
            </span>
          </li>
        ))}
    </ol>
  );
}

function CheckList({ checks, mode, domain }: { checks: Checks; mode: Mode; domain: string }) {
  const line = (ok: boolean | "warn", text: string) => (
    <li className="flex items-start gap-2 text-sm">
      {ok === true ? <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ok" /> : ok === "warn" ? <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" /> : <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />}
      <span>{text}</span>
    </li>
  );
  const { status, web, dns } = checks;
  const dnsOk = !!dns?.resolved && !!dns.publicIp && dns.resolved === dns.publicIp;
  return (
    <ul className="flex flex-col gap-1.5 rounded-lg border border-border bg-subtle p-3">
      {line(status.docker, status.docker ? "Docker est installé" : "Docker n'est pas installé sur ce serveur : installe-le d'abord (guide Docker dans l'Aide)")}
      {status.installed
        ? line(status.healthy ? true : "warn", status.healthy ? `Serveur de synchronisation déjà en place (port ${status.port}) : il sera mis à jour, jeton conservé` : `Installation existante qui ne répond pas (port ${status.port}) : elle sera réparée`)
        : line(true, `Port local libre : ${status.port}`)}
      {mode === "public" && (
        <>
          {line(!!web, web ? `${web.engine === "nginx" ? "nginx" : "Apache"} détecté` : "Ni nginx ni Apache sur ce serveur : le mode public en a besoin (ou choisis le mode privé)")}
          {web && line(web.certbot ? true : "warn", web.certbot ? "certbot est installé" : "certbot absent : Zenytt tentera de l'utiliser, installe-le si l'étape du certificat échoue")}
          {line(
            dnsOk ? true : "warn",
            dnsOk
              ? `${domain} pointe bien vers ce serveur (${dns?.publicIp})`
              : dns?.resolved
                ? `${domain} pointe vers ${dns.resolved}, pas vers ce serveur (${dns.publicIp ?? "IP inconnue"}) : le certificat échouera`
                : `${domain} ne pointe vers aucune adresse : crée l'enregistrement DNS avant d'installer`,
          )}
        </>
      )}
    </ul>
  );
}
