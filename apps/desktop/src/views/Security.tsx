// Sécurité : audit (score et constats par gravité), pare-feu, fail2ban et accès SSH en onglets.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, AlertTriangle, CheckCircle2, Info, OctagonAlert, RefreshCw, Wrench } from "lucide-react";
import { api, errorMessage, type Finding, type FixPlan, type IgnoredFinding, type SecurityReport, type Severity } from "../lib/api";
import { useApp, useAppPick } from "../lib/store";
import { useTabIntent } from "../lib/shell";
import { Badge, Button, Card, ErrorState, Loading, Modal, ResultBanner, Section } from "../components/ui";
import PageLayout from "../components/PageLayout";
import ServerGate, { ServerContext } from "../components/ServerGate";
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
  return <ServerGate title="Sécurité" guide="security">{(serverId) => <Security key={serverId} serverId={serverId} />}</ServerGate>;
}

type TabId = "audit" | "firewall" | "fail2ban" | "access";
const PENALTY: Record<Severity, number> = { critical: 30, high: 15, medium: 6, low: 2, ok: 0 };
const GROUPS: { title: string; severities: Severity[] }[] = [
  { title: "À corriger en priorité", severities: ["critical", "high"] },
  { title: "À prévoir", severities: ["medium"] },
  { title: "Améliorations", severities: ["low"] },
];

