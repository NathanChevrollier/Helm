import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowRight, CircleCheck, CircleX, ExternalLink, FileCode2, Globe, Lock, LockOpen, Plus, Power, PowerOff,
  History, RefreshCw, ShieldCheck, Trash2, Zap,
} from "lucide-react";
import { api, errorMessage, type Certificate, type Container, type NginxState, type DomainInfo, type ServerBlock, type SiteFile } from "../lib/api";
import { ensureConnected, useApp } from "../lib/store";
import { Badge, Button, EmptyState, IconButton, Modal } from "../components/ui";

const NginxEditor = lazy(() => import("../components/NginxEditor"));
const NewSiteWizard = lazy(() => import("../components/NewSiteWizard"));
const NginxHistory = lazy(() => import("../components/NginxHistory"));

export default function SitesView() {
  const serverId = useApp((s) => s.activeServerId);
  if (!serverId) return <EmptyState icon={<Globe size={40} />} title="Aucun serveur sélectionné" />;
  return <Sites key={serverId} serverId={serverId} />;
}

const DAY = 86400;
function certTone(c: Certificate): "ok" | "warn" | "danger" {
  const days = (c.notAfter - Date.now() / 1000) / DAY;
  return days < 7 ? "danger" : days < 21 ? "warn" : "ok";
}

/** Site affiché : un domaine principal et ses server blocks (HTTP + HTTPS). */
interface Site {
  file: SiteFile;
  domain: string;
  aliases: string[];
  blocks: ServerBlock[];
}

function sitesOf(files: SiteFile[]): Site[] {
  return files.map((file) => {
    const names = [...new Set(file.servers.flatMap((s) => s.serverNames))].filter((n) => n !== "_" && n !== "localhost");
    return { file, domain: names[0] ?? file.path.split("/").pop()!, aliases: names.slice(1), blocks: file.servers };
  });
}

function linkFor(file: SiteFile) {
  return file.path.startsWith("/etc/nginx/sites-enabled/") ? file.path : `/etc/nginx/sites-enabled/${file.realPath.split("/").pop()}`;
}

