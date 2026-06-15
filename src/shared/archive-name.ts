export interface ParsedArchiveName {
	artist?: string;
	category?: string;
	code?: string;
	title: string;
	baseTitle: string;
	normalizedTitle: string;
	bracketTags: string[];
	seriesTokens: string[];
	editionTokens: string[];
}

interface TokenPattern {
	label: string;
	regex: RegExp;
}

const SERIES_TOKEN_PATTERNS: TokenPattern[] = [
	{
		label: "chapter",
		regex: /\b(?:ch|chapter)\.?\s*\d{1,4}\b/gi,
	},
	{
		label: "volume",
		regex: /\b(?:vol|volume)\.?\s*\d{1,4}\b/gi,
	},
	{
		label: "part",
		regex: /\b(?:part|pt)\.?\s*\d{1,4}\b/gi,
	},
	{
		label: "episode",
		regex: /\b(?:ep|episode)\.?\s*\d{1,4}\b/gi,
	},
	{
		label: "number",
		regex: /(?:^|\s)(?:#|no\.?)?\s*\d{1,3}(?:\s|$)/gi,
	},
	{
		label: "korean-number",
		regex: /(?:제\s*)?\d{1,3}\s*(?:권|화|편|부)/g,
	},
	{
		label: "extra",
		regex:
			/\b(?:extra|extras|appendix|omake|bonus|after|side story|sequel|prequel)\b/gi,
	},
];

const EDITION_TOKEN_PATTERNS: TokenPattern[] = [
	{
		label: "decensored",
		regex: /\bdecensored\b/gi,
	},
	{
		label: "uncensored",
		regex: /\buncensored\b/gi,
	},
	{
		label: "digital",
		regex: /\bdigital\b/gi,
	},
	{
		label: "color",
		regex: /\b(?:full color|color)\b/gi,
	},
	{
		label: "revision",
		regex: /\b(?:rev|revised|v\d+|ver\.?\s*\d+)\b/gi,
	},
	{
		label: "complete",
		regex: /\b(?:complete|final|compilation)\b/gi,
	},
];

export const stripArchiveExtension = (fileName: string): string =>
	fileName.replace(/\.[^/.]+$/, "");

export const normalizeArchiveText = (value: string): string =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u200b\u200c\u200d]/g, "")
		.replace(/[_\-./\\:;,'"!?~`]+/g, " ")
		.replace(/[[\]{}()]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const extractCode = (
	value: string,
): {
	code?: string;
	rest: string;
} => {
	const codeMatch = value.match(/\s*\((\d{4,})\)\s*$/);
	if (!codeMatch || typeof codeMatch.index !== "number") {
		return { rest: value.trim() };
	}

	return {
		code: codeMatch[1],
		rest: value.slice(0, codeMatch.index).trim(),
	};
};

const extractLeadingBrackets = (
	value: string,
): {
	brackets: string[];
	rest: string;
} => {
	const brackets: string[] = [];
	let rest = value.trim();

	while (rest.startsWith("[")) {
		const closingIndex = rest.indexOf("]");
		if (closingIndex < 0) {
			break;
		}

		brackets.push(rest.slice(1, closingIndex).trim());
		rest = rest.slice(closingIndex + 1).trim();
	}

	return {
		brackets,
		rest,
	};
};

const extractTokens = (
	value: string,
	patterns: TokenPattern[],
): {
	value: string;
	tokens: string[];
} => {
	const tokens: string[] = [];
	let nextValue = value;

	for (const pattern of patterns) {
		nextValue = nextValue.replace(pattern.regex, (match) => {
			const normalizedMatch = normalizeArchiveText(match);
			tokens.push(
				normalizedMatch ? `${pattern.label}:${normalizedMatch}` : pattern.label,
			);
			return " ";
		});
	}

	return {
		value: nextValue.replace(/\s+/g, " ").trim(),
		tokens: Array.from(new Set(tokens)),
	};
};

export const parseArchiveFileName = (fileName: string): ParsedArchiveName => {
	const stem = stripArchiveExtension(fileName);
	const codeResult = extractCode(stem);
	const bracketResult = extractLeadingBrackets(codeResult.rest);
	const title = bracketResult.rest || codeResult.rest || stem;
	const seriesResult = extractTokens(title, SERIES_TOKEN_PATTERNS);
	const editionResult = extractTokens(
		seriesResult.value,
		EDITION_TOKEN_PATTERNS,
	);
	const normalizedTitle = normalizeArchiveText(title);
	const baseTitle =
		normalizeArchiveText(editionResult.value) || normalizedTitle;
	const artist = bracketResult.brackets[0]?.trim() || undefined;
	const category = bracketResult.brackets[1]?.trim() || undefined;
	const bracketTags = bracketResult.brackets.slice(2).filter(Boolean);

	return {
		artist,
		category,
		code: codeResult.code,
		title,
		baseTitle,
		normalizedTitle,
		bracketTags,
		seriesTokens: seriesResult.tokens,
		editionTokens: editionResult.tokens,
	};
};
