"""A lean runner for Qwen3-TTS VoiceDesign (Qwen, Apache 2.0), the model that designs each character's reference voice
during a world build: from a description of how someone sounds, it reads a short text in that voice.

It designs many voices at once through one copy of the model, in plain PyTorch, with nothing beyond what the
VoxCPM2 runner's environment already has (torch, numpy, safetensors, tokenizers):
- a fixed number of slots, each designing one voice, with a static key/value cache sized for the longest clip
  allowed; when a voice finishes, the next one waiting takes its slot, and the busy slots are always the first ones;
- one CUDA graph per batch size that makes one 80 ms frame for every busy slot: the code predictor's 15 passes (the
  other 15 codebooks of the frame), the frame's embedding, the talker's step and the sampling of the next frame's
  first codebook, with the original's repetition penalty, suppressed tokens and minimum length;
- an eager prefill for each new voice, written straight into its slot;
- the 12 Hz codec's decoder turning each finished voice's codes into 24 kHz audio, several voices at a time.

It does what `Qwen3TTSModel.generate_voice_design` does in its default (non-streaming) mode, for one language per
voice. It is meant for build jobs only: load it, design a world's voices, and `close()` it, which gives its GPU
memory back.

    model = VoiceDesigner(MODEL_DIR)
    clips = model.design([Design("wrenna", "A gruff old woman ...", REF_TEXT), ...])   # {id: float32 audio, 24 kHz}
    model.close()
"""

import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from safetensors.torch import load_file
from tokenizers import AddedToken, Regex, Tokenizer, decoders, models, normalizers, pre_tokenizers

BF16 = torch.bfloat16
SAMPLE_RATE, FRAME_SAMPLES = 24000, 1920
# Qwen2's pre-tokenizer pattern, as its tokenizer.json gives it.
QWEN_SPLIT = (r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|"
              r"\s+(?!\S)|\s+")


def default_model_dir():
    return next((Path.home() / ".cache/huggingface/hub/models--Qwen--Qwen3-TTS-12Hz-1.7B-VoiceDesign/snapshots").iterdir())


# ----------------------------------------------------------------------------------------------------------------
# Transformer pieces (Qwen3 layers: q/k norms, rotary embedding on the whole head, SwiGLU)
# ----------------------------------------------------------------------------------------------------------------

def rope_table(head_dim, base, length, device):
    inv = 1.0 / base ** (torch.arange(0, head_dim, 2, device=device, dtype=torch.float32) / head_dim)
    freqs = torch.outer(torch.arange(length, device=device, dtype=torch.float32), inv)
    emb = torch.cat([freqs, freqs], dim=-1)
    return emb.cos(), emb.sin()


def rotate(x, cos, sin):
    """x [..., T, D] with cos/sin broadcast to [..., T, D]: the rotate-half convention, in float32 as the original."""
    half = x.shape[-1] // 2
    xf = x.float()
    turned = torch.cat([-xf[..., half:], xf[..., :half]], dim=-1)
    return (xf * cos + turned * sin).to(x.dtype)


