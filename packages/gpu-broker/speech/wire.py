"""
The speech engines' framing on their local socket (the same in packages/shared/src/speech.ts): each frame is a
4-byte little-endian length, then that many bytes. The first byte
says what follows: 1 a JSON message in UTF-8; 2 audio, as a 2-byte little-endian length, the line's id in UTF-8, and
16-bit little-endian mono PCM.
"""

import json
import struct

JSON, AUDIO = 1, 2
MAX_FRAME = 16 * 1024 * 1024


def json_frame(msg):
    body = bytes([JSON]) + json.dumps(msg, separators=(",", ":")).encode("utf8")
    return struct.pack("<I", len(body)) + body


def audio_frame(line_id, pcm):
    lid = line_id.encode("utf8")
    body = bytes([AUDIO]) + struct.pack("<H", len(lid)) + lid + pcm
    return struct.pack("<I", len(body)) + body


async def read_frame(reader):
    """The next frame as ("json", dict) or ("audio", lineId, pcm); None when the connection closed."""
    try:
        head = await reader.readexactly(4)
    except Exception:
        return None
    (n,) = struct.unpack("<I", head)
    if n == 0 or n > MAX_FRAME:
        raise ConnectionError(f"bad frame length {n}")
    body = await reader.readexactly(n)
    if body[0] == JSON:
        return ("json", json.loads(body[1:].decode("utf8")))
    if body[0] == AUDIO:
        (k,) = struct.unpack("<H", body[1:3])
        return ("audio", body[3 : 3 + k].decode("utf8"), body[3 + k :])
    raise ConnectionError(f"bad frame type {body[0]}")
