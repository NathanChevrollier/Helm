import { useId } from "react";

const SPOKES: [number, number][] = [
  [0, -330],
  [-330, 0],
  [-233, -233],
  [-233, 233],
];

/** Logo de Helm, identique à l'icône de l'application (app-icon.svg). */
export function HelmLogo({ size = 24, className }: { size?: number; className?: string }) {
  const bg = useId();
  return (
    <svg viewBox="64 64 896 896" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d2433" />
          <stop offset="1" stopColor="#0d1117" />
        </linearGradient>
      </defs>
      <rect x="64" y="64" width="896" height="896" rx="200" fill={`url(#${bg})`} />
      <g transform="translate(512 512)" stroke="#3b82f6" strokeLinecap="round" fill="none">
        <g strokeWidth="44">
          {SPOKES.map(([x, y]) => (
            <line key={`${x},${y}`} x1={x} y1={y} x2={-x} y2={-y} />
          ))}
        </g>
        <g fill="#3b82f6" stroke="none">
          {SPOKES.flatMap(([x, y]) => [
            <circle key={`${x},${y}`} cx={x} cy={y} r="42" />,
            <circle key={`${-x},${-y}`} cx={-x} cy={-y} r="42" />,
          ])}
        </g>
        <circle r="220" strokeWidth="56" stroke="#e6edf3" />
        <circle r="70" fill="#e6edf3" stroke="none" />
      </g>
    </svg>
  );
}
