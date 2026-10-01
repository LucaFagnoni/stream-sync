// Tema dell'interfaccia: «auto» segue il sistema, oppure chiaro / scuro (scelta salvata nelle impostazioni).
import * as app from '../app.js';

export const THEMES = ['auto', 'light', 'dark'];

/** Applica il tema salvato alla pagina (attributo data-theme; «auto» lascia decidere prefers-color-scheme). */
export function applyTheme() {
  const mode = app.state.settings.theme;
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
}

export function setTheme(mode) {
  if (!THEMES.includes(mode)) return;
  app.updateSettings({ theme: mode });
  applyTheme();
}

export const currentTheme = () => (THEMES.includes(app.state.settings.theme) ? app.state.settings.theme : 'auto');
