import { useEffect, useState } from "react";
import { BellRing, CheckCircle2, Download, OctagonAlert, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api, errorMessage, type AgentConfig, type AgentInfo, type AlertMetric } from "../../lib/api";
import { useApp } from "../../lib/store";
import { Badge, Button, Field, IconButton, Input } from "../../components/ui";

const METRICS: { id: AlertMetric; label: string; unit: string }[] = [
  { id: "cpu", label: "CPU", unit: "%" },
  { id: "memory", label: "Mémoire", unit: "%" },
  { id: "disk", label: "Disque", unit: "%" },
  { id: "load", label: "Charge (1 min)", unit: "" },
];

export default function Agent({ serverId, agent, reload }: { serverId: string; agent: AgentInfo | null; reload: () => Promise<void> }) {
  const { ask, notify } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [cfg, setCfg] = useState<AgentConfig | null>(null);

  useEffect(() => {
    setCfg(agent?.status ? structuredClone(agent.status.config) : null);
  }, [agent]);

  const run = async (key: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(key);
    try {
      await fn();
      if (success) notify(success, "success");
      await reload();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const install = () =>
    run("install", async () => {
      const out = await api.agentInstall(serverId);
      notify(`Agent installé (${out.trim().split("\n").pop()})`, "success");
    });

  const uninstall = async () => {
    const ok = await ask({
      title: "Désinstaller l'agent helmd ?",
      body: "Le service, sa configuration et tout l'historique des métriques seront supprimés du serveur.",
      confirmLabel: "Désinstaller",
      danger: true,
    });
    if (ok) await run("uninstall", () => api.agentUninstall(serverId), "Agent désinstallé");
  };

  if (!agent) return <p className="text-sm text-muted">Vérification de l'agent…</p>;

  if (!agent.installed || !agent.running) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 rounded-lg border border-border bg-panel p-6">
        <div className="flex items-center gap-3">
          <ShieldCheck size={28} className="text-accent" />
          <div>
            <h2 className="font-semibold">{agent.installed ? "L'agent helmd ne répond pas" : "Installer l'agent helmd"}</h2>
            <p className="text-sm text-muted">Historique sur 30 jours et alertes, même quand ton PC est éteint.</p>
          </div>
        </div>
        {agent.error && <pre className="rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap text-warn">{agent.error}</pre>}
        <ul className="flex flex-col gap-1.5 text-sm text-muted">
          <li>• Binaire statique d'environ 2 Mo, installé dans /usr/local/bin/helmd.</li>
          <li>• Tourne sous un utilisateur système dédié, avec un service systemd durci et limité à 64 Mo de RAM.</li>
          <li>• N'ouvre <strong className="text-fg">aucun port</strong> : il ne répond que sur un socket local, joint à travers ta connexion SSH.</li>
          <li>• Ne touche ni à nginx, ni à Docker, ni à tes sites.</li>
        </ul>
        <div className="flex gap-2">
          <Button variant="primary" icon={<Download size={14} />} loading={busy === "install"} onClick={() => void install()}>
            {agent.installed ? "Réinstaller et redémarrer" : "Installer l'agent"}
          </Button>
          {agent.installed && (
            <Button variant="ghost" loading={busy === "uninstall"} onClick={() => void uninstall()}>
              Désinstaller
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">Nécessite les droits root : connexion en root ou mot de passe sudo renseigné dans le profil du serveur.</p>
      </div>
    );
  }

  const st = agent.status!;
  if (!cfg) return null;
  const set = (patch: Partial<AgentConfig>) => setCfg({ ...cfg, ...patch });
  const dirty = JSON.stringify(cfg) !== JSON.stringify(st.config);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3 text-sm">
        <CheckCircle2 size={16} className="text-ok" />
        <span>
          helmd {st.version} actif sur <span className="font-mono">{st.hostname}</span>
        </span>
        <span className="text-muted">démarré le {new Date(st.startedAt).toLocaleString("fr-FR")}</span>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" loading={busy === "install"} onClick={() => void install()}>
            Mettre à jour
          </Button>
          <Button size="sm" variant="ghost" loading={busy === "uninstall"} onClick={() => void uninstall()}>
            Désinstaller
          </Button>
        </div>
      </div>
      {st.configError && <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{st.configError}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <section className="rounded-lg border border-border bg-panel p-4">
          <h3 className="mb-1 text-sm font-medium">Règles d'alerte</h3>
          <p className="mb-3 text-xs text-muted">Une alerte part quand le seuil est dépassé pendant toute la durée indiquée, puis un message « résolu » quand ça redescend.</p>
          <div className="flex flex-col gap-2">
            {cfg.rules.map((r, i) => {
              const upd = (patch: Partial<typeof r>) => set({ rules: cfg.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              const unit = METRICS.find((m) => m.id === r.metric)?.unit;
              return (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" aria-label="Activer la règle" checked={r.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
                  <select
                    className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
                    value={r.metric}
                    onChange={(e) => upd({ metric: e.target.value as AlertMetric })}
                  >
                    {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                  <span className="text-muted">&gt;</span>
                  <Input className="!w-20" type="number" value={r.threshold} onChange={(e) => upd({ threshold: Number(e.target.value) })} />
                  <span className="w-3 text-muted">{unit}</span>
                  <span className="text-muted">pendant</span>
                  <Input className="!w-20" type="number" value={Math.round(r.forSecs / 60)} onChange={(e) => upd({ forSecs: Number(e.target.value) * 60 })} />
                  <span className="text-muted">min</span>
                  <IconButton title="Supprimer la règle" className="ml-auto" onClick={() => set({ rules: cfg.rules.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })}
            <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={13} />} onClick={() => set({ rules: [...cfg.rules, { metric: "cpu", threshold: 90, forSecs: 300, enabled: true }] })}>
              Ajouter une règle
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-panel p-4">
          <h3 className="mb-1 text-sm font-medium">Sites surveillés</h3>
          <p className="mb-3 text-xs text-muted">
            L'agent appelle chaque URL toutes les {cfg.httpCheckIntervalSecs} s et alerte après 2 échecs consécutifs (erreur réseau ou code HTTP ≥ 400).
          </p>
          <div className="flex flex-col gap-2">
            {cfg.httpChecks.map((c, i) => {
              const upd = (patch: Partial<typeof c>) => set({ httpChecks: cfg.httpChecks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                <div key={i} className="flex items-center gap-2">
                  <input type="checkbox" aria-label="Activer la vérification" checked={c.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
                  <Input className="!w-36" placeholder="Nom" value={c.name} onChange={(e) => upd({ name: e.target.value })} />
                  <Input className="font-mono text-xs" placeholder="https://monsite.fr" value={c.url} onChange={(e) => upd({ url: e.target.value })} />
                  <IconButton title="Retirer" onClick={() => set({ httpChecks: cfg.httpChecks.filter((_, j) => j !== i) })}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              );
            })}
            <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={13} />} onClick={() => set({ httpChecks: [...cfg.httpChecks, { name: "", url: "https://", enabled: true }] })}>
              Ajouter un site
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-panel p-4">
          <h3 className="mb-3 text-sm font-medium">Canaux de notification</h3>
          <div className="flex flex-col gap-3">
            <Field label="Nom du serveur dans les messages" hint={`Par défaut : ${st.hostname}`}>
              <Input value={cfg.serverName ?? ""} onChange={(e) => set({ serverName: e.target.value || null })} />
            </Field>
            <Field label="Webhook Discord" hint="Paramètres du salon → Intégrations → Webhooks → Copier l'URL.">
              <Input className="font-mono text-xs" placeholder="https://discord.com/api/webhooks/…" value={cfg.notifiers.discordWebhook ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, discordWebhook: e.target.value || null } })} />
            </Field>
            <Field label="ntfy (notifications push sur téléphone)" hint="Installe l'app ntfy, abonne-toi à un nom de topic difficile à deviner, et colle ici son URL.">
              <Input className="font-mono text-xs" placeholder="https://ntfy.sh/mon-topic-secret" value={cfg.notifiers.ntfyUrl ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, ntfyUrl: e.target.value || null } })} />
            </Field>
            <Field label="Webhook générique (POST JSON)">
              <Input className="font-mono text-xs" placeholder="https://…" value={cfg.notifiers.webhookUrl ?? ""} onChange={(e) => set({ notifiers: { ...cfg.notifiers, webhookUrl: e.target.value || null } })} />
            </Field>
            <Button
              size="sm"
              className="self-start"
              icon={<BellRing size={13} />}
              loading={busy === "test"}
              disabled={dirty}
              title={dirty ? "Enregistre d'abord la configuration" : undefined}
              onClick={() => void run("test", async () => notify(await api.agentTestNotify(serverId), "success"))}
            >
              Envoyer une notification de test
            </Button>
          </div>
        </section>

        <section className="rounded-lg border border-border bg-panel p-4">
          <h3 className="mb-3 text-sm font-medium">Journal des alertes</h3>
          {st.recentEvents.length === 0 ? (
            <p className="text-sm text-muted">Aucune alerte pour l'instant.</p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-2 overflow-auto">
              {st.recentEvents.map((e, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  {e.resolved ? <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" /> : <OctagonAlert size={14} className="mt-0.5 shrink-0 text-danger" />}
                  <div className="min-w-0">
                    <div className="truncate">{e.title}</div>
                    <div className="text-xs text-muted">
                      {new Date(e.t).toLocaleString("fr-FR")} · {e.message}
                    </div>
                  </div>
                  <Badge tone={e.resolved ? "ok" : "danger"}>{e.resolved ? "résolu" : "alerte"}</Badge>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {dirty && (
        <div className="sticky bottom-0 flex items-center justify-end gap-2 rounded-lg border border-accent/40 bg-panel px-4 py-3 shadow-xl">
          <span className="mr-auto text-sm text-muted">Modifications non enregistrées. L'agent les appliquera dans les secondes qui suivent.</span>
          <Button variant="ghost" onClick={() => setCfg(structuredClone(st.config))}>
            Annuler
          </Button>
          <Button variant="primary" icon={<Save size={14} />} loading={busy === "save"} onClick={() => void run("save", () => api.agentSaveConfig(serverId, cfg), "Configuration enregistrée")}>
            Enregistrer
          </Button>
        </div>
      )}
    </div>
  );
}
