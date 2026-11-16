"""
Speech on the GPU (docs/voices.md): the VoxCPM2 runner speaking lines, and the Qwen3-TTS VoiceDesign designer making
voices for world builds. The GPU broker's speech adapter (src/adapters/speech.ts) starts this, talks to it over a
local socket in the protocol of docs/voices.md ("The engines"; framing in wire.py) and restarts it if it dies.

    python speech_service.py --port 0 --clips <folder> [--slots 16]

It prints "SPEECH LISTENING <port>", then serves one connection (the broker), whose first message must be
{"op": "hello", "token": <SPEECH_TOKEN from the environment>}. It exits when that connection closes (the broker went,
however it went), or if none comes within a minute. (Not by watching stdin: on Windows a thread blocked reading a pipe
stalls the loading of CUDA's libraries.)

It holds at most one model at a time, loaded when asked (`load`) or when work needs it: the runner (6.6 GB, about 8 s
to load) or the designer (up to 9 GB, about 4 s). They never fit together beside anything else.

A voice is named by its reference clip: the SHA-256 of the clip's WAV file. Clips are kept in the clips folder for
good (one unused for half a year is removed), so a voice is sent once, ever, whatever restarts and however many
callers use it: a line for a voice the folder lacks waits while the service asks for its clip (`need`).

Requests:
- load {model: "runner" | "designer", reqId}, unload {reqId}, status {reqId}: every load and unload is answered, with
  its reqId, by "loaded" {model} or "unloaded" (with an error when the load failed, after giving back what it took)
- speak {lineId, voiceId, text, startWithinMs, priority}, cancel {lineId}: a line that has not started within that
  long of arriving here is not spoken (a length of time, since the caller's clock is not this machine's)
- voice {voiceId, wav}: a reference clip (WAV, base64) whose SHA-256 is voiceId; it says REF_TEXT
- design {reqId, designs: [{id, description}]}: one reference clip per description, saying REF_TEXT
Events: hello, loaded {model} and unloaded (also whenever the model changes), need {lineId, voiceId}, started / done /
failed / expired {lineId}, each line's audio as audio frames (16-bit PCM at the runner's 48 kHz), designed {reqId, ids,
sampleRate} after one audio frame per clip (its id is "design:<id>"), status.
"""

import argparse
import asyncio
import base64
import gc
import hashlib
import heapq
import itertools
import json
import os
import queue
import re
import sys
import threading
import time
import traceback
from collections import OrderedDict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wire  # noqa: E402

# What every voice's reference clip says (the designer reads it; the runner continues from it).
REF_TEXT = (
    "I have lived in this place for a long time, and I have seen a great many travelers come and go. "
    "Sit a while, and I will tell you what I know."
)
CLIPS_HELD = 400  # in memory; every clip stays on disk
CLIP_UNUSED_DAYS = 180
VOICE_ID = re.compile(r"^[0-9a-f]{64}$")


def hf_snapshot(repo):
    """A model's folder in the Hugging Face cache (HF_HOME, else ~/.cache/huggingface)."""
    home = Path(os.environ.get("HF_HOME") or Path.home() / ".cache" / "huggingface")
    snaps = home / "hub" / f"models--{repo.replace('/', '--')}" / "snapshots"
    return next(snaps.iterdir())


