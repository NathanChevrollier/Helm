// Glisser-déposer interne à la souris (le glisser HTML5 est réservé par Tauri aux fichiers du PC).
// Les cibles sont les éléments portant `data-drop="<clé>"`.

const ghostStyle =
  "position:fixed;z-index:60;pointer-events:none;padding:4px 10px;border-radius:6px;font-size:12px;" +
  "background:var(--color-panel);color:var(--color-fg);border:1px solid var(--color-accent);box-shadow:0 6px 20px rgb(0 0 0/.35)";

/**
 * Démarre un glisser depuis un `mousedown` : au-delà de 6 px, une étiquette suit la souris et la
 * cible survolée reçoit l'attribut `data-drop-over`. Au relâchement sur une cible, `onDrop(clé)`.
 * Un simple clic ne déclenche rien.
 */
export function startDrag(e: React.MouseEvent, label: string, onDrop: (key: string) => void) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input, select, a, textarea")) return;
  const start = { x: e.clientX, y: e.clientY };
  let ghost: HTMLDivElement | null = null;
  let over: Element | null = null;

  const targetAt = (x: number, y: number) => document.elementFromPoint(x, y)?.closest("[data-drop]") ?? null;
  const setOver = (el: Element | null) => {
    if (el === over) return;
    over?.removeAttribute("data-drop-over");
    el?.setAttribute("data-drop-over", "");
    over = el;
  };
  const move = (m: MouseEvent) => {
    if (!ghost) {
      if (Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
      ghost = document.createElement("div");
      ghost.style.cssText = ghostStyle;
      ghost.textContent = label;
      document.body.appendChild(ghost);
      document.body.style.cursor = "grabbing";
    }
    ghost.style.left = `${m.clientX + 12}px`;
    ghost.style.top = `${m.clientY + 8}px`;
    setOver(targetAt(m.clientX, m.clientY));
  };
  const up = (m: MouseEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (!ghost) return;
    ghost.remove();
    document.body.style.cursor = "";
    const target = targetAt(m.clientX, m.clientY);
    setOver(null);
    const key = target?.getAttribute("data-drop");
    if (key != null) onDrop(key);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}