class Stack:
    """A stack of Qwen3 decoder layers whose weights live in one state dict under `prefix`.layers.N."""

    def __init__(self, sd, prefix, layers, heads, kv_heads, head_dim, eps, theta, length, device):
        self.n, self.heads, self.kv_heads, self.head_dim, self.eps = layers, heads, kv_heads, head_dim, eps
        self.layers = []
        for i in range(layers):
            p = f"{prefix}.layers.{i}."
            w = lambda name: sd.pop(p + name)
            self.layers.append({
                "qkv": torch.cat([w("self_attn.q_proj.weight"), w("self_attn.k_proj.weight"), w("self_attn.v_proj.weight")]),
                "o": w("self_attn.o_proj.weight"), "q_norm": w("self_attn.q_norm.weight"), "k_norm": w("self_attn.k_norm.weight"),
                "gate_up": torch.cat([w("mlp.gate_proj.weight"), w("mlp.up_proj.weight")]), "down": w("mlp.down_proj.weight"),
                "in_norm": w("input_layernorm.weight"), "post_norm": w("post_attention_layernorm.weight"),
            })
        self.norm = sd.pop(f"{prefix}.norm.weight")
        self.cos, self.sin = rope_table(head_dim, theta, length, device)
        self.q_size, self.kv_size = heads * head_dim, kv_heads * head_dim

    def _norm(self, x, w):
        return F.rms_norm(x, (x.shape[-1],), w, self.eps)

    def _qkv(self, x, layer, positions):
        """x [B, T, H] -> q [B, heads, T, D], k and v [B, kv_heads, T, D], rotated at `positions` ([T] or [B, T])."""
        B, T, _ = x.shape
        q, k, v = (self._norm(x, layer["in_norm"]) @ layer["qkv"].T).split([self.q_size, self.kv_size, self.kv_size], -1)
        q = self._norm(q.view(B, T, self.heads, self.head_dim), layer["q_norm"]).transpose(1, 2)
        k = self._norm(k.view(B, T, self.kv_heads, self.head_dim), layer["k_norm"]).transpose(1, 2)
        v = v.view(B, T, self.kv_heads, self.head_dim).transpose(1, 2)
        cos, sin = self.cos[positions], self.sin[positions]
        if cos.dim() == 3:  # per-slot positions: [B, T, D] -> [B, 1, T, D]
            cos, sin = cos[:, None], sin[:, None]
        return rotate(q, cos, sin), rotate(k, cos, sin), v

    def _finish(self, x, attn, layer):
        B, _, T, _ = attn.shape
        x = x + attn.transpose(1, 2).reshape(B, T, self.q_size) @ layer["o"].T
        gate, up = (self._norm(x, layer["post_norm"]) @ layer["gate_up"].T).chunk(2, -1)
        return x + (F.silu(gate) * up) @ layer["down"].T

    def prefill(self, x, cache=None, row=None):
        """Causal over x [1, T, H] from position 0; writes keys and values into cache row `row` if given."""
        T = x.shape[1]
        positions = torch.arange(T, device=x.device)
        for i, layer in enumerate(self.layers):
            q, k, v = self._qkv(x, layer, positions)
            if cache is not None:
                cache[0][i][row, :, :T] = k[0]
                cache[1][i][row, :, :T] = v[0]
            x = self._finish(x, F.scaled_dot_product_attention(q, k, v, is_causal=True, enable_gqa=True), layer)
        return self._norm(x, self.norm)

    def step(self, x, pos, cache_k, cache_v, mask):
        """One new position per slot: x [B, 1, H] at positions pos [B], attending to each slot's cache up to pos. The
        query heads that share a key/value head attend as a group, as if they were several positions."""
        B = x.shape[0]
        group = self.heads // self.kv_heads
        rows = torch.arange(B, device=x.device)
        for i, layer in enumerate(self.layers):
            q, k, v = self._qkv(x, layer, pos[:, None])
            cache_k[i][rows, :, pos] = k[:, :, 0]
            cache_v[i][rows, :, pos] = v[:, :, 0]
            q = q.view(B, self.kv_heads, group, self.head_dim)
            attn = F.scaled_dot_product_attention(q, cache_k[i][:B], cache_v[i][:B], attn_mask=mask)
            x = self._finish(x, attn.reshape(B, self.heads, 1, self.head_dim), layer)
        return self._norm(x, self.norm)


def sample(logits, temperature, top_k):
    """A draw from the softmax of the top-k logits at the temperature, as multinomial sampling after HF's temperature and
    top-k warpers, done with Gumbel noise so that it runs inside a CUDA graph."""
    values, indices = (logits.float() / temperature).topk(top_k, dim=-1)
    gumbel = -torch.log(-torch.log(torch.rand_like(values).clamp_(1e-10, 1.0)))
    return indices.gather(-1, (values + gumbel).argmax(-1, keepdim=True)).squeeze(-1)


# ----------------------------------------------------------------------------------------------------------------
# The 12 Hz codec's decoder: codes -> 24 kHz audio (causal throughout, so voices of different lengths pad at the end)
# ----------------------------------------------------------------------------------------------------------------

