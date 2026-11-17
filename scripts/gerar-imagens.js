const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.join(__dirname, "..");
const out = path.join(repo, "docs", "imagens");
const { normalizeProfiles } = require(path.join(repo, "src", "config.js"));
const version = require(path.join(repo, "package.json")).version;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.setPath("userData", path.join(os.tmpdir(), "rickdev-presence-imagens"));

const svg = (markup) => `data:image/svg+xml;base64,${Buffer.from(markup).toString("base64")}`;
const icon = `data:image/png;base64,${fs.readFileSync(path.join(repo, "build", "icon.png")).toString("base64")}`;

const codeArt = svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5865f2"/><stop offset="1" stop-color="#1e1f4b"/></linearGradient></defs>
<rect width="256" height="256" fill="url(#g)"/>
<g fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round" stroke-linejoin="round">
<path d="M92 84 48 128l44 44"/><path d="m164 84 44 44-44 44"/><path d="m142 70-28 116" stroke-opacity=".75"/></g></svg>`);

const albumArt = svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff8a5b"/><stop offset=".55" stop-color="#d9467a"/><stop offset="1" stop-color="#3b1d5e"/></linearGradient></defs>
<rect width="256" height="256" fill="url(#s)"/>
<circle cx="128" cy="118" r="54" fill="#ffd27a" fill-opacity=".9"/>
<path d="M0 196h22v-40h18v24h16v-58h24v74h14v-34h20v34h12v-50h22v50h16v-30h18v30h16v-62h20v62h18v-22h20v76H0z" fill="#1c1030"/>
<g fill="#ffd27a" fill-opacity=".85"><rect x="62" y="132" width="5" height="6"/><rect x="70" y="146" width="5" height="6"/><rect x="138" y="156" width="5" height="6"/><rect x="214" y="150" width="5" height="6"/><rect x="222" y="164" width="5" height="6"/></g></svg>`);

const APPLICATION = {
  id: "123456789012345678",
  name: "RickDev Studio",
  iconUrl: icon,
  assets: { codigo: codeArt, rickdev: icon }
};

const repoUrl = "https://github.com/Eu-RickDev/RickDev-presence-studio";
const base = {
  clientId: APPLICATION.id,
  statusDisplay: "details",
  largeImageKey: "codigo",
  largeImageText: "RickDev Presence Studio",
  smallImageKey: "rickdev",
  smallImageText: "RickDev",
  button1Label: "Ver no GitHub",
  button1Url: repoUrl,
  button2Label: "Baixar o app",
  button2Url: `${repoUrl}/releases/latest`,
  showTimer: true
};

function store({ active = 0, first = {}, status } = {}) {
  const data = normalizeProfiles({
    activeProfile: active,
    settings: {
      startWithWindows: true,
      autoStartPresence: true,
      autoReconnect: true,
      musicCoverLookup: true,
      musicVideoApps: ["chrome.exe"],
      musicDiscreetApps: ["firefox.exe"],
      awayAction: "hide",
      awayMinutes: 10,
      automationRules: [
        { enabled: true, type: "process", process: "Code.exe", profile: 0 },
        { enabled: true, type: "process", process: "Spotify.exe", profile: 3 },
        { enabled: true, type: "schedule", days: [1, 2, 3, 4, 5], start: "19:00", end: "22:00", profile: 2 }
      ]
    },
    profiles: [
      { name: "Programando", config: { ...base, details: "Desenvolvendo um app", state: "Ajustando a interface", ...first } },
      { name: "Jogando", config: { ...base, details: "Partida ranqueada", state: "Com os amigos" } },
      { name: "Estudando", config: { ...base, details: "Estudando JavaScript", state: "Foco total" } },
      {
        name: "Música",
        config: {
          ...base,
          activityType: "listening",
          smallImageKey: "",
          details: "Ouvindo uma playlist",
          state: "No modo de mídia",
          musicMode: true,
          musicPlayerIcon: true,
          musicButton: "auto",
          button2Label: "",
          button2Url: ""
        }
      },
      { name: "Ausente", config: { ...base, details: "Volto já", state: "Longe do teclado", showTimer: false } }
    ]
  });
  return { ...data, appVersion: version, presenceStatus: status };
}

const online = (message, liveProfile) => ({
  status: "online",
  message,
  connected: true,
  startedAt: Date.now() - ((1 * 60 + 23) * 60 + 41) * 1000,
  liveProfile
});

const media = {
  active: true,
  app: "Spotify.exe",
  title: "Luzes da Avenida",
  artist: "Noite Clara",
  album: "Cidade Acesa",
  playing: true,
  positionMs: 83000,
  durationMs: 214000,
  artUrl: albumArt,
  video: false,
  links: {}
};

