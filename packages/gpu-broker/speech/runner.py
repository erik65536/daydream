"""A lean inference runner for VoxCPM2 (OpenBMB, Apache 2.0), the model that speaks Daydream's NPC lines on the GPU.

It speaks many lines at once through one copy of the model, in plain PyTorch:
- a fixed number of slots, each holding one line, with a static key/value cache sized for the longest line allowed;
- one CUDA graph per batch size (1, 2, 4, 8, 12 and 16 by default) that makes one audio token, 160 ms of speech,
  for every slot at once: the local diffusion with guidance, the stop head, the AudioVAE decoding the new chunk, the
  feature encoder and both language models;
- a prefill for each new line, written straight into its slot: the voice's prefix (reference clip and transcript)
  is computed once per voice and copied in, and only the rest of the prompt runs, through one graph per length;
- streaming: each step hands every line its next 160 ms of 48 kHz audio.

It clones a voice as Daydream does: the character's reference clip is both the reference (VoxCPM2's isolated
timbre prefix) and the prompt that the line continues, with the clip's transcript before the line's text. The maths
follows VoxCPM2's own code (voxcpm 2.0.3).

    model = VoxCPM2(MODEL_DIR)
    runner = Runner(model)
    voice = model.voice(clip_16k, REF_TEXT)
    runner.add(Line("hello", "Good morning.", voice, on_audio=lambda line, chunk: ...))
    runner.run()                     # until every line is spoken; or call runner.step() from a request loop
"""

import json
import math
import re
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import torch
import torch.nn.functional as F
from safetensors.torch import load_file
from torch.nn.attention import SDPBackend, sdpa_kernel
from tokenizers import Tokenizer

BF16 = torch.bfloat16
FP8, FP8_MAX = torch.float8_e4m3fn, 448.0
FP8_CALIBRATION = Path(__file__).with_name("fp8-amax.json")
# The language models' attention over the cache, with each slot's length as a mask: cuDNN's kernel is a little faster
# here than the memory-efficient one PyTorch picks (the unmasked attention keeps PyTorch's choice, flash).
MASKED_ATTENTION = [SDPBackend.CUDNN_ATTENTION, SDPBackend.EFFICIENT_ATTENTION]
AUDIO_START, REF_START, REF_END = 101, 103, 104


# ----------------------------------------------------------------------------------------------------------------
# Transformer pieces (MiniCPM-4 layers, as every part of VoxCPM2 uses them)
# ----------------------------------------------------------------------------------------------------------------

# EXACT_NORM rounds as VoxCPM2 does (several kernels instead of one), for checking that the fused norm changes nothing
# audible.
EXACT_NORM = False


def rms_norm(x, weight, eps):
    # One fused kernel. VoxCPM2 rounds to bfloat16 before scaling by the weight, this after; the difference is a
    # rounding step (0.3% relative in bfloat16, none in float32).
    if EXACT_NORM:
        variance = x.float().pow(2).mean(-1, keepdim=True)
        return (x * torch.rsqrt(variance + eps)).to(x.dtype) * weight
    return F.rms_norm(x, (x.shape[-1],), weight, eps)


def rope_table(head_dim, base, length, factors, device):
    """MiniCPM's LongRoPE at its short factors (VoxCPM2 never goes past the original length, so the scale is 1), as
    one unit complex number per position and frequency."""
    inv_freq = 1.0 / (base ** (torch.arange(0, head_dim, 2, device=device).float() / head_dim))
    t = torch.arange(length, device=device, dtype=torch.float32)
    freqs = torch.outer(t, 1.0 / torch.tensor(factors, dtype=torch.float32, device=device)) * inv_freq
    return torch.polar(torch.ones_like(freqs), freqs)


def rotate(x, table):
    """The rotary embedding as one complex multiply in float32. MiniCPM rotates dimension i with i + d/2; the
    weights' rows are reordered at load (pair_rows) so that those two sit side by side as one complex number. Queries
    and keys get the same order, so their dot products, and so the attention, are unchanged."""
    xc = torch.view_as_complex(x.float().view(*x.shape[:-1], -1, 2))
    return torch.view_as_real(xc * table).flatten(-2).to(x.dtype)


