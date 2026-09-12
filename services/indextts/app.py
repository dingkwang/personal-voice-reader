"""Deploy only to an isolated Modal preview environment."""
from pathlib import Path
import modal
from core import SOURCE_REVISION, WEIGHTS_REVISION

app = modal.App("voice-reader-indextts-preview")
root = Path(__file__).parent
cpu = (modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .uv_sync(str(root), extra_options="--no-dev", uv_version="0.12.13")
    .add_local_python_source("core", "ledger", "api"))
secret = modal.Secret.from_name("voice-reader-indextts-preview")


def download_weights():
    import shutil
    from huggingface_hub import snapshot_download, hf_hub_download
    checkpoint = "/opt/index/checkpoints"
    snapshot_download("IndexTeam/IndexTTS-2.5", revision=WEIGHTS_REVISION, local_dir=checkpoint,
        ignore_patterns=["qwen*", "*.md", "examples/*"])
    snapshot_download("facebook/w2v-bert-2.0", revision="da985ba0987f70aaeb84a80f2851cfac8c697a7b",
        local_dir=f"{checkpoint}/hf_cache/w2v-bert-2.0")
    snapshot_download("nvidia/bigvgan_v2_22khz_80band_256x", revision="633ff708ed5b74903e86ff1298cf4a98e921c513",
        local_dir=f"{checkpoint}/hf_cache/bigvgan", allow_patterns=["config.json", "bigvgan_generator.pt"])
    source = hf_hub_download("funasr/campplus", "campplus_cn_common.bin", revision="e4b6ede7ce16997aff4ae69fbca1f0175e2afede")
    shutil.copyfile(source, f"{checkpoint}/hf_cache/campplus_cn_common.bin")


gpu = (modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "ffmpeg", "build-essential", "libgl1", "libglib2.0-0")
    .pip_install("uv==0.12.13")
    .run_commands(f"git clone https://github.com/index-tts/index-tts.git /opt/index && cd /opt/index && git checkout {SOURCE_REVISION}",
        "cd /opt/index && UV_PROJECT_ENVIRONMENT=$(python -c 'import sys; print(sys.prefix)') uv sync --frozen --no-dev --inexact",
        "uv pip install --system 'psycopg[binary]==3.3.5'")
    .env({"PYTHONPATH": "/opt/index"})
    .run_function(download_weights)
    .env({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    .add_local_python_source("core", "ledger"))


@app.cls(image=gpu, gpu="L4", cpu=2, memory=16384, min_containers=0, max_containers=1,
         scaledown_window=60, timeout=600, retries=0, secrets=[secret])
class Reader:
    @modal.method()
    def generate(self, owner: str, request_id: str):
        import contextlib
        import io
        import os
        import ledger
        from core import synthesize
        row = ledger.claim(owner, request_id)
        if row is None:
            return
        try:
            if not hasattr(self, "tts"):
                os.chdir("/opt/index")
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    from indextts.infer_v2_5 import IndexTTS2
                    self.tts = IndexTTS2(cfg_path="checkpoints/config.yaml", model_dir="checkpoints",
                        use_bf16=True, use_cuda_kernel=False, use_deepspeed=False, use_qwen_emo=False)
            ledger.finish(owner, request_id, synthesize(self.tts, row["payload"], bytes(row["reference"])))
        except Exception:
            ledger.finish(owner, request_id)


@app.function(image=cpu, secrets=[secret], min_containers=0, max_containers=1, timeout=60)
@modal.asgi_app(requires_proxy_auth=True)
def web():
    from api import create_app
    return create_app(lambda owner, request_id: Reader().generate.spawn(owner, request_id))
