from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "samples"
PPQ = 480


def vlq(value):
    value = max(0, int(value))
    buffer = value & 0x7F
    while (value := value >> 7):
        buffer <<= 8
        buffer |= ((value & 0x7F) | 0x80)
    out = bytearray()
    while True:
        out.append(buffer & 0xFF)
        if buffer & 0x80:
            buffer >>= 8
        else:
            break
    return bytes(out)


def meta(kind, payload):
    return bytes((0xFF, kind)) + vlq(len(payload)) + payload


def track_chunk(events):
    events.sort(key=lambda e: (e[0], e[1]))
    body = bytearray()
    last = 0
    for tick, priority, message in events:
        body += vlq(tick - last)
        body += message
        last = tick
    body += b"\x00\xff\x2f\x00"
    return b"MTrk" + len(body).to_bytes(4, "big") + body


def note_events(sequence, channel=0):
    events = []
    for start, duration, pitch, velocity in sequence:
        events.append((start, 2, bytes((0x90 | channel, pitch, velocity))))
        events.append((start + duration, 0, bytes((0x80 | channel, pitch, 0))))
    return events


def write_midi(path, tempo, tracks, title, type_one=False):
    conductor = [
        (0, 0, meta(0x03, title.encode("ascii"))),
        (0, 1, meta(0x51, round(60_000_000 / tempo).to_bytes(3, "big"))),
        (0, 2, meta(0x58, bytes((4, 2, 24, 8)))),
    ]
    chunks = []
    if type_one:
        chunks.append(track_chunk(conductor))
        for name, notes in tracks:
            events = [(0, 0, meta(0x03, name.encode("ascii")))] + note_events(notes)
            chunks.append(track_chunk(events))
        fmt, count = 1, 1 + len(tracks)
    else:
        name, notes = tracks[0]
        chunks.append(track_chunk(conductor + [(tick, priority + 3, message) for tick, priority, message in note_events(notes)]))
        fmt, count = 0, 1
    header = b"MThd" + (6).to_bytes(4, "big") + fmt.to_bytes(2, "big") + count.to_bytes(2, "big") + PPQ.to_bytes(2, "big")
    path.write_bytes(header + b"".join(chunks))


OUT.mkdir(parents=True, exist_ok=True)
write_midi(
    OUT / "little-lantern.mid", 96,
    [("Lantern Melody", [(0, 420, 60, 88), (480, 420, 62, 82), (960, 420, 64, 84), (1440, 420, 67, 92), (1920, 420, 64, 84), (2400, 420, 62, 82), (2880, 840, 60, 88), (3840, 420, 67, 90), (4320, 420, 69, 86), (4800, 840, 72, 94), (5760, 420, 71, 86), (6240, 420, 67, 82), (6720, 960, 60, 88)])],
    "Little Lantern")
write_midi(
    OUT / "warm-chords.mid", 84,
    [("Top Line", [(0, 600, 64, 85), (960, 600, 67, 85), (1920, 600, 69, 87), (2880, 600, 67, 84), (3840, 600, 72, 90), (4800, 600, 69, 84), (5760, 600, 67, 85), (6720, 900, 64, 86)]),
     ("Soft Harmony", [(0, 1680, 48, 62), (0, 1680, 55, 60), (0, 1680, 60, 58), (1920, 1680, 45, 62), (1920, 1680, 52, 59), (1920, 1680, 57, 57), (3840, 1680, 41, 62), (3840, 1680, 48, 59), (3840, 1680, 53, 58), (5760, 1800, 43, 62), (5760, 1800, 50, 59), (5760, 1800, 55, 58)])],
    "Warm Chords", type_one=True)
write_midi(
    OUT / "paper-kite.mid", 116,
    [("Kite Notes", [(0, 200, 67, 80), (240, 200, 71, 82), (480, 200, 74, 86), (720, 430, 79, 90), (1440, 200, 76, 84), (1680, 200, 74, 82), (1920, 430, 71, 82), (2400, 200, 69, 79), (2640, 200, 71, 82), (2880, 430, 74, 86), (3360, 200, 72, 80), (3600, 200, 69, 78), (3840, 850, 67, 84)])],
    "Paper Kite")
