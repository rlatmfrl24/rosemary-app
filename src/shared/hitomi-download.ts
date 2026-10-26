export interface DownloadSource {
	provider: "e-hentai" | "hitomi";
	galleryId: string;
	sourceUrl: string;
}

export type DownloadTransferStatus =
	| "pending"
	| "submitting"
	| "sent"
	| "unknown"
	| "invalid"
	| "failed";

export interface DownloadReceipt extends DownloadSource {
	status: DownloadTransferStatus | "excluded";
	downloadCompletion: "unverified";
	lastError: string | null;
}

export const parseDownloadSource = (value: string): DownloadSource => {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.port)
		throw new Error("다운로드 원본은 허용된 HTTPS 작품 URL이어야 합니다.");
	const isEhentai = ["e-hentai.org", "exhentai.org"].includes(url.hostname);
	const match = isEhentai
		? url.pathname.match(/^\/g\/([1-9]\d*)\/([a-f0-9]{10})\/?$/i)
		: url.hostname === "hitomi.la"
			? url.pathname.match(/^\/galleries\/([1-9]\d*)\.html$/)
			: null;
	if (!match)
		throw new Error("공급자·작품 ID·토큰을 확인할 수 없는 원본입니다.");
	return {
		provider: isEhentai ? "e-hentai" : "hitomi",
		galleryId: match[1],
		sourceUrl: isEhentai
			? `https://${url.hostname}/g/${match[1]}/${match[2].toLowerCase()}/`
			: `https://hitomi.la/galleries/${match[1]}.html`,
	};
};

export const validateDownloadSource = (
	source: DownloadSource,
): DownloadSource => {
	const parsed = parseDownloadSource(source.sourceUrl);
	if (
		parsed.provider !== source.provider ||
		parsed.galleryId !== source.galleryId
	)
		throw new Error("다운로드 원본의 공급자와 작품 ID가 일치하지 않습니다.");
	return parsed;
};

export const getDownloadSourceKey = (source: DownloadSource): string => {
	const parsed = validateDownloadSource(source);
	const token =
		parsed.provider === "e-hentai"
			? new URL(parsed.sourceUrl).pathname.split("/")[3]
			: "";
	return `${parsed.provider}:${parsed.galleryId}:${token}`;
};
