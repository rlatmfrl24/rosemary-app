import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { startTlsRecordProxy } from "../src/main/crawler-tls-proxy.ts";

const listen = (server) =>
	new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const connect = async (proxyUrl, authority) => {
	const socket = net.connect(new URL(proxyUrl).port, "127.0.0.1");
	const response = new Promise((resolve, reject) => {
		socket.once("error", reject);
		socket.once("data", (chunk) => resolve(chunk.toString()));
	});
	socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
	return { socket, response: await response };
};

test("TLS 레코드를 나눠도 초기 협상 바이트와 뒤따르는 레코드를 보존한다", async (t) => {
	const received = [];
	let complete;
	const captured = new Promise((resolve) => {
		complete = resolve;
	});
	const server = net.createServer((socket) => {
		socket.on("data", (chunk) => {
			received.push(chunk);
			if (Buffer.concat(received).length === wire.length + 5)
				complete(Buffer.concat(received));
		});
	});
	await listen(server);
	const authority = `127.0.0.1:${server.address().port}`;
	const proxy = await startTlsRecordProxy([new URL(`https://${authority}`)]);
	t.after(async () => {
		await proxy.close();
		await new Promise((resolve) => server.close(resolve));
	});
	const payload = Buffer.from("\x01handshake-before-127.0.0.1-handshake-after");
	const header = Buffer.from([22, 3, 1, 0, payload.length]);
	const trailing = Buffer.from([20, 3, 3, 0, 1, 1]);
	const wire = Buffer.concat([header, payload, trailing]);
	const { socket, response } = await connect(proxy.url, authority);
	assert.match(response, /^HTTP\/1\.1 200 /);
	socket.write(wire.subarray(0, 3));
	await new Promise((resolve) => setImmediate(resolve));
	socket.write(wire.subarray(3));
	const result = await captured;
	const firstEnd = 5 + result.readUInt16BE(3);
	const secondEnd = firstEnd + 5 + result.readUInt16BE(firstEnd + 3);
	assert.deepEqual(result.subarray(0, 3), header.subarray(0, 3));
	assert.deepEqual(
		result.subarray(firstEnd, firstEnd + 3),
		header.subarray(0, 3),
	);
	assert.deepEqual(
		Buffer.concat([
			result.subarray(5, firstEnd),
			result.subarray(firstEnd + 5, secondEnd),
		]),
		payload,
	);
	assert.deepEqual(result.subarray(secondEnd), trailing);
	assert.equal(result.subarray(5, firstEnd).includes("127.0.0.1"), false);
	assert.equal(
		result.subarray(firstEnd + 5, secondEnd).includes("127.0.0.1"),
		false,
	);
});

test("허용하지 않은 목적지와 포트에는 연결하지 않는다", async (t) => {
	const proxy = await startTlsRecordProxy([new URL("https://e-hentai.org")]);
	t.after(() => proxy.close());
	for (const authority of [
		"example.com:443",
		"e-hentai.org:80",
		"user@e-hentai.org:443",
		"e-hentai.org:443/path",
	]) {
		const { socket, response } = await connect(proxy.url, authority);
		assert.match(response, /^HTTP\/1\.1 403 /);
		socket.destroy();
	}
});

test("서버가 응답 직후 연결을 닫아도 수신 데이터를 끝까지 전달한다", async (t) => {
	const body = Buffer.alloc(256 * 1024, 42);
	const hello = Buffer.from([22, 3, 1, 0, 1, 1]);
	const server = net.createServer((socket) => {
		const chunks = [];
		socket.on("data", (chunk) => {
			chunks.push(chunk);
			const received = Buffer.concat(chunks);
			if (received.length < hello.length) return;
			assert.deepEqual(received, hello);
			socket.end(body);
		});
	});
	await listen(server);
	const authority = `127.0.0.1:${server.address().port}`;
	const proxy = await startTlsRecordProxy([new URL(`https://${authority}`)]);
	t.after(async () => {
		await proxy.close();
		await new Promise((resolve) => server.close(resolve));
	});
	const { socket } = await connect(proxy.url, authority);
	const chunks = [];
	const completed = new Promise((resolve, reject) => {
		socket.on("data", (chunk) => chunks.push(chunk));
		socket.once("end", resolve);
		socket.once("error", reject);
	});
	socket.write(hello);
	await completed;
	assert.deepEqual(Buffer.concat(chunks), body);
});
