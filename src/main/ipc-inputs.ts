import * as path from "node:path";
import { validateSettings } from "./settings";

const invalid = (): never => {
	throw new Error("요청 값이 올바르지 않습니다.");
};
const record = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
};
const text = (value: unknown, empty = false): void => {
	if (
		typeof value !== "string" ||
		value.length > 32768 ||
		value.includes("\0") ||
		(!empty && !value.trim())
	)
		invalid();
};
const filePath = (value: unknown): void => {
	text(value);
	if (!path.isAbsolute(value as string)) invalid();
};
const number = (
	value: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): void => {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max
	)
		invalid();
};
const integer = (
	value: unknown,
	min = 0,
	max = Number.MAX_SAFE_INTEGER,
): void => {
	number(value, min, max);
	if (!Number.isInteger(value)) invalid();
};
const boolean = (value: unknown): void => {
	if (typeof value !== "boolean") invalid();
};
const array = (value: unknown, validate: (item: unknown) => void): void => {
	if (!Array.isArray(value) || value.length > 100_000) invalid();
	for (const item of value as unknown[]) validate(item);
};
const optional = (value: unknown, validate: (item: unknown) => void): void => {
	if (value !== undefined) validate(value);
};
const choice = (value: unknown, values: string[]): void => {
	if (!values.includes(value as string)) invalid();
};
const file = (value: unknown): void => {
	const item = record(value);
	filePath(item.path);
	text(item.name);
	integer(item.size);
	if (path.basename(item.path as string) !== item.name) invalid();
	for (const key of ["artist", "type", "origin"])
		optional(item[key], (value) => text(value, true));
};
const segment = (value: unknown): void => {
	text(value);
	if (/[\\/]/.test(value as string) || value === "." || value === "..")
		invalid();
};
const tag = (value: unknown): void => {
	const item = record(value);
	text(item.namespace);
	text(item.value);
};
const input = (value: unknown): void => {
	const item = record(value);
	for (const key of ["code", "type", "name", "link"]) text(item[key]);
	if (item.sourceCursor !== null)
		optional(item.sourceCursor, (value) => text(value, true));
	optional(item.discoveredAt, text);
};
const options = (value: unknown, similar: boolean): void => {
	const item = record(value);
	filePath(item.sourcePath);
	boolean(item.recursive);
	for (const key of ["forceRefresh", "includeReviewed", "includeSuspicious"])
		optional(item[key], boolean);
	for (const key of ["includeKeyword", "excludeKeyword"])
		optional(item[key], (value) => text(value, true));
	if (similar) {
		integer(item.minGroupSize, 2, 100_000);
		number(item.minConfidence, 0, 100);
		optional(item.queue, (value) =>
			choice(value, ["safe", "cleanup", "series", "merge", "suspicious"]),
		);
		optional(item.contentScanMode, (value) =>
			choice(value, ["off", "metadata", "smart", "sample"]),
		);
	} else {
		integer(item.limit, 1, 100_000);
		for (const key of ["modifiedBeforeMs", "minSizeBytes", "maxSizeBytes"])
			optional(item[key], number);
		optional(item.preferredTags, (value) => array(value, tag));
	}
};
const noArguments = new Set([
	"get-target-path",
	"get-settings",
	"launch-hitomi-downloader",
	"hitomi-api-install",
	"hitomi-api-status",
	"hitomi-api-prepare",
	"crawl-stop",
	"crawl-status",
	"crawl-db-summary",
	"hitomi-catalog-index-status",
	"crawl-db-reset",
	"tag-preferences-list",
	"archive-metadata-recovery-start",
	"archive-metadata-recovery-pause",
	"archive-metadata-recovery-resume",
	"archive-metadata-recovery-status",
	"archive-metadata-recovery-retry",
]);
export const validateIpcInputs = (channel: string, args: unknown[]): void => {
	if (noArguments.has(channel)) {
		if (args.length) invalid();
		return;
	}
	switch (channel) {
		case "clipboard-write-text":
			text(args[0], true);
			break;
		case "save-settings": {
			const settings = validateSettings(args[0]);
			for (const [key, value] of Object.entries(settings))
				if (typeof value === "string") {
					text(value, true);
					if (value && key.endsWith("Path")) filePath(value);
				}
			break;
		}
		case "hitomi-api-send-codes":
		case "archive-metadata-recovery-entries":
			array(args[0], (value) => {
				text(value);
				if (!/^\d+$/.test(value as string)) invalid();
			});
			break;
		case "crawl-start":
			integer(record(args[0]).maxPages, 1, 100_000);
			break;
		case "crawl-recent-items":
		case "crawl-db-list-items": {
			const item = args[0] === undefined ? {} : record(args[0]);
			optional(item.runId, (value) => integer(value, 1));
			optional(item.limit, (value) => integer(value, 1, 100_000));
			optional(item.query, (value) => text(value, true));
			optional(item.type, (value) => text(value, true));
			break;
		}
		case "crawl-download-retry":
			optional(args[0], (value) => integer(value, 1));
			break;
		case "crawl-db-create-item":
			input(args[0]);
			break;
		case "crawl-db-update-item":
			text(args[0]);
			input(args[1]);
			break;
		case "crawl-db-delete-item":
			text(args[0]);
			break;
		case "tag-preferences-upsert":
			tag(args[0]);
			choice(record(args[0]).kind, ["preferred", "excluded"]);
			break;
		case "tag-preferences-delete":
			tag(args[0]);
			break;
		case "archive-metadata-recovery-enqueue-files":
		case "trash-files":
			array(args[0], filePath);
			break;
		case "archive-metadata-recovery-failures":
			optional(args[0], (value) => integer(value, 1, 200));
			break;
		case "select-file-path":
			text(args[0]);
			optional(args[1], (value) =>
				array(value, (filter) => {
					const item = record(filter);
					text(item.name);
					array(item.extensions, text);
				}),
			);
			break;
		case "scan-files":
		case "get-file-thumbnail":
		case "delete-file":
		case "open-with-bandiview":
		case "keep-file":
		case "preview-grouped-folder-migration":
		case "execute-grouped-folder-migration":
			filePath(args[0]);
			break;
		case "random-review-files":
			options(args[0], false);
			break;
		case "preview-similar-group-batch": {
			const request = record(args[0]);
			options(request.options, true);
			optional(request.groupId, text);
			optional(request.retryPlanId, text);
			break;
		}
		case "execute-similar-group-batch":
			text(args[0]);
			array(args[1], text);
			break;
		case "cancel-similar-group-batch":
			text(args[0]);
			break;
		case "find-similar-groups":
			options(args[0], true);
			break;
		case "find-group-merge-candidates":
		case "check-duplicate-files":
			array(args[0], file);
			filePath(args[1]);
			break;
		case "find-favorite-artist-candidates":
			array(args[0], file);
			break;
		case "copy-file":
		case "move-file":
			filePath(args[0]);
			filePath(args[1]);
			break;
		case "move-file-to-favorite-artist":
			filePath(args[0]);
			segment(args[1]);
			break;
		case "move-group-to-folder":
			filePath(args[0]);
			array(args[1], filePath);
			segment(args[2]);
			optional(args[3], (value) => {
				const item = record(value);
				for (const key of ["type", "origin", "artist", "title"])
					segment(item[key]);
			});
			break;
		case "merge-files-to-group":
			filePath(args[0]);
			array(args[1], filePath);
			filePath(args[2]);
			break;
		case "mark-similar-group-review-state": {
			const item = record(args[0]);
			text(item.reviewKey);
			text(item.contentSignature);
			choice(item.status, ["ignored", "confirmed"]);
			break;
		}
		case "clear-similar-group-review-state":
			text(args[0]);
			optional(args[1], text);
			break;
		case "move-all-files-to-store": {
			array(args[0], file);
			filePath(args[1]);
			for (const [key, value] of Object.entries(record(args[2] ?? {}))) {
				text(key);
				if (path.isAbsolute(key)) invalid();
				const item = record(value);
				choice(item.action, ["overwrite", "skip"]);
				filePath(item.targetPath);
				integer(item.targetSize);
				number(item.targetModifiedTimeMs);
			}
			for (const [key, value] of Object.entries(record(args[3] ?? {}))) {
				text(key);
				filePath(value);
			}
			break;
		}
		default:
			invalid();
	}
};
