"""
Exports a Pocket TTS model from Kyutai's PyTorch code (pocket-tts) to ONNX, for the game server, which speaks with it
on ONNX Runtime (src/speech/pocketModel.ts) and needs neither Python nor torch. Run once at install, and again after an
upgrade of pocket-tts, in an environment made from requirements.txt beside it (docs/hosting.md, step 4a):

    python pocket_export.py [--model english_2026-10] [--out <folder>] [--clip <a voice clip>]

<folder> is the repository's models/pocket unless named, where the game looks; the clip checks the export, and is
check-voice.wav beside this script (a designed voice of the game's own, as a 16-bit WAV at 24 kHz) unless named.
<folder>/<model>/ then holds:
- lm.onnx: one step of the flow language model. Inputs: embeddings x [1, T, D] (text, voice, or the last latent),
  noise [1, latent], the position of x's first row, and every layer's past keys and values [1, P, heads, dim]. Outputs:
  the next latent, the end-of-speech logit, and the keys and values of x's rows, for the caller to append.
  lm_int8.onnx is the same with int8 weights, the one spoken with.
- decoder.onnx: the streaming Mimi decoder, latents [1, F, latent] to audio [1, 1, F * 1920] at 24 kHz. Its
  transformer's keys and values work as the language model's (the caller keeps a window of the last `context`); its
  convolutions' buffers go in and come back whole.
- encoder.onnx: the Mimi encoder, a voice clip at 24 kHz to its latents, for making a voice's state.
- tables.bin and model.json: the small tables (text embeddings, projections) as float32, and the settings of the model,
  its graphs and its text front end; tokenizer.json, the tokenizer's pieces and scores.
- check.json and check.bin: a line spoken by PyTorch from the clip with a recorded stream of noise, and how
  pocket-tts splits and tokenizes a set of texts, for `src/cli/pocketcheck.ts` to compare the game's runtime with.
"""

import argparse
import json
import uuid
import wave
from contextlib import contextmanager
from functools import partial
from pathlib import Path

import numpy as np
import onnx
import sentencepiece
import torch
import torch.nn.functional as F
from onnxruntime.quantization import QuantType, quantize_dynamic
from pocket_tts import TTSModel
from pocket_tts.data.audio import audio_read
from pocket_tts.data.audio_utils import convert_audio
from pocket_tts.default_parameters import MAX_TOKEN_PER_CHUNK
from pocket_tts.models import flow_lm as flow_lm_module
from pocket_tts.models.text_chunking import prepare_text_prompt, split_into_best_sentences
from pocket_tts.modules.attention import StreamingMultiheadAttention
from pocket_tts.modules.conv import StreamingConv1d, StreamingConvTranspose1d
from torch import nn

DECODERS = {"lsd": flow_lm_module.lsd_decode, "flow_matching": flow_lm_module.ot_decode,
            "drifting": flow_lm_module.drifting_decode, "pointwise": flow_lm_module.pointwise_decode}

# The line the check speaks, and texts whose splitting and tokens are compared (game lines and awkward cases).
CHECK_LINE = "Three nights ago something took the lantern from the old tower, and nobody saw a thing."
CHECK_TEXTS = [
    CHECK_LINE, "Ah.", "Well, look who finally turned up.", "No. No, that can't be right!", "Is it 3.5 leagues, or 4?",
    "“Halt,” she said — quietly – “who goes there?”", "It’s the Acorn Cup… isn’t it",
    "Sit down, sit down; the kettle's just singing:", "Café crème, naïve façade, über Straße.",
    "Gold: 1,250. Health: 98%. Fire (rank II) → next!", "the road   had   swallowed you whole",
    "A dragon \U0001f409 sleeps here, 2 feet from the £ chest.",
    "Mercy without a plan is only abandonment with kinder words, and I have heard every kind of word, from every kind "
    "of person, in every kind of weather, on every kind of shore, and I will save this one, whatever it costs me, "
    "whatever it costs you, whatever it costs all of us together.",
    "Bring it back before the frost sets in. I'll see that you're paid properly. Three nights, mind you. Not four.",
]


