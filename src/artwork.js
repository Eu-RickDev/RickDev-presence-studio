const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const DEEZER_SEARCH_URL = "https://api.deezer.com/search";
const LOOKUP_TIMEOUT_MS = 6000;
const MAX_IMAGE_URL_LENGTH = 256;
const SEARCH_LIMIT = 10;
const USER_AGENT = "RickDev Presence Studio";
const EMPTY_TRACK_INFO = Object.freeze({ artUrl: "", album: "" });

const BRACKETED_PATTERN = /\s*[([【][^)\]】]*[)\]】]/g;
const TITLE_SEPARATOR = /\s+[-–—]\s+/;
const ARTIST_SEPARATOR = /\s*(?:,|&|\+|;|\/|\s(?:feat\.?|ft\.?|x|e|and|with|part\.?)\s)\s*/i;
const NOISE_PATTERN = /\b(?:official|oficial|video|videoclipe|clipe|clip|lyrics?|letra|audio|visuali[sz]er|mv|hd|hq|4k)\b/;
const FEATURING_PATTERN = /^(?:feat|ft|part|participacao|with)\b/;
const VERSION_PATTERN = /\b(?:ao vivo|live|remaster(?:ed)?|remasterizad[ao]|acustic[oa]|acoustic|version|versao|edit|remix|mix|instrumental|sped up|slowed|bonus|demo|mono|stereo|deluxe|\d{4})\b/;

function fold(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function cleanArtist(value) {
  let artist = String(value || "").trim().replace(/\s*-\s*topic$/i, "");
  if (/vevo$/i.test(artist)) {
    artist = artist.replace(/\s*vevo$/i, "").replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2");
  }
  return artist.trim();
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s*[|｜].*$/, "")
    .replace(BRACKETED_PATTERN, (part) => {
      const content = fold(part);
      return NOISE_PATTERN.test(content) || FEATURING_PATTERN.test(content) ? "" : part;
    })
    .replace(/\s+(?:feat|ft)\.?\s.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanAlbum(value) {
  return String(value || "").replace(/\s+-\s+(?:single|ep)$/i, "").trim();
}

function splitTitle(title) {
  const parts = title.split(TITLE_SEPARATOR);
  if (parts.length < 2) return undefined;
  return { left: parts[0].trim(), right: parts.slice(1).join(" - ").trim() };
}

function titleKey(value) {
  const base = cleanTitle(value).replace(BRACKETED_PATTERN, "").split(TITLE_SEPARATOR)[0];
  return fold(base) || fold(value);
}

function artistNames(value) {
  return String(value || "").split(ARTIST_SEPARATOR).map(fold).filter(Boolean);
}

function artistsOverlap(first, second) {
  const left = artistNames(first);
  const right = artistNames(second);
  const contains = (haystack, needle) => ` ${haystack} `.includes(` ${needle} `);
  return left.some((a) => right.some((b) => contains(a, b) || contains(b, a)));
}

function trackQueries(media) {
  const artist = cleanArtist(media?.artist);
  const title = cleanTitle(media?.title);
  const album = String(media?.album || "").trim();
  const queries = [];
  const add = (queryArtist, queryTitle) => {
    const query = { artist: cleanArtist(queryArtist), title: cleanTitle(queryTitle), album };
    if (!query.artist || !query.title) return;
    if (queries.some((item) => item.artist === query.artist && item.title === query.title)) return;
    queries.push(query);
  };

  const split = splitTitle(title);
  const splittable = split && split.left && split.right && !VERSION_PATTERN.test(fold(split.right));
  if (splittable && (!artist || artistsOverlap(split.left, artist))) {
    add(artist || split.left, split.right);
  } else {
    add(artist, title);
    if (splittable) add(split.left, split.right);
  }
  return queries;
}

function validImageUrl(url) {
  return url.startsWith("https://") && url.length <= MAX_IMAGE_URL_LENGTH;
}

function scoreCandidate(query, candidate) {
  if (!artistsOverlap(query.artist, candidate.artist)) return -1;
  if (titleKey(candidate.title) !== titleKey(query.title)) return -1;
  let score = 0;
  if (fold(cleanTitle(candidate.title)) === fold(query.title)) score += 1;
  if (!candidate.compilation) score += 2;
  if (query.album && fold(cleanAlbum(candidate.album)) === fold(cleanAlbum(query.album))) score += 4;
  return score;
}

function pickBest(items, query, readCandidate) {
  let best;
  let bestScore = -1;
  for (const item of items) {
    const candidate = readCandidate(item);
    if (!candidate || !validImageUrl(candidate.artUrl)) continue;
    const score = scoreCandidate(query, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best ? { artUrl: best.artUrl, album: cleanAlbum(best.album) } : undefined;
}

function pickItunesMatch(results, query) {
  return pickBest(results, query, (song) => ({
    artist: song?.artistName,
    title: song?.trackName,
    album: song?.collectionName,
    compilation: Boolean(song?.collectionArtistName) && !artistsOverlap(song.collectionArtistName, song.artistName),
    artUrl: String(song?.artworkUrl100 || "").replace("100x100bb", "512x512bb")
  }));
}

function pickDeezerMatch(results, query) {
  return pickBest(results, query, (song) => {
    if (!song?.album?.md5_image) return undefined;
    return {
      artist: song.artist?.name,
      title: song.title,
      album: song.album.title,
      artUrl: String(song.album.cover_xl || song.album.cover_big || "")
    };
  });
}

async function getJson(fetch, url, signal) {
  const response = await fetch(url, {
    signal,
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function searchItunes(query, { fetch, country, signal }) {
  const term = encodeURIComponent(`${query.artist} ${query.title}`);
  const url = `${ITUNES_SEARCH_URL}?term=${term}&media=music&entity=song&limit=${SEARCH_LIMIT}&country=${country}`;
  const data = await getJson(fetch, url, signal);
  return pickItunesMatch(Array.isArray(data?.results) ? data.results : [], query);
}

async function searchDeezer(query, { fetch, signal }) {
  const term = encodeURIComponent(`${query.artist} ${query.title}`);
  const data = await getJson(fetch, `${DEEZER_SEARCH_URL}?q=${term}&limit=${SEARCH_LIMIT}`, signal);
  if (data?.error) throw new Error(String(data.error.message || "Deezer"));
  return pickDeezerMatch(Array.isArray(data?.data) ? data.data : [], query);
}

const PROVIDERS = [searchItunes, searchDeezer];

async function fetchTrackInfo(media, options = {}) {
  const { fetch, timeoutMs = LOOKUP_TIMEOUT_MS } = options;
  const country = /^[a-z]{2}$/i.test(String(options.country || "")) ? options.country.toUpperCase() : "US";
  const queries = trackQueries(media);
  if (!queries.length) return { ...EMPTY_TRACK_INFO, failed: false };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let failed = false;

  try {
    for (const query of queries) {
      for (const search of PROVIDERS) {
        if (controller.signal.aborted) return { ...EMPTY_TRACK_INFO, failed: true };
        try {
          const match = await search(query, { fetch, country, signal: controller.signal });
          if (match) return { ...match, failed: false };
        } catch {
          failed = true;
        }
      }
    }
    return { ...EMPTY_TRACK_INFO, failed };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  EMPTY_TRACK_INFO,
  artistsOverlap,
  cleanAlbum,
  cleanArtist,
  cleanTitle,
  fetchTrackInfo,
  pickDeezerMatch,
  pickItunesMatch,
  trackQueries
};
