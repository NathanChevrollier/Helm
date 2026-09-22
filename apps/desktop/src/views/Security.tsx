import { useCallback, useEffect, useState } from "react";
import { Archive, ArchiveRestore, AlertTriangle, BellOff, CheckCircle2, Info, OctagonAlert, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { api, errorMessage, type Finding, type FixPlan, type IgnoredFinding, type SecurityReport, type Severity } from "../lib/api";
import { ensureConnected, useApp, useAppPick } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Modal } from "../components/ui";
import Fail2ban from "./security/Fail2ban";
import Firewall from "./security/Firewall";
import Access from "./security/Access";
import { useCachedState } from "../lib/cache";
import { useAutoRefresh } from "../lib/refresh";

const LABEL: Record<Severity, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", ok: "OK" };
const TONE: Record<Severity, "danger" | "warn" | "accent" | "muted" | "ok"> = { critical: "danger", high: "danger", medium: "warn", low: "muted", ok: "ok" };

function SeverityIcon({ s }: { s: Severity }) {
  if (s === "ok") return <CheckCircle2 size={16} className="text-ok" />;
  if (s === "critical" || s === "high") return <OctagonAlert size={16} className="text-danger" />;
  if (s === "medium") return <AlertTriangle size={16} className="text-warn" />;
  return <Info size={16} className="text-muted" />;
}

export default function SecurityView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<ShieldCheck size={40} />} title="Aucun serveur sélectionné" />;
  return <Security key={serverId} serverId={serverId} />;
}

const TABS = [
  { id: "audit", label: "Audit" },
  { id: "f2b", label: "fail2ban" },
  { id: "firewall", label: "Pare-feu" },
  { id: "access", label: "Accès" },
] as const;
type TabId = (typeof TABS)[number]["id"];