class Gpu(threading.Thread):
    """Every use of the GPU, on one thread: requests come in on `ops`, events go out through `emit`."""

    def __init__(self, slots, clip_dir, emit, emit_audio):
        super().__init__(daemon=True)
        self.slots, self.clip_dir, self.emit, self.emit_audio = slots, clip_dir, emit, emit_audio
        self.ops = queue.Queue()
        self.loaded = None  # the model loaded: "runner", "designer" or None
        self.model = self.runner = self.voices = self.designer = None
        self.clips = OrderedDict()  # voiceId -> float32 clip at 16 kHz, the most recently used last
        self.needing = {}  # voiceId -> lines waiting for its clip
        self.waiting = []  # heap of (priority, seq, request)
        self.seq = itertools.count()
        self.lines = {}  # lineId -> Line given to the runner

    # ----- models

    def ensure(self, name):
        """Loads a model (the one held goes first). A load that fails gives back everything it took, then raises."""
        if self.loaded == name:
            return
        self.free()
        t0 = time.perf_counter()
        error = None
        try:
            if name == "runner":
                from runner import FP8_CALIBRATION, Runner, VoxCPM2, Voices

                self.model = VoxCPM2(hf_snapshot("openbmb/VoxCPM2"), fp8=FP8_CALIBRATION)
                self.runner = Runner(self.model, slots=self.slots, keep_audio=False)
                self.voices = Voices(self.model)
            elif name == "designer":
                from designer import VoiceDesigner

                self.designer = VoiceDesigner(hf_snapshot("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"))
            else:
                raise ValueError(f"no model {name!r}")
        except Exception as e:
            traceback.print_exc()
            error = f"{type(e).__name__}: {e}"
        if error:
            # Out here, not in the except block: the traceback's frames (and the tensors they hold) are gone.
            self.free()
            raise RuntimeError(f"{name} could not load: {error}")
        self.loaded = name
        print(f"speech: {name} loaded in {time.perf_counter() - t0:.1f} s", flush=True)

    def free(self):
        """Gives back every byte of GPU memory, whatever is loaded or half loaded; lines in hand fail."""
        for line_id in list(self.lines):
            self.emit({"ev": "failed", "lineId": line_id, "error": "the speech model was unloaded"})
        self.lines.clear()
        for req in [w[2] for w in self.waiting] + [r for reqs in self.needing.values() for r in reqs]:
            self.emit({"ev": "failed", "lineId": req["lineId"], "error": "the speech model was unloaded"})
        self.waiting.clear()
        self.needing.clear()
        if self.designer is not None:
            self.designer.close()
        self.model = self.runner = self.voices = self.designer = None
        self.loaded = None
        gc.collect()
        if "torch" in sys.modules:
            sys.modules["torch"].cuda.empty_cache()

    def report(self, req_id=None, error=None):
        """What is loaded now: the answer to every load and unload request (by its reqId), and news when it changes."""
        msg = {"ev": "loaded" if self.loaded else "unloaded", "model": self.loaded}
        if req_id is not None:
            msg["reqId"] = req_id
        if error:
            msg["error"] = error
        self.emit(msg)

    # ----- voices

    def clip_path(self, voice_id):
        return self.clip_dir / f"{voice_id}.wav"

    def clip(self, voice_id):
        """A voice's clip at 16 kHz, from memory or the clips folder."""
        if voice_id in self.clips:
            self.clips.move_to_end(voice_id)
            return self.clips[voice_id]
        import numpy as np
        import soundfile as sf
        import soxr

        path = self.clip_path(voice_id)
        os.utime(path)  # used: kept another half year
        audio, rate = sf.read(path, dtype="float32", always_2d=True)
        self.clips[voice_id] = soxr.resample(audio.mean(axis=1), rate, 16000, quality="HQ").astype(np.float32)
        while len(self.clips) > CLIPS_HELD:
            self.clips.popitem(last=False)
        return self.clips[voice_id]

    def keep_clip(self, voice_id, wav):
        """A clip from a caller, kept if it is the clip its name says; the lines waiting for it go ahead."""
        if hashlib.sha256(wav).hexdigest() != voice_id:
            print(f"speech: a clip sent as {voice_id[:12]} has another hash; ignored", flush=True)
            return
        tmp = self.clip_path(voice_id).with_suffix(".tmp")
        tmp.write_bytes(wav)
        os.replace(tmp, self.clip_path(voice_id))
        for req in self.needing.pop(voice_id, []):
            heapq.heappush(self.waiting, (int(req.get("priority") or 0), next(self.seq), req))

    # ----- requests

    def handle(self, op):
        kind = op.get("op")
        if kind == "load":
            try:
                self.ensure(op["model"])
                self.report(op.get("reqId"))
            except Exception as e:
                self.report(op.get("reqId"), str(e))
        elif kind == "unload":
            self.free()
            self.report(op.get("reqId"))
        elif kind == "voice":
            if VOICE_ID.match(str(op.get("voiceId"))):
                self.keep_clip(op["voiceId"], base64.b64decode(op["wav"]))
        elif kind == "speak":
            if op.get("startWithinMs") is not None:
                op["deadline"] = time.time() * 1000 + float(op["startWithinMs"])
            if self.loaded != "runner":
                return self.emit({"ev": "failed", "lineId": op["lineId"], "error": "the runner is not loaded"})
            voice_id = str(op.get("voiceId"))
            if not VOICE_ID.match(voice_id):
                return self.emit({"ev": "failed", "lineId": op["lineId"], "error": "a voice is named by its clip's SHA-256"})
            if voice_id not in self.clips and not self.clip_path(voice_id).exists():
                self.needing.setdefault(voice_id, []).append(op)
                return self.emit({"ev": "need", "lineId": op["lineId"], "voiceId": voice_id})
            heapq.heappush(self.waiting, (int(op.get("priority") or 0), next(self.seq), op))
        elif kind == "cancel":
            self.waiting = [w for w in self.waiting if w[2]["lineId"] != op["lineId"]]
            heapq.heapify(self.waiting)
            for voice_id, reqs in list(self.needing.items()):
                self.needing[voice_id] = [r for r in reqs if r["lineId"] != op["lineId"]]
                if not self.needing[voice_id]:
                    del self.needing[voice_id]
            if self.lines.pop(op["lineId"], None) is not None and self.runner is not None:
                self.runner.cancel(op["lineId"])
        elif kind == "design":
            self.design(op)
        elif kind == "status":
            self.emit({"ev": "status", "reqId": op.get("reqId"), **self.status()})

    def status(self):
        speaking = len(self.lines)
        return {"model": self.loaded, "loaded": self.loaded == "runner", "slots": self.slots,
                "free": max(0, self.slots - speaking) if self.loaded == "runner" else 0, "waiting": len(self.waiting)}

    def design(self, op):
        import numpy as np

        try:
            from designer import SAMPLE_RATE, Design

            try:
                self.ensure("designer")
            finally:
                self.report()
            designs = [Design(d["id"], d["description"], REF_TEXT) for d in op["designs"]]
            clips = self.designer.design(designs)
            for d in designs:
                pcm = (np.clip(clips[d.id], -1, 1) * 32767).astype(np.int16).tobytes()
                self.emit_audio(f"design:{d.id}", pcm)
            self.emit({"ev": "designed", "reqId": op.get("reqId"), "ids": [d.id for d in designs], "sampleRate": SAMPLE_RATE, "text": REF_TEXT})
        except Exception as e:
            traceback.print_exc()
            self.emit({"ev": "designed", "reqId": op.get("reqId"), "error": f"{type(e).__name__}: {e}"})

    # ----- lines

    def admit(self):
        """Waiting lines into free slots, the most urgent first; a line past its deadline is not spoken."""
        from runner import Line
        import numpy as np

        while self.waiting and len(self.lines) < self.slots:
            _, _, req = heapq.heappop(self.waiting)
            line_id = req["lineId"]
            if req.get("deadline") and time.time() * 1000 > req["deadline"]:
                self.emit({"ev": "expired", "lineId": line_id})
                continue
            def on_audio(line, chunk):
                if line.id in self.lines:
                    self.emit_audio(line.id, (np.clip(chunk, -1, 1) * 32767).astype(np.int16).tobytes())

            def on_done(line):
                if self.lines.pop(line.id, None) is not None:
                    self.emit({"ev": "done", "lineId": line.id})

            try:
                voice = self.voices.get(req["voiceId"], lambda: (self.clip(req["voiceId"]), REF_TEXT))
                line = Line(line_id, req["text"], voice, on_audio=on_audio, on_done=on_done)
                self.runner.add(line)
                self.lines[line_id] = line
                self.emit({"ev": "started", "lineId": line_id, "sampleRate": self.model.sample_rate})
            except Exception as e:
                self.emit({"ev": "failed", "lineId": line_id, "error": f"{type(e).__name__}: {e}"})

    def run(self):
        while True:
            busy = self.runner is not None and (self.lines or self.waiting)
            try:
                op = self.ops.get(block=not busy)
            except queue.Empty:
                op = None
            while op is not None:
                try:
                    self.handle(op)
                except Exception as e:
                    traceback.print_exc()
                    if op.get("lineId"):
                        self.emit({"ev": "failed", "lineId": op["lineId"], "error": f"{type(e).__name__}: {e}"})
                try:
                    op = self.ops.get_nowait()
                except queue.Empty:
                    op = None
            if self.runner is None:
                continue
            try:
                self.admit()
                if self.runner.lines or self.runner.pending:
                    self.runner.step()
            except Exception as e:
                # A failed step loses the lines speaking; the runner itself stays usable.
                traceback.print_exc()
                for line_id in list(self.lines):
                    self.runner.cancel(line_id)
                    self.emit({"ev": "failed", "lineId": line_id, "error": f"{type(e).__name__}: {e}"})
                self.lines.clear()


