"use client";

import {
  useEffect,
  useRef,
  useState,
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
import { api, useReader } from "@/components/use-reader";
import type { Voice } from "@/lib/types";

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function ReaderApp({ initialSessionId }: { initialSessionId?: string }) {
  const {
    text, title, document, history, historyLoading, historyError, refreshHistory,
    loadingId, detailError, selectSession, newSession, isSaving, saveDocument, isDirty,
    voices, voiceId, speed, changeSettings, addVoice, voiceError,
    activeIndex, isPlaying, isPreparing, time, totalDuration, loopAll, message, setMessage,
    changeDraft, importFile, togglePlayback, loadSegment, goPrevious, goNext, seek,
    job, retryFailed, makeWebDefault, toggleLoop, downloadDocument,
  } = useReader(initialSessionId);
  const [showVoiceModal, setShowVoiceModal] = useState(false);
  const editorDisabled = isSaving || Boolean(loadingId);
  const queueDisabled = editorDisabled || isDirty;

  const progress = document && time.duration
    ? Math.min(100, ((activeIndex + time.current / time.duration) / document.segments.length) * 100)
    : 0;

  return (
    <div className="app-shell">

      <header className="site-header">
        <a className="brand" href="#top" aria-label="声笺首页">
          <span className="brand-mark" aria-hidden="true">
            <i /><i /><i /><i />
          </span>
          <span>声笺</span>
          <small>VOICE NOTE</small>
        </a>
        <div className="header-actions">
          <span className="private-chip"><span /> Dingkang · 私人会话</span>
          {/* Full navigation disposes private playback state and runs Auth0 logout. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/auth/logout" className="text-button">退出</a>
          <button className="round-button" onClick={() => setShowVoiceModal(true)} aria-label="添加声音">
            <PlusIcon />
          </button>
        </div>
      </header>

      <div id="top" className="session-layout">
        <aside className="history-panel" aria-label="历史会话">
          <div className="history-heading">
            <h2>历史会话 <span>{history.length}</span></h2>
            <button className="text-button" onClick={() => void refreshHistory()} disabled={historyLoading}>刷新</button>
          </div>
          <button className="new-session-button" onClick={newSession} disabled={isSaving}><PlusIcon size={18} />新建会话</button>
          <p className="history-caption">私人云端保存，随时回来继续听。</p>
          {historyLoading && <p className="history-status" role="status">正在加载会话列表…</p>}
          {historyError && <div className="history-status" role="alert">{historyError}<button className="text-button" onClick={() => void refreshHistory()}>重试列表</button></div>}
          {!historyLoading && !historyError && !history.length && <p className="history-status">还没有会话。粘贴文字后点击「保存会话」，留待下次朗读。</p>}
          <ul className="history-list">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  className={`history-item ${(loadingId || document?.id) === item.id ? "active" : ""}`}
                  aria-current={(loadingId || document?.id) === item.id ? "true" : undefined}
                  disabled={isSaving}
                  onClick={() => void selectSession(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span className="history-meta"><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time> · {item.characterCount.toLocaleString()} 字</span>
                  <span className="history-preview">{item.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </aside>
      <main className="workspace" aria-label="会话编辑器">
        <section className="intro">
          <p className="eyebrow">把文字，交给熟悉的声音</p>
          <h1>随身听见，<em>每一篇好文章。</em></h1>
          <p className="intro-copy">保存一篇文章，留住一段声音。从历史会话选一篇，或新建会话开始。</p>
        </section>

        <div className="session-toolbar">
          <span role="status">{loadingId ? "正在打开会话…" : isSaving ? "正在保存会话…" : isDirty ? "未保存的修改" : document ? "会话已保存" : "新会话"}</span>
          <button className="save-session-button" onClick={() => void saveDocument()} disabled={editorDisabled || !text.trim() || (Boolean(document) && !isDirty)}>
            {isSaving ? <span className="spinner" /> : <CheckIcon size={16} />}保存会话
          </button>
          <p>保存不生成语音；朗读会自动保存。修改文字或标题后会另存新会话，原会话保留。</p>
        </div>
        {detailError && <div className="notice" role="alert">{detailError.message}<button className="detail-retry" onClick={() => void selectSession(detailError.id)}>重试打开</button></div>}

        <section className="composer-card">
          <div className="composer-topline">
            <input
              className="title-input"
              aria-label="文章标题"
              placeholder="文章标题（可选）"
              value={title}
              maxLength={100}
              disabled={editorDisabled}
              onChange={(event) => changeDraft({ text, title: event.target.value })}
            />
            <label className="upload-button">
              <UploadIcon size={18} />
              <span>上传 TXT</span>
              <input type="file" accept=".txt,text/plain" aria-label="上传 TXT" disabled={editorDisabled} onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = "";
              }} />
            </label>
          </div>
          <textarea
            aria-label="要朗读的文字"
            value={text}
            disabled={editorDisabled}
            onChange={(event) => changeDraft({ text: event.target.value, title })}
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
              <select id="voice" value={voiceId} onChange={(event) => changeSettings({ voiceId: event.target.value, speed: voices.find((v) => v.id === event.target.value)?.provider === "replicate" ? 1 : speed })}>
                {!voiceId && <option value="">请选择声音</option>}
                {voiceId && !voices.some((voice) => voice.id === voiceId) && <option value={voiceId}>已保存的声音（暂不可用）</option>}
                {voices.map((voice) => <option value={voice.id} key={voice.id}>{voice.name} · {voice.provider === "replicate" ? "IndexTTS 2" : voice.provider === "indextts" ? "IndexTTS-2.5" : "Fish"}{voice.available === false ? "（未配置）" : ""}</option>)}
              </select>
              <button className="add-voice-inline" onClick={() => setShowVoiceModal(true)}>
                <PlusIcon size={16} /> 添加
              </button>
            </div>
            <button className="add-voice-inline" disabled={!voiceId} onClick={() => void makeWebDefault()}>设为网页默认</button>
          </div>
          <div className="control-field speed-field">
            <div className="field-label-row"><label htmlFor="speed">语速</label><strong>{speed}×</strong></div>
            <input
              id="speed"
              disabled={voices.find((voice) => voice.id === voiceId)?.provider === "replicate"}
              type="range"
              min="0.7"
              max="1.5"
              step="0.05"
              value={speed}
              onChange={(event) => changeSettings({ voiceId, speed: Number(event.target.value) })}
              style={{ "--range-progress": `${((speed - 0.7) / 0.8) * 100}%` } as React.CSSProperties}
            />
            <div className="range-labels"><span>舒缓</span><span>自然</span><span>快速</span></div>
          </div>
          <button className="primary-read-button" onClick={() => void togglePlayback()} disabled={editorDisabled || isPreparing || !text.trim()}>
            {isPreparing ? <span className="spinner" /> : isPlaying ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
            {isPreparing ? "正在准备音频…" : isPlaying ? "暂停朗读" : "开始朗读"}
          </button>
          <p className="cost-note"><CheckIcon size={14} /> 相同文字和设置会自动使用缓存</p>
        </section>

        {voiceError && <div className="notice" role="alert">{voiceError}</div>}
        {job && <div className={`notice job-progress ${job.items.some((item) => ["error", "uncertain"].includes(item.status)) ? "needs-attention" : ""}`} role="status">
          <div>
            <p>{job.status === "completed" ? "音频已就绪" : job.status === "attention" ? "部分段落需要处理" : "后台生成中，可以关闭页面，稍后回来继续听"} · {job.items.filter((item) => item.status === "ready").length}/{job.items.length}</p>
            {job.items.filter((item) => ["error", "uncertain"].includes(item.status)).map((item) => (
              <p key={item.segment_id}>{item.error} <button className="text-button" onClick={() => void retryFailed(item.segment_id)}>重试第 {job.items.indexOf(item) + 1} 段</button></p>
            ))}
          </div>
        </div>}
        {message && <div className="notice" role={message === "已设为网页默认声音" ? "status" : "alert"}><span>{message === "已设为网页默认声音" ? "✓" : "!"}</span>{message}<button onClick={() => setMessage("")} aria-label="关闭"><CloseIcon size={16} /></button></div>}

        {document && (
          <section className="reading-card" aria-label="播放队列">
            <div className="reading-heading">
              <div>
                <p className="eyebrow">{isDirty ? "原会话段落 · 保存后更新" : "朗读段落"}</p>
                <h2>{document.title}</h2>
              </div>
              <span>{activeIndex + 1} / {document.segments.length} 段 · {totalDuration ? formatTime(totalDuration) : "准备中"}</span>
            </div>
            <div className="segments">
              {document.segments.map((segment, index) => (
                <button
                  key={segment.id}
                  className={`segment ${index === activeIndex ? "active" : ""}`}
                  disabled={queueDisabled}
                  onClick={() => void loadSegment(index)}
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
      </div>

      {document && (
        <aside className="player-bar" aria-label="播放器">
          <div className="player-progress-track"><span style={{ width: `${progress}%` }} /></div>
          <div className="player-inner">
            <div className="now-playing">
              <div className="mini-cover"><span /><span /><span /><span /></div>
              <div><strong>{document.title}</strong><span>{isPreparing ? "正在准备后续音频…" : voices.find((voice) => voice.id === voiceId)?.name || "声音"}</span></div>
            </div>
            <div className="transport">
              <button onClick={goPrevious} aria-label="上一段" disabled={queueDisabled || activeIndex === 0}><BackIcon /></button>
              <button className="transport-main" onClick={() => void togglePlayback()} disabled={editorDisabled || isPreparing || !text.trim()} aria-label={isPlaying ? "暂停" : "播放"}>
                {isPreparing ? <span className="spinner light" /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
              </button>
              <button onClick={goNext} aria-label="下一段" disabled={queueDisabled || activeIndex === document.segments.length - 1}><ForwardIcon /></button>
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
                disabled={queueDisabled || !time.duration}
                onChange={(event) => seek(Number(event.target.value))}
              />
              <span>{formatTime(time.duration)}</span>
            </div>
            <div className="player-actions">
              <label className="loop-toggle"><input type="checkbox" checked={loopAll} onChange={toggleLoop} />整篇循环</label>
              <button className="text-button" onClick={() => void downloadDocument()} disabled={!document || isPreparing}>下载整篇 WAV</button>
            </div>
          </div>
        </aside>
      )}

      {showVoiceModal && (
        <VoiceModal
          onClose={() => setShowVoiceModal(false)}
          onCreated={(voice) => {
            addVoice(voice);
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
  const [audio, setAudio] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [provider, setProvider] = useState<"indextts" | "fish">("fish");
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const cloneRequestRef = useRef<{ signature: string; input: {
    name: string; language: string; consent: boolean; uploadIds: string[]; idempotencyKey: string; provider: "indextts" | "fish";
  } } | null>(null);

  async function toggleRecording() {
    if (recording) {
      recorderRef.current?.stop();
      setRecording(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const seconds = (Date.now() - recordingStartedAtRef.current) / 1000;
        if (seconds < 10) {
          setAudio([]);
          setError("录音至少需要 10 秒；30–60 秒通常会更自然");
          streamRef.current?.getTracks().forEach((track) => track.stop());
          return;
        }
        const mime = recorder.mimeType || "audio/webm";
        const extension = mime.includes("mp4")
          ? "m4a"
          : mime.includes("ogg")
            ? "ogg"
            : "webm";
        const blob = new Blob(chunksRef.current, { type: mime });
        setAudio([new File([blob], `mobile-recording.${extension}`, { type: mime })]);
        streamRef.current?.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      recordingStartedAtRef.current = Date.now();
      setRecordingSeconds(0);
      setRecording(true);
      setError("");
    } catch {
      setError("无法使用麦克风，请检查浏览器权限");
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (recorderRef.current) recorderRef.current.onstop = recorderRef.current.ondataavailable = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setRecordingSeconds(Math.floor((Date.now() - recordingStartedAtRef.current) / 1000));
    }, 500);
    return () => window.clearInterval(timer);
  }, [recording]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return setError("请给声音起一个名字");
    if (provider === "indextts" && audio.length !== 1) return setError("请上传一段 10–60 秒的参考录音");
    if (!audio.length && !providerVoiceId.trim()) return setError("请录音、上传音频，或填写已有 Fish Voice ID");
    if (audio.length && !consent) return setError("请确认你拥有并获准克隆这个声音");
    setSaving(true);
    setError("");
    try {
      let result: { voice: Voice };
      if (audio.length) {
        const signature = JSON.stringify([provider, name.trim(), audio.map((file) => [file.name, file.size, file.lastModified, file.type])]);
        if (cloneRequestRef.current?.signature !== signature) {
          const { upload } = await import("@vercel/blob/client");
          const uploadIds: string[] = [];
          for (const file of audio) {
            const reservation = await api<{ id: string; pathname: string }>("/api/uploads", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ size: file.size, contentType: file.type.split(";")[0] }),
            });
            await upload(reservation.pathname, file, { access: "private", handleUploadUrl: "/api/uploads",
              clientPayload: reservation.id, contentType: file.type.split(";")[0], multipart: true });
            uploadIds.push(reservation.id);
          }
          cloneRequestRef.current = { signature, input: { provider, name: name.trim(), language: "zh", consent, uploadIds, idempotencyKey: crypto.randomUUID() } };
        }
        result = await api<{ voice: Voice }>("/api/voices", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(cloneRequestRef.current.input),
        });
      } else {
        result = await api<{ voice: Voice }>("/api/voices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim(), provider: "fish", providerVoiceId: providerVoiceId.trim(), language: "zh" }),
        });
      }
      if (mountedRef.current) onCreated(result.voice);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "添加声音失败");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="voice-modal" role="dialog" aria-modal="true" aria-labelledby="voice-title">
        <button className="modal-close" onClick={onClose} aria-label="关闭"><CloseIcon /></button>
        <p className="eyebrow">创建专属声音</p>
        <h2 id="voice-title">添加一个声音</h2>
        <p className="modal-lead">{provider === "indextts" ? "上传一段 10–60 秒清晰人声。保存后将作为网页默认声音。" : "录制清晰人声或连接已有 Fish Voice ID。"}</p>
        <form onSubmit={submit}>
          <label className="form-label">语音服务<select value={provider} disabled={saving || recording} onChange={(event) => { setProvider(event.target.value as "indextts" | "fish"); setAudio([]); setError(""); }}><option value="indextts">IndexTTS-2.5</option><option value="fish">Fish Audio</option></select></label>
          <label className="form-label">声音名称<input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：我的声音" maxLength={60} /></label>
          <div className={`record-zone ${recording ? "recording" : ""}`}>
            <button type="button" className="record-button" onClick={() => void toggleRecording()}>
              <MicIcon size={24} />
            </button>
            <div>
              <strong>{recording ? `正在录音 ${recordingSeconds} 秒，点击结束` : audio.length ? "录音已经准备好" : "用手机录一段"}</strong>
              <span>{audio.length ? `${audio.length} 段 · ${(audio.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024).toFixed(1)} MB` : "安静环境下自然说话 30–60 秒"}</span>
            </div>
            <label className="file-pill">上传<input type="file" accept="audio/*" multiple={provider === "fish"} onChange={(event) => setAudio(Array.from(event.target.files || []).slice(0, provider === "indextts" ? 1 : 20))} /></label>
          </div>
          {provider === "fish" && <><div className="or-divider"><span>或者连接已有声音</span></div>
          <label className="form-label">Fish Voice ID<input value={providerVoiceId} onChange={(event) => setProviderVoiceId(event.target.value)} placeholder="例如 98abc…" disabled={Boolean(audio.length)} /></label></>}
          {Boolean(audio.length) && <label className="consent-row"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>我确认这是我的声音，或我已获得声音所有者的明确授权。</span></label>}
          {error && <p className="form-error">{error}</p>}
          <button className="modal-submit" disabled={saving || recording}>{saving ? <><span className="spinner light" />正在创建…</> : "保存声音"}</button>
        </form>
      </div>
    </div>
  );
}