function Security({ serverId }: { serverId: string }) {
  const { openTab } = useAppPick("openTab");
  const [tab, setTab] = useState<TabId>("audit");
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [report, setReport] = useCachedState<SecurityReport | null>(`security:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState<{ finding: Finding; plan: FixPlan } | null>(null);
  const [ignored, setIgnored] = useState<IgnoredFinding[]>([]);
  const [showIgnored, setShowIgnored] = useState(false);
  const { ask, notify } = useAppPick("ask", "notify");

  const loadIgnored = useCallback(() => void api.findingsIgnored(serverId).then(setIgnored, () => {}), [serverId]);
  useEffect(loadIgnored, [loadIgnored]);

  /** Met un constat de côté, avec une raison facultative : il rejoint les constats ignorés. */
  const ignore = async (f: Finding) => {
    const reason = await ask({
      title: `Ignorer « ${f.title} » ?`,
      body: "Ce constat n'apparaîtra plus dans les problèmes de ce serveur. Il reste consultable dans les constats ignorés, où tu peux le réactiver.",
      input: { label: "Raison (facultatif)", initial: "" },
      confirmLabel: "Ignorer",
    });
    if (reason === null || reason === false) return;
    try {
      await api.findingIgnore(serverId, f.id, f.title, typeof reason === "string" ? reason : "");
      loadIgnored();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const unignore = async (f: IgnoredFinding) => {
    try {
      await api.findingUnignore(serverId, f.findingId);
      loadIgnored();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!(await ensureConnected(serverId))) throw new Error("Non connecté.");
      setReport(await api.securityAudit(serverId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);
  useAutoRefresh(load, { serverId, auto: false });

  const startFix = async (f: Finding) => {
    if (f.fix === "apply-updates") {
      openTab(serverId, { title: "Mises à jour", command: "sudo apt-get update && sudo apt-get upgrade; echo; echo 'Terminé. Tu peux fermer cet onglet.'; exec \"$SHELL\" -l" });
      return;
    }
    setFixing({ finding: f, plan: await api.securityFixPlan(f.fix!) });
  };

  const ignoredIds = ignored.map((i) => i.findingId);
  const problems = report?.findings.filter((f) => f.severity !== "ok" && !ignoredIds.includes(f.id)) ?? [];
  const ok = report?.findings.filter((f) => f.severity === "ok") ?? [];

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Sécurité de {server?.name}</h1>
          <p className="text-sm text-muted">{report ? `${report.os} · SSH sur le port ${report.sshPorts.join(", ") || "?"}` : "Audit en lecture seule : rien n'est modifié sans ton accord."}</p>
        </div>
        <nav className="ml-auto flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-sm ${tab === t.id ? "bg-accent/15 text-fg" : "text-muted hover:text-fg"}`}
            >
              {t.label}
            </button>
          ))}
          {tab === "audit" && (
            <IconButton title="Relancer l'audit" onClick={() => void load()}>
              <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            </IconButton>
          )}
        </nav>
      </header>
      {tab !== "audit" && (
        <div className="min-h-0 flex-1 overflow-auto p-6">
          {tab === "f2b" && <Fail2ban serverId={serverId} />}
          {tab === "firewall" && <Firewall serverId={serverId} />}
          {tab === "access" && <Access serverId={serverId} />}
        </div>
      )}
      <div className={`min-h-0 flex-1 overflow-auto p-6 ${tab === "audit" ? "" : "hidden"}`}>
        {error && <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div>}
        {!report && !error && <EmptyState icon={<ShieldCheck size={36} className="animate-pulse" />} title="Audit en cours…" />}
        {report && (
          <div className="flex flex-col gap-3">
            {problems.length === 0 && (
              <div className="flex items-center gap-2 rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-sm">
                <CheckCircle2 size={16} className="text-ok" /> Aucun problème détecté.
              </div>
            )}
            {problems.map((f) => (
              <div key={f.id} className="flex items-start gap-3 rounded-lg border border-border bg-panel px-4 py-3">
                <div className="mt-0.5">
                  <SeverityIcon s={f.severity} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{f.title}</span>
                    <Badge tone={TONE[f.severity]}>{LABEL[f.severity]}</Badge>
                  </div>
                  {f.detail && <p className="mt-1 text-sm text-muted">{f.detail}</p>}
                </div>
                {f.fix && (
                  <Button size="sm" icon={<Wrench size={13} />} onClick={() => void startFix(f)}>
                    {f.fixLabel}
                  </Button>
                )}
                <IconButton title="Ignorer ce constat (il sera archivé)" onClick={() => void ignore(f)}>
                  <BellOff size={14} />
                </IconButton>
              </div>
            ))}
            {ignored.length > 0 && (
              <div className="mt-4">
                <button className="flex items-center gap-2 text-sm text-muted hover:text-fg" onClick={() => setShowIgnored((v) => !v)}>
                  <Archive size={14} />
                  Constats ignorés ({ignored.length})
                </button>
                {showIgnored && (
                  <div className="mt-2 flex flex-col gap-2">
                    {ignored.map((f) => {
                      const current = report.findings.find((x) => x.id === f.findingId);
                      return (
                        <div key={f.findingId} className="flex items-start gap-3 rounded-lg border border-border bg-panel/60 px-4 py-2.5 text-sm">
                          <Archive size={15} className="mt-0.5 shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{current?.title ?? f.title}</span>
                              {current && current.severity !== "ok" ? (
                                <Badge tone={TONE[current.severity]}>{LABEL[current.severity]}</Badge>
                              ) : (
                                <Badge tone="ok">réglé depuis</Badge>
                              )}
                              <span className="text-xs text-muted">ignoré le {new Date(f.at).toLocaleDateString("fr-FR")}</span>
                            </div>
                            {f.reason && <p className="mt-0.5 text-xs text-muted">{f.reason}</p>}
                          </div>
                          <Button size="sm" variant="ghost" icon={<ArchiveRestore size={13} />} onClick={() => void unignore(f)}>
                            Réafficher
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {ok.length > 0 && (
              <div className="mt-4">
                <h2 className="mb-2 text-sm font-medium text-muted">Points conformes</h2>
                <div className="flex flex-wrap gap-2">
                  {ok.map((f) => (
                    <span key={f.id} className="flex items-center gap-1.5 rounded-full border border-ok/30 px-3 py-1 text-xs">
                      <CheckCircle2 size={12} className="text-ok" /> {f.title}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {fixing && (
        <FixDialog
          serverId={serverId}
          finding={fixing.finding}
          plan={fixing.plan}
          onClose={() => setFixing(null)}
          onDone={() => {
            setFixing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function FixDialog({ serverId, finding, plan, onClose, onDone }: { serverId: string; finding: Finding; plan: FixPlan; onClose: () => void; onDone: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; output: string } | null>(null);

  const apply = async () => {
    setRunning(true);
    try {
      setResult(await api.securityFixApply(serverId, plan.id));
    } catch (e) {
      setResult({ ok: false, output: errorMessage(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={finding.fixLabel ?? "Correction"}
      width="max-w-3xl"
      onClose={running ? () => {} : result ? onDone : onClose}
      footer={
        result ? (
          <Button variant="primary" onClick={onDone}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="ghost" disabled={running} onClick={onClose}>
              Annuler
            </Button>
            <Button variant="primary" loading={running} onClick={() => void apply()}>
              Appliquer
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <div className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${result.ok ? "border-ok/40 bg-ok/10" : "border-danger/40 bg-danger/10"}`}>
            {result.ok ? <CheckCircle2 size={15} className="text-ok" /> : <OctagonAlert size={15} className="text-danger" />}
            {result.ok ? "Correction appliquée." : "Correction non appliquée (ou annulée automatiquement)."}
          </div>
          <pre className="max-h-80 overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{result.output}</pre>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{plan.description}</p>
          {plan.needsVerification && (
            <p className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs">
              Cette correction touche l'accès au serveur. Helm garde ta connexion actuelle ouverte, en ouvre une nouvelle pour vérifier que tu peux toujours te connecter, et annule tout sinon.
            </p>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted">Voir le script exécuté en root</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-bg p-3 font-mono text-[11px] whitespace-pre-wrap select-text">{plan.script}</pre>
          </details>
        </div>
      )}
    </Modal>
  );
}
