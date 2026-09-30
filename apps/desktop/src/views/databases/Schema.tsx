// Structure des bases sans écrire de SQL : nouvelle table (éditeur de colonnes), structure d'une
// table (ajouter, renommer, supprimer une colonne), et les actions sur tables et bases.
//
// Chaque action passe par `useSchemaApply` : le SQL est construit côté Rust, montré dans la
// confirmation, puis exécuté ; rien ne part sans validation.
import { useCallback, useEffect, useState } from "react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { api, errorMessage, type DbColumn, type DbColumnDef, type DbEngine, type DbInstance, type DbSchemaOp } from "../../lib/api";
import { useAppPick } from "../../lib/store";
import { Badge, Button, Checkbox, Drawer, Field, IconButton, Input, Loading, Modal, Select } from "../../components/ui";

/** Applique une opération de structure après confirmation ; renvoie vrai si elle a été exécutée. */
export function useSchemaApply(serverId: string, instance: DbInstance | undefined, database: string | null, onDone: () => void) {
  const { ask, notify } = useAppPick("ask", "notify");
  return useCallback(
    async (op: DbSchemaOp, title: string, body: string, danger = true): Promise<boolean> => {
      if (!instance) return false;
      try {
        const sql = await api.dbSchemaSql(instance.engine, op);
        if (!(await ask({ title, body, code: sql, confirmLabel: "Appliquer", danger }))) return false;
        // Une base à supprimer ne peut pas être celle de la connexion (PostgreSQL le refuse).
        await api.dbQuery(serverId, instance, op.op === "dropDatabase" ? null : database, sql, 1);
        notify("Modification appliquée.", "success");
        onDone();
        return true;
      } catch (e) {
        notify(errorMessage(e), "error");
        return false;
      }
    },
    [serverId, instance, database, ask, notify, onDone],
  );
}

const NAME_RE = /^[A-Za-z0-9_$.-]{1,64}$/;

function useColumnTypes(engine: DbEngine) {
  const [types, setTypes] = useState<string[]>([]);
  useEffect(() => {
    void api.dbColumnTypes(engine).then(setTypes, () => setTypes([]));
  }, [engine]);
  return types;
}

const newColumn = (engine: DbEngine, first: boolean): DbColumnDef =>
  first
    ? { name: "id", dataType: engine === "mysql" ? "INT" : "INTEGER", length: "", nullable: false, default: "", primary: true, autoIncrement: true }
    : { name: "", dataType: engine === "mysql" ? "VARCHAR" : "TEXT", length: engine === "mysql" ? "255" : "", nullable: true, default: "", primary: false, autoIncrement: false };

/** Ligne d'édition d'une colonne. `withKeys` : clé primaire et auto-incrément (création de table). */
function ColumnRow({ engine, types, value, onChange, onRemove, withKeys }: { engine: DbEngine; types: string[]; value: DbColumnDef; onChange: (c: DbColumnDef) => void; onRemove?: () => void; withKeys: boolean }) {
  const set = (patch: Partial<DbColumnDef>) => onChange({ ...value, ...patch });
  const lengthUseful = ["VARCHAR", "CHAR", "DECIMAL", "NUMERIC"].includes(value.dataType);
  return (
    <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_70px_minmax(0,1fr)_auto] items-center gap-2">
      <Input size_="sm" className="font-mono" placeholder="nom" value={value.name} onChange={(e) => set({ name: e.target.value })} aria-label="Nom de la colonne" />
      <Select size="sm" value={value.dataType} onChange={(dataType) => set({ dataType, length: ["VARCHAR", "CHAR"].includes(dataType) && engine === "mysql" ? value.length || "255" : ["DECIMAL", "NUMERIC"].includes(dataType) ? value.length || "10,2" : "" })} options={types.map((t) => ({ value: t, label: t }))} aria-label="Type" />
      <Input size_="sm" className="font-mono" placeholder={lengthUseful ? "taille" : "—"} disabled={!lengthUseful} value={value.length} onChange={(e) => set({ length: e.target.value })} aria-label="Taille" />
      <Input size_="sm" placeholder="défaut (vide : aucun)" disabled={value.autoIncrement} value={value.default} onChange={(e) => set({ default: e.target.value })} aria-label="Valeur par défaut" />
      <span className="flex items-center gap-2 text-xs">
        <Checkbox checked={value.nullable && !value.primary} disabled={value.primary} onChange={(nullable) => set({ nullable })} label="NULL" />
        {withKeys && (
          <>
            <Checkbox checked={value.primary} onChange={(primary) => set({ primary, nullable: primary ? false : value.nullable, autoIncrement: primary ? value.autoIncrement : false })} label="Clé" />
            <Checkbox checked={value.autoIncrement} disabled={!value.primary} onChange={(autoIncrement) => set({ autoIncrement, default: autoIncrement ? "" : value.default })} label="Auto" />
          </>
        )}
        {onRemove && (
          <IconButton size="sm" title="Retirer cette colonne" onClick={onRemove}>
            <Trash2 size={13} />
          </IconButton>
        )}
      </span>
    </div>
  );
}

