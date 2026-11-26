import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_KEY = "sketchdex:theme";

const THEME_COLOR: Record<Theme, string> = {
  light: "#f6f6f4",
  dark: "#0b0b0c",
};

export const readTheme = (): Theme => {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
};

export const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLOR[theme]);
};

type Listener = (theme: Theme) => void;

const listeners = new Set<Listener>();
let current: Theme = readTheme();

const publish = (theme: Theme) => {
  current = theme;
  applyTheme(theme);
  for (const listener of listeners) listener(theme);
};

export const setTheme = (theme: Theme) => {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {}
  publish(theme);
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_KEY) return;
    const next = readTheme();
    if (next !== current) publish(next);
  });
}

export const useTheme = () => {
  const [theme, setLocal] = useState<Theme>(current);
  useEffect(() => {
    listeners.add(setLocal);
    setLocal(current);
    return () => {
      listeners.delete(setLocal);
    };
  }, []);
  return { theme, setTheme };
};
