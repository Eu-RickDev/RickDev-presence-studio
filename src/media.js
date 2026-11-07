const { spawn } = require("child_process");

const PAUSE_GRACE_MS = 30 * 1000;
const SEEK_TOLERANCE_MS = 5000;
const RESTART_DELAY_MS = 3000;
const FAST_FAILURE_WINDOW_MS = 15 * 1000;
const MAX_FAST_FAILURES = 3;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_UNIX_TIMESTAMP_MS = 2147483647000;
const NON_BREAKING_SPACE = String.fromCharCode(160);

// Windows exposes whatever is playing (Spotify, browsers, media players) through
// the Global System Media Transport Controls API. WinRT is not reachable from
// Node directly, so a persistent PowerShell child polls it and streams JSON lines.
const WATCHER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]",
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  "$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]",
  "function Await($winRtTask, $resultType) {",
  "  $asTask = $asTaskGeneric.MakeGenericMethod($resultType)",
  "  $netTask = $asTask.Invoke($null, @($winRtTask))",
  "  $null = $netTask.Wait(-1)",
  "  $netTask.Result",
  "}",
  "$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])",
  "$parentPid = 0",
  "if (-not [int]::TryParse([string]$env:RICKDEV_PARENT_PID, [ref]$parentPid)) { $parentPid = 0 }",
  "function Read-MediaSession($session) {",
  "  $media = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])",
  "  $playback = $session.GetPlaybackInfo()",
  "  $timeline = $session.GetTimelineProperties()",
  "  @{",
  "    title = [string]$media.Title",
  "    artist = [string]$media.Artist",
  "    album = [string]$media.AlbumTitle",
  "    app = [string]$session.SourceAppUserModelId",
  "    status = [string]$playback.PlaybackStatus",
  "    positionMs = [long]($timeline.Position.TotalMilliseconds - $timeline.StartTime.TotalMilliseconds)",
  "    durationMs = [long]($timeline.EndTime.TotalMilliseconds - $timeline.StartTime.TotalMilliseconds)",
  "    updatedAtMs = [long]$timeline.LastUpdatedTime.ToUnixTimeMilliseconds()",
  "  }",
  "}",
  "while ($true) {",
  "  if ($parentPid -gt 0) {",
  "    try { $null = Get-Process -Id $parentPid -ErrorAction Stop } catch { exit 0 }",
  "  }",
  "  try {",
  "    $current = $manager.GetCurrentSession()",
  "    $currentApp = if ($null -ne $current) { [string]$current.SourceAppUserModelId } else { '' }",
  "    $sessions = @()",
  "    foreach ($session in $manager.GetSessions()) {",
  "      try { $sessions += ,(Read-MediaSession $session) } catch { }",
  "    }",
  "    Write-Output (ConvertTo-Json -InputObject @{ currentApp = $currentApp; sessions = $sessions } -Compress -Depth 4)",
  "  } catch {",
  "    Write-Output '{\"currentApp\":\"\",\"sessions\":[]}'",
  "  }",
  "  Start-Sleep -Milliseconds 1500",
  "}"
].join("\n");

function parseMediaLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("{")) return undefined;

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function normalizeMediaState(payload, nowMs = Date.now()) {
  if (!payload || payload.active !== true) return { active: false };

  const title = String(payload.title || "").trim();
  if (!title) return { active: false };

  const playing = payload.status === "Playing";

  // Garbage timelines happen (livestreams, buggy players); treat implausible
  // durations as unknown so no out-of-range timestamp ever reaches Discord.
  let durationMs = Math.floor(Number(payload.durationMs) || 0);
  if (durationMs < 0 || durationMs > MAX_DURATION_MS) durationMs = 0;
  let positionMs = Math.max(0, Math.floor(Number(payload.positionMs) || 0));
  const updatedAtMs = Math.floor(Number(payload.updatedAtMs) || 0);
  const hasTimeline = durationMs > 0 || updatedAtMs > 0;

  // Players only refresh the timeline sporadically; project the position
  // forward while playing so progress stays accurate between refreshes.
  if (playing && updatedAtMs > 0) {
    const drift = nowMs - updatedAtMs;
    if (drift > 0 && drift < 6 * 60 * 60 * 1000) positionMs += drift;
  }
  if (durationMs > 0) positionMs = Math.min(positionMs, durationMs);

  return {
    active: true,
    playing,
    hasTimeline,
    title,
    artist: String(payload.artist || "").trim(),
    album: String(payload.album || "").trim(),
    app: String(payload.app || "").trim(),
    positionMs,
    durationMs
  };
}

function normalizeMediaPayload(payload, nowMs = Date.now()) {
  const raw = payload?.sessions;
  // PowerShell 5.1 may serialize a single-element array as a bare object.
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return {
    currentApp: String(payload?.currentApp || ""),
    sessions: list
      .map((session) => normalizeMediaState({ active: true, ...session }, nowMs))
      .filter((session) => session.active)
  };
}

// Choose which media session drives the presence: skip sources the user
// blocked, then prefer whatever is playing, then the system's current one.
function selectMediaSession(payload, ignoredApps = []) {
  const ignored = new Set(
    ignoredApps.map((app) => String(app).trim().toLowerCase()).filter(Boolean)
  );
  const candidates = (payload?.sessions || [])
    .filter((session) => session.active && !ignored.has(session.app.toLowerCase()));
  if (!candidates.length) return { active: false };

  const score = (session) =>
    (session.playing ? 2 : 0) + (session.app && session.app === payload.currentApp ? 1 : 0);
  return candidates.reduce((best, session) => (score(session) > score(best) ? session : best));
}

