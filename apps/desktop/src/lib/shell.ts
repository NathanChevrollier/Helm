// État de la coque de l'application (ce qui entoure les pages) : sous-titre du fil d'Ariane,
// ouverture du sélecteur de serveur, de la palette et du centre de notifications.
import { create } from "zustand";

interface ShellState {
  /** Sous-partie affichée par la page (onglet courant…), dernier maillon du fil d'Ariane. */
  crumb: string | null;
  setCrumb: (c: string | null) => void;
  switcherOpen: boolean;
  setSwitcherOpen: (v: boolean) => void;
  paletteOpen: boolean;
  /** Texte initial de la palette (préfixe de portée : `>`, `@`, `/`, `#`). */
  paletteQuery: string;
  openPalette: (query?: string) => void;
  closePalette: () => void;
  notificationsOpen: boolean;
  setNotificationsOpen: (v: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;
  /** Demande d'ouverture du formulaire « Nouveau serveur » (depuis le sélecteur ou l'accueil). */
  newServerRequested: boolean;
  requestNewServer: (v: boolean) => void;
}

export const useShell = create<ShellState>((set) => ({
  crumb: null,
  setCrumb: (crumb) => set({ crumb }),
  switcherOpen: false,
  setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),
  paletteOpen: false,
  paletteQuery: "",
  openPalette: (paletteQuery = "") => set({ paletteOpen: true, paletteQuery }),
  closePalette: () => set({ paletteOpen: false, paletteQuery: "" }),
  notificationsOpen: false,
  setNotificationsOpen: (notificationsOpen) => set({ notificationsOpen }),
  shortcutsOpen: false,
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  newServerRequested: false,
  requestNewServer: (newServerRequested) => set({ newServerRequested }),
}));