class CodecDecoder:
    def __init__(self, path, device, dtype=torch.float32):
        cfg = json.loads((path / "config.json").read_text(encoding="utf8"))["decoder_config"]
        sd = {k[len("decoder."):]: v.to(device, dtype) for k, v in load_file(path / "model.safetensors").items()
              if k.startswith("decoder.")}
        self.sd, self.cfg, self.dtype = sd, cfg, dtype
        self.books = []
        for part, n in (("rvq_first", 1), ("rvq_rest", cfg["num_quantizers"] - 1)):
            for i in range(n):
                p = f"quantizer.{part}.vq.layers.{i}._codebook."
                self.books.append(sd[p + "embedding_sum"] / sd[p + "cluster_usage"].clamp(min=1e-5)[:, None])
        self.out_first, self.out_rest = sd["quantizer.rvq_first.output_proj.weight"], sd["quantizer.rvq_rest.output_proj.weight"]
        self.heads, self.head_dim = cfg["num_attention_heads"], cfg["head_dim"]
        self.cos, self.sin = rope_table(self.head_dim, cfg["rope_theta"], cfg["max_position_embeddings"], device)

    def _conv(self, x, prefix, dilation=1, groups=1):
        w = self.sd[prefix + ".weight"]
        x = F.pad(x, ((w.shape[-1] - 1) * dilation, 0))
        return F.conv1d(x, w, self.sd[prefix + ".bias"], dilation=dilation, groups=groups)

    def _up(self, x, prefix, stride):
        w = self.sd[prefix + ".weight"]
        y = F.conv_transpose1d(x, w, self.sd[prefix + ".bias"], stride=stride)
        trim = w.shape[-1] - stride
        return y[..., : y.shape[-1] - trim] if trim else y

    def _snake(self, x, prefix):
        alpha = self.sd[prefix + ".alpha"].exp()[None, :, None]
        beta = self.sd[prefix + ".beta"].exp()[None, :, None]
        return x + (1.0 / (beta + 1e-9)) * torch.sin(x * alpha).pow(2)

    def _transformer(self, x):
        cfg, sd = self.cfg, self.sd
        B, T, _ = x.shape
        x = x @ sd["pre_transformer.input_proj.weight"].T + sd["pre_transformer.input_proj.bias"]
        i = torch.arange(T, device=x.device)
        mask = (i[None, :] <= i[:, None]) & (i[None, :] > i[:, None] - cfg["sliding_window"])
        cos, sin = self.cos[:T], self.sin[:T]
        norm = lambda h, w: F.rms_norm(h, (h.shape[-1],), w, cfg["rms_norm_eps"])
        for n in range(cfg["num_hidden_layers"]):
            p = f"pre_transformer.layers.{n}."
            h = norm(x, sd[p + "input_layernorm.weight"])
            q, k, v = (h @ sd[p + f"self_attn.{name}_proj.weight"].T for name in "qkv")
            q, k, v = (t.view(B, T, self.heads, self.head_dim).transpose(1, 2) for t in (q, k, v))
            attn = F.scaled_dot_product_attention(rotate(q, cos, sin), rotate(k, cos, sin), v, attn_mask=mask)
            x = x + sd[p + "self_attn_layer_scale.scale"] * (attn.transpose(1, 2).reshape(B, T, -1) @ sd[p + "self_attn.o_proj.weight"].T)
            h = norm(x, sd[p + "post_attention_layernorm.weight"])
            h = (F.silu(h @ sd[p + "mlp.gate_proj.weight"].T) * (h @ sd[p + "mlp.up_proj.weight"].T)) @ sd[p + "mlp.down_proj.weight"].T
            x = x + sd[p + "mlp_layer_scale.scale"] * h
        x = norm(x, sd["pre_transformer.norm.weight"])
        return x @ sd["pre_transformer.output_proj.weight"].T + sd["pre_transformer.output_proj.bias"]

    @torch.inference_mode()
    def decode(self, codes):
        """codes [B, T, 16] (long) -> audio [B, T * 1920], clamped to [-1, 1] as the original."""
        sd = self.sd
        first = F.embedding(codes[..., 0], self.books[0]).transpose(1, 2)
        rest = sum(F.embedding(codes[..., i], self.books[i]) for i in range(1, len(self.books))).transpose(1, 2)
        x = F.conv1d(first, self.out_first) + F.conv1d(rest, self.out_rest)
        x = self._conv(x, "pre_conv.conv")
        x = self._transformer(x.transpose(1, 2)).transpose(1, 2)
        for u in range(len(self.cfg["upsampling_ratios"])):
            x = self._up(x, f"upsample.{u}.0.conv", self.cfg["upsampling_ratios"][u])
            p = f"upsample.{u}.1."
            h = self._conv(x, p + "dwconv.conv", groups=x.shape[1]).transpose(1, 2)
            h = F.layer_norm(h, (h.shape[-1],), sd[p + "norm.weight"], sd[p + "norm.bias"], 1e-6)
            h = F.gelu(h @ sd[p + "pwconv1.weight"].T + sd[p + "pwconv1.bias"]) @ sd[p + "pwconv2.weight"].T + sd[p + "pwconv2.bias"]
            x = x + (sd[p + "gamma"] * h).transpose(1, 2)
        x = self._conv(x, "decoder.0.conv")
        for b, rate in enumerate(self.cfg["upsample_rates"], start=1):
            p = f"decoder.{b}.block."
            x = self._up(self._snake(x, p + "0"), p + "1.conv", rate)
            for r, dilation in zip((2, 3, 4), (1, 3, 9)):
                h = self._conv(self._snake(x, f"{p}{r}.act1"), f"{p}{r}.conv1.conv", dilation=dilation)
                x = x + self._conv(self._snake(h, f"{p}{r}.act2"), f"{p}{r}.conv2.conv")
        last = len(self.cfg["upsample_rates"]) + 1
        x = self._conv(self._snake(x, f"decoder.{last}"), f"decoder.{last + 1}.conv")
        return x[:, 0].clamp(-1, 1)


