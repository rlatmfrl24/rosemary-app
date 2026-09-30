import type { FileHandle } from "node:fs/promises";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflateRawAsync = promisify(inflateRaw);

export const readBuffer = async (
	handle: FileHandle,
	length: number,
	position: number,
): Promise<Buffer | null> => {
	const buffer = Buffer.alloc(length);
	let bytesRead = 0;
	while (bytesRead < length) {
		const result = await handle.read(
			buffer,
			bytesRead,
			length - bytesRead,
			position + bytesRead,
		);
		if (result.bytesRead === 0) return null;
		bytesRead += result.bytesRead;
	}
	return buffer;
};

export const readZipImageBuffer = async (
	handle: FileHandle,
	entry: {
		localHeaderOffset: number;
		compressedSize: number;
		uncompressedSize: number;
		method: number;
	},
	maxOutputLength: number,
): Promise<Buffer | null> => {
	if (entry.uncompressedSize <= 0 || entry.uncompressedSize > maxOutputLength)
		return null;
	const header = await readBuffer(handle, 30, entry.localHeaderOffset);
	if (!header || header.readUInt32LE(0) !== 0x04034b50) return null;
	const offset =
		entry.localHeaderOffset +
		30 +
		header.readUInt16LE(26) +
		header.readUInt16LE(28);
	const compressed = await readBuffer(handle, entry.compressedSize, offset);
	if (!compressed) return null;
	if (entry.method !== 0 && entry.method !== 8) return null;
	const output =
		entry.method === 0
			? compressed
			: await inflateRawAsync(compressed, {
					maxOutputLength: entry.uncompressedSize,
				});
	return output.length === entry.uncompressedSize ? output : null;
};
