import { useTheme } from "../lib/theme";

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const target = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${target} theme`;

  return (
    <button
      onClick={() => setTheme(target)}
      title={label}
      aria-label={label}
      className="hairline flex items-center justify-center rounded-md bg-ink-900 p-1.5 text-graphite transition-colors hover:text-chalk"
    >
      {target === "light" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="9" r="3.2" />
      <path d="M9 1.5v1.5M9 15v1.5M1.5 9h1.5M15 9h1.5M3.7 3.7l1.1 1.1M13.2 13.2l1.1 1.1M14.3 3.7l-1.1 1.1M4.8 13.2l-1.1 1.1" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 10.6A6.2 6.2 0 0 1 7.4 3 6.3 6.3 0 1 0 15 10.6Z" />
    </svg>
  );
}
