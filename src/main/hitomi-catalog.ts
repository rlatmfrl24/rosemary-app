import * as path from "node:path";

const MAX_CONTAINER_LENGTH = 2_000_000;
const MAX_DEPTH = 64;

class MessagePackReader {
	private offset = 0;
	private readonly buffer: Buffer;

	constructor(buffer: Buffer) {
		this.buffer = buffer;
	}

	public readRootArray(
		onItem: (
			value: unknown,
			index: number,
			span: { offset: number; length: number },
		) => void,
		signal?: AbortSignal,
	): number {
		const length = this.readArrayLength();
		for (let index = 0; index < length; index += 1) {
			if (index % 256 === 0 && signal?.aborted) {
				throw signal.reason ?? new DOMException("aborted", "AbortError");
			}
			const offset = this.offset;
			const value = this.readValue(0);
			onItem(value, index, { offset, length: this.offset - offset });
		}
		if (this.offset !== this.buffer.length) {
			throw new Error("MessagePack 끝에 해석되지 않은 데이터가 있습니다.");
		}
		return length;
	}

	public readSingleValue(): unknown {
		const value = this.readValue(0);
		if (this.offset !== this.buffer.length) {
			throw new Error("MessagePack 값 뒤에 해석되지 않은 데이터가 있습니다.");
		}
		return value;
	}

	private readArrayLength(): number {
		const prefix = this.readUInt8();
		if ((prefix & 0xf0) === 0x90) {
			return prefix & 0x0f;
		}
		if (prefix === 0xdc) {
			return this.readUInt16();
		}
		if (prefix === 0xdd) {
			return this.validateLength(this.readUInt32());
		}
		throw new Error("Hitomi 카탈로그 루트가 배열이 아닙니다.");
	}

	private readValue(depth: number): unknown {
		if (depth > MAX_DEPTH) {
			throw new Error("MessagePack 중첩 깊이가 제한을 초과했습니다.");
		}
		const prefix = this.readUInt8();
		if (prefix <= 0x7f) return prefix;
		if (prefix >= 0xe0) return prefix - 0x100;
		if ((prefix & 0xe0) === 0xa0) return this.readString(prefix & 0x1f);
		if ((prefix & 0xf0) === 0x90) return this.readArray(prefix & 0x0f, depth);
		if ((prefix & 0xf0) === 0x80) return this.readMap(prefix & 0x0f, depth);

		switch (prefix) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return this.readBinary(this.readUInt8());
			case 0xc5:
				return this.readBinary(this.readUInt16());
			case 0xc6:
				return this.readBinary(this.validateLength(this.readUInt32()));
			case 0xca:
				return this.readNumber(4, (offset) => this.buffer.readFloatBE(offset));
			case 0xcb:
				return this.readNumber(8, (offset) => this.buffer.readDoubleBE(offset));
			case 0xcc:
				return this.readUInt8();
			case 0xcd:
				return this.readUInt16();
			case 0xce:
				return this.readUInt32();
			case 0xcf:
				return this.readBigInt(false);
			case 0xd0:
				return this.readNumber(1, (offset) => this.buffer.readInt8(offset));
			case 0xd1:
				return this.readNumber(2, (offset) => this.buffer.readInt16BE(offset));
			case 0xd2:
				return this.readNumber(4, (offset) => this.buffer.readInt32BE(offset));
			case 0xd3:
				return this.readBigInt(true);
			case 0xd9:
				return this.readString(this.readUInt8());
			case 0xda:
				return this.readString(this.readUInt16());
			case 0xdb:
				return this.readString(this.validateLength(this.readUInt32()));
			case 0xdc:
				return this.readArray(this.readUInt16(), depth);
			case 0xdd:
				return this.readArray(this.validateLength(this.readUInt32()), depth);
			case 0xde:
				return this.readMap(this.readUInt16(), depth);
			case 0xdf:
				return this.readMap(this.validateLength(this.readUInt32()), depth);
			default:
				throw new Error(
					`지원하지 않는 MessagePack 형식입니다. (0x${prefix.toString(16)})`,
				);
		}
	}

	private readArray(length: number, depth: number): unknown[] {
		this.validateLength(length);
		return Array.from({ length }, () => this.readValue(depth + 1));
	}

	private readMap(length: number, depth: number): Record<string, unknown> {
		this.validateLength(length);
		const result: Record<string, unknown> = {};
		for (let index = 0; index < length; index += 1) {
			const key = this.readValue(depth + 1);
			if (typeof key !== "string") {
				throw new Error("MessagePack 객체 키가 문자열이 아닙니다.");
			}
			result[key] = this.readValue(depth + 1);
		}
		return result;
	}

	private readString(length: number): string {
		this.ensureAvailable(length);
		const value = this.buffer.toString(
			"utf8",
			this.offset,
			this.offset + length,
		);
		this.offset += length;
		return value;
	}

	private readBinary(length: number): Buffer {
		this.ensureAvailable(length);
		const value = this.buffer.subarray(this.offset, this.offset + length);
		this.offset += length;
		return value;
	}

	private readUInt8(): number {
		return this.readNumber(1, (offset) => this.buffer.readUInt8(offset));
	}

	private readUInt16(): number {
		return this.readNumber(2, (offset) => this.buffer.readUInt16BE(offset));
	}

	private readUInt32(): number {
		return this.readNumber(4, (offset) => this.buffer.readUInt32BE(offset));
	}

	private readBigInt(signed: boolean): number | bigint {
		this.ensureAvailable(8);
		const value = signed
			? this.buffer.readBigInt64BE(this.offset)
			: this.buffer.readBigUInt64BE(this.offset);
		this.offset += 8;
		return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
			value >= BigInt(Number.MIN_SAFE_INTEGER)
			? Number(value)
			: value;
	}

	private readNumber(
		byteLength: number,
		reader: (offset: number) => number,
	): number {
		this.ensureAvailable(byteLength);
		const value = reader(this.offset);
		this.offset += byteLength;
		return value;
	}

	private ensureAvailable(byteLength: number): void {
		if (
			!Number.isSafeInteger(byteLength) ||
			byteLength < 0 ||
			this.offset + byteLength > this.buffer.length
		) {
			throw new Error(
				"MessagePack 데이터가 잘렸거나 길이가 올바르지 않습니다.",
			);
		}
	}

	private validateLength(length: number): number {
		if (
			!Number.isSafeInteger(length) ||
			length < 0 ||
			length > MAX_CONTAINER_LENGTH
		) {
			throw new Error("MessagePack 컨테이너 길이가 제한을 초과했습니다.");
		}
		return length;
	}
}

export const decodeMessagePackArray = (
	buffer: Buffer,
	onItem: (
		value: unknown,
		index: number,
		span: { offset: number; length: number },
	) => void,
	signal?: AbortSignal,
): number => new MessagePackReader(buffer).readRootArray(onItem, signal);

export const decodeMessagePackValue = (buffer: Buffer): unknown =>
	new MessagePackReader(buffer).readSingleValue();

export const getHitomiCatalogPath = (
	hitomiDownloaderPath: string,
): string | null => {
	const executablePath = hitomiDownloaderPath.trim();
	if (!executablePath) {
		return null;
	}
	return path.join(path.dirname(executablePath), "hitomi_data");
};
