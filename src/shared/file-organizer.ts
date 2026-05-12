export interface FileThumbnail {
	dataUrl: string;
	source: "archive-image" | "file-thumbnail" | "file-icon";
}

export interface ScanArchiveProgress {
	phase: "searching" | "reading" | "complete";
	processed: number;
	total: number;
	foundFiles: number;
	currentPath?: string;
	currentFileName?: string;
}
