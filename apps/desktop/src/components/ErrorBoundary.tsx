// Filet de sécurité de l'interface : une page qui plante n'emporte plus toute la fenêtre.
//
// Sans lui, une erreur de rendu démonte l'app entière (écran vide, plus de barre latérale). Ici
// l'erreur reste confinée à la zone qui l'a levée, la navigation reste utilisable, et changer de
// section (ou de `resetKey`) repart d'un état propre.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Bug, House, RefreshCw, X } from "lucide-react";
import { Button } from "./ui";

interface Props {
  children: ReactNode;
  /** Change de valeur → l'erreur est oubliée et les enfants sont remontés (ex. la section affichée). */
  resetKey?: unknown;
  /** Nom de la zone, pour le message (« la page Docker », « l'écran distant »…). */
  label?: string;
  /** Action de repli propre à la zone : fermer la session, revenir à l'accueil… */
  onClose?: () => void;
  closeLabel?: string;
  /** Rendu compact (panneau latéral, barre) plutôt qu'une page entière. */
  compact?: boolean;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // Nouvelle section (ou nouvelle session) : on repart de zéro.
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[zenytt] erreur d'affichage${this.props.label ? ` (${this.props.label})` : ""}`, error, info.componentStack);
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { label, onClose, closeLabel, compact } = this.props;
    return (
      <div role="alert" className={`flex size-full flex-col items-center justify-center gap-3 bg-bg text-center ${compact ? "p-4" : "p-8"}`}>
        <div className="flex size-12 items-center justify-center rounded-2xl bg-danger/10 text-danger">
          <Bug size={22} />
        </div>
        <h2 className="text-[15px] font-semibold">{label ? `Un problème est survenu dans ${label}` : "Un problème est survenu"}</h2>
        <p className="max-w-lg text-[13px] leading-relaxed text-muted">Le reste de Zenytt fonctionne toujours : tu peux changer de section, réessayer ou fermer cette zone.</p>
        <pre className="max-h-32 max-w-lg overflow-auto rounded-lg border border-border bg-subtle px-3 py-2 text-left font-mono text-[11.5px] whitespace-pre-wrap text-danger select-text">{error.message || String(error)}</pre>
        <div className="flex flex-wrap justify-center gap-2">
          <Button icon={<RefreshCw size={13} />} onClick={this.retry}>
            Réessayer
          </Button>
          {onClose && (
            <Button variant="ghost" icon={closeLabel ? <X size={13} /> : <House size={13} />} onClick={onClose}>
              {closeLabel ?? "Retour à l'accueil"}
            </Button>
          )}
        </div>
      </div>
    );
  }
}
