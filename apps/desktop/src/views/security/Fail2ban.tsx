import { useCallback, useEffect, useState } from "react";
import { Ban, Plus, RefreshCw, ShieldOff, Trash2, UserCheck } from "lucide-react";
import { api, errorMessage, formatDuration, type F2bState } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, EmptyState, IconButton, Input } from "../../components/ui";
import { useCachedState } from "../../lib/cache";

/** Adresses que Helm ajoute toujours à la liste (boucle locale). */
const LOOPBACK = ["127.0.0.1/8", "127.0.0.0/8", "::1"];

function duration(secs: number): string {
  return secs < 0 ? "définitif" : formatDuration(secs);
}

export default function Fail2ban({ serverId }: { serverId: string }) {
  const { ask, notify } = useAppPick("ask", "notify");
  const [state, setState] = useCachedState<F2bState | null>(`fail2ban:${serverId}`, null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [myIp, setMyIp] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState(await api.f2bState(serverId));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
    void api.myPublicIp().then(setMyIp);
  }, [load]);

  // Liste commune à tous les jails (Helm les garde synchronisées), hors boucle locale.
  const ignored = [...new Set(state?.jails.flatMap((j) => j.ignoreip) ?? [])].filter((a) => !LOOPBACK.includes(a));

  const saveIgnore = async (addresses: string[], message: string) => {
    setSaving(true);
    try {
      await api.f2bSetIgnore(serverId, addresses);
      notify(message, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  const add = (addr: string) => {
    const a = addr.trim();
    if (!a || ignored.includes(a)) return;
    void saveIgnore([...ignored, a], `${a} ne sera plus jamais bannie`);
    setDraft("");
  };

  const unban = async (jail: string, ip: string) => {
    try {
      await api.f2bUnban(serverId, jail, ip);
      notify(`${ip} débloquée`, "success");
      await load();
    } catch (e) {
      notify(errorMessage(e), "error");
    }
  };

  if (error) return <p className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>;
  if (!state) return <EmptyState icon={<Ban size={36} className="animate-pulse" />} title="Lecture de fail2ban…" />;
  if (!state.installed || !state.running)
    return (
      <EmptyState icon={<ShieldOff size={36} />} title={state.installed ? "fail2ban est arrêté" : "fail2ban n'est pas installé"}>
        fail2ban bannit les adresses qui multiplient les échecs de connexion. L'onglet Audit propose de l'installer et de l'activer.
      </EmptyState>
    );

  const myIpIgnored = !!myIp && ignored.includes(myIp);
  const myIpBanned = !!myIp && state.jails.some((j) => j.banned.includes(myIp));

  return (
    <div className="flex max-w-4xl flex-col gap-5">
      <div className="flex items-center gap-2 text-sm text-muted">
        fail2ban {state.version} · {state.jails.length} jail(s) actif(s)
        <IconButton title="Actualiser" className="ml-auto" onClick={() => void load()}>
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </IconButton>
      </div>

      {myIp && !myIpIgnored && (
        <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-sm ${myIpBanned ? "border-danger/40 bg-danger/10" : "border-warn/40 bg-warn/10"}`}>
          <UserCheck size={16} className="shrink-0" />
          <span className="flex-1">
            {myIpBanned ? "Ton IP actuelle " : "Ton IP actuelle "}
            <span className="font-mono">{myIp}</span>
            {myIpBanned ? " est bannie. " : " peut être bannie après quelques échecs de connexion. "}
            L'ajouter aux exceptions évite de te retrouver bloqué dehors (fais-le seulement si c'est ton IP fixe, par exemple celle de ta box).
          </span>
          <Button size="sm" variant="primary" loading={saving} onClick={() => add(myIp)}>
            Ne jamais bannir mon IP
          </Button>
        </div>
      )}

      {state.jails.map((j) => (
        <section key={j.name} className="rounded-lg border border-border bg-panel">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="font-medium">{j.name}</span>
            <Badge tone={j.currentlyBanned ? "danger" : "ok"}>{j.currentlyBanned} bannie(s)</Badge>
            <span className="ml-auto text-xs text-muted">
              Bannissement de {duration(j.bantime)} après {j.maxretry} échec(s) en {duration(j.findtime)} · {j.totalBanned} bannissement(s) depuis le démarrage · {j.currentlyFailed} échec(s) en cours
            </span>
          </header>
          {j.banned.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted">Aucune adresse bannie.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {j.banned.map((ip) => (
                <li key={ip} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <span className="font-mono">{ip}</span>
                  {ip === myIp && <Badge tone="danger">ton IP</Badge>}
                  <Button
                    size="sm"
                    className="ml-auto"
                    onClick={async () => {
                      if (await ask({ title: `Débloquer ${ip} ?`, body: `Elle pourra de nouveau se connecter en SSH (jail ${j.name}).`, confirmLabel: "Débloquer" })) void unban(j.name, ip);
                    }}
                  >
                    Débloquer
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4">
        <div>
          <h2 className="font-medium">Adresses jamais bannies</h2>
          <p className="text-sm text-muted">
            Appliquées à tous les jails. Helm les écrit dans son propre fichier ({"/etc/fail2ban/jail.d/zz-helm-ignore.local"}), teste la configuration puis recharge fail2ban ; tes fichiers ne sont pas modifiés.
          </p>
        </div>
        <ul className="flex flex-wrap gap-2">
          {LOOPBACK.filter((a) => state.jails.some((j) => j.ignoreip.includes(a))).map((a) => (
            <li key={a} className="rounded-full border border-border px-3 py-1 font-mono text-xs text-muted">
              {a}
            </li>
          ))}
          {ignored.map((a) => (
            <li key={a} className="flex items-center gap-1 rounded-full border border-accent/40 py-1 pr-1 pl-3 font-mono text-xs">
              {a}
              {a === myIp && <span className="font-sans text-[10px] text-accent">(toi)</span>}
              <button
                className="rounded-full p-0.5 text-muted hover:text-danger"
                title="Retirer"
                onClick={async () => {
                  if (await ask({ title: `Retirer ${a} des exceptions ?`, body: "Elle pourra de nouveau être bannie.", confirmLabel: "Retirer", danger: true }))
                    void saveIgnore(
                      ignored.filter((x) => x !== a),
                      `${a} retirée des exceptions`,
                    );
                }}
              >
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add(draft);
          }}
        >
          <Input className="!w-72 font-mono" placeholder="IP ou réseau (ex. 203.0.113.4 ou 10.0.0.0/8)" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <Button size="sm" icon={<Plus size={13} />} type="submit" loading={saving} disabled={!draft.trim()}>
            Ajouter
          </Button>
        </form>
      </section>
    </div>
  );
}
