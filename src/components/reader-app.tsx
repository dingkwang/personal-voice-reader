"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import {
  BackIcon,
  CheckIcon,
  CloseIcon,
  ForwardIcon,
  MicIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  UploadIcon,
} from "@/components/icons";
import { ServiceWorkerRegistration } from "@/components/service-worker-registration";
import type { PublicDocument, Segment, Voice } from "@/lib/types";

const SAMPLE_TEXT = `把一篇长文章变成声音，不应该是一段漫长的等待。

粘贴文字，选择熟悉的声音，然后按下播放。第一段生成后会立刻开始朗读，后面的段落在你聆听时悄悄准备好。你可以暂停、继续，也可以随时跳到上一段或下一段。

这是一个很小的开始，但它已经拥有成为个人声音平台所需的骨架。`;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败，请稍后重试");
  return data;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function ReaderApp() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [title, setTitle] = useState("");
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState("");
  const [speed, setSpeed] = useState(1);
  const [document, setDocument] = useState<PublicDocument | null>(null);
  const [documentSource, setDocumentSource] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const [message, setMessage] = useState("");
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const audioRef = useRef<HTMLAudioElement>(null);
  const documentRef = useRef<PublicDocument | null>(null);
  const activeIndexRef = useRef(0);
  const inFlightRef = useRef(new Map<string, Promise<Segment>>());
  const currentSignatureRef = useRef("");

  useEffect(() => {
    documentRef.current = document;
  }, [document]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  useEffect(() => {
    if (!currentSignatureRef.current) return;
    audioRef.current?.pause();
    currentSignatureRef.current = "";
    setTime({ current: 0, duration: 0 });
  }, [speed, voiceId]);

  useEffect(() => {
    api<{ voices: Voice[] }>("/api/voices")
      .then(({ voices: items }) => {
        setVoices(items);
        setVoiceId((current) => current || items[0]?.id || "");
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !("mediaSession" in navigator)) return;

    navigator.mediaSession.setActionHandler("play", () => void audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      window.dispatchEvent(new CustomEvent("reader:previous"));
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      window.dispatchEvent(new CustomEvent("reader:next"));
    });

    return () => {
      for (const action of ["play", "pause", "previoustrack", "nexttrack"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, []);

  const updateSegment = useCallback((next: Segment) => {
    setDocument((current) => {
      if (!current) return current;
      const updated = {
        ...current,
        segments: current.segments.map((segment) =>
          segment.id === next.id ? next : segment,
        ),
      };
      documentRef.current = updated;
      return updated;
    });
  }, []);

  const ensureAudio = useCallback(
    async (segment: Segment): Promise<Segment> => {
      const signature = `${segment.id}:${voiceId}:${speed}`;
      if (
        segment.audioUrl &&
        segment.voiceId === voiceId &&
        segment.speed === speed
      ) {
        return segment;
      }
      const pending = inFlightRef.current.get(signature);
      if (pending) return pending;

      const generation = api<{ segment: Segment }>("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId: segment.id, voiceId, speed }),
      }).then(({ segment: next }) => {
        updateSegment(next);
        return next;
      });
      inFlightRef.current.set(signature, generation);
      try {
        return await generation;
      } finally {
        inFlightRef.current.delete(signature);
      }
    },
    [speed, updateSegment, voiceId],
  );

  const loadSegment = useCallback(
    async (index: number, autoplay = true) => {
      const currentDocument = documentRef.current;
      const audio = audioRef.current;
      const segment = currentDocument?.segments[index];
      if (!currentDocument || !audio || !segment) return;

      setIsPreparing(true);
      setMessage("");
      setActiveIndex(index);
      activeIndexRef.current = index;
      try {
        const ready = await ensureAudio(segment);
        const signature = `${ready.id}:${voiceId}:${speed}`;
        if (currentSignatureRef.current !== signature) {
          audio.src = ready.audioUrl!;
          audio.load();
          currentSignatureRef.current = signature;
          setTime({ current: 0, duration: 0 });
        }
        if ("mediaSession" in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: currentDocument.title,
            artist: voices.find((voice) => voice.id === voiceId)?.name || "Personal Voice",
            album: `第 ${index + 1} / ${currentDocument.segments.length} 段`,
          });
        }
        if (autoplay) {
          await audio.play();
          setIsPlaying(true);
        }

        for (const next of currentDocument.segments.slice(index + 1, index + 3)) {
          void ensureAudio(next).catch(() => undefined);
        }
      } catch (error) {
        setIsPlaying(false);
        setMessage(error instanceof Error ? error.message : "无法生成音频");
      } finally {
        setIsPreparing(false);
      }
    },
    [ensureAudio, speed, voiceId, voices],
  );

  const createDocument = useCallback(async () => {
    const result = await api<{ document: PublicDocument }>("/api/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, title: title || undefined }),
    });
    setDocument(result.document);
    documentRef.current = result.document;
    setDocumentSource(text);
    setActiveIndex(0);
    activeIndexRef.current = 0;
    currentSignatureRef.current = "";
    return result.document;
  }, [text, title]);

  const togglePlayback = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !voiceId) {
      setMessage("请先选择一个声音");
      return;
    }
    if (!text.trim()) {
      setMessage("先粘贴一些文字，或上传 TXT 文件");
      return;
    }
    if (isPlaying) {
      audio.pause();
      return;
    }

    setMessage("");
    try {
      let currentDocument = documentRef.current;
      if (!currentDocument || documentSource !== text) {
        setIsPreparing(true);
        currentDocument = await createDocument();
      }
      const segment = currentDocument.segments[activeIndexRef.current];
      const signature = `${segment.id}:${voiceId}:${speed}`;
      if (audio.src && currentSignatureRef.current === signature) {
        await audio.play();
        setIsPlaying(true);
      } else {
        await loadSegment(activeIndexRef.current, true);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "暂时无法开始朗读");
      setIsPreparing(false);
    }
  }, [createDocument, documentSource, isPlaying, loadSegment, speed, text, voiceId]);

  const goPrevious = useCallback(() => {
    if (!documentRef.current) return;
    void loadSegment(Math.max(0, activeIndexRef.current - 1), true);
  }, [loadSegment]);

  const goNext = useCallback(() => {
    const count = documentRef.current?.segments.length || 0;
    if (!count) return;
    void loadSegment(Math.min(count - 1, activeIndexRef.current + 1), true);
  }, [loadSegment]);

  useEffect(() => {
    window.addEventListener("reader:previous", goPrevious);
    window.addEventListener("reader:next", goNext);
    return () => {
      window.removeEventListener("reader:previous", goPrevious);
      window.removeEventListener("reader:next", goNext);
    };
  }, [goNext, goPrevious]);

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".txt") && file.type !== "text/plain") {
      setMessage("V0 目前只支持 TXT 文件");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setMessage("TXT 文件请控制在 2 MB 以内");
      return;
    }
    file.text().then((content) => {
      setText(content.replace(/^\uFEFF/, ""));
      setTitle(file.name.replace(/\.txt$/i, ""));
      setMessage("");
    });
    event.target.value = "";
  }

  const progress = document
    ? ((activeIndex + (time.duration ? time.current / time.duration : 0)) /
        document.segments.length) *
      100
    : 0;

  return (
    <div className="app-shell">
      <ServiceWorkerRegistration />
      <audio
        ref={audioRef}
        preload="auto"
        onEnded={() => {
          const count = documentRef.current?.segments.length || 0;
          if (activeIndexRef.current < count - 1) goNext();
          else setIsPlaying(false);
        }}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        onLoadedMetadata={(event) =>
          setTime({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })
        }
        onTimeUpdate={(event) =>
          setTime({ current: event.currentTarget.currentTime, duration: event.currentTarget.duration })
        }
      />

      <header className="site-header">
        <a className="brand" href="#top" aria-label="声笺首页">
          <span className="brand-mark" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
          <span>声笺</span>
          <small>VOICE NOTE</small>
        </a>
        <div className="header-actions">
          <span className="private-chip"><span /> 私密处理</span>
          <button className="round-button" onClick={() => setShowVoiceModal(true)} aria-label="添加声音">
            <PlusIcon />
          </button>
        </div>
      </header>

      <main id="top" className="workspace">
        <section className="intro">
          <p className="eyebrow">把文字，交给熟悉的声音</p>
          <h1>随身听见，<em>每一篇好文章。</em></h1>
          <p className="intro-copy">粘贴文字或上传 TXT。第一段准备好就开始播放，其余内容会在聆听中接续生成。</p>
        </section>

        <section className="composer-card">
          <div className="composer-topline">
            <input
              className="title-input"
              aria-label="文章标题"
              placeholder="文章标题（可选）"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label className="upload-button">
              <UploadIcon size={18} />
              <span>上传 TXT</span>
              <input type="file" accept=".txt,text/plain" onChange={handleFile} />
            </label>
          </div>
          <textarea
            aria-label="要朗读的文字"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="在这里粘贴你想听的文字……"
            spellCheck={false}
          />
          <div className="composer-footer">
            <span>{text.length.toLocaleString()} 字</span>
            <span>支持中英文 · 最多 100,000 字</span>
          </div>
        </section>

        <section className="controls-card">
          <div className="control-field voice-field">
            <label htmlFor="voice">朗读声音</label>
            <div className="select-row">
              <div className="voice-avatar" aria-hidden="true"><span /><span /><span /></div>
              <select id="voice" value={voiceId} onChange={(event) => setVoiceId(event.target.value)}>
                {voices.map((voice) => <option value={voice.id} key={voice.id}>{voice.name}</option>)}
              </select>
              <button className="add-voice-inline" onClick={() => setShowVoiceModal(true)}>
                <PlusIcon size={16} /> 添加
              </button>
            </div>
          </div>
          <div className="control-field speed-field">
            <div className="field-label-row"><label htmlFor="speed">语速</label><strong>{speed.toFixed(1)}×</strong></div>
            <input
              id="speed"
              type="range"
              min="0.7"
              max="1.5"
              step="0.1"
              value={speed}
              onChange={(event) => setSpeed(Number(event.target.value))}
              style={{ "--range-progress": `${((speed - 0.7) / 0.8) * 100}%` } as React.CSSProperties}
            />
            <div className="range-labels"><span>舒缓</span><span>自然</span><span>快速</span></div>
          </div>
          <button className="primary-read-button" onClick={() => void togglePlayback()} disabled={isPreparing && !document}>
            {isPreparing ? <span className="spinner" /> : isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
            {isPreparing ? "正在准备第一段…" : isPlaying ? "暂停朗读" : "开始朗读"}
          </button>
          <p className="cost-note"><CheckIcon size={14} /> 相同文字和设置会自动使用缓存</p>
        </section>

        {message && <div className="notice" role="alert"><span>!</span>{message}<button onClick={() => setMessage("")} aria-label="关闭"><CloseIcon size={16} /></button></div>}

        {document && (
          <section className="reading-card" aria-label="播放队列">
            <div className="reading-heading">
              <div>
                <p className="eyebrow">正在朗读</p>
                <h2>{document.title}</h2>
              </div>
              <span>{activeIndex + 1} / {document.segments.length} 段</span>
            </div>
            <div className="segments">
              {document.segments.map((segment, index) => (
                <button
                  key={segment.id}
                  className={`segment ${index === activeIndex ? "active" : ""}`}
                  onClick={() => void loadSegment(index, true)}
                >
                  <span className="segment-number">{String(index + 1).padStart(2, "0")}</span>
                  <span>{segment.text}</span>
                  <i className={`segment-state ${segment.status}`} aria-label={segment.status === "ready" ? "已准备" : "待生成"} />
                </button>
              ))}
            </div>
          </section>
        )}
      </main>

      {document && (
        <aside className="player-bar" aria-label="播放器">
          <div className="player-progress-track"><span style={{ width: `${progress}%` }} /></div>
          <div className="player-inner">
            <div className="now-playing">
              <div className="mini-cover"><span /><span /><span /><span /></div>
              <div><strong>{document.title}</strong><span>{isPreparing ? "正在生成音频…" : `第 ${activeIndex + 1} 段 · ${voices.find((voice) => voice.id === voiceId)?.name || "声音"}`}</span></div>
            </div>
            <div className="transport">
              <button onClick={goPrevious} aria-label="上一段" disabled={activeIndex === 0}><BackIcon /></button>
              <button className="transport-main" onClick={() => void togglePlayback()} aria-label={isPlaying ? "暂停" : "播放"}>
                {isPreparing ? <span className="spinner light" /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button onClick={goNext} aria-label="下一段" disabled={activeIndex === document.segments.length - 1}><ForwardIcon /></button>
            </div>
            <div className="time-control">
              <span>{formatTime(time.current)}</span>
              <input
                aria-label="段落播放进度"
                type="range"
                min="0"
                max={time.duration || 0}
                step="0.1"
                value={time.current}
                onMouseDown={() => setIsDragging(true)}
                onMouseUp={() => setIsDragging(false)}
                onTouchStart={() => setIsDragging(true)}
                onTouchEnd={() => setIsDragging(false)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setTime((current) => ({ ...current, current: next }));
                  if (audioRef.current && !isDragging) audioRef.current.currentTime = next;
                }}
                onPointerUp={(event) => {
                  if (audioRef.current) audioRef.current.currentTime = Number(event.currentTarget.value);
                  setIsDragging(false);
                }}
              />
              <span>{formatTime(time.duration)}</span>
            </div>
          </div>
        </aside>
      )}

      {showVoiceModal && (
        <VoiceModal
          onClose={() => setShowVoiceModal(false)}
          onCreated={(voice) => {
            setVoices((current) => [...current, voice]);
            setVoiceId(voice.id);
            setShowVoiceModal(false);
          }}
        />
      )}
    </div>
  );
}

function VoiceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (voice: Voice) => void }) {
  const [name, setName] = useState("");
  const [providerVoiceId, setProviderVoiceId] = useState("");
  const [audio, setAudio] = useState<File | null>(null);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setAudio(new File([blob], "mobile-recording.webm", { type: blob.type }));
        streamRef.current?.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      setRecording(true);
      setError("");
    } catch {
      setError("无法使用麦克风，请检查浏览器权限");
    }
  }

  useEffect(() => () => streamRef.current?.getTracks().forEach((track) => track.stop()), []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("请给声音起一个名字");
    if (!audio && !providerVoiceId.trim()) return setError("请录音、上传音频，或填写已有 Fish Voice ID");
    if (audio && !consent) return setError("请确认你拥有并获准克隆这个声音");
    setSaving(true);
    setError("");
    try {
      let result: { voice: Voice };
      if (audio) {
        const form = new FormData();
        form.append("name", name.trim());
        form.append("audio", audio);
        form.append("language", "zh");
        form.append("consent", String(consent));
        result = await api<{ voice: Voice }>("/api/voices", { method: "POST", body: form });
      } else {
        result = await api<{ voice: Voice }>("/api/voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), provider: "fish", providerVoiceId: providerVoiceId.trim(), language: "zh" }),
        });
      }
      onCreated(result.voice);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "添加声音失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="voice-modal" role="dialog" aria-modal="true" aria-labelledby="voice-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        <p className="eyebrow">创建专属声音</p>
        <h2 id="voice-title">添加一个声音</h2>
        <p className="modal-lead">录制 30–60 秒清晰人声，Fish 会创建一个私密、可重复使用的 Voice ID。</p>
        <form onSubmit={submit}>
          <label className="form-label">声音名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的声音" maxLength={60} /></label>
          <div className={`record-zone ${recording ? "recording" : ""}`}>
            <button type="button" className="record-button" onClick={() => void toggleRecording()}>
              <MicIcon size={24} />
            </button>
            <div>
              <strong>{recording ? "正在录音，点击结束" : audio ? "录音已经准备好" : "用手机录一段"}</strong>
              <span>{audio ? `${audio.name} · ${(audio.size / 1024 / 1024).toFixed(1)} MB` : "安静环境下自然说话 30–60 秒"}</span>
            </div>
            <label className="file-pill">上传<input type="file" accept="audio/*" onChange={(event) => setAudio(event.target.files?.[0] || null)} /></label>
          </div>
          <div className="or-divider"><span>或者连接已有声音</span></div>
          <label className="form-label">Fish Voice ID<input value={providerVoiceId} onChange={(event) => setProviderVoiceId(event.target.value)} placeholder="例如 98abc…" disabled={Boolean(audio)} /></label>
          {audio && <label className="consent-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我确认这是我的声音，或我已获得声音所有者的明确授权。</span></label>}
          {error && <p className="form-error">{error}</p>}
          <button className="modal-submit" disabled={saving || recording}>{saving ? <><span className="spinner light" />正在创建…</> : "保存声音"}</button>
        </form>
      </div>
    </div>
  );
}
