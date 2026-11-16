(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PresenceFormat = factory();
})(typeof self !== "undefined" ? self : this, () => {
  const WEEKDAYS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
  const VARIABLE_PATTERN = /\{\s*(\p{L}+)\s*\}/gu;
  const MEDIA_VARIABLES = new Set(["musica", "artista"]);
  const CLOCK_VARIABLES = new Set(["hora", "data", "dia"]);
  const TEXT_FIELDS = [
    "details", "state", "details2", "state2", "details3", "state3", "details4", "state4",
    "largeImageText", "smallImageText"
  ];
  const MUSIC_QUERY_LIMIT = 100;
  const MAX_BUTTON_URL = 512;

  const PLAYERS = [
    [/spotify/i, "Spotify", "spotify.com", "spotify"],
    [/youtube.?music|th-ch|cinhimbnkkaeohfgghhklpknlkffjgod/i, "YouTube Music", "music.youtube.com", "youtube"],
    [/deezer/i, "Deezer", "deezer.com", "deezer"],
    [/applemusic|apple.?music|itunes/i, "Apple Music", "music.apple.com", "apple"],
    [/tidal/i, "TIDAL", "tidal.com"],
    [/soundcloud/i, "SoundCloud", "soundcloud.com"],
    [/amazon.?music/i, "Amazon Music", "music.amazon.com"],
    [/netflix/i, "Netflix", "netflix.com"],
    [/disney/i, "Disney+", "disneyplus.com"],
    [/plex/i, "Plex", "plex.tv"],
    [/vlc|videolan/i, "VLC", "videolan.org"],
    [/foobar2000/i, "foobar2000", "foobar2000.org"],
    [/musicbee/i, "MusicBee", "getmusicbee.com"]
  ];

  const MUSIC_SERVICES = {
    youtube: { label: "Ouvir no YouTube Music", search: (query) => `https://music.youtube.com/search?q=${query}` },
    spotify: { label: "Ouvir no Spotify", search: (query) => `https://open.spotify.com/search/${query}` },
    deezer: { label: "Ouvir no Deezer", search: (query) => `https://www.deezer.com/search/${query}` },
    apple: { label: "Ouvir no Apple Music", search: (query) => `https://music.apple.com/search?term=${query}` }
  };

  function fold(name) {
    return String(name).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function variableValue(name, context) {
    const now = new Date(context.now ?? Date.now());
    switch (name) {
      case "hora": return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
      case "data": return `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
      case "dia": return WEEKDAYS[now.getDay()];
      case "perfil": return String(context.profileName || "");
      case "musica": return String(context.media?.title || "");
      case "artista": return String(context.media?.artist || "");
      default: return undefined;
    }
  }

  // A line that names the playing track is left out while nothing plays,
  // instead of reaching Discord half filled.
  function resolveText(template, context = {}) {
    const text = String(template || "");
    if (!text.includes("{")) return text;

    let missingMedia = false;
    const resolved = text.replace(VARIABLE_PATTERN, (match, raw) => {
      const name = fold(raw);
      const value = variableValue(name, context);
      if (value === undefined) return match;
      if (MEDIA_VARIABLES.has(name) && !context.media?.title) missingMedia = true;
      return value;
    });
    return missingMedia ? "" : resolved;
  }

  function variablesIn(config) {
    const names = new Set();
    for (const field of TEXT_FIELDS) {
      for (const match of String(config?.[field] || "").matchAll(VARIABLE_PATTERN)) names.add(fold(match[1]));
    }
    return names;
  }

  function usesMediaVariables(config) {
    return [...variablesIn(config)].some((name) => MEDIA_VARIABLES.has(name));
  }

  function usesClockVariables(config) {
    return [...variablesIn(config)].some((name) => CLOCK_VARIABLES.has(name));
  }

  function parseClock(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
    return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : undefined;
  }

  function clockOn(nowMs, clock, dayOffset = 0) {
    const date = new Date(nowMs);
    date.setDate(date.getDate() + dayOffset);
    date.setHours(clock.hours, clock.minutes, 0, 0);
    return date.getTime();
  }

  // "since" counts from the last time the clock showed that time and "until"
  // counts down to the next one, so both keep working across midnight.
  function timerTimestamps(config, { startMs = 0, nowMs = Date.now() } = {}) {
    if (!config?.showTimer) return undefined;
    const clock = parseClock(config.timerTime);

    if (config.timerMode === "since" && clock) {
      const today = clockOn(nowMs, clock);
      return { start: today <= nowMs ? today : clockOn(nowMs, clock, -1) };
    }
    if (config.timerMode === "until" && clock) {
      const today = clockOn(nowMs, clock);
      return { end: today > nowMs ? today : clockOn(nowMs, clock, 1) };
    }
    return startMs > 0 ? { start: startMs } : undefined;
  }

  function faviconUrl(domain) {
    return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`;
  }

  function playerInfo(app) {
    const value = String(app || "");
    if (!value) return undefined;
    for (const [pattern, name, domain, service] of PLAYERS) {
      if (pattern.test(value)) return { name, domain, service, icon: faviconUrl(domain) };
    }
    return undefined;
  }

  // "auto" follows the player's own service, then the link the cover lookup
  // found, and falls back to a YouTube Music search.
  function musicButton(choice, media, { app = "", links = {} } = {}) {
    if (!choice || choice === "off" || !media?.title) return undefined;
    const service = choice === "auto"
      ? playerInfo(app)?.service || (links.apple ? "apple" : links.deezer ? "deezer" : "youtube")
      : choice;
    const target = MUSIC_SERVICES[service];
    if (!target) return undefined;

    const link = String(links[service] || "");
    if (/^https:\/\//i.test(link) && link.length <= MAX_BUTTON_URL) return { label: target.label, url: link };

    // Cut by code point so an emoji is never split, then shorten until the
    // encoded search fits the button limit.
    let characters = Array.from([media.artist, media.title].filter(Boolean).join(" ")).slice(0, MUSIC_QUERY_LIMIT);
    let url = target.search(encodeURIComponent(characters.join("")));
    while (url.length > MAX_BUTTON_URL && characters.length) {
      characters = characters.slice(0, -1);
      url = target.search(encodeURIComponent(characters.join("")));
    }
    return { label: target.label, url };
  }

  return {
    musicButton,
    parseClock,
    playerInfo,
    resolveText,
    timerTimestamps,
    usesClockVariables,
    usesMediaVariables
  };
});
