import type { JSX } from "react";

interface BrandMarkProps {
  className?: string;
}

/** Renders the HOLO-Codex terminal prompt inside the human-on-loop control ring. */
export function BrandMark({ className = "brand-logo" }: BrandMarkProps): JSX.Element {
  return (
    <svg className={className} viewBox="0 0 128 128" role="img" aria-label="HOLO-Codex">
      <path
        d="M111.3 52.6A49 49 0 1 1 84 19.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="8"
      />
      <circle className="brand-logo__gate" cx="98.6" cy="29.4" r="6.5" />
      <path
        d="M41 48L62 64L41 80"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="8"
      />
      <path
        d="M70 81H91"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="8"
      />
    </svg>
  );
}