const SCENES = [
  {
    file: "tela-principal.png",
    store: () => store({ status: online("Presence ativa", 0) })
  },
  {
    file: "variaveis.png",
    store: () => store({
      first: { details: "Programando · {dia}", state: "{data} às {hora}" },
      status: online("Presence ativa", 0)
    }),
    action: `document.querySelector("#variableToggle").click();
      const card = document.querySelector("#variableBar").closest(".card");
      let box = card.parentElement;
      while (box && box.scrollHeight <= box.clientHeight + 1) box = box.parentElement;
      (box || document.scrollingElement).scrollTop += card.getBoundingClientRect().top - document.querySelector(".discord-card").getBoundingClientRect().top;
      for (const other of card.parentElement.children) if (other !== card) other.style.visibility = "hidden";`,
    crop: `(() => {
      const card = document.querySelector("#variableBar").closest(".card").getBoundingClientRect();
      const label = document.querySelector(".preview-column .section-label").getBoundingClientRect();
      const pill = document.querySelector("#statusPill").getBoundingClientRect();
      const preview = document.querySelector(".discord-card").getBoundingClientRect();
      const top = label.top - 20;
      const bottom = Math.max(card.bottom, pill.bottom) + 24;
      return { x: Math.round(card.left - 24), y: Math.round(top), width: Math.round(preview.right + 24 - (card.left - 24)), height: Math.round(bottom - top) };
    })()`
  },
  {
    file: "modo-de-midia.png",
    height: 1010,
    wait: 3000,
    store: () => store({ active: 3, status: online(`Modo de mídia: ${media.title} - ${media.artist}`, 3) }),
    action: `document.querySelector('[data-tab="media"]').click();`,
    music: () => ({
      watching: true,
      error: "",
      presentation: { mode: "music", paused: false },
      sources: [
        { app: "Spotify.exe", title: media.title, playing: true, ignored: false, video: false, discreet: false, reportedVideo: false },
        { app: "chrome.exe", title: "Aula de JavaScript", playing: false, ignored: false, video: true, discreet: false, reportedVideo: false },
        { app: "firefox.exe", title: "Podcast de tecnologia", playing: false, ignored: false, video: false, discreet: true, reportedVideo: false }
      ],
      media
    })
  },
  {
    file: "automacao.png",
    height: 1010,
    wait: 2000,
    store: () => store({ status: online("Presence ativa", 0) }),
    action: `document.querySelector("#settingsButton").click();
      setTimeout(() => { document.querySelector("#settingsModal .modal-body").scrollTop = 100000; }, 400);`,
    crop: `(() => {
      const modal = document.querySelector("#settingsModal .modal").getBoundingClientRect();
      return { x: Math.round(modal.left), y: Math.round(modal.top), width: Math.round(modal.width), height: Math.round(modal.height) };
    })()`
  }
];

const WINDOW_CSS = `
.capture-controls { position: fixed; top: 0; right: 0; height: 39px; display: flex; z-index: 2147483647; background: #0f0f10; }
.capture-controls span { width: 46px; height: 39px; display: grid; place-items: center; font: 10px "Segoe MDL2 Assets"; color: #a1a1a6; }
* { caret-color: transparent !important; }
`;
const WINDOW_JS = `(() => {
  const bar = document.createElement("div");
  bar.className = "capture-controls";
  for (const glyph of ["\\uE921", "\\uE922", "\\uE8BB"]) {
    const item = document.createElement("span");
    item.textContent = glyph;
    bar.append(item);
  }
  document.querySelector(".titlebar").append(bar);
})();`;

let scene;

ipcMain.handle("config:load", () => scene.store());
ipcMain.handle("config:save", (_event, data) => ({ ...normalizeProfiles(data), appVersion: version }));
ipcMain.handle("application:lookup", (_event, clientId) => {
  if (clientId !== APPLICATION.id) throw new Error("Application ID desconhecido");
  return APPLICATION;
});
ipcMain.handle("automation:processes", () => ["Code.exe", "Discord.exe", "Spotify.exe", "chrome.exe"]);
for (const channel of ["music:watch", "presence:connect", "presence:disconnect", "link:open", "profiles:export", "profiles:import", "update:install"]) {
  ipcMain.handle(channel, () => ({ ok: false }));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function capture(win, next) {
  scene = next;
  win.setContentSize(1180, next.height || 820);
  const ready = new Promise((resolve) => ipcMain.once("ui:ready", resolve));
  await win.loadFile(path.join(repo, "src", "renderer", "index.html"));
  await ready;
  await win.webContents.insertCSS(WINDOW_CSS);
  await win.webContents.executeJavaScript(WINDOW_JS);
  if (next.music) win.webContents.send("music:state", next.music());
  if (next.action) await win.webContents.executeJavaScript(next.action);
  await wait(next.wait || 1500);
  await win.webContents.executeJavaScript("document.activeElement?.blur?.(); true");
  await wait(200);
  const rect = next.crop ? await win.webContents.executeJavaScript(next.crop) : undefined;
  const image = await win.webContents.capturePage(rect);
  fs.writeFileSync(path.join(out, next.file), image.toPNG());
  const { width, height } = image.getSize();
  console.log(`${next.file} ${width}x${height}`);
}

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    callback({ cancel: !details.url.startsWith("https://t1.gstatic.com/faviconV2") });
  });

  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 820,
    useContentSize: true,
    frame: false,
    backgroundColor: "#141415",
    webPreferences: {
      preload: path.join(repo, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false
    }
  });
  win.webContents.setFrameRate(30);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  for (const next of SCENES) await capture(win, next);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