/** Nouvelle table : son nom et ses colonnes. */
export function CreateTableDialog({ instance, database, apply, onClose }: { instance: DbInstance; database: string; apply: ReturnType<typeof useSchemaApply>; onClose: () => void }) {
  const types = useColumnTypes(instance.engine);
  const [name, setName] = useState("");
  const [columns, setColumns] = useState<DbColumnDef[]>(() => [newColumn(instance.engine, true), newColumn(instance.engine, false)]);
  const valid = NAME_RE.test(name) && columns.length > 0 && columns.every((c) => NAME_RE.test(c.name));
  const submit = async () => {
    if (await apply({ op: "createTable", table: name, columns }, `Créer la table « ${name} » dans ${database} ?`, "Voici la requête qui sera exécutée.", false)) onClose();
  };
  return (
    <Modal
      title={`Nouvelle table dans « ${database} »`}
      width="max-w-4xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="primary" disabled={!valid} onClick={() => void submit()}>
            Voir la requête et créer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Nom de la table" hint="Lettres, chiffres, « _ » (ex. clients, commandes_2026)">
          <Input value={name} onChange={(e) => setName(e.target.value)} className="w-72 font-mono" autoFocus />
        </Field>
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_70px_minmax(0,1fr)_auto] gap-2 text-[11px] font-medium text-muted">
            <span>Colonne</span>
            <span>Type</span>
            <span>Taille</span>
            <span>Valeur par défaut</span>
            <span>Options</span>
          </div>
          {columns.map((c, i) => (
            <ColumnRow
              key={i}
              engine={instance.engine}
              types={types}
              value={c}
              withKeys
              onChange={(v) => setColumns((cs) => cs.map((x, j) => (j === i ? v : x)))}
              onRemove={columns.length > 1 ? () => setColumns((cs) => cs.filter((_, j) => j !== i)) : undefined}
            />
          ))}
          <Button size="sm" variant="ghost" className="self-start" icon={<Plus size={13} />} onClick={() => setColumns((cs) => [...cs, newColumn(instance.engine, false)])}>
            Ajouter une colonne
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-faint">
          « Clé » : identifiant unique de chaque ligne (indispensable pour modifier les lignes depuis le tableau). « Auto » : numéroté automatiquement. Valeur par défaut : un nombre, un texte, ou CURRENT_TIMESTAMP pour la date du jour.
        </p>
      </div>
    </Modal>
  );
}

/** Structure d'une table : ses colonnes, à ajouter, renommer ou supprimer. */
export function StructureDrawer({ serverId, instance, database, table, apply, onClose }: { serverId: string; instance: DbInstance; database: string | null; table: string; apply: ReturnType<typeof useSchemaApply>; onClose: () => void }) {
  const { ask } = useAppPick("ask");
  const types = useColumnTypes(instance.engine);
  const [columns, setColumns] = useState<DbColumn[] | null>(null);
  const [adding, setAdding] = useState<DbColumnDef | null>(null);
  const load = useCallback(() => {
    setColumns(null);
    void api.dbColumns(serverId, instance, database, table).then(setColumns, () => setColumns([]));
  }, [serverId, instance, database, table]);
  useEffect(load, [load]);

  const rename = async (column: string) => {
    const to = await ask({ title: `Renommer la colonne « ${column} »`, input: { label: "Nouveau nom", initial: column }, confirmLabel: "Continuer" });
    if (typeof to !== "string" || !to.trim() || to.trim() === column) return;
    if (await apply({ op: "renameColumn", table, column, to: to.trim() }, `Renommer ${table}.${column} en « ${to.trim()} » ?`, "Les requêtes et applications qui utilisent l'ancien nom devront être adaptées.")) load();
  };
  const drop = async (column: string) => {
    if (await apply({ op: "dropColumn", table, column }, `Supprimer la colonne ${table}.${column} ?`, "Toutes ses valeurs sont perdues définitivement.")) load();
  };
  const add = async () => {
    if (!adding) return;
    if (await apply({ op: "addColumn", table, column: adding }, `Ajouter la colonne « ${adding.name} » à ${table} ?`, "Les lignes existantes prennent la valeur par défaut (ou NULL).", false)) {
      setAdding(null);
      load();
    }
  };

  return (
    <Drawer title={`Structure de ${table}`} subtitle={database ?? instance.label} width={720} onClose={onClose}>
      {!columns ? (
        <Loading rows={5} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="overflow-hidden rounded-xl border border-border">
            {columns.map((c) => (
              <div key={c.name} className="flex items-center gap-3 border-b border-line px-3 py-2 text-[13px] last:border-b-0">
                {c.primary ? <KeyRound size={13} className="shrink-0 text-warn" /> : <span className="w-[13px]" />}
                <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
                <span className="font-mono text-xs text-muted">{c.dataType}</span>
                {c.nullable ? <Badge tone="muted">NULL</Badge> : <Badge tone="accent">requis</Badge>}
                <IconButton size="sm" title="Renommer" onClick={() => void rename(c.name)}>
                  <Pencil size={13} />
                </IconButton>
                <IconButton size="sm" title={c.primary ? "La clé primaire ne se supprime pas ici" : "Supprimer la colonne"} disabled={c.primary || columns.length <= 1} onClick={() => void drop(c.name)}>
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
          </div>
          {adding ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-subtle p-3">
              <ColumnRow engine={instance.engine} types={types} value={adding} onChange={setAdding} withKeys={false} />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>
                  Annuler
                </Button>
                <Button size="sm" variant="primary" disabled={!NAME_RE.test(adding.name)} onClick={() => void add()}>
                  Voir la requête et ajouter
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" className="self-start" icon={<Plus size={13} />} onClick={() => setAdding(newColumn(instance.engine, false))}>
              Ajouter une colonne
            </Button>
          )}
        </div>
      )}
    </Drawer>
  );
}
