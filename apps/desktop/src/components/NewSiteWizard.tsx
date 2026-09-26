import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { api, ENGINE_LABELS, errorMessage, type AppSpec, type NewSitePlan, type WebEngine } from "../lib/api";
import { useApp } from "../lib/store";
import { Button, Checkbox, Field, Input, Modal, Segmented, Textarea } from "./ui";

type StepState = "pending" | "running" | "done" | "error" | "skipped" | "warn";
interface Step {
  label: string;
  state: StepState;
  detail?: string;
}

const EMAIL_KEY = "helm.certbotEmail";
const validDomain = (d: string) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(d);

function readEmail() {
  try {
    return localStorage.getItem(EMAIL_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Assistant « Nouveau site » : conteneur Docker (optionnel) → vhost nginx ou Apache (application
 * sûre) → certificat HTTPS via certbot → vérification.
 */
export default function NewSiteWizard({
  serverId,
  engine = "nginx",
  confRoot,
  onClose,
  onDone,
}: {
  serverId: string;
  engine?: WebEngine;
  confRoot?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const web = ENGINE_LABELS[engine];
  const notify = useApp((s) => s.notify);
  const [plan, setPlan] = useState<NewSitePlan | null>(null);
  const [domain, setDomain] = useState("");
  const [source, setSource] = useState<"docker" | "port">("docker");
  const [image, setImage] = useState("");
  const [containerPort, setContainerPort] = useState(80);
  const [hostPort, setHostPort] = useState(8100);
  const [env, setEnv] = useState("");
  const [https, setHttps] = useState(true);
  const [email, setEmail] = useState(readEmail);
  const [dnsIp, setDnsIp] = useState<string | null | undefined>(undefined);
  const [preview, setPreview] = useState<{ vhost: string; compose: string | null; path: string; link: string | null } | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);

  useEffect(() => {
    api.sitesPlan(serverId).then(
      (p) => {
        setPlan(p);
        setHostPort(p.freePort);
        if (!p.docker) setSource("port");
        if (!p.certbot) setHttps(false);
      },
      (e) => notify(errorMessage(e), "error"),
    );
  }, [serverId, notify]);

  const name = useMemo(() => domain.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50), [domain]);
  const envPairs = useMemo<[string, string][]>(
    () =>
      env
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    [env],
  );
  const spec: AppSpec | undefined = source === "docker" ? { name, image: image.trim(), hostPort, containerPort, env: envPairs } : undefined;
  const portTaken = source === "docker" && plan?.usedPorts.includes(hostPort);
  const canRun = validDomain(domain) && (source === "port" || (image.trim() && !portTaken)) && (!https || email.includes("@"));

  // Vérifie le DNS du domaine (depuis le serveur) quand la saisie se stabilise.
  useEffect(() => {
    setDnsIp(undefined);
    if (!validDomain(domain)) return;
    const t = setTimeout(() => api.sitesResolve(serverId, domain).then(setDnsIp, () => setDnsIp(null)), 600);
    return () => clearTimeout(t);
  }, [domain, serverId]);

  useEffect(() => {
    if (!validDomain(domain)) {
      setPreview(null);
      return;
    }
    void api.sitesPreview(domain, hostPort, spec, engine, confRoot).then(setPreview);
    // `spec` est dérivé des champs ci-dessous.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, hostPort, source, image, containerPort, env]);

  const run = async () => {
    try {
      localStorage.setItem(EMAIL_KEY, email);
    } catch {
      /* préférence non sauvegardée */
    }
    const list: Step[] = [
      { label: source === "docker" ? `Créer et démarrer le conteneur ${name}` : `Utiliser l'application déjà en écoute sur le port ${hostPort}`, state: source === "docker" ? "pending" : "skipped" },
      { label: `Configurer ${web} pour ${domain}`, state: "pending" },
      { label: "Obtenir le certificat HTTPS (Let's Encrypt)", state: https ? "pending" : "skipped" },
      { label: "Vérifier que le site répond", state: "pending" },
    ];
    setSteps([...list]);
    const update = (i: number, patch: Partial<Step>) => {
      list[i] = { ...list[i], ...patch };
      setSteps([...list]);
    };

    if (spec) {
      update(0, { state: "running" });
      try {
        const out = await api.sitesCreateApp(serverId, spec);
        update(0, { state: "done", detail: out.split("\n")[0] });
      } catch (e) {
        update(0, { state: "error", detail: errorMessage(e) });
        return;
      }
    }

    update(1, { state: "running" });
    const available = preview!.path;
    try {
      const r = await api.sitesWrite(serverId, available, preview!.vhost, preview!.link ?? undefined, engine, engine === "apache");
      if (!r.ok) {
        update(1, { state: "error", detail: `${web} a refusé la configuration (rien n'a été modifié) :\n${r.log}` });
        return;
      }
      update(1, { state: "done", detail: `${available} · sauvegarde ${r.backup}` });
    } catch (e) {
      update(1, { state: "error", detail: errorMessage(e) });
      return;
    }

    if (https) {
      update(2, { state: "running" });
      try {
        await api.sitesCertbot(serverId, domain, email, engine);
        update(2, { state: "done", detail: "Certificat installé, HTTP redirigé vers HTTPS. Renouvellement automatique par certbot." });
      } catch (e) {
        update(2, {
          state: "warn",
          detail: `Le site fonctionne en HTTP, mais le certificat n'a pas pu être obtenu. Vérifie que le DNS de ${domain} pointe vers ce serveur, puis utilise « Activer HTTPS » sur la carte du site (page Sites).\n${errorMessage(e)}`,
        });
      }
    }

    update(3, { state: "running" });
    try {
      const code = await api.sitesCheck(serverId, domain);
      const ok = /^[23]/.test(code);
      update(3, {
        state: ok ? "done" : "warn",
        detail: ok ? `${web} répond HTTP ${code}` : `${web} répond HTTP ${code} : l'application ne répond peut-être pas encore (démarrage en cours ?)`,
      });
    } catch (e) {
      update(3, { state: "warn", detail: errorMessage(e) });
    }
    onDone();
  };

  const icon = (s: StepState) =>
    s === "done" ? <CheckCircle2 size={16} className="text-ok" /> :
    s === "error" ? <XCircle size={16} className="text-danger" /> :
    s === "warn" ? <AlertTriangle size={16} className="text-warn" /> :
    s === "running" ? <Loader2 size={16} className="animate-spin text-accent" /> :
    <Circle size={16} className={s === "skipped" ? "text-border" : "text-muted"} />;

  const finished = steps && steps.every((s) => s.state !== "running" && s.state !== "pending");

  return (
    <Modal
      title="Nouveau site"
      width="max-w-4xl"
      onClose={onClose}
      footer={
        steps ? (
          <Button variant="primary" disabled={!finished} onClick={onClose}>Fermer</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>Annuler</Button>
            <Button variant="primary" disabled={!canRun || !plan} onClick={() => void run()}>Créer le site</Button>
          </>
        )
      }
    >
      {steps ? (
        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <div className="mt-0.5">{icon(s.state)}</div>
              <div className="min-w-0 flex-1">
                <div className={`text-sm ${s.state === "skipped" ? "text-muted line-through" : ""}`}>{s.label}</div>
                {s.detail && <pre className="mt-1 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted select-text">{s.detail}</pre>}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-4">
            <Field
              label="Domaine"
              hint={
                !validDomain(domain) ? "Ex. : app.mondomaine.fr (le sous-domaine doit pointer vers ton VPS)." :
                dnsIp === undefined ? "Vérification du DNS…" :
                dnsIp === null ? <span className="text-warn">Ce domaine ne résout pas encore : crée l'enregistrement DNS A avant d'activer HTTPS.</span> :
                plan?.publicIp && dnsIp !== plan.publicIp ? <span className="text-warn">Pointe vers {dnsIp}, mais ton serveur est {plan.publicIp}.</span> :
                <span className="text-ok">Pointe vers {dnsIp}{plan?.publicIp ? " : c'est bien ce serveur" : ""}.</span>
              }
            >
              <Input value={domain} onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} placeholder="app.mondomaine.fr" autoFocus />
            </Field>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Application</span>
              <Segmented
                label="Application"
                value={source}
                onChange={setSource}
                className="self-start"
                options={[
                  { value: "docker", label: "Nouveau conteneur Docker", disabled: !plan?.docker, title: plan?.docker ? undefined : "Docker n'est pas disponible sur ce serveur" },
                  { value: "port", label: "Déjà lancée sur un port" },
                ]}
              />
            </div>

            {source === "docker" && (
              <>
                <Field label="Image Docker" hint="Ex. : ghcr.io/moi/mon-app:latest, nginx:alpine…">
                  <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="ghcr.io/moi/mon-app:latest" className="font-mono text-xs" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Port de l'application (dans le conteneur)">
                    <Input type="number" value={containerPort} onChange={(e) => setContainerPort(Number(e.target.value))} />
                  </Field>
                  <Field label="Port local sur le VPS" hint={portTaken ? <span className="text-danger">Port déjà utilisé</span> : "Choisi automatiquement parmi les ports libres."}>
                    <Input type="number" value={hostPort} onChange={(e) => setHostPort(Number(e.target.value))} />
                  </Field>
                </div>
                <Field label="Variables d'environnement (une par ligne, CLE=valeur)">
                  <Textarea
                    className="h-20 font-mono text-xs"
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    placeholder={"NODE_ENV=production"}
                  />
                </Field>
              </>
            )}
            {source === "port" && (
              <Field label="Port local de l'application" hint={`${web} relaiera le trafic vers 127.0.0.1 sur ce port.`}>
                <Input type="number" value={hostPort} onChange={(e) => setHostPort(Number(e.target.value))} />
              </Field>
            )}

            <Checkbox
              checked={https}
              disabled={!plan?.certbot}
              onChange={setHttps}
              label="Activer HTTPS avec Let's Encrypt"
              hint={plan?.certbot ? "Certificat gratuit, redirection automatique de HTTP vers HTTPS, renouvelé tout seul." : `certbot n'est pas installé sur ce serveur (apt install certbot python3-certbot-${engine}).`}
            />
            {https && (
              <Field label="E-mail pour Let's Encrypt" hint="Utilisé uniquement pour les avertissements d'expiration.">
                <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="toi@exemple.fr" />
              </Field>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-xs font-medium text-muted">Ce qui va être créé</span>
            {preview ? (
              <>
                {preview.compose && (
                  <div>
                    <div className="mb-1 font-mono text-[11px] text-muted">/opt/sites/{name}/docker-compose.yml</div>
                    <pre className="max-h-40 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] select-text">{preview.compose}</pre>
                  </div>
                )}
                <div>
                  <div className="mb-1 font-mono text-[11px] text-muted">{preview.path}</div>
                  <pre className="max-h-72 overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11px] select-text">{preview.vhost}</pre>
                </div>
                <p className="text-xs text-muted">
                  Le port de l'application n'est publié que sur 127.0.0.1 : seul {web} peut l'atteindre. Les autres sites et configurations ne sont pas modifiés.
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">Saisis un domaine pour voir l'aperçu.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
