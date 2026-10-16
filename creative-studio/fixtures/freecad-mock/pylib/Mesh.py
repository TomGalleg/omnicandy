# MOCK Mesh module (test double, not FreeCAD). Binary STL whose 80-byte header carries the volume.
import re
import struct


class Mesh(object):
    def __init__(self, path=None, volume=0.0):
        self.Volume = volume
        self.CountFacets = 12 if volume > 0 else 0
        if path:
            data = open(path, 'rb').read()
            m = re.match(rb'MOCK volume=([0-9.eE+-]+)', data[:80])
            if not m:
                raise ValueError('not an STL file the mock can read')
            self.Volume = float(m.group(1))
            self.CountFacets = struct.unpack('<I', data[80:84])[0]

    def write(self, path):
        head = ('MOCK volume=%r' % self.Volume).encode().ljust(80, b' ')
        with open(path, 'wb') as f:
            f.write(head + struct.pack('<I', self.CountFacets) + b'\0' * (50 * self.CountFacets))
