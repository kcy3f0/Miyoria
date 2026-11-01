/** Miyoria mark: a crescent (her) over a baseline (the stage). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
      <path
        d="M15.5 3.5a8 8 0 1 0 5 14.2A6.5 6.5 0 0 1 15.5 3.5Z"
        fill="currentColor"
        opacity="0.9"
      />
      <path d="M3 21h18" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" opacity="0.55" />
    </svg>
  );
}
