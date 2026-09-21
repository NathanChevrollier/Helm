import { create } from "zustand";

export type ThemeSetting = "dark" | "light" | "system";
export type Theme = "dark" | "light";

/** Thème effectivement affiché (le réglage « système » suit Windows). */
export const useTheme = create<{ theme: Theme }>(() => ({ theme: "dark" }));

const media = () => window.matchMedia?.("(prefers-color-scheme: light)");

function resolve(setting: ThemeSetting): Theme {
  if (setting === "system") return media()?.matches ? "light" : "dark";
  return setting;
}

/** Applique le réglage et suit les changements de thème de Windows en mode « système ». */
export function applyTheme(setting: ThemeSetting): () => void {
  const set = () => {
    const theme = resolve(setting);
    document.documentElement.dataset.theme = theme;
    useTheme.setState({ theme });
  };
  set();
  const m = media();
  if (setting !== "system" || !m) return () => {};
  m.addEventListener("change", set);
  return () => m.removeEventListener("change", set);
}

/** Thème Monaco correspondant (défini dans lib/monaco.ts). */
export function useMonacoTheme(): string {
  return useTheme((s) => (s.theme === "light" ? "helm-light" : "helm-dark"));
}