# ----------------------------------------------------------------------------------------------------------------
# The model and the runner
# ----------------------------------------------------------------------------------------------------------------

@dataclass
class Design:
    id: str
    instruct: str            # how the voice sounds, in words
    text: str                # what it reads
    language: str = "english"
    codes: torch.Tensor | None = None   # [frames, 16], once finished
    queued_at: float = field(default_factory=time.perf_counter)
    done_at: float = 0.0
    capped: bool = False     # ended by the length cap rather than the model's own stop


class VoiceDesigner:
    def __init__(self, path=None, device="cuda", slots=16, max_frames=360, max_prompt=192,
                 buckets=(1, 2, 4, 8, 12, 16, 24, 32), graphs=True, decode_batch=4, dtype=BF16):
        t0 = time.perf_counter()
        path = Path(path or default_model_dir())
        self.cfg = cfg = json.loads((path / "config.json").read_text(encoding="utf8"))
        tc, pc = cfg["talker_config"], cfg["talker_config"]["code_predictor_config"]
        self.tc, self.device = tc, device
        sd = {k: v.to(device, dtype) for k, v in load_file(path / "model.safetensors", device="cpu").items()}
        length = max_prompt + max_frames + 1
        self.talker = Stack(sd, "talker.model", tc["num_hidden_layers"], tc["num_attention_heads"],
                            tc["num_key_value_heads"], tc["head_dim"], tc["rms_norm_eps"], tc["rope_theta"], length, device)
        self.predictor = Stack(sd, "talker.code_predictor.model", pc["num_hidden_layers"], pc["num_attention_heads"],
                               pc["num_key_value_heads"], pc["head_dim"], pc["rms_norm_eps"], pc["rope_theta"], 17, device)
        self.text_embedding = sd.pop("talker.model.text_embedding.weight")
        self.codec_embedding = sd.pop("talker.model.codec_embedding.weight")
        self.codec_head = sd.pop("talker.codec_head.weight")
        self.fc1, self.fc1_b = sd.pop("talker.text_projection.linear_fc1.weight"), sd.pop("talker.text_projection.linear_fc1.bias")
        self.fc2, self.fc2_b = sd.pop("talker.text_projection.linear_fc2.weight"), sd.pop("talker.text_projection.linear_fc2.bias")
        self.groups = pc["num_code_groups"]
        self.cp_embedding = [sd.pop(f"talker.code_predictor.model.codec_embedding.{i}.weight") for i in range(self.groups - 1)]
        self.cp_heads = [sd.pop(f"talker.code_predictor.lm_head.{i}.weight") for i in range(self.groups - 1)]
        self.mtp, self.mtp_b = sd.pop("talker.code_predictor.small_to_mtp_projection.weight"), sd.pop("talker.code_predictor.small_to_mtp_projection.bias")
        assert not sd, f"unused weights: {list(sd)[:5]}"
        self.decoder = CodecDecoder(path / "speech_tokenizer", device, torch.float32 if dtype == BF16 else dtype)
        self.tokenizer = self._tokenizer(path)

        gen = json.loads((path / "generation_config.json").read_text(encoding="utf8"))
        self.temperature, self.top_k, self.penalty = gen["temperature"], gen["top_k"], gen["repetition_penalty"]
        self.sub_temperature, self.sub_top_k = gen["subtalker_temperature"], gen["subtalker_top_k"]
        self.eos = tc["codec_eos_token_id"]
        vocab = tc["vocab_size"]
        # The original suppresses the top 1,024 codec ids (control tokens) except the stop, and the stop itself until
        # two frames exist.
        self.suppress = torch.zeros(vocab, device=device)
        self.suppress[vocab - 1024:] = -math.inf
        self.suppress[self.eos] = 0.0
        self.no_stop = torch.zeros(vocab, device=device)
        self.no_stop[self.eos] = -math.inf
        with torch.inference_mode():
            bos, eos, pad = self._project(self.text_embedding[[cfg["tts_bos_token_id"], cfg["tts_eos_token_id"], cfg["tts_pad_token_id"]]])
            self.tts_bos, self.tts_eos, self.tts_pad = bos, eos, pad

        # Slot state, all on the GPU. h: the talker's last (normed) hidden state; code0: the frame's first codebook,
        # sampled from it; n: frames written; pos: the talker's next position.
        S, H = slots, tc["hidden_size"]
        self.slots, self.max_frames, self.max_prompt, self.decode_batch = slots, max_frames, max_prompt, decode_batch
        kv = lambda: [torch.zeros(S, tc["num_key_value_heads"], length, tc["head_dim"], dtype=dtype, device=device)
                      for _ in range(tc["num_hidden_layers"])]
        self.cache_k, self.cache_v = kv(), kv()
        self.h = torch.zeros(S, 1, H, dtype=dtype, device=device)
        self.code0 = torch.zeros(S, dtype=torch.long, device=device)
        self.n = torch.zeros(S, dtype=torch.long, device=device)
        self.pos = torch.zeros(S, dtype=torch.long, device=device)
        self.seen = torch.zeros(S, vocab, dtype=torch.bool, device=device)
        self.frames = torch.zeros(S, max_frames, self.groups, dtype=torch.long, device=device)
        self.stopped = torch.zeros(S, dtype=torch.bool, device=device)
        self.positions = torch.arange(length, device=device)
        self.busy: list[Design] = []
        self.buckets = sorted(b for b in buckets if b <= slots) or [slots]
        if self.buckets[-1] != slots:
            self.buckets.append(slots)
        self.load_seconds = time.perf_counter() - t0
        t0 = time.perf_counter()
        self.graphs = self._capture() if graphs else {}
        self.capture_seconds = time.perf_counter() - t0

    @staticmethod
    def _tokenizer(path):
        """Qwen2's byte-level BPE from the model's vocab.json and merges.txt, with its added tokens at their ids."""
        tok = Tokenizer(models.BPE.from_file(str(path / "vocab.json"), str(path / "merges.txt")))
        tok.normalizer = normalizers.NFC()
        tok.pre_tokenizer = pre_tokenizers.Sequence([
            pre_tokenizers.Split(Regex(QWEN_SPLIT), behavior="isolated"),
            pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)])
        tok.decoder = decoders.ByteLevel()
        added = json.loads((path / "tokenizer_config.json").read_text(encoding="utf8"))["added_tokens_decoder"]
        for i in sorted(added, key=int):
            tok.add_special_tokens([AddedToken(added[i]["content"], special=True, normalized=False)])
            assert tok.token_to_id(added[i]["content"]) == int(i), added[i]
        return tok

    def tokenize(self, text):
        return self.tokenizer.encode(text, add_special_tokens=False).ids

    def _project(self, x):
        return F.silu(x @ self.fc1.T + self.fc1_b) @ self.fc2.T + self.fc2_b

    def prompt(self, d: Design):
        """The talker's input for one voice, as the original builds it for voice design in non-streaming mode: the
        description as a user turn, then the assistant turn with the codec's think/language tags under padding, the
        whole text to read with the codec's padding under it, and the codec's start."""
        tc = self.tc
        instruct = self.tokenize(f"<|im_start|>user\n{d.instruct}<|im_end|>\n")
        text = self.tokenize(f"<|im_start|>assistant\n{d.text}<|im_end|>\n<|im_start|>assistant\n")
        ids = lambda xs: torch.tensor(xs, device=self.device)
        codec = self.codec_embedding[ids([tc["codec_think_id"], tc["codec_think_bos_id"], tc["codec_language_id"][d.language],
                                          tc["codec_think_eos_id"], tc["codec_pad_id"], tc["codec_bos_id"]])]
        body = self._project(self.text_embedding[ids(text[3:-5])])
        parts = [
            self._project(self.text_embedding[ids(instruct)]),
            self._project(self.text_embedding[ids(text[:3])]),
            torch.cat([self.tts_pad.expand(4, -1), self.tts_bos[None]]) + codec[:5],
            torch.cat([body, self.tts_eos[None]]) + self.codec_embedding[tc["codec_pad_id"]],
            (self.tts_pad + codec[5])[None],
        ]
        return torch.cat(parts)[None], (instruct, text)

    def _first_code(self, logits, seen, n):
        """The original's logits processors for the frame's first codebook, then its sampling."""
        logits = logits.float()
        penalized = torch.where(logits < 0, logits * self.penalty, logits / self.penalty)
        logits = torch.where(seen, penalized, logits) + self.suppress + torch.where(n[:, None] < 2, self.no_stop, 0.0)
        return sample(logits, self.temperature, self.top_k)

    def _predict(self, h, code0, forced=None, logits_out=None):
        """The code predictor: from the talker's hidden state and the first codebook, the other 15 codebooks of the
        frame, each from its own head, over a fresh 17-position sequence (positions are the same for every slot).
        `forced` ([B, 16]) feeds given codes instead of sampled ones and `logits_out` collects each head's logits, for
        the reference test."""
        P = self.predictor
        mtp = lambda x: x @ self.mtp.T + self.mtp_b
        x = mtp(torch.cat([h, self.codec_embedding[code0][:, None]], dim=1))   # [B, 2, 1024]
        keys, values = [None] * P.n, [None] * P.n
        codes = [code0]
        for g in range(self.groups - 1):
            T0 = 0 if g == 0 else g + 1
            positions = self.positions[T0: T0 + x.shape[1]]
            for i, layer in enumerate(P.layers):
                q, k, v = P._qkv(x, layer, positions)
                keys[i] = k if g == 0 else torch.cat([keys[i], k], dim=2)
                values[i] = v if g == 0 else torch.cat([values[i], v], dim=2)
                attn = F.scaled_dot_product_attention(q, keys[i], values[i], is_causal=g == 0, enable_gqa=True)
                x = P._finish(x, attn, layer)
            logits = P._norm(x[:, -1], P.norm) @ self.cp_heads[g].T
            code = sample(logits, self.sub_temperature, self.sub_top_k) if forced is None else forced[:, g + 1]
            if logits_out is not None:
                logits_out.append(logits)
            codes.append(code)
            x = mtp(self.cp_embedding[g][code])[:, None]
        return torch.stack(codes, dim=1)   # [B, 16]

    def _step(self, b):
        """One frame for the first b slots: finish this frame's codes, feed the frame to the talker, sample the next
        frame's first codebook. Updates the slot state in place (so that it can run as a CUDA graph)."""
        rows = torch.arange(b, device=self.device)
        codes = self._predict(self.h[:b], self.code0[:b])
        self.frames[rows, self.n[:b].clamp(max=self.max_frames - 1)] = codes
        x = self.codec_embedding[codes[:, 0]] + sum(self.cp_embedding[g][codes[:, g + 1]] for g in range(self.groups - 1))
        x = (x + self.tts_pad)[:, None]
        pos = self.pos[:b]
        mask = (self.positions[None, None, None, :] <= pos[:, None, None, None])
        h = self.talker.step(x, pos, self.cache_k, self.cache_v, mask)
        n = self.n[:b] + 1
        code0 = self._first_code(h[:, 0] @ self.codec_head.T, self.seen[:b], n)
        self.seen[rows, code0] = True
        self.h[:b] = h
        self.code0[:b] = code0
        self.n[:b] = n
        self.pos[:b] = pos + 1
        self.stopped[:b] = (code0 == self.eos) | (n >= self.max_frames)

    def _capture(self):
        graphs = {}
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.inference_mode(), torch.cuda.stream(stream):
            for b in self.buckets:
                self._step(b)   # warm-up, on the side stream as graph capture wants
        torch.cuda.current_stream().wait_stream(stream)
        pool = None
        with torch.inference_mode():
            for b in reversed(self.buckets):
                g = torch.cuda.CUDAGraph()
                with torch.cuda.graph(g, pool=pool):
                    self._step(b)
                pool = g.pool()
                graphs[b] = g
        self._reset()
        return graphs

    def _reset(self):
        for t in (self.n, self.pos, self.code0, self.seen, self.stopped):
            t.zero_()

    def _admit(self, d: Design, i):
        embeds, _ = self.prompt(d)
        T = embeds.shape[1]
        assert T <= self.max_prompt, f"prompt of {T} tokens is longer than {self.max_prompt}"
        h = self.talker.prefill(embeds, (self.cache_k, self.cache_v), i)[:, -1:]
        self.seen[i] = False
        self.n[i] = 0
        code0 = self._first_code(h[:, 0] @ self.codec_head.T, self.seen[i:i + 1], self.n[i:i + 1])
        self.seen[i, code0] = True
        self.h[i], self.code0[i], self.pos[i] = h[0], code0[0], T

    def _move(self, src, dst):
        """Slot src's whole state into slot dst, so that the busy slots stay the first ones."""
        for cache in (self.cache_k, self.cache_v):
            for layer in cache:
                layer[dst] = layer[src]
        for t in (self.h, self.code0, self.n, self.pos, self.seen, self.frames, self.stopped):
            t[dst] = t[src]

    @torch.inference_mode()
    def run(self, designs):
        """Designs every voice, as many at once as there are slots; returns them with their codes."""
        waiting, done = list(designs), []
        while waiting or self.busy:
            while waiting and len(self.busy) < self.slots:
                d = waiting.pop(0)
                self._admit(d, len(self.busy))
                self.busy.append(d)
            b = len(self.busy)
            bucket = next(x for x in self.buckets if x >= b)
            if bucket in self.graphs:
                self.graphs[bucket].replay()
            else:
                self._step(bucket)
            stopped = self.stopped[:b].tolist()
            if not any(stopped):
                continue
            n = self.n[:b].tolist()
            for i in reversed(range(b)):
                if not stopped[i]:
                    continue
                d = self.busy[i]
                d.capped = n[i] >= self.max_frames and self.code0[i].item() != self.eos
                d.codes = self.frames[i, : n[i]].clone()
                d.done_at = time.perf_counter()
                done.append(d)
                last = len(self.busy) - 1
                if i != last:
                    self._move(last, i)
                    self.busy[i] = self.busy[last]
                self.busy.pop()
                self.stopped[last] = False
        return done

    @torch.inference_mode()
    def decode(self, designs):
        """Each design's codes into 24 kHz audio, decode_batch voices at a time (padded at the end)."""
        out = {}
        for k in range(0, len(designs), self.decode_batch):
            part = designs[k: k + self.decode_batch]
            T = max(len(d.codes) for d in part)
            codes = torch.stack([F.pad(d.codes, (0, 0, 0, T - len(d.codes))) for d in part])
            audio = self.decoder.decode(codes)
            for d, a in zip(part, audio):
                out[d.id] = a[: len(d.codes) * FRAME_SAMPLES].float().cpu().numpy()
        return out

    def design(self, designs):
        return self.decode(self.run(designs))

    def close(self):
        """Drops the weights, the cache and the graphs, and gives the memory back to the GPU."""
        self.graphs.clear()
        for name in list(vars(self)):
            delattr(self, name)
        import gc

        gc.collect()
        torch.cuda.empty_cache()
