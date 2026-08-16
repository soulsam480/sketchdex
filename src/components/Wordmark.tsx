export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <CodexMark />
      {!compact && (
        <span className="font-mono text-sm tracking-tight">
          <span className="text-chalk">sketch</span>
          <span className="text-graphite">dex</span>
        </span>
      )}
    </div>
  );
}

/** Three bound leaves: the codex, not the endless scroll. */
function CodexMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2.5"
        y="4.5"
        width="13"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeOpacity="0.35"
      />
      <rect
        x="4.5"
        y="2.5"
        width="9"
        height="10"
        rx="1.5"
        fill="#0b0b0c"
        stroke="currentColor"
        strokeOpacity="0.6"
      />
      <path
        d="M7 6.5h4M7 9h2.5"
        stroke="currentColor"
        strokeOpacity="0.9"
        strokeLinecap="round"
      />
    </svg>
  );
}