// Music keeps showing through short pauses (track gaps, quick interruptions);
// only a long pause hands the presence back to the configured profile.
function derivePresentation(media, lastPlayingAt, nowMs = Date.now(), graceMs = PAUSE_GRACE_MS) {
  if (media?.active && media.title) {
    if (media.playing) return { mode: "music", paused: false };
    if (lastPlayingAt && nowMs - lastPlayingAt <= graceMs) return { mode: "music", paused: true };
  }
  return { mode: "fallback", paused: false };
}

function mediaSignature(presentation, media) {
  if (presentation?.mode !== "music" || !media?.active) return "fallback";
  return ["music", media.title, media.artist, media.album, presentation.paused ? "paused" : "playing"].join("|");
}

function hasSeeked(previous, media, nowMs = Date.now(), toleranceMs = SEEK_TOLERANCE_MS) {
  // Players without a usable timeline report a frozen position; comparing it
  // against projected time would flag a bogus seek on every tick.
  if (!previous?.playing || !media?.active || !media.playing || !media.hasTimeline) return false;
  const expected = previous.positionMs + (nowMs - previous.atMs);
  return Math.abs(media.positionMs - expected) > toleranceMs;
}

function presenceText(value) {
  const text = String(value || "").trim().slice(0, 128);
  if (!text) return "";
  // Discord rejects one-character texts; a non-breaking space survives trimming.
  return text.length < 2 ? text + NON_BREAKING_SPACE : text;
}

// Raw SET_ACTIVITY payload (snake_case) so the activity can carry type 2
// ("Listening to...") and external image URLs, which discord-rpc does not map.
function buildMusicActivity(config, media, options = {}) {
  const {
    paused = false,
    artUrl = "",
    buttons = [],
    includeType = true,
    now = Date.now(),
    fallbackStart = now
  } = options;

  const activity = { instance: false };
  if (includeType) activity.type = 2;

  const details = presenceText(media.title);
  if (details) activity.details = details;

  const stateText = paused
    ? (media.artist ? `Em pausa - ${media.artist}` : "Em pausa")
    : media.artist;
  const state = presenceText(stateText);
  if (state) activity.state = state;

  const assets = {};
  const largeImage = String(artUrl || "").slice(0, 256) || String(config.largeImageKey || "").trim();
  if (largeImage) assets.large_image = largeImage;
  const largeText = presenceText(media.album) || presenceText(config.largeImageText);
  if (largeText) assets.large_text = largeText;
  const smallImage = String(config.smallImageKey || "").trim();
  if (smallImage) {
    assets.small_image = smallImage;
    const smallText = presenceText(config.smallImageText);
    if (smallText) assets.small_text = smallText;
  }
  if (Object.keys(assets).length) activity.assets = assets;

  if (!paused && media.playing) {
    if (media.durationMs > 0) {
      const start = now - Math.min(media.positionMs, media.durationMs);
      if (start + media.durationMs <= MAX_UNIX_TIMESTAMP_MS) {
        activity.timestamps = { start, end: start + media.durationMs };
      }
    } else if (config.showTimer) {
      // Without a timeline the position is frozen; keep the track's original
      // start so forced reapplies never reset the visible elapsed timer.
      activity.timestamps = {
        start: media.positionMs > 0 ? now - media.positionMs : fallbackStart
      };
    }
  }

  if (buttons.length) activity.buttons = buttons;
  return activity;
}

function createMediaWatcher(options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const platform = options.platform || process.platform;
  const onState = options.onState || (() => {});
  const onError = options.onError || (() => {});
  let child;
  let stopped = false;
  let restartTimer;
  let fastFailures = 0;
  let launchedAt = 0;
  let stdoutBuffer = "";

  function handleChunk(chunk) {
    stdoutBuffer += chunk;
    let newlineIndex;
    while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      const payload = parseMediaLine(line);
      if (payload) onState(normalizeMediaPayload(payload));
    }
  }

  function scheduleRestart() {
    if (stopped) return;
    fastFailures = Date.now() - launchedAt < FAST_FAILURE_WINDOW_MS ? fastFailures + 1 : 1;

    if (fastFailures >= MAX_FAST_FAILURES) {
      onError("Não foi possível iniciar a detecção de mídia neste sistema.");
      return;
    }

    restartTimer = setTimeout(launch, RESTART_DELAY_MS);
    if (restartTimer.unref) restartTimer.unref();
  }

  function launch() {
    if (stopped || child) return;

    if (platform !== "win32") {
      onError("A detecção de mídia está disponível apenas no Windows.");
      return;
    }

    launchedAt = Date.now();
    stdoutBuffer = "";
    child = spawnProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(WATCHER_SCRIPT, "utf16le").toString("base64")
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      // The script exits by itself when this PID dies, so an abnormal app
      // termination never leaves an orphaned powershell.exe polling forever.
      env: { ...process.env, RICKDEV_PARENT_PID: String(process.pid) }
    });

    let finished = false;
    const handleEnd = () => {
      if (finished) return;
      finished = true;
      child = undefined;
      if (stopped) return;
      onState({ currentApp: "", sessions: [] });
      scheduleRestart();
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", () => {});
    child.on("error", handleEnd);
    child.on("exit", handleEnd);
  }

  function stop() {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = undefined;

    if (child) {
      const current = child;
      child = undefined;
      try {
        current.kill();
      } catch {
        // The process may already be gone.
      }
    }
  }

  return {
    start: launch,
    stop,
    isRunning: () => Boolean(child)
  };
}

module.exports = {
  PAUSE_GRACE_MS,
  buildMusicActivity,
  createMediaWatcher,
  derivePresentation,
  hasSeeked,
  mediaSignature,
  normalizeMediaPayload,
  normalizeMediaState,
  parseMediaLine,
  presenceText,
  selectMediaSession
};
