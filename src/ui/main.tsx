import { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useApp,
  type App,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps/react";
import { parseBubble, type BubbleResult } from "../shared/types.js";
import "./style.css";

type Loaded = NonNullable<ReturnType<typeof parseBubble>>;
function formatTime(seconds: number) {
  const t = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}
function VoiceBubble() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [context, setContext] = useState<McpUiHostContext>();
  const [problem, setProblem] = useState("");
  const bridgeRef = useRef<App | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const recoveryAttempted = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState(1);
  const clipId = useId().replace(/:/g, "");
  function accept(result: BubbleResult) {
    const parsed = parseBubble(result);
    if (!parsed) {
      setProblem("音频不可用");
      return;
    }
    const changed = loadedRef.current?.data.audioId !== parsed.data.audioId;
    loadedRef.current = parsed;
    setLoaded(parsed);
    setProblem("");
    if (changed) {
      audioRef.current?.pause();
      setPosition(0);
      recoveryAttempted.current = false;
    }
  }
  const { app, error, isConnected } = useApp({
    appInfo: { name: "Voice Bubble", version: "0.1.0" },
    capabilities: {},
    onAppCreated(bridge) {
      bridgeRef.current = bridge;
      bridge.ontoolresult = (result) => accept(result);
      bridge.onhostcontextchanged = (patch) =>
        setContext((old) => ({ ...old, ...patch }));
      bridge.onteardown = async () => {
        audioRef.current?.pause();
        return {};
      };
    },
  });
  useEffect(() => {
    if (app) setContext(app.getHostContext());
  }, [app, isConnected]);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        context?.theme ?? (mq.matches ? "dark" : "light");
    };
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [context?.theme]);

  async function refresh() {
    if (refreshPromise.current) return refreshPromise.current;
    const active = loadedRef.current,
      bridge = bridgeRef.current;
    if (!active || !bridge) throw new Error("No bridge");
    const run = (async () => {
      const result = await bridge.callServerTool({
        name: "get_voice_bubble",
        arguments: { audio_id: active.data.audioId },
      });
      const next = parseBubble(result);
      if (!next || next.data.audioId !== active.data.audioId)
        throw new Error("Audio unavailable");
      if (loadedRef.current?.data.audioId !== active.data.audioId) return;
      accept(result);
      // Update synchronously so a user-initiated play can wait for this exact source.
      const audio = audioRef.current;
      if (audio && (audio.src !== next.playback.url || audio.error)) {
        const saved = audio.currentTime || position;
        audio.src = next.playback.url;
        const ready = new Promise<void>((resolve, reject) => {
          const done = () => {
            cleanup();
            audio.currentTime = Math.min(saved, next.data.durationSeconds);
            audio.playbackRate = rate;
            resolve();
          };
          const fail = () => {
            cleanup();
            reject(new Error("Audio loading failed"));
          };
          const timer = setTimeout(fail, 15_000);
          const cleanup = () => {
            clearTimeout(timer);
            audio.removeEventListener("loadedmetadata", done);
            audio.removeEventListener("error", fail);
          };
          audio.addEventListener("loadedmetadata", done, { once: true });
          audio.addEventListener("error", fail, { once: true });
        });
        audio.load();
        await ready;
      }
    })();
    refreshPromise.current = run;
    try {
      await run;
    } finally {
      refreshPromise.current = null;
    }
  }
  useEffect(() => {
    if (
      loaded &&
      Date.parse(loaded.playback.expiresAt) <= Date.now() + 5000 &&
      isConnected
    ) {
      setBusy(true);
      void refresh()
        .catch(() => setProblem("点击重试"))
        .finally(() => setBusy(false));
    }
  }, [loaded?.data.audioId, isConnected]);
  async function toggle() {
    const audio = audioRef.current,
      active = loadedRef.current;
    if (!audio || !active || busy) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    setBusy(true);
    setProblem("");
    recoveryAttempted.current = false;
    try {
      if (
        Date.parse(active.playback.expiresAt) <= Date.now() + 5000 ||
        audio.error
      )
        await refresh();
      if (audio.ended || audio.currentTime >= active.data.durationSeconds)
        audio.currentTime = 0;
      audio.playbackRate = rate;
      await audio.play(); // Only reached from an explicit user click. Never from a timer or host event.
    } catch {
      setProblem("点击重试");
    } finally {
      setBusy(false);
    }
  }
  async function mediaError() {
    const active = loadedRef.current;
    if (!active || refreshPromise.current) return;
    setPlaying(false);
    if (recoveryAttempted.current) {
      setProblem("点击重试");
      return;
    }
    recoveryAttempted.current = true;
    setBusy(true);
    try {
      await refresh();
      setProblem("");
    } catch {
      setProblem("点击重试");
    } finally {
      setBusy(false);
    }
  }
  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio || !loaded || audio.readyState < 1) return;
    const time = Math.max(0, Math.min(value, loaded.data.durationSeconds));
    audio.currentTime = time;
    setPosition(time);
  }
  function changeRate() {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
    setRate(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }
  const duration = loaded?.data.durationSeconds ?? 0;
  const progress = duration ? Math.min(1, position / duration) : 0;
  const status =
    problem ||
    (error ? "连接失败" : !loaded ? "等待音频" : busy ? "加载中" : "");
  return (
    <div
      className="bubble"
      data-palette={loaded?.data.palette ?? "lavender"}
      aria-label={
        loaded?.data.source === "test" ? "测试音频语音气泡" : "语音气泡"
      }
    >
      <button
        className="play"
        type="button"
        onClick={() => void toggle()}
        disabled={!loaded || busy}
        aria-label={problem ? "重试播放" : playing ? "暂停" : "播放"}
        title={problem || (playing ? "暂停" : "播放")}
        aria-busy={busy}
      >
        {busy ? (
          <span className="spinner" />
        ) : playing ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1.4" />
            <rect x="14" y="5" width="4" height="14" rx="1.4" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 4.7c-.7-.4-1.5.1-1.5.9v12.8c0 .8.8 1.3 1.5.9l11-6.4a1 1 0 0 0 0-1.8z" />
          </svg>
        )}
      </button>
      <div className="wave">
        <svg viewBox="0 0 256 36" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <clipPath id={clipId}>
              <rect x="0" y="0" width={256 * progress} height="36" />
            </clipPath>
          </defs>
          <g className="wave-base">
            {loaded?.data.waveform.map((v, i) => (
              <rect
                key={i}
                x={i * 4}
                y={(36 - Math.max(2, v * 32)) / 2}
                width="2.4"
                height={Math.max(2, v * 32)}
                rx="1.2"
              />
            ))}
          </g>
          <g className="wave-played" clipPath={`url(#${clipId})`}>
            {loaded?.data.waveform.map((v, i) => (
              <rect
                key={i}
                x={i * 4}
                y={(36 - Math.max(2, v * 32)) / 2}
                width="2.4"
                height={Math.max(2, v * 32)}
                rx="1.2"
              />
            ))}
          </g>
        </svg>
        <input
          type="range"
          min="0"
          max={duration || 1}
          step="0.01"
          value={Math.min(position, duration)}
          disabled={!loaded}
          aria-label="播放进度"
          aria-valuetext={`${formatTime(position)} / ${formatTime(duration)}`}
          onChange={(event) => seek(Number(event.currentTarget.value))}
        />
      </div>
      <span
        className="time"
        aria-live={status ? "polite" : "off"}
        title={status || `总时长 ${formatTime(duration)}`}
      >
        {status ? (
          <span className="status">{status}</span>
        ) : (
          <span>−{formatTime(duration - position)}</span>
        )}
        {loaded?.data.source === "test" && <small>测试音频</small>}
      </span>
      <button
        className="speed"
        type="button"
        onClick={changeRate}
        aria-label={`播放速度 ${rate} 倍`}
        title="切换播放速度"
      >
        {rate}×
      </button>
      <audio
        ref={audioRef}
        src={loaded?.playback.url}
        crossOrigin="anonymous"
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onEnded={() => {
          setPlaying(false);
          setPosition(duration);
        }}
        onError={() => void mediaError()}
        onLoadedMetadata={(event) => {
          event.currentTarget.playbackRate = rate;
        }}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<VoiceBubble />);