def pair_rows(w, heads, head_dim):
    """Reorders each head's rows of a query or key projection as 0, d/2, 1, d/2 + 1, ..."""
    half = torch.arange(head_dim // 2, device=w.device)
    order = torch.stack([half, half + head_dim // 2], dim=-1).flatten()
    return w.view(heads, head_dim, -1)[:, order].reshape(w.shape)


class Stack:
    """A stack of MiniCPM decoder layers with the q/k/v and gate/up projections each merged into one matrix.

    Its four matrices per layer can run in FP8 (to_fp8): weights with one scale per matrix, and activations cast
    with fixed scales calibrated beforehand (calibrate). Each activation scale is folded into the weight before it
    (the norm weights for the q/k/v and gate/up inputs, the value rows for the attention output, the up rows for the
    down projection's input), so each conversion is a single saturating cast."""

    NAMES = ("qkv", "o", "gate_up", "down")

    def __init__(self, sd, prefix, layers, heads, kv_heads, head_dim, eps, rope=None):
        self.heads, self.kv_heads, self.head_dim, self.eps, self.rope = heads, kv_heads, head_dim, eps, rope
        self.q_size, self.kv_size = heads * head_dim, kv_heads * head_dim
        self.fp8, self.amax = False, None
        self.layers = []
        for i in range(layers):
            p = f"{prefix}.layers.{i}."
            a, m = p + "self_attn.", p + "mlp."
            q, k = sd.pop(a + "q_proj.weight"), sd.pop(a + "k_proj.weight")
            if rope is not None:
                q, k = pair_rows(q, heads, head_dim), pair_rows(k, kv_heads, head_dim)
            self.layers.append(dict(
                i=i, ln1=sd.pop(p + "input_layernorm.weight"), ln2=sd.pop(p + "post_attention_layernorm.weight"),
                qkv=torch.cat([q, k, sd.pop(a + "v_proj.weight")]), o=sd.pop(a + "o_proj.weight"),
                gate_up=torch.cat([sd.pop(m + "gate_proj.weight"), sd.pop(m + "up_proj.weight")]),
                down=sd.pop(m + "down_proj.weight")))
        self.norm = sd.pop(f"{prefix}.norm.weight")
        self.ffn = self.layers[0]["down"].shape[1]

    # -- FP8 -----------------------------------------------------------------------------------------------------

    def calibrate(self):
        """From now on, record the largest magnitude entering each matrix (on the GPU, without syncing)."""
        dev = self.norm.device
        self.amax = [{n: torch.zeros((), device=dev) for n in self.NAMES} for _ in self.layers]

    def to_fp8(self, amax, margin=2.0):
        """amax: per layer, the calibrated largest input of each matrix. Inputs up to margin times that keep their
        precision; larger ones saturate at FP8's largest value rather than overflow."""
        def quantize(w):
            scale = w.float().abs().max() / FP8_MAX
            return (w.float() / scale).to(FP8), scale

        for layer, peaks in zip(self.layers, amax):
            c = {n: FP8_MAX / (margin * max(float(peaks[n]), 1e-6)) for n in self.NAMES}
            layer["ln1"] = (layer["ln1"].float() * c["qkv"]).to(layer["ln1"].dtype)
            layer["ln2"] = (layer["ln2"].float() * c["gate_up"]).to(layer["ln2"].dtype)
            qkv = layer["qkv"].float()
            qkv[self.q_size + self.kv_size:] *= c["o"]      # values, so the attention output arrives scaled
            gate_up = layer["gate_up"].float()
            gate_up[self.ffn:] *= c["down"]                 # up rows, so silu(gate) * up arrives scaled
            for name, w in (("qkv", qkv), ("o", layer["o"]), ("gate_up", gate_up), ("down", layer["down"])):
                w8, scale = quantize(w)
                layer[name] = (w8, torch.tensor(1 / c[name], device=w8.device), scale)
        self.fp8 = True

    def _linear(self, layer, name, x):
        if self.fp8:
            w8, scale_a, scale_b = layer[name]
            out = torch._scaled_mm(x.reshape(-1, x.shape[-1]).to(FP8), w8.T, scale_a=scale_a, scale_b=scale_b,
                                   out_dtype=x.dtype)
            return out.view(*x.shape[:-1], -1)
        if self.amax is not None:
            peak = self.amax[layer["i"]]
            torch.maximum(peak[name], x.detach().abs().amax().float(), out=peak[name])
        return F.linear(x, layer[name])

    # -- the layers ----------------------------------------------------------------------------------------------

    def _mlp(self, x, layer):
        g, u = self._linear(layer, "gate_up", rms_norm(x, layer["ln2"], self.eps)).split(self.ffn, dim=-1)
        return x + self._linear(layer, "down", F.silu(g) * u)

    def _qkv(self, x, layer, table):
        """Projects to queries, keys and values, (..., heads, d) each, with the queries and keys rotated together."""
        qkv = self._linear(layer, "qkv", rms_norm(x, layer["ln1"], self.eps))
        qk, v = qkv.split([self.q_size + self.kv_size, self.kv_size], dim=-1)
        qk = qk.unflatten(-1, (self.heads + self.kv_heads, self.head_dim))
        if table is not None:
            qk = rotate(qk, table)
        q, k = qk.split([self.heads, self.kv_heads], dim=-2)
        return q, k, v.unflatten(-1, (self.kv_heads, self.head_dim))

    def forward(self, x, causal, kv_out=None):
        """x: (N, T, hidden), every position at once. With kv_out, layer i's keys and values (N, kv_heads, T, d) are
        handed to kv_out(i, k, v) (the prefill writes them into its slot of the cache)."""
        n, t, _ = x.shape
        table = None if self.rope is None else self.rope[:t, None]
        for i, layer in enumerate(self.layers):
            q, k, v = (y.transpose(1, 2) for y in self._qkv(x, layer, table))
            if kv_out is not None:
                kv_out(i, k, v)
            o = F.scaled_dot_product_attention(q, k, v, is_causal=causal, enable_gqa=True)
            x = x + self._linear(layer, "o", o.transpose(1, 2).reshape(n, t, self.q_size))
            x = self._mlp(x, layer)
        return rms_norm(x, self.norm, self.eps)

    def step(self, x, pos, cache_k, cache_v, mask):
        """One new position for each of B slots. x: (B, hidden); pos: (B,) positions; cache_k/v: (layers, B,
        kv_heads, L, d) views of the slots' caches; mask: (B, 1, 1, L), true up to and including each slot's position.
        The query heads of one key/value head attend as a group (as several "positions" against that head), so
        grouped-query attention needs no copies of the cache and no special kernel."""
        b = x.shape[0]
        rows = torch.arange(b, device=x.device)
        group = self.heads // self.kv_heads
        table = None if self.rope is None else self.rope[pos][:, None]
        for i, layer in enumerate(self.layers):
            q, k, v = self._qkv(x, layer, table)
            cache_k[i][rows, :, pos] = k
            cache_v[i][rows, :, pos] = v
            with sdpa_kernel(MASKED_ATTENTION, set_priority=True):
                o = F.scaled_dot_product_attention(q.reshape(b, self.kv_heads, group, self.head_dim), cache_k[i],
                                                   cache_v[i], attn_mask=mask)
            x = x + self._linear(layer, "o", o.reshape(b, self.q_size))
            x = self._mlp(x, layer)
        return rms_norm(x, self.norm, self.eps)

    def extend(self, x, pos, cache_k, cache_v, slot, allowed):
        """T new positions of one line, after a prefix already in its slot of the cache. x: (1, T, hidden); pos: (T,)
        their positions; cache_k/v: (layers, S, kv_heads, L, d); slot: (1,) the line's slot; allowed: (T, W), which
        of the cache's first W positions each new position sees. Grouped as in step()."""
        t, w = x.shape[1], allowed.shape[1]
        group = self.heads // self.kv_heads
        mask = allowed.expand(group, t, w).reshape(1, 1, group * t, w)
        table = None if self.rope is None else self.rope[pos][:, None]
        x = x[0]
        for i, layer in enumerate(self.layers):
            q, k, v = self._qkv(x, layer, table)
            cache_k[i][slot, :, pos] = k
            cache_v[i][slot, :, pos] = v
            q = q.view(t, self.kv_heads, group, self.head_dim).permute(1, 2, 0, 3).reshape(1, self.kv_heads, -1,
                                                                                            self.head_dim)
            with sdpa_kernel(MASKED_ATTENTION, set_priority=True):
                o = F.scaled_dot_product_attention(q, cache_k[i][slot, :, :w], cache_v[i][slot, :, :w],
                                                   attn_mask=mask)
            o = o.view(self.kv_heads, group, t, self.head_dim).permute(2, 0, 1, 3).reshape(t, self.q_size)
            x = x + self._linear(layer, "o", o)
            x = self._mlp(x, layer)
        return rms_norm(x, self.norm, self.eps)[None]


# ----------------------------------------------------------------------------------------------------------------
# AudioVAE (its decoder runs one patch at a time, carrying each causal convolution's left context per slot)
# ----------------------------------------------------------------------------------------------------------------

def snake(x, alpha):
    return x + (alpha + 1e-9).reciprocal() * torch.sin(alpha * x).pow(2)


class AudioVAE:
    """VoxCPM2's AudioVAE (V2) with its weight norm folded in. Float32, like VoxCPM2's own code."""

    def __init__(self, path, cfg, device):
        sd = torch.load(path, map_location=device, weights_only=True)["state_dict"]
        self.sd = sd
        self.sample_rate, self.out_sample_rate = cfg["sample_rate"], cfg["out_sample_rate"]
        self.hop = math.prod(cfg["encoder_rates"])
        self.decode_hop = math.prod(cfg["decoder_rates"])
        self.latent_dim = cfg["latent_dim"]
        # Encoder: a plain causal convolution stack (it runs once per voice).
        self.enc = [self._conv("encoder.block.0", 1, left=6)]
        dim = cfg["encoder_dim"]
        for i, s in enumerate(cfg["encoder_rates"]):
            p = f"encoder.block.{i + 1}.block."
            self.enc += [("res", self._res_unit(f"{p}{j}", dim, d)) for j, d in enumerate((1, 3, 9))]
            self.enc += [("snake", sd[f"{p}3.alpha"]), self._conv(f"{p}4", dim, left=2 * math.ceil(s / 2) - s % 2,
                                                                  stride=s)]
            dim *= 2
        self.enc.append(self._conv("encoder.fc_mu", dim, left=2))
        # Decoder, at the 48 kHz output rate (VoxCPM2's sample-rate condition is a fixed scale and bias per block).
        bucket = int(torch.bucketize(torch.tensor(self.out_sample_rate),
                                     torch.tensor(cfg["sr_bin_boundaries"])).item())
        dim = cfg["decoder_dim"]
        self.dec = [self._conv("decoder.model.0", self.latent_dim, left=6), self._conv("decoder.model.1",
                                                                                         self.latent_dim)]
        for i, s in enumerate(cfg["decoder_rates"]):
            c = f"decoder.sr_cond_model.{i + 2}."
            p = f"decoder.model.{i + 2}.block."
            self.dec.append(("scale_bias", sd[c + "scale_embed.weight"][bucket][None, :, None],
                             sd[c + "bias_embed.weight"][bucket][None, :, None]))
            self.dec += [("snake", sd[f"{p}0.alpha"]), ("convT", *self._weight(f"{p}1"), s,
                                                        2 * math.ceil(s / 2) - s % 2)]
            dim //= 2
            self.dec += [("res", self._res_unit(f"{p}{j + 2}", dim, d)) for j, d in enumerate((1, 3, 9))]
        n = len(cfg["decoder_rates"]) + 2
        self.dec += [("snake", sd[f"decoder.model.{n}.alpha"]), self._conv(f"decoder.model.{n + 1}", dim, left=6),
                     ("tanh",)]
        del self.sd
        self.decoder_dtype = torch.float32

    def _weight(self, prefix):
        g, v = self.sd[prefix + ".weight_g"], self.sd[prefix + ".weight_v"]
        return g * v / v.norm(dim=(1, 2), keepdim=True), self.sd[prefix + ".bias"]

    def _conv(self, prefix, channels_in, left=0, stride=1, dilation=1):
        w, b = self._weight(prefix)
        return ("conv", w, b, left, stride, dilation, channels_in // w.shape[1])

    def _res_unit(self, prefix, dim, dilation):
        p = prefix + ".block."
        return [("snake", self.sd[p + "0.alpha"]), self._conv(p + "1", dim, left=6 * dilation, dilation=dilation),
                ("snake", self.sd[p + "2.alpha"]), self._conv(p + "3", dim)]

    @staticmethod
    def _run(ops, x, states=None, it=None):
        """Runs the ops. With states (a list, one tensor per op that needs left context, in op order), each
        convolution takes its left context from its state and leaves its own last inputs there; without, the
        context is silence, as for the start of a stream."""
        it = iter(states) if states is not None and it is None else it
        for op in ops:
            kind = op[0]
            if kind == "conv":
                _, w, b, left, stride, dilation, groups = op
                if left:
                    if it is None:
                        x = F.pad(x, (left, 0))
                    else:
                        state = next(it)
                        x = torch.cat([state, x], dim=-1)
                        state.copy_(x[..., -left:])
                x = F.conv1d(x, w, b, stride=stride, dilation=dilation, groups=groups)
            elif kind == "convT":
                _, w, b, stride, trim = op
                if it is None:
                    x = F.conv_transpose1d(x, w, b, stride=stride)[..., :-trim]
                else:
                    state = next(it)
                    full = torch.cat([state, x], dim=-1)
                    state.copy_(x[..., -1:])
                    x = F.conv_transpose1d(full, w, b, stride=stride)[..., stride:-trim]
            elif kind == "res":
                x = x + AudioVAE._run(op[1], x, states, it)
            elif kind == "snake":
                x = snake(x, op[1])
            elif kind == "scale_bias":
                x = x * op[1] + op[2]
            else:
                x = torch.tanh(x)
        return x

    def state_shapes(self):
        """The left-context shape (channels, frames) of every decoder op that carries state, in op order."""
        shapes = []

        def walk(ops, channels):
            for op in ops:
                if op[0] == "conv":
                    if op[3]:
                        shapes.append((channels, op[3]))
                    channels = op[1].shape[0]
                elif op[0] == "convT":
                    shapes.append((channels, 1))
                    channels = op[1].shape[1]
                elif op[0] == "res":
                    walk(op[1], channels)
            return channels

        walk(self.dec, self.latent_dim)
        return shapes

    def encode(self, audio):
        """audio: (1, samples) at 16 kHz, a multiple of the hop. Returns latents (1, 64, frames)."""
        return self._run(self.enc, audio[:, None])

    def decode_stream(self, z, states):
        """z: (B, 64, frames); states: the per-slot left contexts, each (B, channels, frames), in decoder_dtype.
        Returns float32 audio."""
        return self._run(self.dec, z.to(self.decoder_dtype), states)[:, 0].float()

    def set_decoder_dtype(self, dtype):
        """Runs the decoder in another precision (Nano-vLLM-VoxCPM runs it in float16)."""
        def cast(ops):
            return [tuple(cast(x) if isinstance(x, list) else x.to(dtype) if torch.is_tensor(x) else x for x in op)
                    for op in ops]

        self.dec = cast(self.dec)
        self.decoder_dtype = dtype


# ----------------------------------------------------------------------------------------------------------------
# The model
# ----------------------------------------------------------------------------------------------------------------

@dataclass
class Voice:
    """A character's voice: their reference clip's latents, encoded as VoxCPM2 does for each role, and those latents
    through the feature encoder (the same for every line, so the prefill need not run the encoder at all).

    Every line's prompt starts the same way for one voice: the reference clip, then the clip's transcript. Both
    language models are causal, so that prefix's keys and values never depend on the line; they are computed once
    here, and a line's prefill copies them into its slot and runs only the rest."""
    ref: torch.Tensor           # (frames, 4, 64), padded on the right: the isolated reference prefix
    prompt: torch.Tensor        # (frames, 4, 64), padded on the left: the audio the line continues
    text: str                   # what the clip says
    ref_embed: torch.Tensor     # (frames, hidden): ref through the feature encoder
    prompt_embed: torch.Tensor  # (frames, hidden): prompt through the feature encoder
    tokens: list                # text's tokens
    prefix: tuple               # the prefix's keys and values: base k, base v, residual k, residual v, each
                                # (layers, kv_heads, positions, d)


class VoxCPM2:
    def __init__(self, path, device="cuda", max_positions=1024, timesteps=8, cfg_value=2.0, dtype=BF16,
                 fp8=FP8_CALIBRATION, vae_dtype=torch.float16):
        """vae_dtype: the AudioVAE decoder's precision; float16 is 55 dB or more below float32's audio, and 40% faster.
        fp8: a calibration file (from calibrate(); see bench.py calibrate) to run the four transformers' matrices
        in FP8, or None for bfloat16 throughout. timesteps: the diffusion's Euler steps; VoxCPM2's own default is 10.
        FP8 with 8 steps is the default because listening found no difference from bfloat16 with 10, and it is the
        fastest setting measured."""
        path = Path(path)
        self.dtype = dtype
        t0 = time.perf_counter()
        self.device = device
        cfg = json.loads((path / "config.json").read_text(encoding="utf8"))
        lm, enc, dit = cfg["lm_config"], cfg["encoder_config"], cfg["dit_config"]
        assert cfg["architecture"] == "voxcpm2" and not lm["use_mup"]
        self.patch, self.feat_dim = cfg["patch_size"], cfg["feat_dim"]
        self.max_positions, self.timesteps, self.cfg_value = max_positions, timesteps, cfg_value
        eps = lm["rms_norm_eps"]
        sd = load_file(str(path / "model.safetensors"), device=device)  # straight to the GPU
        if dtype != BF16:
            sd = {k: v.to(dtype) for k, v in sd.items()}
        factors = lm["rope_scaling"]["short_factor"]
        assert lm["max_position_embeddings"] == lm["rope_scaling"]["original_max_position_embeddings"]
        head = lm["kv_channels"]
        lm_rope = rope_table(head, lm["rope_theta"], max_positions, factors, device)
        small_rope = rope_table(head, lm["rope_theta"], 16, factors, device)
        kv = lm["num_key_value_heads"]
        self.base = Stack(sd, "base_lm", lm["num_hidden_layers"], lm["num_attention_heads"], kv, head, eps, lm_rope)
        self.residual = Stack(sd, "residual_lm", cfg["residual_lm_num_layers"], lm["num_attention_heads"], kv, head,
                              eps, None if cfg["residual_lm_no_rope"] else lm_rope)
        self.encoder = Stack(sd, "feat_encoder.encoder", enc["num_layers"], enc["num_heads"], kv, enc["kv_channels"],
                             eps, small_rope)
        self.dit = Stack(sd, "feat_decoder.estimator.decoder", dit["num_layers"], dit["num_heads"], kv,
                         dit["kv_channels"], eps, small_rope)
        self.embed = sd.pop("base_lm.embed_tokens.weight")
        self.w = {k: sd.pop(k) for k in list(sd) if not k.startswith("feat_decoder.estimator.time")
                  and not k.startswith("feat_decoder.estimator.delta")}
        self.hidden, self.dit_hidden = lm["hidden_size"], dit["hidden_dim"]
        self.fsq_scale = cfg["scalar_quantization_scale"]
        self._diffusion_schedule(sd, timesteps)
        del sd
        self.vae = AudioVAE(path / "audiovae.pth", cfg["audio_vae_config"], device)
        if vae_dtype != torch.float32:
            self.vae.set_decoder_dtype(vae_dtype)
        self.chunk_samples = self.patch * self.vae.decode_hop
        self.sample_rate = self.vae.out_sample_rate
        self.tokenizer = Tokenizer.from_file(str(path / "tokenizer.json"))
        vocab = self.tokenizer.get_vocab()
        # VoxCPM2 splits multi-character Chinese tokens into single characters.
        self.multichar = {t for t in vocab if len(t) >= 2 and all("\u4e00" <= c <= "\u9fff" for c in t)}
        if fp8 is not None:
            amax = json.loads(Path(fp8).read_text(encoding="utf8"))
            for name, stack in self.stacks().items():
                stack.to_fp8(amax[name])
        torch.cuda.synchronize()
        self.load_seconds = time.perf_counter() - t0

    def stacks(self):
        return {"base": self.base, "residual": self.residual, "encoder": self.encoder, "dit": self.dit}

    def calibrate(self):
        """Starts recording each FP8 candidate matrix's largest input; calibration() returns them."""
        for stack in self.stacks().values():
            stack.calibrate()

    def calibration(self):
        return {name: [{k: float(v) for k, v in layer.items()} for layer in stack.amax]
                for name, stack in self.stacks().items()}

    def _diffusion_schedule(self, sd, n):
        """The Euler steps' times, and each step's timestep embedding, which depends on nothing but the step."""
        dev = self.device
        t_span = torch.linspace(1, 0, n + 1, device=dev, dtype=self.dtype)
        t_span = t_span + 1.0 * (torch.cos(torch.pi / 2 * t_span) - 1 + t_span)
        t, dt = t_span[0], t_span[0] - t_span[1]
        steps = []
        for step in range(1, n + 1):
            steps.append((t.clone(), dt.clone()))
            t = t - dt
            if step < n:
                dt = t - t_span[step + 1]
        # VoxCPM2's "zero init": the first max(1, int(0.04 * (n + 1))) steps leave x as it is.
        self.zero_init = max(1, int((n + 1) * 0.04))

        def mlp(p, x):
            x = F.linear(x, sd[p + "linear_1.weight"], sd[p + "linear_1.bias"])
            return F.linear(F.silu(x), sd[p + "linear_2.weight"], sd[p + "linear_2.bias"])

        def sinusoid(x, dim=self.dit_hidden, scale=1000):
            # In bfloat16 throughout, exactly as VoxCPM2 computes it.
            half = dim // 2
            e = math.log(10000) / (half - 1)
            e = torch.exp(torch.arange(half, dtype=x.dtype, device=dev) * -e)
            e = scale * x.unsqueeze(1) * e.unsqueeze(0)
            return torch.cat((e.sin(), e.cos()), dim=-1)

        p = "feat_decoder.estimator."
        delta = mlp(p + "delta_time_mlp.", sinusoid(torch.zeros(1, device=dev, dtype=self.dtype)))
        self.euler = [(dt, mlp(p + "time_mlp.", sinusoid(t[None])) + delta) for t, dt in steps]

    # -- text and voices ---------------------------------------------------------------------------------------

    def tokenize(self, text):
        out = []
        for token in self.tokenizer.encode(text, add_special_tokens=False).tokens:
            clean = token.replace("▁", "")
            out += [self.tokenizer.token_to_id(c) for c in clean] if clean in self.multichar else \
                [self.tokenizer.token_to_id(token)]
        return out

    @torch.inference_mode()
    def voice(self, clip_16k, text):
        """clip_16k: float32 samples at 16 kHz. Encodes the clip twice, padded on the right for the reference and
        on the left for the prompt, as VoxCPM2 does."""
        audio = torch.as_tensor(clip_16k, dtype=torch.float32, device=self.device)[None]
        span = self.patch * self.vae.hop
        pad = (-audio.shape[1]) % span

        def encode(padding):
            z = self.vae.encode(F.pad(audio, padding))[0]  # (64, frames)
            return z.view(self.feat_dim, -1, self.patch).permute(1, 2, 0).contiguous()

        ref, prompt = encode((0, pad)), encode((pad, 0))
        ref_embed = self.encode_patches(ref.to(self.dtype))
        tokens = self.tokenize(text)
        n_ref, dev = ref.shape[0], self.device
        ids = torch.tensor([REF_START] + [0] * n_ref + [REF_END] + tokens, device=dev)
        is_audio = torch.zeros(len(ids), dtype=torch.bool, device=dev)
        is_audio[1:1 + n_ref] = True
        embed = torch.zeros(len(ids), self.hidden, device=dev, dtype=self.dtype)
        embed[1:1 + n_ref] = ref_embed
        kv = {"base": ([], []), "residual": ([], [])}

        def kv_out(name, i, k, v):
            kv[name][0].append(k[0])
            kv[name][1].append(v[0])

        self.prefill(ids, embed, is_audio, kv_out)
        prefix = tuple(torch.stack(c) for name in ("base", "residual") for c in kv[name])
        return Voice(ref=ref, prompt=prompt, text=text, ref_embed=ref_embed,
                     prompt_embed=self.encode_patches(prompt.to(self.dtype)), tokens=tokens, prefix=prefix)

    @staticmethod
    def _clean(text):
        return re.sub(r"\s+", " ", text.replace("\n", " "))

    def shared(self, voice, text):
        """How many leading positions of the line's prompt are the voice's cached prefix: the reference clip and as
        much of its transcript as tokenizes the same with the line's text after it (usually all of it)."""
        tokens = self.tokenize(voice.text + self._clean(text))
        same = 0
        while same < min(len(tokens), len(voice.tokens)) and tokens[same] == voice.tokens[same]:
            same += 1
        return 2 + voice.ref.shape[0] + same

    def prompt(self, voice, text):
        """The prefill's inputs for one line: tokens, latent patches, which positions are audio, the number of tokens
        in the line's own text, and the feature encoder's output (zero at the text positions, as VoxCPM2 masks it)."""
        text = self._clean(text)
        tokens = self.tokenize(voice.text + text) + [AUDIO_START]
        n_ref, n_text, n_prompt = voice.ref.shape[0], len(tokens), voice.prompt.shape[0]
        dev = self.device
        z = torch.zeros(1, self.patch, self.feat_dim, device=dev)
        ids = torch.tensor([REF_START] + [0] * n_ref + [REF_END] + tokens + [0] * n_prompt, device=dev)
        feats = torch.cat([z, voice.ref, z, z.expand(n_text, -1, -1), voice.prompt]).to(self.dtype)
        audio = torch.zeros(len(ids), dtype=torch.bool, device=dev)
        audio[1:1 + n_ref] = True
        audio[len(ids) - n_prompt:] = True
        embed = torch.zeros(len(ids), self.hidden, device=dev, dtype=self.dtype)
        embed[1:1 + n_ref] = voice.ref_embed
        embed[len(ids) - n_prompt:] = voice.prompt_embed
        return ids, feats, audio, len(self.tokenize(text)), embed

    # -- the model's parts ------------------------------------------------------------------------------------

    def linear(self, name, x):
        return F.linear(x, self.w[name + ".weight"], self.w.get(name + ".bias"))

    def fsq(self, h):
        h = torch.tanh(self.linear("fsq_layer.in_proj", h))
        return self.linear("fsq_layer.out_proj", torch.round(h * self.fsq_scale) / self.fsq_scale)

    def encode_patches(self, feats):
        """feats: (N, 4, 64) latent patches -> (N, hidden) language-model inputs (VoxCPM2's local encoder)."""
        x = self.linear("feat_encoder.in_proj", feats)
        special = self.w["feat_encoder.special_token"].view(1, 1, -1).expand(x.shape[0], 1, -1)
        out = self.encoder.forward(torch.cat([special, x], dim=1), causal=False)
        return self.linear("enc_to_lm_proj", out[:, 0])

    def stop_logits(self, lm_hidden):
        return self.linear("stop_head", F.silu(self.linear("stop_proj", lm_hidden)))

    def diffuse(self, lm_hidden, res_hidden, cond, noise):
        """The local diffusion: (B, 4, 64) new latent patches from the two language models' states, the previous
        patch (cond, (B, 4, 64)) and the starting noise (B, 64, 4). Classifier-free guidance runs the conditional
        and unconditional halves as one batch of 2B, with VoxCPM2's CFG-zero* scaling."""
        b = lm_hidden.shape[0]
        e = "feat_decoder.estimator."
        mu = torch.cat([self.linear("lm_to_dit_proj", lm_hidden), self.linear("res_to_dit_proj", res_hidden)], -1)
        mu = mu.view(b, -1, self.dit_hidden)
        cond = self.linear(e + "cond_proj", cond)
        prefix = torch.cat([mu, torch.zeros_like(mu)]), torch.cat([cond, cond])
        x = noise
        for step, (dt, temb) in enumerate(self.euler, start=1):
            if step > self.zero_init:
                h = self.linear(e + "in_proj", x.transpose(1, 2))
                seq = torch.cat([prefix[0], temb.expand(2 * b, 1, -1), prefix[1], torch.cat([h, h])], dim=1)
                out = self.dit.forward(seq, causal=False)[:, -self.patch:]
                v = self.linear(e + "out_proj", out).transpose(1, 2)  # (2B, 64, 4)
                pos, neg = v[:b], v[b:]
                pf, nf = pos.reshape(b, -1), neg.reshape(b, -1)
                st = ((pf * nf).sum(1, keepdim=True) / ((nf ** 2).sum(1, keepdim=True) + 1e-8)).view(b, 1, 1)
                x = x - dt * (neg * st + self.cfg_value * (pos - neg * st))
        return x.transpose(1, 2)

    def advance(self, pred, pos, base_k, base_v, res_k, res_v, mask):
        """Feeds the new patches to both language models: returns their next states."""
        curr = self.encode_patches(pred)
        lm_hidden = self.fsq(self.base.step(curr, pos, base_k, base_v, mask))
        res_in = self.linear("fusion_concat_proj", torch.cat([lm_hidden, curr], dim=-1))
        return lm_hidden, self.residual.step(res_in, pos, res_k, res_v, mask)

    @torch.inference_mode()
    def prefill(self, ids, embed, audio, kv_out, last=None):
        """Runs the whole prompt of one line. kv_out(name, layer, k, v) receives each stack's cache entries.
        embed: the voice's feature-encoder output per position (zero at text positions).
        Returns (lm_hidden, res_hidden) for the first step, each with a batch of one. last: the index of the
        prompt's last position, as a tensor of one, when the prompt is padded at the end (the graphed prefill);
        causal attention keeps the real positions blind to the padding."""
        last = slice(-1, None) if last is None else last
        mask = audio[:, None]
        x = torch.where(mask, embed, F.embedding(ids, self.embed))[None]
        enc = self.base.forward(x, causal=True, kv_out=lambda i, k, v: kv_out("base", i, k, v))
        enc = torch.where(mask, self.fsq(enc), enc)
        res_in = self.linear("fusion_concat_proj", torch.cat([enc, embed[None]], -1))
        res = self.residual.forward(res_in, causal=True, kv_out=lambda i, k, v: kv_out("residual", i, k, v))
        return enc[:, last][:, 0], res[:, last][:, 0]

    @torch.inference_mode()
    def extend(self, ids, embed, audio, pos, caches, slot, window, last):
        """The rest of one line's prompt, at positions pos (T,), after the part already in its slot's caches
        (base k, base v, residual k, residual v). The attention reads the caches' first window positions. Returns
        (lm_hidden, res_hidden) at index last (a tensor of one) for the first step."""
        allowed = torch.arange(window, device=pos.device)[None, :] <= pos[:, None]
        mask = audio[:, None]
        x = torch.where(mask, embed, F.embedding(ids, self.embed))[None]
        enc = self.base.extend(x, pos, caches[0], caches[1], slot, allowed)
        enc = torch.where(mask, self.fsq(enc), enc)
        res_in = self.linear("fusion_concat_proj", torch.cat([enc, embed[None]], -1))
        res = self.residual.extend(res_in, pos, caches[2], caches[3], slot, allowed)
        return enc[:, last][:, 0], res[:, last][:, 0]


class Voices:
    """The voices on the GPU, least recently used first out once they pass a memory budget. A voice is about 4 MB
    (its cached prefix is most of it), so the default 512 MB holds over a hundred; a voice that was dropped is
    rebuilt from its clip when next asked for. A line keeps its own voice alive while it speaks, whatever is dropped.

        voices = Voices(model)
        voice = voices.get("wrenna", lambda: (clip_16k, REF_TEXT))
    """

    def __init__(self, model: VoxCPM2, budget_bytes=512 * 2 ** 20):
        self.m, self.budget = model, budget_bytes
        self.held: OrderedDict[str, tuple[Voice, int]] = OrderedDict()
        self.bytes, self.builds = 0, 0

    @staticmethod
    def size(voice: Voice):
        tensors = [voice.ref, voice.prompt, voice.ref_embed, voice.prompt_embed, *voice.prefix]
        return sum(t.numel() * t.element_size() for t in tensors)

    def get(self, key, source: Callable):
        """The voice under key; source() returns (clip_16k, text) to build it when it is not held."""
        if key in self.held:
            self.held.move_to_end(key)
            return self.held[key][0]
        voice = self.m.voice(*source())
        self.builds += 1
        size = self.size(voice)
        self.held[key] = voice, size
        self.bytes += size
        while self.bytes > self.budget and len(self.held) > 1:
            _, (_, dropped) = self.held.popitem(last=False)
            self.bytes -= dropped
        return voice


# ----------------------------------------------------------------------------------------------------------------
# The runner: slots, the step graphs and the request loop
# ----------------------------------------------------------------------------------------------------------------

@dataclass
class Line:
    id: str
    text: str
    voice: Voice
    on_audio: Callable | None = None   # on_audio(line, chunk): each 160 ms of float32 audio, as soon as it exists
    on_done: Callable | None = None    # on_done(line)
    seed: int | None = None            # the line's own noise, the same whatever else is speaking
    noise: torch.Tensor | None = None  # or the noise itself, (steps, 64, 4), to replay a recorded run
    min_steps: int = 2                 # as VoxCPM2: the stop head is heeded from the fourth step on
    max_steps: int | None = None       # default: VoxCPM2's own, six tokens of audio per token of text plus ten
    # Sometimes the stop head never fires and the model goes on making near-digital silence until max_steps (ten
    # seconds of it in one test). Once a line has spoken, this many quiet steps in a row (each 160 ms, below quiet_db)
    # end it. Real pauses are just as silent and last up to 1.4 s in the cast's lines, so only length tells them
    # apart: three seconds. None keeps VoxCPM2's own rule alone.
    quiet_steps: int | None = 19
    quiet_db: float = -60.0
    # Filled in by the runner:
    slot: int = -1
    steps: int = 0
    position: int = 0
    queued_at: float = 0.0
    first_audio_at: float = 0.0
    done_at: float = 0.0
    chunks: list = field(default_factory=list)
    spoken: bool = False
    quiet: int = 0
    ended_by_silence: bool = False


class Runner:
    def __init__(self, model: VoxCPM2, slots=16, buckets=(1, 2, 4, 8, 12, 16), graphs=True, keep_audio=True,
                 prefill_buckets=(64, 96, 128, 192, 256, 384, 512), prefix_window=256, voice_cache=True):
        """prefill_buckets: the lengths of the graphed prefills, each for the part of a prompt after the voice's
        cached prefix. prefix_window: the most cached positions a graphed prefill reads (a longer prefix is used up
        to that length). voice_cache=False prefills every whole prompt, for comparison."""
        self.m, self.slots, self.keep_audio = model, slots, keep_audio
        self.prefix_window, self.voice_cache = prefix_window, voice_cache
        self.buckets = [b for b in buckets if b <= slots]
        if self.buckets[-1] != slots:
            self.buckets.append(slots)
        m, dev, L = model, model.device, model.max_positions
        kvh, d = m.base.kv_heads, m.base.head_dim
        self.base_k = torch.zeros(len(m.base.layers), slots, kvh, L, d, device=dev, dtype=m.dtype)
        self.base_v = torch.zeros_like(self.base_k)
        self.res_k = torch.zeros(len(m.residual.layers), slots, kvh, L, d, device=dev, dtype=m.dtype)
        self.res_v = torch.zeros_like(self.res_k)
        # Per-slot state the step reads and writes. Idle slots keep position 0 and finite values, so they compute
        # harmless garbage when a bucket is larger than the number of lines.
        self.lm_hidden = torch.zeros(slots, m.hidden, device=dev, dtype=m.dtype)
        self.res_hidden = torch.zeros(slots, m.hidden, device=dev, dtype=m.dtype)
        self.cond = torch.zeros(slots, m.patch, m.feat_dim, device=dev, dtype=m.dtype)
        self.pos = torch.zeros(slots, dtype=torch.long, device=dev)
        self.step_index = torch.zeros(slots, dtype=torch.long, device=dev)
        self.active = torch.zeros(slots, dtype=torch.long, device=dev)
        self.noise = torch.zeros(slots, L, m.feat_dim, m.patch, device=dev, dtype=m.dtype)
        self.vae_states = [torch.zeros(slots, c, f, device=dev, dtype=m.vae.decoder_dtype)
                           for c, f in m.vae.state_shapes()]
        self.audio_out = torch.zeros(slots, m.chunk_samples, device=dev)
        self.stop_out = torch.zeros(slots, dtype=torch.long, device=dev)
        self.audio_host = torch.zeros(slots, m.chunk_samples).pin_memory()
        self.stop_host = torch.zeros(slots, dtype=torch.long).pin_memory()
        self.positions = torch.arange(L, device=dev)
        # The graphed prefill: one graph per length bucket of the uncached rest of a prompt, padded at the end to its
        # bucket. A longer rest is prefilled eagerly.
        self.prefill_buckets = [p for p in prefill_buckets if prefix_window + p <= L] if graphs else []
        top = max(self.prefill_buckets, default=0)
        self.p_ids = torch.zeros(top, dtype=torch.long, device=dev)
        self.p_embed = torch.zeros(top, m.hidden, device=dev, dtype=m.dtype)
        self.p_audio = torch.zeros(top, dtype=torch.bool, device=dev)
        self.p_last = torch.zeros(1, dtype=torch.long, device=dev)
        self.p_slot = torch.zeros(1, dtype=torch.long, device=dev)
        self.p_start = torch.zeros(1, dtype=torch.long, device=dev)
        self.prefill_graphs = {}
        self.per_slot = [self.lm_hidden, self.res_hidden, self.cond, self.pos, self.step_index, self.active,
                         self.noise, *self.vae_states]
        self.lines: list[Line] = []   # lines[i] holds slot i
        self.pending: deque[Line] = deque()
        self.vae_stream = torch.cuda.Stream()
        self.graphs, self.capture_seconds = {}, 0.0
        if graphs:
            t0 = time.perf_counter()
            self._capture()
            self.capture_seconds = time.perf_counter() - t0

    # -- the step --------------------------------------------------------------------------------------------

    def _step(self, b):
        """One audio token for slots 0..b-1, entirely on the GPU."""
        m = self.m
        rows = torch.arange(b, device=m.device)
        noise = self.noise[rows, self.step_index[:b]]
        pred = m.diffuse(self.lm_hidden[:b], self.res_hidden[:b], self.cond[:b], noise)
        self.stop_out[:b] = m.stop_logits(self.lm_hidden[:b]).argmax(-1)
        # The AudioVAE needs only the new patch, as do the language models: it runs beside them on a second stream.
        main = torch.cuda.current_stream()
        self.vae_stream.wait_stream(main)
        with torch.cuda.stream(self.vae_stream):
            z = pred.transpose(1, 2)
            self.audio_out[:b] = m.vae.decode_stream(z, [s[:b] for s in self.vae_states])
        mask = (self.positions[None, :] <= self.pos[:b, None])[:, None, None]
        lm_hidden, res_hidden = m.advance(pred, self.pos[:b], self.base_k[:, :b], self.base_v[:, :b],
                                          self.res_k[:, :b], self.res_v[:, :b], mask)
        main.wait_stream(self.vae_stream)
        self.lm_hidden[:b] = lm_hidden
        self.res_hidden[:b] = res_hidden
        self.cond[:b] = pred
        self.pos[:b] += self.active[:b]
        self.step_index[:b] += self.active[:b]

    def _prefill(self, t):
        """The rest of a prompt in p_ids/p_embed/p_audio, padded to t positions, from position p_start on, into the
        slot in p_slot (whose caches already hold the positions before p_start)."""
        slot = self.p_slot
        lm_hidden, res_hidden = self.m.extend(
            self.p_ids[:t], self.p_embed[:t], self.p_audio[:t], self.p_start + self.positions[:t],
            (self.base_k, self.base_v, self.res_k, self.res_v), slot, self.prefix_window + t, self.p_last)
        self.lm_hidden[slot] = lm_hidden
        self.res_hidden[slot] = res_hidden

    @torch.inference_mode()
    def _capture(self):
        pool = torch.cuda.graph_pool_handle()
        stream = torch.cuda.Stream()
        stream.wait_stream(torch.cuda.current_stream())
        with torch.cuda.stream(stream):
            for b in self.buckets:
                self._step(b)  # warm-up: cuBLAS handles, workspaces
            for t in self.prefill_buckets:
                self._prefill(t)
        torch.cuda.current_stream().wait_stream(stream)
        for b in reversed(self.buckets):
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g, pool=pool):
                self._step(b)
            self.graphs[b] = g
        for t in reversed(self.prefill_buckets):
            g = torch.cuda.CUDAGraph()
            with torch.cuda.graph(g, pool=pool):
                self._prefill(t)
            self.prefill_graphs[t] = g
        torch.cuda.synchronize()
        for t in self.per_slot:
            t.zero_()

    # -- lines ----------------------------------------------------------------------------------------------

    def add(self, line: Line):
        line.queued_at = time.perf_counter()
        self.pending.append(line)

    @torch.inference_mode()
    def _admit(self, line: Line):
        m = self.m
        slot = len(self.lines)
        ids, feats, audio, n_target, embed = m.prompt(line.voice, line.text)
        n = len(ids)
        if line.max_steps is None:
            line.max_steps = int(n_target * 6 + 10)
        line.max_steps = min(line.max_steps, m.max_positions - n)
        if line.max_steps < 1:
            raise ValueError(f"line {line.id!r} is too long for {m.max_positions} positions")

        # The voice's cached prefix goes straight into the slot; only the rest of the prompt is computed.
        start = min(m.shared(line.voice, line.text), self.prefix_window, n - 1) if self.voice_cache else 0
        caches = (self.base_k, self.base_v, self.res_k, self.res_v)
        for cache, prefix in zip(caches, line.voice.prefix):
            cache[:, slot, :, :start] = prefix[:, :, :start]
        rest = n - start
        t = next((p for p in self.prefill_buckets if p >= rest), None)
        if t is not None:
            self.p_ids[:rest], self.p_embed[:rest], self.p_audio[:rest] = ids[start:], embed[start:], audio[start:]
            self.p_last.fill_(rest - 1)
            self.p_slot.fill_(slot)
            self.p_start.fill_(start)
            self.prefill_graphs[t].replay()
        else:
            dev = m.device
            lm_hidden, res_hidden = m.extend(
                ids[start:], embed[start:], audio[start:], torch.arange(start, n, device=dev), caches,
                torch.tensor([slot], device=dev), n, torch.tensor([rest - 1], device=dev))
            self.lm_hidden[slot] = lm_hidden[0]
            self.res_hidden[slot] = res_hidden[0]
        self.cond[slot] = feats[-1]  # the first step continues from the prompt's last patch
        self.pos[slot] = n
        self.step_index[slot] = 0
        self.active[slot] = 1
        for s in self.vae_states:
            s[slot].zero_()
        steps = min(line.max_steps, self.noise.shape[1])
        if line.noise is not None:
            k = min(len(line.noise), steps)
            self.noise[slot, :k] = line.noise[:k].to(self.noise)
        else:
            gen = torch.Generator(device=m.device)
            if line.seed is not None:
                gen.manual_seed(line.seed)
            else:
                gen.seed()
            self.noise[slot, :steps] = torch.randn(steps, m.feat_dim, m.patch, generator=gen, device=m.device,
                                                   dtype=m.dtype)
        line.slot, line.steps, line.position = slot, 0, n
        self.lines.append(line)

    def _retire(self, i):
        """Frees slot i, moving the last line into it so that the busy slots stay 0..n-1."""
        last = len(self.lines) - 1
        if i != last:
            moved = self.lines[last]
            n = moved.position + 1
            for c in (self.base_k, self.base_v, self.res_k, self.res_v):
                c[:, i, :, :n] = c[:, last, :, :n]
            for t in self.per_slot:
                t[i] = t[last]
            moved.slot = i
            self.lines[i] = moved
        self.lines.pop()
        for t in self.per_slot:
            t[last].zero_()

    @torch.inference_mode()
    def step(self):
        """Admits waiting lines into free slots, then makes the next 160 ms of audio for every line. Returns the
        number of lines that spoke."""
        while self.pending and len(self.lines) < self.slots:
            self._admit(self.pending.popleft())
        n = len(self.lines)
        if n == 0:
            return 0
        b = next(x for x in self.buckets if x >= n)
        if self.graphs:
            self.graphs[b].replay()
        else:
            self._step(b)
        self.audio_host[:n].copy_(self.audio_out[:n], non_blocking=True)
        self.stop_host[:n].copy_(self.stop_out[:n], non_blocking=True)
        torch.cuda.current_stream().synchronize()
        now = time.perf_counter()
        finished = []
        for i, line in enumerate(self.lines):
            chunk = self.audio_host[i].numpy().copy()
            if line.steps == 0:
                line.first_audio_at = now
            if self.keep_audio:
                line.chunks.append(chunk)
            if line.on_audio:
                line.on_audio(line, chunk)
            index = line.steps
            line.steps += 1
            line.position += 1
            loud = bool(10 * np.log10(float(np.mean(chunk ** 2)) + 1e-12) > line.quiet_db)
            line.spoken |= loud
            line.quiet = 0 if loud else line.quiet + 1
            line.ended_by_silence = line.quiet_steps is not None and line.spoken and line.quiet >= line.quiet_steps
            if (index > line.min_steps and self.stop_host[i] == 1) or line.steps >= line.max_steps or                     line.ended_by_silence:
                finished.append(i)
        for i in reversed(finished):
            line = self.lines[i]
            line.done_at = now
            self._retire(i)
            if line.on_done:
                line.on_done(line)
        return n

    def cancel(self, line_id):
        """Stops a line, waiting or speaking (its slot is free at once). True when there was one."""
        for line in list(self.pending):
            if line.id == line_id:
                self.pending.remove(line)
                return True
        for i, line in enumerate(self.lines):
            if line.id == line_id:
                self._retire(i)
                return True
        return False

    def run(self):
        while self.pending or self.lines:
            self.step()

    def audio(self, line: Line):
        return np.concatenate(line.chunks) if line.chunks else np.zeros(0, dtype=np.float32)