function Sites({ serverId }: { serverId: string }) {
  const { ask, notify } = useApp();
  const [state, setState] = useState<NginxState | null>(null);
  const [containers, setContainers] = useState<Container[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<SiteFile | null>(null);
  const [wizard, setWizard] = useState(false);
  const [history, setHistory] = useState(false);
  const [output, setOutput] = useState<{ title: string; text: string; ok: boolean } | null>(null);
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [dns, setDns] = useState<Record<string, DomainInfo>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (!(await ensureConnected(serverId))) {
        setError("Non connecté.");
        return;
      }
      const [s, d] = await Promise.all([api.sitesState(serverId), api.dockerOverview(serverId).catch(() => null)]);
      setState(s);
      setContainers(d?.containers ?? []);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const certFor = useCallback(
    (block: ServerBlock) => state?.certificates.find((c) => c.path === block.sslCertificate),
    [state],
  );
  const containerOnPort = (port: number) => containers.find((c) => c.ports.some((p) => p.hostPort === port));
  const sites = useMemo(() => sitesOf(state?.files ?? []), [state]);
  const disabled = useMemo(() => sitesOf(state?.disabled ?? []), [state]);

  // DNS et expiration des domaines, vérifiés depuis le PC après l'affichage (sans le ralentir).
  const domainList = useMemo(() => sites.map((s) => s.domain).filter((d) => d.includes(".")).join(","), [sites]);
  useEffect(() => {
    if (!domainList) return;
    void api
      .domainsCheck(serverId, domainList.split(","))
      .then((list) => setDns(Object.fromEntries(list.map((d) => [d.domain, d]))))
      .catch(() => {});
  }, [serverId, domainList]);

  const runApply = async (label: string, fn: () => Promise<{ ok: boolean; log: string; backup: string | null }>) => {
    try {
      const r = await fn();
      if (r.ok) notify(`${label} : OK (sauvegarde ${r.backup})`, "success");
      else setOutput({ title: `${label} : refusé par nginx, rien n'a changé`, text: r.log, ok: false });
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  if (error) return <EmptyState icon={<Globe size={40} />} title="Impossible de lire la configuration">{error}</EmptyState>;
  if (!state) return <EmptyState icon={<Globe size={40} />} title="Chargement…" />;
  if (!state.installed) return <EmptyState icon={<Globe size={40} />} title="nginx n'est pas installé sur ce serveur" />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Sites</h1>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <Badge>{state.version}</Badge>
            {state.running ? <Badge tone="ok">nginx actif</Badge> : <Badge tone="danger">nginx arrêté</Badge>}
            <Badge>{sites.length} site(s) actif(s)</Badge>
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            icon={<ShieldCheck size={13} />}
            onClick={async () => {
              const r = await api.sitesTest(serverId).catch((e) => ({ ok: false, output: errorMessage(e) }));
              setOutput({ title: r.ok ? "Configuration valide" : "Configuration invalide", text: r.output, ok: r.ok });
            }}
          >
            Tester la config
          </Button>
          <Button
            size="sm"
            icon={<Zap size={13} />}
            onClick={async () => {
              try {
                await api.sitesReload(serverId);
                notify("nginx rechargé", "success");
              } catch (e) {
                setOutput({ title: "Rechargement refusé", text: errorMessage(e), ok: false });
              }
            }}
          >
            Recharger
          </Button>
          {state.certbot && (
            <Button
              size="sm"
              icon={<RefreshCw size={13} />}
              onClick={async () => {
                notify("Renouvellement des certificats en cours…");
                const out = await api.sitesRenew(serverId).catch(errorMessage);
                setOutput({ title: "certbot renew", text: out, ok: true });
                void load();
              }}
            >
              Renouveler les certificats
            </Button>
          )}
          <Button size="sm" icon={<History size={13} />} onClick={() => setHistory(true)}>
            Historique
          </Button>
          <IconButton title="Actualiser" onClick={() => void load()}>
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </IconButton>
          <Button size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setWizard(true)}>
            Nouveau site
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(440px,1fr))] gap-4">
          {sites.map((site) => {
            const httpsBlock = site.blocks.find((b) => b.ssl);
            const cert = httpsBlock ? certFor(httpsBlock) : undefined;
            const ports = [...new Set(site.blocks.flatMap((b) => b.upstreamPorts))];
            const statics = site.blocks.flatMap((b) => (b.root ? [b.root] : b.locations.filter((l) => l.root).map((l) => l.root!)));
            const redirectsOnly = site.blocks.every((b) => b.returns && !b.locations.length);
            const days = cert ? Math.floor((cert.notAfter - Date.now() / 1000) / DAY) : null;
            const check = checks[site.domain];
            const isDefault = site.file.path.endsWith("/default");
            return (
              <div key={site.file.path} className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {httpsBlock ? <Lock size={14} className="text-ok" /> : <LockOpen size={14} className="text-muted" />}
                      <span className="truncate">{site.domain}</span>
                    </div>
                    {site.aliases.length > 0 && <div className="truncate text-xs text-muted">+ {site.aliases.join(", ")}</div>}
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted">{site.file.realPath}</div>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <DomainBadges info={dns[site.domain]} />
                    {cert ? (
                      <Badge tone={certTone(cert)}>{days! < 0 ? "certificat expiré" : `certificat ${days} j`}</Badge>
                    ) : httpsBlock ? (
                      <Badge tone="warn">certificat illisible</Badge>
                    ) : (
                      <Badge>HTTP seulement</Badge>
                    )}
                  </div>
                </div>

                {/* Chaîne : domaine → nginx → port → conteneur */}
                <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg px-3 py-2 text-xs">
                  <span className="font-medium">{site.domain}</span>
                  <ArrowRight size={12} className="text-muted" />
                  <span className="text-muted">nginx {httpsBlock ? ":443" : ":80"}</span>
                  {ports.map((p) => {
                    const c = containerOnPort(p);
                    return (
                      <span key={p} className="flex items-center gap-2">
                        <ArrowRight size={12} className="text-muted" />
                        <span className="font-mono">127.0.0.1:{p}</span>
                        {c && (
                          <>
                            <ArrowRight size={12} className="text-muted" />
                            <span className="flex items-center gap-1.5">
                              <span className={`size-1.5 rounded-full ${c.state === "running" ? "bg-ok" : "bg-danger"}`} />
                              {c.name}
                            </span>
                          </>
                        )}
                        {!c && containers.length > 0 && <span className="text-warn">aucun conteneur sur ce port</span>}
                      </span>
                    );
                  })}
                  {statics.length > 0 && ports.length === 0 && (
                    <>
                      <ArrowRight size={12} className="text-muted" />
                      <span className="font-mono text-muted">{statics[0]}</span>
                    </>
                  )}
                  {redirectsOnly && <span className="text-muted">(redirection)</span>}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => setEditing(site.file)}>Éditer</Button>
                  <Button size="sm" icon={<ExternalLink size={12} />} onClick={() => void openUrl(`${httpsBlock ? "https" : "http"}://${site.domain}`)} disabled={isDefault}>
                    Ouvrir
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={isDefault}
                    onClick={async () => {
                      setChecks((c) => ({ ...c, [site.domain]: "" }));
                      try {
                        const code = await api.sitesCheck(serverId, site.domain);
                        setChecks((c) => ({ ...c, [site.domain]: code }));
                      } catch (e) {
                        notify(errorMessage(e), "error");
                      }
                    }}
                  >
                    Tester
                  </Button>
                  {check && (
                    <span className={`flex items-center gap-1 text-xs ${/^[23]/.test(check) ? "text-ok" : "text-danger"}`}>
                      {/^[23]/.test(check) ? <CircleCheck size={13} /> : <CircleX size={13} />} HTTP {check}
                    </span>
                  )}
                  <span className="ml-auto flex">
                    <IconButton
                      title="Désactiver le site"
                      onClick={async () => {
                        const ok = await ask({
                          title: `Désactiver ${site.domain} ?`,
                          body: "Le site ne sera plus servi par nginx. Sa configuration est conservée dans sites-available et peut être réactivée.",
                          confirmLabel: "Désactiver",
                          danger: true,
                        });
                        if (ok) await runApply(`Désactivation de ${site.domain}`, () => api.sitesSetEnabled(serverId, site.file.realPath, linkFor(site.file), false));
                      }}
                    >
                      <PowerOff size={14} />
                    </IconButton>
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {disabled.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-medium text-muted">Sites désactivés</h2>
            <div className="flex flex-col gap-2">
              {disabled.map((site) => (
                <div key={site.file.path} className="flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-2 text-sm">
                  <span className="flex-1 truncate">{site.domain}</span>
                  <span className="truncate font-mono text-xs text-muted">{site.file.realPath}</span>
                  <Button size="sm" icon={<Power size={12} />} onClick={() => void runApply(`Activation de ${site.domain}`, () => api.sitesSetEnabled(serverId, site.file.realPath, linkFor(site.file), true))}>
                    Activer
                  </Button>
                  <IconButton
                    title="Supprimer définitivement"
                    onClick={async () => {
                      const ok = await ask({
                        title: `Supprimer la configuration de ${site.domain} ?`,
                        body: "Le fichier est supprimé de sites-available (une sauvegarde de /etc/nginx est faite avant). Les conteneurs et certificats ne sont pas touchés.",
                        confirmLabel: "Supprimer",
                        danger: true,
                      });
                      if (ok) await runApply(`Suppression de ${site.domain}`, () => api.sitesDelete(serverId, site.file.realPath, linkFor(site.file)));
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          </section>
        )}

        {state.certificates.length > 0 && (
          <section className="mt-8">
            <h2 className="mb-3 text-sm font-medium text-muted">Certificats</h2>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead className="bg-panel text-left text-xs text-muted">
                  <tr>
                    <th className="px-3 py-2 font-medium">Domaines</th>
                    <th className="px-3 py-2 font-medium">Expire</th>
                    <th className="px-3 py-2 font-medium">Émetteur</th>
                    <th className="px-3 py-2 font-medium">Fichier</th>
                  </tr>
                </thead>
                <tbody>
                  {state.certificates.map((c) => {
                    const days = Math.floor((c.notAfter - Date.now() / 1000) / DAY);
                    return (
                      <tr key={c.path} className="border-t border-border/50">
                        <td className="px-3 py-2">{c.domains.join(", ") || c.subject}</td>
                        <td className="px-3 py-2">
                          <Badge tone={certTone(c)}>{days < 0 ? "expiré" : `dans ${days} j`}</Badge>
                          <span className="ml-2 text-xs text-muted">{new Date(c.notAfter * 1000).toLocaleDateString("fr-FR")}</span>
                        </td>
                        <td className="max-w-60 truncate px-3 py-2 text-xs text-muted">{c.issuer.replace(/^.*O = /, "").replace(/,.*$/, "")}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-muted">{c.path}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <Suspense fallback={null}>
        {editing && <NginxEditor serverId={serverId} path={editing.realPath} onClose={() => setEditing(null)} onApplied={() => void load()} />}
        {wizard && <NewSiteWizard serverId={serverId} onClose={() => setWizard(false)} onDone={() => void load()} />}
        {history && <NginxHistory serverId={serverId} onClose={() => setHistory(false)} onRestored={() => void load()} />}
      </Suspense>
      {output && (
        <Modal title={output.title} width="max-w-3xl" onClose={() => setOutput(null)}>
          <pre className={`max-h-[60vh] overflow-auto rounded-md bg-bg p-3 font-mono text-xs whitespace-pre-wrap select-text ${output.ok ? "" : "text-danger"}`}>{output.text}</pre>
        </Modal>
      )}
    </div>
  );
}

/** DNS du domaine (pointe-t-il vers ce serveur ?) et expiration de son enregistrement. */
function DomainBadges({ info }: { info?: DomainInfo }) {
  if (!info) return null;
  const days = info.expires ? Math.floor((Date.parse(info.expires) - Date.now()) / 86_400_000) : null;
  const dnsBadge =
    info.dns === "ok" ? null : (
      <span title={`${info.dnsDetail}${info.ips.length ? ` (${info.ips.join(", ")})` : ""}`}>
        <Badge tone={info.dns === "missing" ? "danger" : "warn"}>{info.dns === "missing" ? "DNS absent" : info.dns === "elsewhere" ? "DNS ailleurs" : "DNS ?"}</Badge>
      </span>
    );
  return (
    <>
      {dnsBadge}
      {days !== null && days < 60 && (
        <span title={`${info.registrable} expire le ${new Date(info.expires!).toLocaleDateString("fr-FR")} : pense à le renouveler chez ton registrar`}>
          <Badge tone={days < 15 ? "danger" : "warn"}>{days < 0 ? "domaine expiré" : `domaine ${days} j`}</Badge>
        </span>
      )}
    </>
  );
}
