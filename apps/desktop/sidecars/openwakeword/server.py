#!/usr/bin/env python3
"""
openWakeWord sidecar for Superset voice control.

Reads 16-bit PCM 16kHz mono audio frames from stdin and emits JSON wake events
to stdout. Designed to be spawned as a child process from the Electron main process.

Protocol:
  stdin  <- raw PCM int16 frames (chunk_size samples per read, default 1280 = 80ms)
  stdout -> JSON lines: {"event":"ready"}, {"event":"wake","score":0.87}, {"event":"error","message":"..."}
  stderr -> human-readable logs for debugging

Frame size: openWakeWord expects multiples of 80ms at 16kHz = 1280 samples = 2560 bytes.
"""

import argparse
import json
import os
import sys
import time

import numpy as np

# Debug log file for diagnostics (read by parent process or developer)
_debug_log_path = os.path.join(os.path.dirname(__file__), "debug.log")
_debug_log_file = open(_debug_log_path, "w")

def log(msg: str) -> None:
    print(f"[openwakeword] {msg}", file=sys.stderr, flush=True)
    _debug_log_file.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    _debug_log_file.flush()

def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)

def main() -> None:
    parser = argparse.ArgumentParser(description="openWakeWord sidecar")
    parser.add_argument("--model", default="hey_jarvis_v0.1", help="Wake word model name or path")
    parser.add_argument("--threshold", type=float, default=0.5, help="Detection threshold (0.0-1.0)")
    parser.add_argument("--trigger-level", type=int, default=1, help="Consecutive frames above threshold to trigger")
    parser.add_argument("--refractory-seconds", type=float, default=2.0, help="Cooldown after detection")
    parser.add_argument("--chunk-size", type=int, default=1280, help="Samples per frame (1280 = 80ms at 16kHz)")
    args = parser.parse_args()

    try:
        import openwakeword
        from openwakeword.model import Model
    except ImportError as e:
        emit({"event": "error", "message": f"openwakeword not installed: {e}"})
        sys.exit(1)

    # Download default models if needed
    try:
        openwakeword.utils.download_models()
    except Exception:
        log("Model download skipped or failed (may already be cached)")

    try:
        oww = Model(
            wakeword_models=[args.model],
            inference_framework="onnx",
        )
    except Exception as e:
        emit({"event": "error", "message": f"Failed to load model '{args.model}': {e}"})
        sys.exit(1)

    log(f"Model loaded: {args.model} (threshold={args.threshold}, trigger={args.trigger_level})")
    emit({"event": "ready"})

    chunk_bytes = args.chunk_size * 2  # int16 = 2 bytes per sample
    last_detection = 0.0
    trigger_count = 0
    frame_count = 0
    peak_score = 0.0
    last_health_log = time.time()

    try:
        while True:
            raw = sys.stdin.buffer.read(chunk_bytes)
            if not raw or len(raw) < chunk_bytes:
                break

            # Decode int16 PCM into numpy array
            samples = np.frombuffer(raw, dtype=np.int16)
            frame_count += 1

            # Run prediction
            prediction = oww.predict(samples)

            # Check all model scores
            for model_name, score in prediction.items():
                if score > peak_score:
                    peak_score = score

                # Log non-trivial scores to stderr for debugging
                if score > 0.1:
                    log(f"score={score:.3f} model={model_name} trigger_count={trigger_count}")

                if score >= args.threshold:
                    trigger_count += 1
                    if trigger_count >= args.trigger_level:
                        now = time.time()
                        if now - last_detection >= args.refractory_seconds:
                            # Cast numpy scalars to native Python types for JSON serialization.
                            emit(
                                {
                                    "event": "wake",
                                    "score": float(round(float(score), 3)),
                                    "model": str(model_name),
                                }
                            )
                            last_detection = now
                        trigger_count = 0
                else:
                    trigger_count = max(0, trigger_count - 1)

            # Periodic health log every 10 seconds
            now = time.time()
            if now - last_health_log >= 10.0:
                rms = int(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
                log(f"health: frames={frame_count} peak_score={peak_score:.3f} rms={rms}")
                last_health_log = now

    except KeyboardInterrupt:
        pass
    except Exception as e:
        emit({"event": "error", "message": str(e)})

    log("Shutting down")

if __name__ == "__main__":
    main()
