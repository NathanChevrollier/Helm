// Module séparé de TerminalPane : l'importer ne charge pas xterm.
/** Terminal actuellement focalisé : cible des fragments. */
export const focusedTerminal: { id: number | null; focus?: () => void } = { id: null };
