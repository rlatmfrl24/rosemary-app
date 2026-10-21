import * as net from "node:net";
import { Transform } from "node:stream";

const splitClientHello = (hostname: string): Transform => {
	let pending = Buffer.alloc(0);
	let complete = false;
	return new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (complete) {
				callback(null, chunk);
				return;
			}
			pending = Buffer.concat([pending, chunk]);
			if (pending.length < 5) {
				callback();
				return;
			}
			const length = pending.readUInt16BE(3);
			if (pending[0] !== 22 || length > 16_384) {
				callback(new Error("잘못된 TLS 초기 레코드입니다."));
				return;
			}
			const end = 5 + length;
			if (pending.length < end) {
				callback();
				return;
			}
			complete = true;
			const offset = pending.subarray(5, end).indexOf(hostname);
			if (offset < 0) {
				callback(null, pending);
				pending = Buffer.alloc(0);
				return;
			}
			// Split record framing only; the authenticated TLS handshake stays intact.
			const split = 5 + offset + Math.floor(Buffer.byteLength(hostname) / 2);
			const first = Buffer.from(pending.subarray(0, 5));
			const second = Buffer.from(first);
			first.writeUInt16BE(split - 5, 3);
			second.writeUInt16BE(end - split, 3);
			callback(
				null,
				Buffer.concat([
					first,
					pending.subarray(5, split),
					second,
					pending.subarray(split),
				]),
			);
			pending = Buffer.alloc(0);
		},
	});
};

export const startTlsRecordProxy = async (
	origins: readonly URL[],
): Promise<{ url: string; close: () => Promise<void> }> => {
	const allowedOrigins = new Set(origins.map((origin) => origin.origin));
	const clients = new Set<net.Socket>();
	const server = net.createServer((client) => {
		clients.add(client);
		let header = Buffer.alloc(0);
		let upstream: net.Socket | undefined;
		let framing: Transform | undefined;
		const stop = () => {
			client.destroy();
			upstream?.destroy();
			framing?.destroy();
		};
		client.on("error", stop);
		client.once("close", () => {
			clients.delete(client);
			upstream?.destroy();
			framing?.destroy();
		});
		client.setTimeout(30_000, stop);
		const receiveConnect = (chunk: Buffer) => {
			header = Buffer.concat([header, chunk]);
			const end = header.indexOf("\r\n\r\n");
			if (end < 0 && header.length <= 8192) return;
			const authority = header
				.toString("latin1")
				.match(/^CONNECT ([^\s]+) HTTP\/1\.[01]\r\n/)?.[1];
			let target: URL;
			try {
				target = new URL(`https://${authority ?? ""}`);
				if (
					end < 0 ||
					end > 8192 ||
					target.username ||
					target.password ||
					target.pathname !== "/" ||
					target.search ||
					target.hash ||
					!allowedOrigins.has(target.origin)
				)
					throw new Error("허용하지 않은 크롤링 목적지입니다.");
			} catch {
				client.end(
					"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
				);
				client.removeListener("data", receiveConnect);
				return;
			}
			client.pause();
			client.removeListener("data", receiveConnect);
			const remaining = header.subarray(end + 4);
			header = Buffer.alloc(0);
			upstream = net.connect({
				host: target.hostname,
				port: Number(target.port || 443),
			});
			upstream.on("error", stop);
			upstream.once("close", () => {
				if (!upstream?.readableEnded) stop();
			});
			upstream.once("connect", () => {
				if (client.destroyed || !upstream) return;
				client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
				framing = splitClientHello(target.hostname);
				framing.on("error", stop);
				framing.pipe(upstream);
				if (remaining.length) framing.write(remaining);
				client.pipe(framing);
				upstream.pipe(client);
				client.resume();
			});
		};
		client.on("data", receiveConnect);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	server.unref();
	const address = server.address() as net.AddressInfo;
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				for (const client of clients) client.destroy();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
};
