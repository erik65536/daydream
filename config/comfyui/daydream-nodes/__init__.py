"""Daydream's ComfyUI nodes. A copy of this folder is installed in ComfyUI's own custom_nodes folder on the GPU PC
(docs/gpu-broker.md, "Daydream's ComfyUI nodes"); ComfyUI never loads it from a checkout.

VERSION goes up with every change here, together with the `version` the workflows send: a ComfyUI still holding an
older copy then refuses the prompt (value not in list) instead of running old code.

DaydreamQwenEncode is TextEncodeQwenImage21 without the waste (docs/experiments/gpu-runner):
- The stock node runs Qwen3-VL-8B over the whole reference picture twice per prompt, once for the prompt and once for
  the empty negative prompt. Daydream samples Qwen at cfg 1, where ComfyUI never evaluates the negative, so this node
  encodes the prompt alone and passes it as both. Only correct at cfg 1.
- The vision tower's answer for a picture is the same for every prompt about it (the reader asks several plans of
  each map), so it is kept per picture, in system memory, on the encoder itself.
At 1.4 MP this takes the encoding from 9.1 s to 3.3 s, and the plans come out identical pixel for pixel.
"""
import hashlib
from collections import OrderedDict

import comfy.utils
import node_helpers
from comfy_api.latest import ComfyExtension, io

VERSION = "1"
VISION_CACHE_SIZE = 4


def _cached_vision(clip):
    """Wrap the Qwen3-VL encoder's preprocess_embed once, so a picture's vision tower output is computed once."""
    te = clip.cond_stage_model
    model = getattr(te, te.clip).transformer
    if hasattr(model, "_daydream_cache"):
        return
    cache = model._daydream_cache = OrderedDict()
    orig = model.preprocess_embed

    def preprocess_embed(embed, device):
        if embed.get("type") != "image":
            return orig(embed, device)
        data = embed["data"]
        key = hashlib.sha1(data.detach().float().cpu().numpy().tobytes()).hexdigest() + str(tuple(data.shape))
        hit = cache.get(key)
        if hit is not None:
            cache.move_to_end(key)
            merged, extra = hit
            return merged.to(device), {"grid": extra["grid"], "deepstack": [d.to(device) for d in extra["deepstack"]]}
        merged, extra = orig(embed, device)
        cache[key] = (merged.detach().cpu(), {"grid": extra["grid"], "deepstack": [d.detach().cpu() for d in extra["deepstack"]]})
        while len(cache) > VISION_CACHE_SIZE:
            cache.popitem(last=False)
        return merged, extra

    model.preprocess_embed = preprocess_embed


class DaydreamQwenEncode(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="DaydreamQwenEncode",
            display_name="Daydream Qwen Image 2.1 encode (cfg 1)",
            category="daydream",
            inputs=[
                io.Clip.Input("clip"),
                io.Vae.Input("vae"),
                io.String.Input("prompt", multiline=True),
                io.Combo.Input("version", options=[VERSION], tooltip="The version of Daydream's nodes the workflow was written for."),
                io.Autogrow.Input(
                    "images",
                    template=io.Autogrow.TemplateNames(io.Image.Input("image"), names=[f"image_{i}" for i in range(1, 17)], min=1),
                    tooltip="Reference pictures, each at its own size rounded to a multiple of 32 (the stock node's resolution 0).",
                ),
            ],
            outputs=[io.Conditioning.Output(display_name="positive"), io.Conditioning.Output(display_name="negative")],
        )

    @classmethod
    def execute(cls, clip, vae, prompt, version, images: io.Autogrow.Type) -> io.NodeOutput:
        images_vl, ref_latents = [], []
        for name in sorted(images, key=lambda n: int(n.rsplit("_", 1)[-1])):
            image = images[name]
            if image is None:
                continue
            samples = image[:1].movedim(-1, 1)
            width, height = max(32, round(samples.shape[3] / 32) * 32), max(32, round(samples.shape[2] / 32) * 32)
            s = image[:1] if (width, height) == (samples.shape[3], samples.shape[2]) else comfy.utils.common_upscale(samples, width, height, "lanczos", "disabled").movedim(1, -1)
            rgb = s[:, :, :, :3]
            if s.shape[-1] > 3:
                rgb = rgb * s[:, :, :, 3:] + (1.0 - s[:, :, :, 3:])
            images_vl.append(rgb)
            ref_latents.append(vae.encode(s))
        _cached_vision(clip)
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(prompt, images=images_vl, keep_vision=False, prevent_empty_text=True))
        positive = node_helpers.conditioning_set_values(positive, {"reference_latents": ref_latents}, append=True)
        return io.NodeOutput(positive, positive)


class DaydreamExtension(ComfyExtension):
    async def get_node_list(self):
        return [DaydreamQwenEncode]


async def comfy_entrypoint():
    return DaydreamExtension()