function Security({ serverId }: { serverId: string }) {
  const { openTab, ask, notify } = useAppPick("openTab", "ask", "notify");
  const server = useApp((s) => s.servers.find((x) => x.id === serverId));
  const [tab, setTab] = useTabIntent<TabId>("security", "audit");
  const [report, setReport] = useCachedState<SecurityReport | null>(`security:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fixing, setFixing] = useState<{ finding: Finding; plan: FixPlan } | null>(null);
  const [ignored, setIgnored] = useState<IgnoredFinding[]>([]);
  const [showIgnored, setShowIgnored] = useState(false);
  const [counts, setCounts] = useState<{ firewall?: number; fail2ban?: number; access?: number }>({});
  // Rappels stables : les panneaux remontent leur compteur sans relancer de rendu en boucle.
  const onCount = useMemo(
    () => ({
      firewall: (n: number) => setCounts((c) => (c.firewall === n ? c : { ...c, firewall: n })),
      fail2ban: (n: number) => setCounts((c) => (c.fail2ban === n ? c : { ...c, fail2ban: n })),
      access: (n: number) => setCounts((c) => (c.access === n ? c : { ...c, access: n })),
    }),
    [],
  );
  const toAudit = useCallback(() => setTab("audit"), [setTab]);

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
    try {
      setFixing({ finding: f, plan: await api.securityFixPlan(f.fix!) });
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  const ignoredIds = ignored.map((i) => i.findingId);
  const problems = report?.findings.filter((f) => f.severity !== "ok" && !ignoredIds.includes(f.id)) ?? [];
  const ok = report?.findings.filter((f) => f.severity === "ok") ?? [];
  const serious = problems.filter((f) => f.severity === "critical" || f.severity === "high").length;
  const score = report ? Math.max(0, 100 - problems.reduce((n, f) => n + PENALTY[f.severity], 0)) : null;

  return (
    <PageLayout
      context={server && <ServerContext server={server} />}
      title="Sécurité"
      subtitle={report ? `${report.os} · SSH sur le port ${report.sshPorts.join(", ") || "?"}` : "Audit en lecture seule : rien n'est modifié sans ton accord."}
      guide="security"
      tabs={[
        { id: "audit", label: "Audit", count: report ? problems.length || undefined : undefined, tone: serious ? "danger" : problems.length ? "warn" : undefined },
        { id: "firewall", label: "Pare-feu", count: counts.firewall || undefined, tone: counts.firewall ? "warn" : undefined },
        { id: "fail2ban", label: "fail2ban", count: counts.fail2ban || undefined },
        { id: "access", label: "Accès SSH", count: counts.access },
      ]}
      activeTab={tab}
      onTab={setTab}
      actions={
        tab === "audit" && (
          <Button icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} disabled={loading} onClick={() => void load()}>
            Relancer l'audit
          </Button>
        )
      }
    >
      {/* Les quatre panneaux restent montés : leurs compteurs s'affichent dans les onglets dès
          l'arrivée sur la page, et revenir sur un onglet ne relance pas sa lecture. */}
      <div className={tab === "audit" ? "flex flex-col gap-6 px-7 py-5" : "hidden"}>
        {error && <ErrorState message={error} onRetry={() => void load()} retryLabel="Relancer l'audit" />}
        {!report && !error && <Loading label="Audit en cours… (lecture seule)" rows={5} />}
        {report && score != null && (
          <>
            <Card className="flex flex-wrap items-center gap-6">
              <ScoreGauge score={score} />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold">
                  {score >= 90 ? "Serveur bien protégé" : score >= 70 ? "Quelques points à renforcer" : score >= 40 ? "Des failles à corriger" : "Serveur exposé"}
                </h2>
                <p className="mt-0.5 text-[13px] text-muted">
                  {problems.length === 0
                    ? "Aucun problème détecté."
                    : `${problems.length} point${problems.length > 1 ? "s" : ""} à traiter${serious ? `, dont ${serious} prioritaire${serious > 1 ? "s" : ""}` : ""}.`}{" "}
                  {ok.length} point{ok.length > 1 ? "s" : ""} conforme{ok.length > 1 ? "s" : ""}
                  {ignored.length ? ` · ${ignored.length} ignoré${ignored.length > 1 ? "s" : ""}` : ""}.
                </p>
                <p className="mt-2 text-xs text-faint">Lecture seule : chaque correction montre son script et attend ton accord.</p>
              </div>
            </Card>

            {GROUPS.map((g) => {
              const list = problems.filter((f) => g.severities.includes(f.severity)).sort((x, y) => PENALTY[y.severity] - PENALTY[x.severity]);
              if (!list.length) return null;
              return (
                <Section key={g.title} title={g.title} count={list.length}>
                  <div className="flex flex-col gap-2">
                    {list.map((f) => (
                      <Card key={f.id} className="flex items-start gap-3 !py-3">
                        <div className="mt-0.5">
                          <SeverityIcon s={f.severity} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{f.title}</span>
                            <Badge tone={TONE[f.severity]}>{LABEL[f.severity]}</Badge>
                          </div>
                          {f.detail && <p className="mt-1 text-[13px] text-muted">{f.detail}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Button size="sm" variant="ghost" onClick={() => void ignore(f)}>
                            Ignorer
                          </Button>
                          {f.fix && (
                            <Button size="sm" variant={g.severities.includes("critical") ? "primary" : "outline"} icon={<Wrench size={13} />} onClick={() => void startFix(f)}>
                              {f.fixLabel}
                            </Button>
                          )}
                        </div>
                      </Card>
                    ))}
                  </div>
                </Section>
              );
            })}

            {problems.length === 0 && (
              <ResultBanner tone="ok" title="Aucun problème détecté">
                <span className="text-xs text-muted">Relance l'audit après une mise à jour ou un changement de configuration.</span>
              </ResultBanner>
            )}

            {ok.length > 0 && (
              <Section title="Points conformes" count={ok.length}>
                <div className="flex flex-wrap gap-2">
                  {ok.map((f) => (
                    <span key={f.id} className="flex items-center gap-1.5 rounded-full border border-ok/30 px-3 py-1 text-xs">
                      <CheckCircle2 size={12} className="text-ok" /> {f.title}
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {ignored.length > 0 && (
              <Section
                title="Constats ignorés"
                count={ignored.length}
                actions={
                  <Button size="sm" variant="ghost" onClick={() => setShowIgnored((v) => !v)}>
                    {showIgnored ? "Masquer" : "Afficher"}
                  </Button>
                }
              >
                {showIgnored && (
                  <div className="flex flex-col gap-2">
                    {ignored.map((f) => {
                      const current = report.findings.find((x) => x.id === f.findingId);
                      return (
                        <div key={f.findingId} className="flex items-start gap-3 rounded-lg border border-border bg-panel/60 px-4 py-2.5 text-sm">
                          <Archive size={15} className="mt-0.5 shrink-0 text-muted" />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{current?.title ?? f.title}</span>
                              {current && current.severity !== "ok" ? <Badge tone={TONE[current.severity]}>{LABEL[current.severity]}</Badge> : <Badge tone="ok">réglé depuis</Badge>}
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
              </Section>
            )}
          </>
        )}
      </div>
      <div className={tab === "firewall" ? "px-7 py-5" : "hidden"}>
        <Firewall serverId={serverId} onCount={onCount.firewall} onAudit={toAudit} />
      </div>
      <div className={tab === "fail2ban" ? "px-7 py-5" : "hidden"}>
        <Fail2ban serverId={serverId} onCount={onCount.fail2ban} onAudit={toAudit} />
      </div>
      <div className={tab === "access" ? "px-7 py-5" : "hidden"}>
        <Access serverId={serverId} onCount={onCount.access} />
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
    </PageLayout>
  );
}

/** Jauge en demi-cercle : 100 = rien à signaler, chaque constat retire des points selon sa gravité. */
function ScoreGauge({ score }: { score: number }) {
  const r = 44;
  const len = Math.PI * r;
  const color = score >= 90 ? "var(--color-ok)" : score >= 70 ? "var(--color-accent)" : score >= 40 ? "var(--color-warn)" : "var(--color-danger)";
  return (
    <div className="relative h-[70px] w-[120px] shrink-0" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Score de sécurité">
      <svg viewBox="0 0 120 70" className="h-full w-full">
        <path d={`M 16 62 A ${r} ${r} 0 0 1 104 62`} fill="none" stroke="var(--color-raised)" strokeWidth="10" strokeLinecap="round" />
        <path
          d={`M 16 62 A ${r} ${r} 0 0 1 104 62`}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${(len * score) / 100} ${len}`}
          style={{ transition: "stroke-dasharray 600ms ease" }}
        />
      </svg>
      <div className="absolute inset-x-0 bottom-0 text-center">
        <span className="text-[22px] leading-none font-semibold tabular-nums">{score}</span>
        <span className="text-xs text-muted">/100</span>
      </div>
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
          <ResultBanner tone={result.ok ? "ok" : "danger"} title={result.ok ? "Correction appliquée." : "Correction non appliquée (ou annulée automatiquement)."} />
          <pre className="max-h-80 overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text">{result.output}</pre>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{plan.description}</p>
          {plan.needsVerification && (
            <ResultBanner tone="warn" title="Cette correction touche l'accès au serveur">
              <span className="text-xs text-muted">Helm garde ta connexion actuelle ouverte, en ouvre une nouvelle pour vérifier que tu peux toujours te connecter, et annule tout sinon.</span>
            </ResultBanner>
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
