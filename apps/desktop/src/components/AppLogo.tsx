import { useId } from "react";

/**
 * Logo « Zénith » de l'application, identique à l'icône (app-icon.svg). En petit (32 px et moins),
 * la version simplifiée d'app-icon-small.svg : trait plus épais, sans les micro-détails.
 */
export function AppLogo({ size = 24, className }: { size?: number; className?: string }) {
  const bg = useId();
  const small = size <= 32;
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#16213a" />
          <stop offset="1" stopColor="#0b1120" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="1024" height="1024" rx="230" fill={`url(#${bg})`} />
      <g transform="translate(-68 1.6) scale(11.6)">
        <path d="M62.31 16.17 A36 36 0 1 1 37.69 16.17" fill="none" stroke="#e9eef7" strokeWidth={small ? 7 : 5} strokeLinecap="round" />
        {small ? (
          <>
            <path d="M50 6 L44 44 L19 50 L44 56 L50 82Z" fill="#9cc0ff" />
            <path d="M50 6 L56 44 L81 50 L56 56 L50 82Z" fill="#4f8bff" />
          </>
        ) : (
          <>
            <path d="M50 6 L45 45 L20 50 L45 55 L50 82Z" fill="#9cc0ff" />
            <path d="M50 6 L55 45 L80 50 L55 55 L50 82Z" fill="#4f8bff" />
            <path d="M80 73 L81.4 76.6 L85 78 L81.4 79.4 L80 83 L78.6 79.4 L75 78 L78.6 76.6Z" fill="#f5b642" />
            <circle cx="21" cy="78" r="2" fill="#e9eef7" />
          </>
        )}
      </g>
    </svg>
  );
}