def prune_clips(folder):
    """The clips folder, without the clips unused for half a year (and any half-written one)."""
    folder.mkdir(parents=True, exist_ok=True)
    old = time.time() - CLIP_UNUSED_DAYS * 86400
    for f in folder.iterdir():
        if f.suffix == ".tmp" or f.stat().st_mtime < old:
            f.unlink(missing_ok=True)
    return folder


class Service:
    def __init__(self, args):
        self.args = args
        self.writer = None
        self.loop = None
        self.gpu = Gpu(args.slots, prune_clips(Path(args.clips)), self.emit, self.emit_audio)

    def emit(self, msg):
        self.loop.call_soon_threadsafe(self._write, wire.json_frame(msg))

    def emit_audio(self, line_id, pcm):
        self.loop.call_soon_threadsafe(self._write, wire.audio_frame(line_id, pcm))

    def _write(self, frame):
        if self.writer is not None and not self.writer.is_closing():
            self.writer.write(frame)

    async def serve(self, reader, writer):
        if self.writer is not None:
            writer.close()
            return
        try:
            hello = await wire.read_frame(reader)
            if not hello or hello[0] != "json" or hello[1].get("op") != "hello" or hello[1].get("token") != os.environ.get("SPEECH_TOKEN"):
                writer.close()
                return
            self.writer = writer
            self._write(wire.json_frame({"ev": "hello", "engine": "runner", **self.gpu.status()}))
            while True:
                frame = await wire.read_frame(reader)
                if frame is None:
                    break
                if frame[0] == "json":
                    self.gpu.ops.put(frame[1])
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            writer.close()
            if self.writer is writer:
                os._exit(0)  # the broker went away

    async def main(self):
        self.loop = asyncio.get_running_loop()
        self.gpu.start()
        server = await asyncio.start_server(self.serve, "127.0.0.1", self.args.port)
        print(f"SPEECH LISTENING {server.sockets[0].getsockname()[1]}", flush=True)
        self.loop.call_later(60, lambda: self.writer is None and os._exit(0))
        async with server:
            await server.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--clips", required=True)
    parser.add_argument("--slots", type=int, default=16)
    asyncio.run(Service(parser.parse_args()).main())
