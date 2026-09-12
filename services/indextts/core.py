"""Media and inference contract. No GPU imports here."""
import contextlib
import hashlib
import io
from pathlib import Path
import re
import subprocess
import tempfile
import wave

SOURCE_REVISION = "ee40fa7d6c6b8a2c7f06105f9f1e65775b74868c"
WEIGHTS_REVISION = "c39ce5ba981572cb187443877ff559dfb246ce63"
MODEL = f"indextts-2.5:{WEIGHTS_REVISION}:{SOURCE_REVISION}:natural-v1"
LANGUAGES = {"zh": "ZH", "en": "EN", "ja": "JA", "es": "ES", "ar": "AR"}


def validate_ids(owner, request_id):
    if not re.fullmatch(r"[a-f0-9]{32}", owner) or not re.fullmatch(r"[a-f0-9-]{36}", request_id):
        raise ValueError("Invalid request identifier")


def validate_payload(payload, reference):
    if payload.get("model") != MODEL:
        raise ValueError("Model revision mismatch")
    if not isinstance(payload.get("text"), str) or not 1 <= len(payload["text"]) <= 1000:
        raise ValueError("Invalid text length")
    speed = payload.get("speed")
    if isinstance(speed, bool) or not isinstance(speed, (float, int)) or not 0.5 <= speed <= 2:
        raise ValueError("Invalid speed")
    if payload.get("language") not in LANGUAGES:
        raise ValueError("Unsupported language")
    if not reference or len(reference) > 2_700_000 or hashlib.sha256(reference).hexdigest() != payload.get("reference_hash"):
        raise ValueError("Invalid reference")
    return {"text": payload["text"], "lang": LANGUAGES[payload["language"]], "duration_factor": 1 / speed}


def normalize(raw):
    if not raw or len(raw) > 20 * 1024 * 1024:
        raise ValueError("Invalid recording size")
    with tempfile.TemporaryDirectory() as tmp:
        source, output = Path(tmp) / "input", Path(tmp) / "reference.wav"
        source.write_bytes(raw)
        # Decode at most 61 seconds. Protocol restrictions prevent playlist/network reads.
        result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
            "-format_whitelist", "wav,mp3,mov,matroska,webm,ogg,aac,flac", "-i", str(source), "-t", "61", "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(output)],
            capture_output=True, timeout=20)
        if result.returncode or not output.exists():
            raise ValueError("Invalid recording")
        data = output.read_bytes()
        with wave.open(io.BytesIO(data)) as audio:
            seconds = audio.getnframes() / audio.getframerate()
        if not 10 <= seconds <= 60:
            raise ValueError("Recording must be 10–60 seconds")
        return data, seconds


def synthesize(model, payload, reference):
    args = validate_payload(payload, reference)
    with tempfile.TemporaryDirectory() as tmp:
        prompt, wav, mp3 = (Path(tmp) / name for name in ("reference.wav", "speech.wav", "speech.mp3"))
        prompt.write_bytes(reference)
        # Upstream prints input text even when verbose=False. Do not forward it to logs.
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            model.infer(spk_audio_prompt=str(prompt), output_path=str(wav),
                use_emo_text=False, use_random=False, verbose=False, **args)
        result = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-i", str(wav), "-vn",
            "-c:a", "libmp3lame", "-b:a", "128k", str(mp3)], capture_output=True, timeout=30)
        if result.returncode or not mp3.exists() or not 0 < mp3.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError("Invalid generated audio")
        return mp3.read_bytes()
