"use client";

import { useEffect, useState } from "react";

// Same mechanism as the launch terminal: light is the default, dark is the `dark` class on
// <html>, and the choice is remembered under "d17-theme" (applied before paint by layout.tsx).
export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    if (next) {
      delete document.documentElement.dataset.theme;
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.dataset.theme = "light";
      document.documentElement.classList.remove("dark");
    }
    try {
      localStorage.setItem("d17-theme", next ? "dark" : "light");
    } catch {
      /* private mode */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="font-mono text-[11px] uppercase tracking-[0.04em] text-quiet transition-colors hover:text-ink"
    >
      {dark ? "Light" : "Dark"}
    </button>
  );
}
