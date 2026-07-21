import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	createGalleryMetadataRequestPayload,
	mapGalleryMetadataBatchResponse,
	parseGalleryIdentity,
} from "../src/shared/gallery-metadata.ts";

const API_URL = "https://api.e-hentai.org/api.php";
const REQUIRED_BATCH_SIZE = 25;
const MAX_RETRY_COUNT = 2;

const getArgument = (name) => {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
};

const databasePath = getArgument("--db");
const outputPath = getArgument("--output");
if (!databasePath || !outputPath) {
	console.error(
		"사용법: pnpm validate:metadata-api -- --db <crawler.sqlite 사본> --output <결과.json>",
	);
	process.exit(2);
}

const delay = async (milliseconds) =>
	await new Promise((resolve) => setTimeout(resolve, milliseconds));

const writeResult = (result) => {
	const resolvedOutputPath = path.resolve(outputPath);
	mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
	writeFileSync(
		resolvedOutputPath,
		`${JSON.stringify(result, null, 2)}\n`,
		"utf8",
	);
};

const startedAt = new Date();
let attemptCount = 0;
let httpStatus = null;

try {
	const database = new DatabaseSync(path.resolve(databasePath), {
		readOnly: true,
	});
	let identities;
	try {
		const rows = database
			.prepare(
				`SELECT item.code, item.link
				 FROM crawl_items AS item
				 JOIN crawl_item_metadata AS metadata
				   ON metadata.gallery_id = item.code
				 WHERE metadata.expunged = 0
				 ORDER BY metadata.fetched_at DESC, CAST(item.code AS INTEGER) DESC
				 LIMIT 250`,
			)
			.all();
		const identitiesByGalleryId = new Map();
		for (const row of rows) {
			const identity = parseGalleryIdentity(row.link);
			if (identity?.galleryId === row.code) {
				identitiesByGalleryId.set(identity.galleryId, identity);
			}
		}
		identities = [...identitiesByGalleryId.values()].slice(
			0,
			REQUIRED_BATCH_SIZE,
		);
	} finally {
		database.close();
	}

	if (identities.length !== REQUIRED_BATCH_SIZE) {
		throw new Error(
			`유효한 gallery id와 token을 ${REQUIRED_BATCH_SIZE}개 확보하지 못했습니다. (${identities.length}개)`,
		);
	}

	const requestPayload = createGalleryMetadataRequestPayload(identities);
	if (
		requestPayload.gidlist.length !== REQUIRED_BATCH_SIZE ||
		requestPayload.namespace !== 1
	) {
		throw new Error("25개 namespace 요청 payload 검증에 실패했습니다.");
	}

	let responseBody;
	for (let attempt = 0; attempt <= MAX_RETRY_COUNT; attempt += 1) {
		attemptCount = attempt + 1;
		try {
			const response = await fetch(API_URL, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": "rosemary-app/8.3.0 metadata-release-validation",
				},
				body: JSON.stringify(requestPayload),
			});
			httpStatus = response.status;
			if ((response.status === 429 || response.status >= 500) && attempt < 2) {
				await delay(2000 * (attempt + 1));
				continue;
			}
			if (!response.ok) {
				throw new Error(`E-Hentai API HTTP ${response.status}`);
			}
			responseBody = await response.json();
			break;
		} catch (error) {
			if (attempt >= MAX_RETRY_COUNT) throw error;
			await delay(2000 * (attempt + 1));
		}
	}

	const rawMetadata = Array.isArray(responseBody?.gmetadata)
		? responseBody.gmetadata
		: [];
	const mapped = mapGalleryMetadataBatchResponse(
		rawMetadata,
		identities,
		new Date().toISOString(),
	);
	const finishedAt = new Date();
	const result = {
		passed:
			httpStatus === 200 &&
			mapped.metadata.length === REQUIRED_BATCH_SIZE &&
			mapped.failures.size === 0,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		requestCount: REQUIRED_BATCH_SIZE,
		namespace: requestPayload.namespace,
		attemptCount,
		httpStatus,
		responseCount: rawMetadata.length,
		successCount: mapped.metadata.length,
		failureCount: mapped.failures.size,
		tokensIncludedInReport: false,
	};
	writeResult(result);
	console.log(JSON.stringify(result, null, 2));
	if (!result.passed) process.exit(1);
} catch (error) {
	const finishedAt = new Date();
	const result = {
		passed: false,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		requestCount: REQUIRED_BATCH_SIZE,
		namespace: 1,
		attemptCount,
		httpStatus,
		responseCount: 0,
		successCount: 0,
		failureCount: REQUIRED_BATCH_SIZE,
		tokensIncludedInReport: false,
		error: error instanceof Error ? error.message : String(error),
	};
	writeResult(result);
	console.error(JSON.stringify(result, null, 2));
	process.exit(1);
}
