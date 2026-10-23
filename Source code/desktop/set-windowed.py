# Flips a Windows .exe from the console subsystem (3) to the GUI subsystem (2)
# by editing the Subsystem field of its PE optional header. Nothing else in
# the file changes, so pkg's appended program data is untouched.
import struct, sys
path = sys.argv[1]
with open(path, "r+b") as f:
    data = f.read(4096)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    assert data[pe:pe + 4] == b"PE\0\0", "not a PE file"
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    assert magic in (0x10B, 0x20B), "unknown optional header"
    field = optional + 68  # Subsystem, same offset for PE32 and PE32+
    current = struct.unpack_from("<H", data, field)[0]
    print("subsystem was", current)
    f.seek(field)
    f.write(struct.pack("<H", 2))
    print("subsystem now 2 (windows GUI)")
