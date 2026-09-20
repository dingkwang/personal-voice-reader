import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { DocumentSummary, JobStatus, PublicDocument, Segment, Voice } from "@/lib/types";
import { encodePcmWav } from "@/lib/wav";
import type { RegenerateInput } from "@/lib/jobs";
import { generationDisabledReason } from "./regeneration-reason";

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error || "请求失败，请稍后重试", response.status);
  return data;
}

type Draft = { text: string; title: string };
const emptyDraft: Draft = { text: "", title: "" };
const regenerationStorageKey = (scope: string, id: string) => `voice-note:regeneration:v2:${scope}:${id}`;
const legacyRegenerationStorageKey = (id: string) => `voice-note:regeneration:v1:${id}`;
function storedRegeneration(scope: string, id: string, allowLegacy: boolean): RegenerateInput | null {
  const current = localStorage.getItem(regenerationStorageKey(scope, id));
  // The server enables this only for the original subject. Call only after the
  // document GET has verified ownership. Existing v2, even malformed, wins.
  const raw = current ?? (allowLegacy ? localStorage.getItem(legacyRegenerationStorageKey(id)) : null);
  if (raw === null) return null;
  const value = JSON.parse(raw) as RegenerateInput;
  const bounded = (input: unknown, min: number, max: number) => typeof input === "string" && input.length >= min && input.length <= max;
  if (!value || !["segment", "all"].includes(value.scope) || !bounded(value.idempotencyKey, 8, 160) ||
    !bounded(value.voiceId, 5, 120) || !Number.isFinite(value.speed) || value.speed < 0.5 || value.speed > 2 ||
    value.acknowledgeBilling !== true || !(value.sourceJobId === null || bounded(value.sourceJobId, 5, 100)) ||
    (value.scope === "segment" ? !bounded(value.segmentId, 5, 100) : value.segmentId !== undefined)) throw new Error("Invalid regeneration request");
  // Keep the legacy copy until a definite result. Failed reads/writes propagate
  // to the conservative uncertainty guard, never a fresh paid request.
  if (current === null) localStorage.setItem(regenerationStorageKey(scope, id), raw);
  return value;
}

