const APP_NAME = "RickDev Presence Studio";
const MAX_TOOLTIP_LENGTH = 127;

function menuLabel(text) {
  return String(text).replace(/&/g, "&&");
}

function formatSince(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "há menos de 1 min";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `há ${hours}h ${rest}min` : `há ${hours}h`;
}

function liveProfileName(state) {
  return state.names[state.liveIndex];
}

function trayHeadline(state) {
  if (state.away?.mode === "hide") return "Discord: ausente, presence oculta";
  if (state.away) return `Discord: ausente, perfil ${state.away.profileName}`;
  if (state.connected) return `Discord: ${liveProfileName(state) || "presence ativa"}`;
  if (state.connecting) return "Discord: conectando...";
  return "Discord: desconectado";
}

function trayTooltip(state, now = Date.now()) {
  if (!state.connected) return state.connecting ? `${APP_NAME} · conectando` : APP_NAME;
  if (state.away) return `${APP_NAME} · ausente`;
  const name = liveProfileName(state);
  if (!name) return APP_NAME;
  const since = state.since ? ` ${formatSince(now - state.since)}` : "";
  return `${APP_NAME} · ${name}${since}`.slice(0, MAX_TOOLTIP_LENGTH);
}

function trayMenuTemplate(state, actions) {
  return [
    { label: menuLabel(trayHeadline(state)), enabled: false },
    ...state.names.map((name, index) => ({
      label: menuLabel(name),
      type: "checkbox",
      checked: Boolean(state.connected && !state.away && index === state.liveIndex),
      click: () => actions.selectProfile(index)
    })),
    { type: "separator" },
    state.connected || state.connecting
      ? { label: "Desativar presence", click: actions.disconnect }
      : { label: "Ativar presence", click: actions.activate },
    { type: "separator" },
    { label: "Abrir RickDev Presence Studio", click: actions.open },
    { label: "Encerrar", click: actions.quit }
  ];
}

module.exports = { formatSince, menuLabel, trayHeadline, trayMenuTemplate, trayTooltip };
