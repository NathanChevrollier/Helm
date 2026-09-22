// Assistant IA : conversation, outils appelés et commandes proposées.
import { create } from "zustand";
import { api, errorMessage, type AiEvent, type AiView } from "./api";
import { useApp } from "./store";

export interface ToolRun {
  callId: string;
  name: string;
  detail: string;
  ok?: boolean;
  summary?: string;
}

export interface Proposal {
  callId: string;
  server: string;
  command: string;
  why: string;
  dangerous: boolean;
  /** Réponse déjà donnée, pour garder la trace dans la discussion. */
  answer?: "accepted" | "refused";
}

export type Entry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; run: ToolRun }
  | { kind: "proposal"; proposal: Proposal }
  | { kind: "error"; text: string };

interface AssistantState {
  open: boolean;
  conversation: string;
  entries: Entry[];
  running: boolean;
  /** Configuration relue à l'ouverture du panneau. */
  config: AiView | null;
  setOpen: (open: boolean) => void;
  reload: () => Promise<void>;
  reset: () => Promise<void>;
  push: (entry: Entry) => void;
}

export const useAssistant = create<AssistantState>((set, get) => ({
  open: false,
  conversation: `conv-${Date.now()}`,
  entries: [],
  running: false,
  config: null,
  setOpen: (open) => {
    set({ open });
    if (open && !get().config) void get().reload();
  },
  reload: async () => set({ config: await api.aiGet().catch(() => null) }),
  reset: async () => {
    const conversation = await api.aiReset(get().conversation).catch(() => `conv-${Date.now()}`);
    set({ conversation, entries: [] });
  },
  push: (entry) => set((s) => ({ entries: [...s.entries, entry] })),
}));

/** Pose une question. `context` décrit ce que l'utilisateur regarde (terminal, journal…). */
export async function ask(question: string, context?: string) {
  const state = useAssistant.getState();
  if (state.running || !question.trim()) return;
  state.setOpen(true);
  useAssistant.setState({ running: true, entries: [...useAssistant.getState().entries, { kind: "user", text: question }] });
  const { push } = useAssistant.getState();
  try {
    await api.aiAsk(useAssistant.getState().conversation, question, context, (e: AiEvent) => {
      if (e.type === "text") push({ kind: "assistant", text: e.text });
      else if (e.type === "tool") push({ kind: "tool", run: { callId: e.callId, name: e.name, detail: e.detail } });
      else if (e.type === "toolDone")
        useAssistant.setState((s) => ({
          entries: s.entries.map((entry) =>
            entry.kind === "tool" && entry.run.callId === e.callId ? { ...entry, run: { ...entry.run, ok: e.ok, summary: e.summary } } : entry,
          ),
        }));
      else if (e.type === "proposal") push({ kind: "proposal", proposal: { callId: e.callId, server: e.server, command: e.command, why: e.why, dangerous: e.dangerous } });
      else if (e.type === "error") push({ kind: "error", text: e.message });
    });
  } catch (e) {
    const message = errorMessage(e);
    // L'erreur est déjà affichée si elle est venue par un évènement.
    if (!useAssistant.getState().entries.some((x) => x.kind === "error" && x.text === message)) push({ kind: "error", text: message });
  } finally {
    useAssistant.setState({ running: false });
  }
}

/** Accepte ou refuse une commande proposée. */
export async function answerProposal(callId: string, accepted: boolean) {
  useAssistant.setState((s) => ({
    entries: s.entries.map((e) =>
      e.kind === "proposal" && e.proposal.callId === callId ? { ...e, proposal: { ...e.proposal, answer: accepted ? "accepted" : "refused" } } : e,
    ),
  }));
  try {
    await api.aiAnswerProposal(callId, accepted);
  } catch (e) {
    useApp.getState().notify(errorMessage(e), "error");
  }
}

/**
 * Demande une explication sur ce que l'utilisateur regarde (erreur de terminal, journal, échec
 * d'une action) : le texte part comme contexte, pas comme question.
 */
export function explain(what: string, content: string) {
  const extract = content.trim().slice(-4000);
  void ask(`Explique ${what} et dis-moi quoi faire.`, `Voici ${what} :\n\n${extract}`);
}
