import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const rootDir = process.cwd();
const assetsDir = path.join(rootDir, 'assets');
const iconsDir = path.join(assetsDir, 'icons');
const publicDir = path.join(rootDir, 'public');
const sourceSvg = path.join(assetsDir, 'icon.svg');
const sourcePng = path.join(assetsDir, 'icon.png');
const sizes = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const icoSizes = sizes.filter((size) => size <= 256);

async function writeIcoFromPngs(outputFile) {
  const pngs = await Promise.all(
    icoSizes.map(async (size) => ({
      size,
      data: await readFile(path.join(iconsDir, `${size}x${size}.png`)),
    }))
  );

  const headerSize = 6;
  const entrySize = 16;
  const header = Buffer.alloc(headerSize + entrySize * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);

  let imageOffset = header.length;
  for (const [index, png] of pngs.entries()) {
    const entryOffset = headerSize + entrySize * index;
    header.writeUInt8(png.size === 256 ? 0 : png.size, entryOffset);
    header.writeUInt8(png.size === 256 ? 0 : png.size, entryOffset + 1);
    header.writeUInt8(0, entryOffset + 2);
    header.writeUInt8(0, entryOffset + 3);
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(png.data.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += png.data.length;
  }

  await writeFile(outputFile, Buffer.concat([header, ...pngs.map((png) => png.data)]));
}

if (!existsSync(sourceSvg)) {
  throw new Error(`Missing source icon: ${sourceSvg}`);
}

await mkdir(iconsDir, { recursive: true });
await mkdir(publicDir, { recursive: true });

for (const size of sizes) {
  await sharp(sourceSvg, { density: 384 })
    .resize(size, size, { fit: 'contain' })
    .png()
    .toFile(path.join(iconsDir, `${size}x${size}.png`));
}

await sharp(sourceSvg, { density: 384 })
  .resize(1024, 1024, { fit: 'contain' })
  .png()
  .toFile(sourcePng);

await copyFile(sourceSvg, path.join(publicDir, 'icon.svg'));
await copyFile(path.join(iconsDir, '256x256.png'), path.join(publicDir, 'icon.png'));

await writeIcoFromPngs(path.join(assetsDir, 'icon.ico'));

console.log('Generated Neon Equalizer icons in assets/ and public/.');
