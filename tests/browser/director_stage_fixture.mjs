import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

export function makeGlb() {
  const json = Buffer.from(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0 },
              indices: 1,
            },
          ],
        },
      ],
      buffers: [{ byteLength: 42 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: "VEC3",
          min: [0, 0, 0],
          max: [1, 1, 0],
        },
        { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
      ],
    }),
  );
  const jsonChunk = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const binary = Buffer.alloc(44);
  binary.writeFloatLE(0, 0);
  binary.writeFloatLE(0, 4);
  binary.writeFloatLE(0, 8);
  binary.writeFloatLE(1, 12);
  binary.writeFloatLE(0, 16);
  binary.writeFloatLE(0, 20);
  binary.writeFloatLE(0, 24);
  binary.writeFloatLE(1, 28);
  binary.writeFloatLE(0, 32);
  binary.writeUInt16LE(0, 36);
  binary.writeUInt16LE(1, 38);
  binary.writeUInt16LE(2, 40);
  const chunk = (type, data) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(data.length, 0);
    header.writeUInt32LE(type, 4);
    return Buffer.concat([header, data]);
  };
  const body = Buffer.concat([
    chunk(0x4e4f534a, jsonChunk),
    chunk(0x004e4942, binary),
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: node director_stage_fixture.mjs <path>");
  writeFileSync(destination, makeGlb());
  console.log(destination);
}
