# AirLLM server for Devon AI (NVIDIA GPU).
#
#   docker build -t devon-airllm airllm-server
#   docker run --gpus all -p 8790:8790 --env-file airllm-server/.env \
#     -v airllm-data:/data devon-airllm
#
# The torch wheel from PyPI bundles the CUDA runtime, so the host only needs an
# NVIDIA driver and the NVIDIA Container Toolkit (for --gpus). Model downloads
# and AirLLM's per-layer shards go to the /data volume; give it at least twice
# the model's size in free space for the first run.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/data/huggingface \
    AIRLLM_SHARDS_PATH=/data/shards \
    AIRLLM_HOST=0.0.0.0 \
    AIRLLM_PORT=8790

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY server.py .

RUN useradd --create-home --uid 10001 airllm && mkdir -p /data && chown airllm /data
USER airllm
VOLUME ["/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8790/health', timeout=4).status == 200 else 1)"

CMD ["python", "server.py"]