export function useReader(storageScope: string, initialSessionId?: string) {
  const [draft, setDraft] = useState(emptyDraft);
  const [source, setSource] = useState(emptyDraft);
  const [document, setDocument] = useState<PublicDocument | null>(null);
  const [history, setHistory] = useState<DocumentSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [canLinkFishVoice, setCanLinkFishVoice] = useState(false);
  const [voiceId, setVoiceId] = useState("");
  const defaultVoiceRef = useRef("");
  const [speed, setSpeed] = useState(1);
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [totalDuration, setTotalDuration] = useState(0);
  const [loopAll, setLoopAll] = useState(false);
  const [message, setMessage] = useState("");
  const [voiceError, setVoiceError] = useState("");
  const [job, setJob] = useState<JobStatus | null>(null);
  const [savedJob, setSavedJob] = useState<JobStatus | null>(null);
  const [savedSettings, setSavedSettings] = useState<{ voiceId: string; speed: number } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [pendingRegeneration, setPendingRegeneration] = useState<RegenerateInput | null>(null);
  const [unfinishedRequest, setUnfinishedRequest] = useState(false);
  const regenerateRef = useRef(false);
  const savedJobRef = useRef<JobStatus | null>(null);
  const savedSettingsRef = useRef<{ voiceId: string; speed: number } | null>(null);
  const pendingRegenerationRef = useRef<RegenerateInput | null>(null);
  const legacyRecoveryDocumentRef = useRef<string | null>(null);

  // Refs change in event handlers, not effects: even same-tick actions see
  // the new session/settings and cannot adopt an older async completion.
  const draftRef = useRef(draft);
  const sourceRef = useRef(emptyDraft);
  const documentRef = useRef<PublicDocument | null>(null);
  const settingsRef = useRef({ voiceId: "", speed: 1 });
  const sessionRef = useRef(0);
  const generationRef = useRef(0);
  const playRef = useRef(0);
  const listRef = useRef(0);
  const importRef = useRef(0);
  const loadingRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const preparingRef = useRef(false);
  const indexRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const inFlightRef = useRef(new Map<string, Promise<JobStatus>>());
  const requestKeysRef = useRef(new Map<string, string>());
  const jobRef = useRef<JobStatus | null>(null);
  const eventsRef = useRef<EventSource | null>(null);
  const prefetchRef = useRef<HTMLAudioElement[]>([]);
  const durationRef = useRef(new Map<string, number>());
  const loopRef = useRef(false);
  const endedRef = useRef(false);

  const detachAudio = useCallback(() => {
    for (const item of prefetchRef.current) { item.removeAttribute("src"); item.load(); }
    prefetchRef.current = [];
    const audio = audioRef.current;
    audioRef.current = null;
    if (!audio) return;
    audio.onplay = audio.onpause = audio.onended = audio.ontimeupdate = audio.onloadedmetadata = audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const stopPlayback = useCallback(() => {
    eventsRef.current?.close();
    eventsRef.current = null;
    jobRef.current = null;
    setJob(null);
    generationRef.current++;
    playRef.current++;
    preparingRef.current = false;
    detachAudio();
    setIsPlaying(false);
    setIsPreparing(false);
    setTime({ current: 0, duration: 0 });
    durationRef.current.clear();
    setTotalDuration(0);
    endedRef.current = false;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    }
  }, [detachAudio]);

  const loadHistory = useCallback(async () => {
    const request = ++listRef.current;
    try {
      const { documents } = await api<{ documents: DocumentSummary[] }>("/api/documents");
      if (request === listRef.current) setHistory(documents);
    } catch {
      if (request === listRef.current) setHistoryError("会话列表加载失败，请重试。");
    } finally {
      if (request === listRef.current) setHistoryLoading(false);
    }
  }, []);

  function refreshHistory() {
    setHistoryLoading(true);
    setHistoryError("");
    return loadHistory();
  }

  const invalidateOnUnmount = useCallback(() => {
    sessionRef.current++;
    generationRef.current++;
    playRef.current++;
    listRef.current++;
    importRef.current++;
    eventsRef.current?.close();
    detachAudio();
  }, [detachAudio]);

  const adoptJob = useCallback((next: JobStatus, generation: number) => {
    const current = documentRef.current;
    if (generation !== generationRef.current || current?.id !== next.document_id ||
      settingsRef.current.voiceId !== next.voice_id || settingsRef.current.speed !== next.speed) return;
    jobRef.current = next;
    setJob(next);
    savedJobRef.current = next;
    setSavedJob(next);
    savedSettingsRef.current = { voiceId: next.voice_id, speed: next.speed };
    setSavedSettings(savedSettingsRef.current);
    const items = new Map(next.items.map((item) => [item.segment_id, item]));
    const updated = { ...current, segments: current.segments.map((segment) => {
      const item = items.get(segment.id);
      // Progress is not playback state. Keep the selected version until its replacement is ready.
      if (item?.status !== "ready" && segment.status === "ready" && segment.audioUrl &&
        segment.voiceId === next.voice_id && segment.speed === next.speed) return segment;
      if (item?.audioUrl !== segment.audioUrl && segment.audioUrl) durationRef.current.delete(segment.audioUrl);
      return item ? { ...segment, status: item.status, audioUrl: item.audioUrl,
        voiceId: next.voice_id, speed: next.speed } : segment;
    }) };
    // Replacing attached audio cancels playback, not a Start waiting for this job.
    if (audioRef.current && current.segments[indexRef.current]?.audioUrl &&
      current.segments[indexRef.current]?.audioUrl !== updated.segments[indexRef.current]?.audioUrl) {
      playRef.current++;
      detachAudio();
      preparingRef.current = false;
      setIsPreparing(false);
      setIsPlaying(false);
      setTime({ current: 0, duration: 0 });
      endedRef.current = false;
    }
    setTotalDuration([...durationRef.current.values()].reduce((sum, duration) => sum + duration, 0));
    documentRef.current = updated;
    setDocument(updated);
  }, [detachAudio]);

  const watchJob = useCallback((next: JobStatus, generation: number) => {
    if (generation !== generationRef.current || documentRef.current?.id !== next.document_id ||
      settingsRef.current.voiceId !== next.voice_id || settingsRef.current.speed !== next.speed) return;
    eventsRef.current?.close();
    eventsRef.current = null;
    adoptJob(next, generation);
    if (["completed", "attention"].includes(next.status)) return;
    const events = new EventSource(`/api/jobs/${next.id}/events`);
    eventsRef.current = events;
    events.addEventListener("progress", (event) => {
      if (eventsRef.current !== events) return;
      const snapshot = JSON.parse((event as MessageEvent).data) as JobStatus;
      if (snapshot.id !== next.id) return;
      adoptJob(snapshot, generation);
      if (["completed", "attention"].includes(snapshot.status)) {
        events.close();
        eventsRef.current = null;
      }
    });
  }, [adoptJob]);

  const openInitial = useEffectEvent(() => {
    if (initialSessionId) void selectSession(initialSessionId);
  });

  useEffect(() => {
    let cancelled = false;
    void loadHistory();
    openInitial();
    api<{ voices: Voice[]; defaultVoiceId?: string; canLinkFishVoice?: boolean }>("/api/voices")
      .then(({ voices: items, defaultVoiceId, canLinkFishVoice }) => {
        if (cancelled) return;
        setVoices(items);
        setCanLinkFishVoice(canLinkFishVoice === true);
        defaultVoiceRef.current = items.find((voice) => voice.id === defaultVoiceId)?.id || items[0]?.id || "";
        if (!settingsRef.current.voiceId) {
          const id = items.find((voice) => voice.id === defaultVoiceId)?.id || items[0]?.id || "";
          settingsRef.current.voiceId = id;
          setVoiceId(id);
        }
      })
      .catch(() => {
        if (!cancelled) setVoiceError("声音列表加载失败，请刷新页面重试。");
      });
    return () => {
      cancelled = true;
      invalidateOnUnmount();
    };
  }, [invalidateOnUnmount, loadHistory]);

  useEffect(() => {
    const hide = () => { detachAudio(); eventsRef.current?.close(); };
    const show = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => { window.removeEventListener("pagehide", hide); window.removeEventListener("pageshow", show); };
  }, [detachAudio]);

  const isDirty = draft.text !== source.text || draft.title !== source.title;
  const upcomingUrls = (document?.segments || []).slice(activeIndex + 1, activeIndex + 3)
    .filter((item) => item.status === "ready" && item.audioUrl && item.voiceId === voiceId && item.speed === speed)
    .map((item) => item.audioUrl).join("\n");
  useEffect(() => {
    const elements = upcomingUrls ? upcomingUrls.split("\n").map((url) => {
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      audio.load();
      return audio;
    }) : [];
    prefetchRef.current = elements;
    return () => {
      for (const audio of elements) { audio.removeAttribute("src"); audio.load(); }
      prefetchRef.current = [];
    };
  }, [upcomingUrls]);

  useEffect(() => {
    if (!isDirty && !isSaving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty, isSaving]);

  function mayLeave() {
    if (savingRef.current) return false;
    const current = draftRef.current;
    const source = sourceRef.current;
    return (current.text === source.text && current.title === source.title) ||
      window.confirm("有未保存的文字或标题。离开会丢弃这些修改；要保留，请取消并点击「保存会话」。");
  }

  function changeDraft(next: Draft) {
    if (savingRef.current || loadingRef.current) return;
    importRef.current++;
    stopPlayback();
    draftRef.current = next;
    setDraft(next);
    setMessage("");
    if (next.text === sourceRef.current.text && next.title === sourceRef.current.title && savedJobRef.current) {
      watchJob(savedJobRef.current, generationRef.current);
    }
  }

  function changeSettings(next: { voiceId: string; speed: number }) {
    stopPlayback();
    settingsRef.current = next;
    setVoiceId(next.voiceId);
    setSpeed(next.speed);
    setMessage("");
    if (!savingRef.current && draftRef.current.text === sourceRef.current.text &&
      draftRef.current.title === sourceRef.current.title &&
      savedJobRef.current?.voice_id === next.voiceId && savedJobRef.current.speed === next.speed) {
      watchJob(savedJobRef.current, generationRef.current);
    }
  }

  async function selectSession(id: string) {
    if (id === loadingRef.current || !mayLeave()) return;
    const session = ++sessionRef.current;
    importRef.current++;
    stopPlayback();
    loadingRef.current = id;
    setLoadingId(id);
    setDetailError(null);
    setMessage("");
    try {
      const { document: loaded, job: savedJob, allowLegacyRecovery } = await api<{
        document: PublicDocument & { originalText: string }; job: JobStatus | null; allowLegacyRecovery?: boolean;
      }>(
        `/api/documents/${encodeURIComponent(id)}`,
      );
      if (session !== sessionRef.current) return;
      const nextDraft = { text: loaded.originalText, title: loaded.title };
      draftRef.current = sourceRef.current = nextDraft;
      documentRef.current = loaded;
      setDraft(nextDraft);
      setSource(nextDraft);
      setDocument(loaded);
      indexRef.current = 0;
      setActiveIndex(0);
      const ready = loaded.segments.find((segment) =>
        segment.status === "ready" && segment.audioUrl && segment.voiceId && segment.speed !== null,
      );
      savedJobRef.current = savedJob;
      setSavedJob(savedJob);
      savedSettingsRef.current = savedJob ? { voiceId: savedJob.voice_id, speed: savedJob.speed } :
        ready ? { voiceId: ready.voiceId!, speed: ready.speed! } : null;
      setSavedSettings(savedSettingsRef.current);
      if (ready) changeSettings({ voiceId: ready.voiceId!, speed: ready.speed! });
      if (savedJob) {
        changeSettings({ voiceId: savedJob.voice_id, speed: savedJob.speed });
        watchJob(savedJob, generationRef.current);
      }
      if (!inFlightRef.current.size) setUnfinishedRequest(false);
      pendingRegenerationRef.current = null;
      setPendingRegeneration(null);
      legacyRecoveryDocumentRef.current = allowLegacyRecovery === true ? loaded.id : null;
      try {
        pendingRegenerationRef.current = storedRegeneration(storageScope, loaded.id, allowLegacyRecovery === true);
        setPendingRegeneration(pendingRegenerationRef.current);
      } catch {
        setMessage("无法读取重新生成请求记录。请恢复浏览器存储后重新打开会话，避免重复计费。");
        setUnfinishedRequest(true);
      }
      window.history.replaceState(null, "", `/sessions/${loaded.id}`);
    } catch {
      if (session === sessionRef.current) {
        setDetailError({ id, message: "这条会话加载失败，原来的文字仍保留。请重试或选择其他会话。" });
      }
    } finally {
      if (session === sessionRef.current) {
        loadingRef.current = null;
        setLoadingId(null);
      }
    }
  }

  function newSession() {
    if (!mayLeave()) return;
    sessionRef.current++;
    importRef.current++;
    stopPlayback();
    loadingRef.current = null;
    documentRef.current = null;
    savedJobRef.current = null;
    savedSettingsRef.current = null;
    pendingRegenerationRef.current = null;
    setSavedJob(null);
    setSavedSettings(null);
    setPendingRegeneration(null);
    draftRef.current = sourceRef.current = emptyDraft;
    indexRef.current = 0;
    setLoadingId(null);
    setDetailError(null);
    setDocument(null);
    setDraft(emptyDraft);
    setSource(emptyDraft);
    setActiveIndex(0);
    setMessage("");
    if (defaultVoiceRef.current) changeSettings({ voiceId: defaultVoiceRef.current, speed: 1 });
    window.history.replaceState(null, "", "/");
  }

  async function saveDocument(): Promise<PublicDocument | null> {
    if (savingRef.current || loadingRef.current) return null;
    const current = draftRef.current;
    if (documentRef.current && current.text === sourceRef.current.text && current.title === sourceRef.current.title) {
      return documentRef.current;
    }
    if (!current.text.trim()) {
      setMessage("先粘贴一些文字，或上传 TXT 文件");
      return null;
    }
    // A new snapshot must not inherit the old document's job or subscription.
    // Invalidate before awaiting the save so Start can own the new generation.
    stopPlayback();
    const session = sessionRef.current;
    savingRef.current = true;
    importRef.current++;
    setIsSaving(true);
    setMessage("");
    try {
      const { document: saved } = await api<{ document: PublicDocument }>("/api/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: current.text, title: current.title || undefined }),
      });
      if (session !== sessionRef.current) return null;
      const nextDraft = { text: current.text.trim(), title: saved.title };
      documentRef.current = saved;
      savedJobRef.current = null;
      savedSettingsRef.current = null;
      pendingRegenerationRef.current = null;
      setSavedJob(null);
      setSavedSettings(null);
      setPendingRegeneration(null);
      draftRef.current = sourceRef.current = nextDraft;
      setDocument(saved);
      window.history.replaceState(null, "", `/sessions/${saved.id}`);
      setDraft(nextDraft);
      setSource(nextDraft);
      indexRef.current = 0;
      setActiveIndex(0);
      // Invalidate an older list GET before adding the freshly saved snapshot.
      listRef.current++;
      setHistoryLoading(false);
      setHistory((items) => [{
        id: saved.id, title: saved.title, createdAt: saved.createdAt,
        characterCount: saved.characterCount, segmentCount: saved.segments.length,
        preview: nextDraft.text.slice(0, 100),
      }, ...items.filter((item) => item.id !== saved.id)]);
      void refreshHistory();
      return saved;
    } catch (error) {
      if (session === sessionRef.current) {
        setMessage(error instanceof Error ? error.message : "保存失败，请重试");
      }
      return null;
    } finally {
      if (session === sessionRef.current) {
        savingRef.current = false;
        setIsSaving(false);
      }
    }
  }

  const ensureAudio = useCallback(async (
    segment: Segment, generation: number, settings: { voiceId: string; speed: number },
  ): Promise<Segment> => {
    const current = documentRef.current;
    if (!current) throw new Error("会话已关闭");
    if (segment.status === "ready" && segment.audioUrl &&
      segment.voiceId === settings.voiceId && segment.speed === settings.speed) return segment;
    const signature = `${generation}:${current.id}:${settings.voiceId}:${settings.speed}`;
    const matches = (value: JobStatus | null) => value?.document_id === current.id &&
      value.voice_id === settings.voiceId && value.speed === settings.speed;
    let pending = inFlightRef.current.get(signature);
    if (!pending) {
      if (!requestKeysRef.current.has(signature)) requestKeysRef.current.set(signature, crypto.randomUUID());
      if (!matches(jobRef.current)) setUnfinishedRequest(true);
      pending = matches(jobRef.current) ? Promise.resolve(jobRef.current!) : api<{ job: JobStatus }>("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentId: current.id, ...settings, idempotencyKey: requestKeysRef.current.get(signature) }),
      }).then(({ job: next }) => { setUnfinishedRequest(false); return next; }, (error: unknown) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) setUnfinishedRequest(false);
        throw error;
      });
      inFlightRef.current.set(signature, pending);
    }
    try {
      let next = await pending;
      if (generation !== generationRef.current) throw new Error("会话已切换");
      if (jobRef.current?.id === next.id) next = jobRef.current;
      watchJob(next, generation);
      for (;;) {
        if (generation !== generationRef.current || jobRef.current?.id !== next.id) throw new Error("会话已切换");
        // An SSE update may already be newer than the initial POST snapshot.
        next = jobRef.current;
        const item = next.items.find((item) => item.segment_id === segment.id);
        if (item?.status === "ready" && item.audioUrl) return { ...segment, status: "ready", audioUrl: item.audioUrl, voiceId: settings.voiceId, speed: settings.speed };
        if (item && ["error", "uncertain"].includes(item.status)) throw new Error(item.error || "此段生成失败，请确认后重试");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (generation !== generationRef.current) throw new Error("会话已切换");
        const beforePoll = jobRef.current;
        const polled = (await api<{ job: JobStatus }>(`/api/jobs/${next.id}`)).job;
        if (jobRef.current === beforePoll && beforePoll?.id === next.id) adoptJob(polled, generation);
      }
    } finally {
      if (inFlightRef.current.get(signature) === pending) inFlightRef.current.delete(signature);
    }
  }, [adoptJob, watchJob]);

  const loadSegment = useCallback(async function playSegment(index: number): Promise<void> {
    const current = documentRef.current;
    const segment = current?.segments[index];
    if (!current || !segment || savingRef.current || loadingRef.current ||
      draftRef.current.text !== sourceRef.current.text || draftRef.current.title !== sourceRef.current.title) return;
    const generation = generationRef.current;
    const request = ++playRef.current;
    const settings = { ...settingsRef.current };
    const valid = () => generation === generationRef.current && request === playRef.current &&
      documentRef.current?.id === current.id;
    detachAudio();
    preparingRef.current = true;
    setIsPreparing(true);
    setIsPlaying(false);
    setTime({ current: 0, duration: 0 });
    endedRef.current = false;
    setMessage("");
    indexRef.current = index;
    setActiveIndex(index);
    try {
      const ready = await ensureAudio(segment, generation, settings);
      if (!valid()) return;
      if (ready.documentId !== current.id || !ready.audioUrl) throw new Error("音频尚未准备好，请重试");
      // Each load owns its audio element. Late play promises/events from a
      // detached element cannot play or pause the next session's audio.
      const audio = new Audio(ready.audioUrl);
      audioRef.current = audio;
      const syncTime = () => {
        if (!valid()) return;
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        if (duration > 0) {
          durationRef.current.set(ready.audioUrl!, duration);
          setTotalDuration([...durationRef.current.values()].reduce((sum, value) => sum + value, 0));
        }
        if (valid()) setTime({ current: audio.currentTime, duration });
      };
      audio.ontimeupdate = audio.onloadedmetadata = syncTime;
      audio.onplay = () => { if (valid()) setIsPlaying(true); };
      audio.onpause = () => { if (valid()) setIsPlaying(false); };
      audio.onerror = () => {
        if (valid()) {
          setIsPlaying(false);
          setMessage("音频无法播放，请重试。");
        }
      };
      audio.onended = () => {
        if (!valid()) return;
        setIsPlaying(false);
        if (index < current.segments.length - 1) void playSegment(index + 1);
        else if (loopRef.current) void playSegment(0);
        else endedRef.current = true;
      };
      if ("mediaSession" in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: current.title, album: `第 ${index + 1} / ${current.segments.length} 段`,
        });
      }
      await audio.play();
      if (!valid()) return;
      setIsPlaying(true);
    } catch (error) {
      if (valid()) {
        setIsPlaying(false);
        setMessage(error instanceof Error ? error.message : "无法开始朗读，请重试");
      }
    } finally {
      if (valid()) {
        preparingRef.current = false;
        setIsPreparing(false);
      }
    }
  }, [detachAudio, ensureAudio]);

  async function togglePlayback() {
    if (savingRef.current || loadingRef.current || preparingRef.current) return;
    if (!settingsRef.current.voiceId) return setMessage("请先选择一个声音");
    const audio = audioRef.current;
    if (audio && !audio.paused) {
      audio.pause();
      setIsPlaying(false);
      return;
    }
    const generation = generationRef.current;
    if (audio && !endedRef.current) {
      const request = playRef.current;
      preparingRef.current = true;
      setIsPreparing(true);
      setMessage("");
      try {
        await audio.play();
      } catch {
        if (generation === generationRef.current && request === playRef.current) setMessage("无法继续播放，请重新选择段落");
      } finally {
        if (generation === generationRef.current && request === playRef.current) {
          preparingRef.current = false;
          setIsPreparing(false);
        }
      }
      return;
    }
    const saving = saveDocument();
    // saveDocument synchronously invalidates old playback for a new snapshot.
    const startGeneration = generationRef.current;
    const request = playRef.current;
    const saved = await saving;
    if (saved && startGeneration === generationRef.current && request === playRef.current) {
      await loadSegment(endedRef.current ? 0 : indexRef.current);
    }
  }

  const goPrevious = useCallback(() => {
    void loadSegment(Math.max(0, indexRef.current - 1));
  }, [loadSegment]);
  const goNext = useCallback(() => {
    const count = documentRef.current?.segments.length || 0;
    if (count) void loadSegment(Math.min(count - 1, indexRef.current + 1));
  }, [loadSegment]);

  const mediaPlay = useEffectEvent(() => { void togglePlayback(); });
  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", mediaPlay);
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("previoustrack", goPrevious);
    navigator.mediaSession.setActionHandler("nexttrack", goNext);
    return () => {
      for (const action of ["play", "pause", "previoustrack", "nexttrack"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [goPrevious, goNext]);

  async function importFile(file: File) {
    if (savingRef.current || loadingRef.current) return;
    if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") {
      return setMessage("目前只支持 TXT 文件");
    }
    if (file.size > 2 * 1024 * 1024) return setMessage("TXT 文件请控制在 2 MB 以内");
    const request = ++importRef.current;
    try {
      const content = await file.text();
      if (request === importRef.current) {
        changeDraft({ text: content.replace(/^\uFEFF/, ""), title: file.name.replace(/\.txt$/i, "").slice(0, 100) });
      }
    } catch {
      if (request === importRef.current) setMessage("无法读取 TXT 文件，请重试");
    }
  }

  function addVoice(voice: Voice) {
    if (["indextts", "replicate"].includes(voice.provider)) defaultVoiceRef.current = voice.id;
    setVoices((items) => [...items, voice]);
    setVoiceError("");
    changeSettings({ ...settingsRef.current, voiceId: voice.id, speed: voice.provider === "replicate" ? 1 : settingsRef.current.speed });
  }

  function seek(seconds: number) {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration)) return;
    audio.currentTime = seconds;
    setTime({ current: seconds, duration: audio.duration });
  }

  function toggleLoop() {
    loopRef.current = !loopRef.current;
    setLoopAll(loopRef.current);
  }

  async function downloadDocument() {
    const current = documentRef.current;
    if (!current) return;
    if (!current.segments.every((segment) => segment.status === "ready" && segment.audioUrl)) {
      setMessage("请等待整篇音频准备完成后再下载");
      return;
    }
    try {
      const context = new AudioContext();
      const decoded: AudioBuffer[] = [];
      let frames = 0;
      for (const segment of current.segments) {
        const response = await fetch(segment.audioUrl!, { cache: "no-store" });
        if (!response.ok) throw new Error("音频下载失败");
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        decoded.push(buffer);
        frames += Math.ceil(buffer.duration * 24_000);
        if (44 + frames * 2 > 256 * 1024 * 1024) throw new Error("整篇音频超过 256 MiB，暂不支持导出");
      }
      const rendered = new OfflineAudioContext(1, frames, 24_000);
      let offset = 0;
      for (const buffer of decoded) {
        const source = rendered.createBufferSource();
        source.buffer = buffer;
        source.connect(rendered.destination);
        source.start(offset);
        offset += buffer.duration;
      }
      const output = await rendered.startRendering();
      const blob = encodePcmWav(output.getChannelData(0), 24_000);
      const url = URL.createObjectURL(blob);
      const link = globalThis.document.createElement("a");
      link.href = url;
      link.download = `${(current.title || "声笺朗读").replace(/[\\/:*?"<>|]/g, "_")}.wav`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      await context.close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "整篇音频导出失败，请重试");
    }
  }

  async function makeWebDefault() {
    const selected = settingsRef.current.voiceId;
    try {
      const result = await api<{ defaultVoiceId: string }>("/api/voices", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voiceId: selected }) });
      defaultVoiceRef.current = result.defaultVoiceId;
      setMessage("已设为网页默认声音");
    } catch (error) { setMessage(error instanceof Error ? error.message : "设置失败"); }
  }

  async function retryFailed(segmentId: string) {
    const current = jobRef.current;
    if (!current || !window.confirm("之前的请求可能已计费。确认再次生成这一段？不确定的请求需等待当前任务结束。")) return;
    const generation = generationRef.current;
    try {
      const { job: next } = await api<{ job: JobStatus }>(`/api/jobs/${current.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId, acknowledgeBilling: true }),
      });
      watchJob(next, generation);
    } catch (error) {
      if (generation === generationRef.current) setMessage(error instanceof Error ? error.message : "重试失败");
    }
  }

  const regenerationDisabledReason = isSaving || loadingId ? "请等待会话保存或加载完成" :
    isDirty ? "文字或标题有未保存的修改，请先保存或还原" :
    !savedSettings ? "请先为当前会话生成音频" :
    voiceId !== savedSettings.voiceId || speed !== savedSettings.speed ? "声音或语速与会话已保存设置不同。重新生成需先还原；使用当前设置请点击「开始朗读」。" :
    generationDisabledReason({
      regenerating, pendingRegeneration: Boolean(pendingRegeneration), unfinishedRequest, isPreparing, savedJob,
      provider: savedJob?.synthesis?.provider || voices.find((voice) => voice.id === savedJob?.voice_id)?.provider,
    });
  const recoveryDisabledReason = isSaving || loadingId ? "请等待会话保存或加载完成" :
    isDirty ? "请先还原未保存的文字或标题，再恢复原请求" :
    pendingRegeneration && (voiceId !== pendingRegeneration.voiceId || speed !== pendingRegeneration.speed)
      ? "请先还原原请求的声音和语速，再恢复原请求" : "";
  function clearResolvedRegeneration(id: string, input: RegenerateInput, allowLegacy: boolean) {
    if (allowLegacy) {
      const key = legacyRegenerationStorageKey(id);
      // Do not remove a different/malformed legacy record. Never clear either
      // copy for network/5xx failures. Delete v2 last if storage becomes unusable.
      if (localStorage.getItem(key) === JSON.stringify(input)) localStorage.removeItem(key);
    }
    localStorage.removeItem(regenerationStorageKey(storageScope, id));
  }

  async function submitRegeneration(input: RegenerateInput) {
    const current = documentRef.current;
    if (!current || regenerateRef.current) return;
    const allowLegacy = legacyRecoveryDocumentRef.current === current.id;
    regenerateRef.current = true;
    setRegenerating(true);
    const session = sessionRef.current;
    const generation = generationRef.current;
    // Invalidate pending play promises, but keep the job subscription and old audio versions.
    playRef.current++;
    detachAudio();
    preparingRef.current = false;
    setIsPreparing(false);
    setIsPlaying(false);
    setTime({ current: 0, duration: 0 });
    setMessage("");
    try {
      // Persist before sending. A lost HTTP response must never lead to a fresh paid request.
      localStorage.setItem(regenerationStorageKey(storageScope, current.id), JSON.stringify(input));
      pendingRegenerationRef.current = input;
      setPendingRegeneration(input);
      const { job: next } = await api<{ job: JobStatus }>(`/api/documents/${current.id}/regenerate`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      });
      clearResolvedRegeneration(current.id, input, allowLegacy);
      if (session !== sessionRef.current || current.id !== documentRef.current?.id) return;
      pendingRegenerationRef.current = null;
      setPendingRegeneration(null);
      watchJob(next, generation);
    } catch (error) {
      // Only a definite rejection permits a new operation. Network/5xx failures keep the key.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        try {
          clearResolvedRegeneration(current.id, input, allowLegacy);
          if (current.id === documentRef.current?.id) {
            pendingRegenerationRef.current = null;
            setPendingRegeneration(null);
          }
        } catch { /* Retain the request if browser storage becomes unavailable. */ }
      }
      if (session === sessionRef.current) setMessage(error instanceof Error ? error.message : "提交结果未确认，请恢复原请求");
    } finally {
      regenerateRef.current = false;
      setRegenerating(false);
    }
  }

  function regenerate(scope: "segment" | "all") {
    const current = documentRef.current;
    if (!current || regenerateRef.current || regenerationDisabledReason || pendingRegenerationRef.current) return;
    const settings = savedSettingsRef.current;
    if (!settings || settings.voiceId !== settingsRef.current.voiceId || settings.speed !== settingsRef.current.speed) return;
    const segment = current.segments[indexRef.current];
    if (!segment) return;
    const voiceName = voices.find((voice) => voice.id === settings.voiceId)?.name || "会话已保存的声音";
    if (!window.confirm(`${scope === "segment" ? `重新生成当前段落（第 ${indexRef.current + 1} 段）` : `重新生成整篇（共 ${current.segments.length} 段）`}？\n声音：${voiceName} · ${settings.speed}×\n将发起新的语音生成并产生新的费用，不使用旧缓存。成功前保留旧音频，完成后不会自动播放。`)) return;
    void submitRegeneration({ scope, ...(scope === "segment" ? { segmentId: segment.id } : {}),
      sourceJobId: savedJobRef.current?.id || null, ...settings, idempotencyKey: crypto.randomUUID(), acknowledgeBilling: true });
  }

  function recoverRegeneration() {
    if (!recoveryDisabledReason && pendingRegenerationRef.current) void submitRegeneration(pendingRegenerationRef.current);
  }

  return {
    ...draft, document, history, historyLoading, historyError, refreshHistory,
    loadingId, detailError, selectSession, newSession, isSaving, saveDocument, isDirty,
    voices, voiceId, speed, changeSettings, addVoice, voiceError, canLinkFishVoice,
    activeIndex, isPlaying, isPreparing, time, totalDuration, loopAll, message, setMessage,
    changeDraft, importFile, togglePlayback, loadSegment, goPrevious, goNext, seek,
    job, retryFailed, makeWebDefault, toggleLoop, downloadDocument,
    regenerate, regenerationDisabledReason, regenerating, pendingRegeneration, recoverRegeneration, recoveryDisabledReason,
  };
}