def attention(self, query, model_state, attn_mask=None):
    """StreamingMultiheadAttention with its cache as plain tensors: the past keys and values [B, P, H, d] go in (state
    k, v and the position offset), and those of the new rows come out (state k_new, v_new)."""
    state = None if model_state is None else self.get_state(model_state)
    b, t, _ = query.shape
    d = self.dim_per_head
    projected = self.in_proj(query)
    q = projected[..., : self.attn_dim].view(b, t, self.num_heads, d)
    k, v = projected[..., self.attn_dim :].view(b, t, 2, self.num_kv_heads, d).unbind(2)
    q, k = self.rope(q, k, offset=state["offset"].float() if state else torch.zeros(()))
    if state:
        state["k_new"], state["v_new"] = k, v
        k, v = torch.cat([state["k"], k], dim=1), torch.cat([state["v"], v], dim=1)
    q, k, v = q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
    qpos = torch.arange(t).view(-1, 1) + (k.shape[2] - t)
    kpos = torch.arange(k.shape[2]).view(1, -1)
    mask = kpos <= qpos
    if self.context:
        mask = mask & (qpos - kpos < self.context)
    if self.num_kv_heads != self.num_heads:
        k = k.repeat_interleave(self.num_heads // self.num_kv_heads, dim=1)
        v = v.repeat_interleave(self.num_heads // self.num_kv_heads, dim=1)
    x = F.scaled_dot_product_attention(q, k, v, mask)
    return self.out_proj(x.transpose(1, 2).reshape(b, t, self.attn_dim))


def transposed_conv(self, x, model_state):
    """StreamingConvTranspose1d (kernel twice its stride) as one matrix product and an overlap-add, the same sums in
    another order: ONNX Runtime's ConvTranspose is slow on a CPU. Every input step makes two output frames of `stride`
    samples; the first is added to the second of the step before, and the last step's second frame waits in the state
    for the next call."""
    convtr = self.convtr
    w, s = convtr.weight, convtr.stride[0]
    assert convtr.kernel_size[0] == 2 * s and convtr.groups in (1, w.shape[0])
    state = self.get_state(model_state)
    b, c_in, t = x.shape
    if convtr.groups == 1:
        z = torch.matmul(w.permute(1, 2, 0).reshape(-1, c_in), x)
    else:  # one filter per channel
        z = x[:, :, None, :] * w[:, 0, :, None]
    z = z.view(b, -1, 2, s, t)
    first, second = z[:, :, 0], z[:, :, 1]
    carried = torch.cat([state["partial"][..., None], second[..., :-1]], dim=-1)
    y = (first + carried).permute(0, 1, 3, 2).reshape(b, -1, t * s)
    state["partial"] = second[..., -1]
    return y if convtr.bias is None else y + convtr.bias[:, None]


def elu(self, x):
    """ELU as a select of an exponential: ONNX Runtime's own Elu is slow on a CPU."""
    return torch.where(x > 0, x, torch.exp(x) - 1)


@contextmanager
def exportable():
    """The streaming modules in forms that export to ONNX and run fast there."""
    patches = [(StreamingMultiheadAttention, attention), (StreamingConvTranspose1d, transposed_conv), (nn.ELU, elu)]
    originals = [(cls, cls.forward) for cls, _ in patches]
    for cls, forward in patches:
        cls.forward = forward
    try:
        yield
    finally:
        for cls, forward in originals:
            cls.forward = forward


def state_layout(module, prefixes=("",)):
    """A module's streaming state, as a list of entries: `kv` for an attention layer (its keys and values, appended to
    by each call, within a window of `context` rows if it has one), `state` for a convolution's buffer (replaced)."""
    layout = []
    for _, sub in module.named_modules():
        name = getattr(sub, "_module_absolute_name", None)
        if name is None or not name.startswith(prefixes):
            continue
        if isinstance(sub, StreamingMultiheadAttention):
            layout.append({"module": name, "kind": "kv", "heads": sub.num_kv_heads, "dim": sub.dim_per_head, "context": sub.context})
        elif isinstance(sub, (StreamingConv1d, StreamingConvTranspose1d)):
            key = "previous" if isinstance(sub, StreamingConv1d) else "partial"
            layout.append({"module": name, "kind": "state", "key": key, "shape": list(sub.init_state(1, 0)[key].shape)})
    for i, s in enumerate(layout):
        s["name"] = f"{s['kind']}{i}"
    return layout


def state_inputs(layout, past=3):
    """Example inputs and input names for a layout: past k and v per kv entry, the buffer per state entry."""
    tensors, names = [], []
    for s in layout:
        if s["kind"] == "kv":
            # Two tensors: the exporter would read one input twice for two arguments that are the same tensor.
            tensors += [torch.zeros(1, past, s["heads"], s["dim"]) for _ in range(2)]
            names += [f"{s['name']}_k", f"{s['name']}_v"]
        else:
            tensors.append(torch.zeros(s["shape"]))
            names.append(s["name"])
    return tensors, names


def build_state(layout, tensors, offset):
    state, it = {}, iter(tensors)
    for s in layout:
        entry = state.setdefault(s["module"], {"offset": offset, "first": torch.zeros(1, dtype=torch.bool)})
        if s["kind"] == "kv":
            entry["k"], entry["v"] = next(it), next(it)
        else:
            entry[s["key"]] = next(it).clone()
    return state


def state_outputs(layout, state):
    out = []
    for s in layout:
        entry = state[s["module"]]
        out += [entry["k_new"], entry["v_new"]] if s["kind"] == "kv" else [entry[s["key"]]]
    return out


class LMStep(nn.Module):
    def __init__(self, model: TTSModel):
        super().__init__()
        self.lm = model.flow_lm
        self.layout = state_layout(self.lm.transformer)
        self.decode = partial(DECODERS[self.lm.flow_type], num_steps=model.sampler_decode_steps)

    def forward(self, x, noise, offset, *cache):
        state = build_state(self.layout, cache, offset)
        z = self.lm.out_norm(self.lm.transformer(x, state))[:, -1]
        if self.lm.z_proj is not None:
            z = self.lm.z_proj(z)
        latent = self.decode(partial(self.lm.flow_net, z), noise)
        return (latent, self.lm.out_eos(z), *state_outputs(self.layout, state))


class DecoderStep(nn.Module):
    def __init__(self, model: TTSModel):
        super().__init__()
        self.mimi = model.mimi
        self.lm = model.flow_lm
        self.layout = state_layout(self.mimi, ("decoder", "upsample"))

    def forward(self, latent, offset, *states):
        state = build_state(self.layout, states, offset)
        audio = self.mimi.decode_from_latent(latent * self.lm.emb_std + self.lm.emb_mean, state)
        return (audio, *state_outputs(self.layout, state))


class Encoder(nn.Module):
    def __init__(self, model: TTSModel):
        super().__init__()
        self.mimi = model.mimi

    def forward(self, audio):
        return self.mimi.encode_to_latent(audio)


def export(module, args, names, outputs, dynamic, path):
    torch.onnx.export(module, args, str(path), input_names=names, output_names=outputs, dynamic_shapes=dynamic,
                      dynamo=True, external_data=False, optimize=True, verify=False)
    # The exporter's intermediate shapes trip the int8 quantizer's shape inference; ONNX Runtime infers its own.
    m = onnx.load(str(path))
    del m.graph.value_info[:]
    onnx.save(m, str(path))


def output_names(layout):
    return [n for s in layout for n in ([f"{s['name']}_k_new", f"{s['name']}_v_new"] if s["kind"] == "kv" else [f"{s['name']}_new"])]


def state_dims(layout, past):
    return tuple(d for s in layout for d in ([{1: past}] * 2 if s["kind"] == "kv" else [None]))


def export_graphs(model: TTSModel, out: Path):
    lm = model.flow_lm
    T, P = torch.export.Dim("t"), torch.export.Dim("past")
    with torch.no_grad(), exportable():
        step = LMStep(model)
        cache, names = state_inputs(step.layout)
        export(step, (torch.zeros(1, 2, lm.dim), torch.zeros(1, lm.ldim), torch.tensor(3), *cache),
               ["x", "noise", "offset", *names], ["latent", "eos", *output_names(step.layout)],
               ({1: T}, None, None, state_dims(step.layout, P)), out / "lm.onnx")
        # Weights in int8 with one scale per output channel, activations quantized per call: a quarter of the memory
        # traffic of float32, which is what limits a step on a small CPU. The decoder stays float32: in int8 its
        # audio moves by -28 dB, for 2% of the time.
        quantize_dynamic(out / "lm.onnx", out / "lm_int8.onnx", weight_type=QuantType.QInt8, per_channel=True)

        dec = DecoderStep(model)
        states, names = state_inputs(dec.layout)
        export(dec, (torch.zeros(1, 2, lm.ldim), torch.tensor(48), *states), ["latent", "offset", *names],
               ["audio", *output_names(dec.layout)], ({1: T}, None, state_dims(dec.layout, P)), out / "decoder.onnx")

        frames = torch.export.Dim("frames", min=1, max=1000)
        export(Encoder(model), (torch.zeros(1, 1, model.mimi.frame_size * 20),), ["audio"], ["latent"],
               ({2: model.mimi.frame_size * frames},), out / "encoder.onnx")

        cond = lm.conditioner
        tables = {"embed": cond.embed.weight if cond.proj is None else cond.proj(cond.embed.weight),
                  "inputLinear": lm.input_linear.weight, "bos": lm.bos_emb, "speakerProj": lm.speaker_proj_weight}
        if lm.insert_bos_before_voice:
            tables["bosBeforeVoice"] = lm.bos_before_voice.reshape(1, -1)
    index, offset = {}, 0
    with open(out / "tables.bin", "wb") as f:
        for name, t in tables.items():
            a = np.ascontiguousarray(t.detach().float().numpy(), dtype="<f4")
            f.write(a.tobytes())
            index[name] = {"offset": offset, "shape": list(a.shape)}
            offset += a.size
    return {"lm": step.layout, "decoder": dec.layout, "tables": index}


def export_tokenizer(model: TTSModel, out: Path):
    """The tokenizer's pieces and scores, the same for both kinds pocket-tts uses: a Unigram model with byte fallback,
    a ▁ in front of the text and in place of every space, and no other normalization."""
    kind, payload = model.flow_lm.conditioner.tokenizer.serialize()
    if kind == "tokenizers":
        spec = json.loads(payload)
        assert spec["model"]["type"] == "Unigram" and spec["model"]["byte_fallback"] and spec["normalizer"] == {"type": "Prepend", "prepend": "▁"}
        pieces = [[p, s, "byte" if p.startswith("<0x") else "control" if i < 4 else "normal"] for i, (p, s) in enumerate(spec["model"]["vocab"])]
    else:
        sp = sentencepiece.SentencePieceProcessor()
        sp.load_from_serialized_proto(payload)
        pieces = [[sp.id_to_piece(i), sp.get_score(i), "byte" if sp.is_byte(i) else "control" if sp.is_control(i) or sp.is_unknown(i) else "normal"]
                  for i in range(sp.get_piece_size())]
    (out / "tokenizer.json").write_text(json.dumps({"unk": 0, "pieces": pieces}, ensure_ascii=False), encoding="utf8")


class Noise:
    """The sampler's normal draws, recorded: PyTorch's torch.nn.init.normal_ reads them in order."""

    def __init__(self):
        self.rng = np.random.default_rng(0)
        self.draws = []

    def normal_(self, t, mean=0.0, std=1.0):
        z = self.rng.standard_normal(t.numel()).astype(np.float32)
        self.draws.append(z.tolist())
        return t.copy_(torch.from_numpy(z).view(t.shape) * std + mean)


def write_check(model: TTSModel, out: Path, clip: str):
    """PyTorch's reference for the runtime: a line spoken from the clip (as a 24 kHz WAV, check.wav) with recorded noise,
    and pocket-tts's chunks and tokens for CHECK_TEXTS."""
    audio, rate = audio_read(clip)
    audio = convert_audio(audio[..., : 30 * rate], rate, model.sample_rate, 1)
    pcm = (audio.clamp(-1, 1).numpy()[0] * 32767).astype(np.int16)
    with wave.open(str(out / "check.wav"), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(model.sample_rate)
        w.writeframes(pcm.tobytes())
    noise = Noise()
    original, torch.nn.init.normal_ = torch.nn.init.normal_, noise.normal_
    try:
        with torch.no_grad():
            voice = model.get_state_for_audio_prompt(out / "check.wav", truncate=False)
            reference = model.generate_audio(voice, CHECK_LINE).numpy()
    finally:
        torch.nn.init.normal_ = original
    reference.astype("<f4").tofile(out / "check.bin")

    tokenizer = model.flow_lm.conditioner.tokenizer
    texts = []
    for text in CHECK_TEXTS:
        chunks = split_into_best_sentences(tokenizer, text, MAX_TOKEN_PER_CHUNK, model.pad_with_spaces_for_short_inputs,
                                           remove_semicolons=model.remove_semicolons,
                                           append_terminal_punctuation=model.append_terminal_punctuation,
                                           capitalize_first_letter=model.capitalize_first_letter,
                                           replace_characters=model.replace_characters)
        prompts = [prepare_text_prompt(c, model.pad_with_spaces_for_short_inputs, model.remove_semicolons,
                                       model.append_terminal_punctuation, model.capitalize_first_letter,
                                       model.replace_characters) for c in chunks]
        texts.append({"text": text, "chunks": [{"prompt": p, "framesAfterEos": g, "tokens": tokenizer.encode(p)} for p, g in prompts]})
    check = {"line": CHECK_LINE, "noise": noise.draws, "samples": len(reference), "texts": texts}
    (out / "check.json").write_text(json.dumps(check, ensure_ascii=False), encoding="utf8")


def main():
    ap = argparse.ArgumentParser()
    here = Path(__file__).resolve().parent
    ap.add_argument("--out", default=str(here.parents[2] / "models" / "pocket"))
    ap.add_argument("--clip", default=str(here / "check-voice.wav"))
    ap.add_argument("--model", default="english_2026-10")
    a = ap.parse_args()
    out = Path(a.out) / a.model
    out.mkdir(parents=True, exist_ok=True)
    model = TTSModel.load_model(language=a.model)
    model.eval()
    assert model.noise_clamp is None, "the runtime samples untruncated noise"
    graphs = export_graphs(model, out)
    export_tokenizer(model, out)
    settings = {
        "model": a.model,
        # Voice states made with one export are kept under its id (src/speech/pocket.ts).
        "exportId": uuid.uuid4().hex[:12],
        "sampleRate": model.sample_rate,
        "frameSize": model.mimi.frame_size,
        "decoderStepsPerFrame": int(model.mimi.encoder_frame_rate / model.mimi.frame_rate),
        "dim": model.flow_lm.dim,
        "latentDim": model.flow_lm.ldim,
        "temperature": model.temp,
        "eosThreshold": model.eos_threshold,
        "minFramesBeforeEos": model._MIN_FRAMES_BEFORE_EOS,
        "framesAfterEos": model.model_recommended_frames_after_eos,
        "tokensPerSecond": model._TOKENS_PER_SECOND_ESTIMATE,
        "paddingSeconds": model._GEN_SECONDS_PADDING,
        "maxTokensPerChunk": MAX_TOKEN_PER_CHUNK,
        "text": {"padShortInputs": model.pad_with_spaces_for_short_inputs, "removeSemicolons": model.remove_semicolons,
                 "terminalPunctuation": model.append_terminal_punctuation, "capitalize": model.capitalize_first_letter,
                 "replace": model.replace_characters},
        **graphs,
    }
    (out / "model.json").write_text(json.dumps(settings, indent=1, ensure_ascii=False), encoding="utf8")
    write_check(model, out, a.clip)
    print(f"{a.model}: exported to {out}", flush=True)


if __name__ == "__main__":
    main()
