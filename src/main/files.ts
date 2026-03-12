import * as fs from "node:fs";
import * as path from "node:path";
import { ensurePathExists, pathExists } from "./process-utils";

export interface FileEntry {
	path: string;
	name: string;
	size: number;
}

export interface DuplicateFileInfo {
	sourceFile: string;
	sourcePath: string;
	sourceSize: number;
	targetPath: string;
	targetSize: number;
	relativePath: string;
}

interface FileMutationResult {
	success: boolean;
	message: string;
	targetPath?: string;
}

interface MoveAllFileResult {
	file: string;
	success: boolean;
	error?: string;
	action?: string;
	targetPath?: string;
}

type DuplicateAction = "overwrite" | "skip";

const ARCHIVE_EXTENSIONS = new Set([
	".zip",
	".rar",
	".7z",
	".tar",
	".gz",
	".bz2",
	".xz",
	".cab",
	".iso",
	".dmg",
	".pkg",
	".deb",
	".rpm",
]);

const COMPOUND_ARCHIVE_EXTENSIONS = [".tar.gz", ".tar.bz2", ".tar.xz"];

const EXCLUDED_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".bmp",
	".tiff",
	".tif",
	".webp",
	".svg",
	".ico",
	".raw",
	".cr2",
	".nef",
	".arw",
	".dng",
	".psd",
	".ai",
	".eps",
	".mp4",
	".avi",
	".mkv",
	".mov",
	".wmv",
	".flv",
	".webm",
	".m4v",
	".3gp",
	".mpg",
	".mpeg",
	".ts",
	".vob",
	".asf",
	".rm",
	".rmvb",
	".m2ts",
	".mts",
	".mp3",
	".wav",
	".flac",
	".aac",
	".ogg",
	".wma",
	".m4a",
	".txt",
	".doc",
	".docx",
	".pdf",
	".xls",
	".xlsx",
	".ppt",
	".pptx",
	".rtf",
	".odt",
	".ods",
	".odp",
]);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => {
	return error instanceof Error && "code" in error;
};

const isArchiveFile = (fileName: string): boolean => {
	const lowerFileName = fileName.toLowerCase();
	const extension = path.extname(lowerFileName);

	if (EXCLUDED_EXTENSIONS.has(extension)) {
		return false;
	}

	if (ARCHIVE_EXTENSIONS.has(extension)) {
		return true;
	}

	return COMPOUND_ARCHIVE_EXTENSIONS.some((suffix) =>
		lowerFileName.endsWith(suffix),
	);
};

const ensureTargetDirectory = async (targetPath: string): Promise<void> => {
	await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
};

const moveFileWithFallback = async (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	try {
		await fs.promises.rename(sourcePath, targetPath);
	} catch (error) {
		if (isErrnoException(error) && error.code === "EXDEV") {
			await fs.promises.copyFile(sourcePath, targetPath);
			await fs.promises.unlink(sourcePath);
			return;
		}

		throw error;
	}
};

const createNumberedPath = async (targetPath: string): Promise<string> => {
	const fileExtension = path.extname(targetPath);
	const baseName = path.basename(targetPath, fileExtension);
	const targetDirectory = path.dirname(targetPath);
	let counter = 1;
	let nextPath = targetPath;

	while (await pathExists(nextPath)) {
		nextPath = path.join(
			targetDirectory,
			`${baseName}_${counter}${fileExtension}`,
		);
		counter += 1;
	}

	return nextPath;
};

export const scanArchiveFiles = async (
	targetPath: string,
): Promise<FileEntry[]> => {
	if (!targetPath) {
		throw new Error("경로가 지정되지 않았습니다.");
	}

	const results: FileEntry[] = [];
	const directories = [targetPath];

	while (directories.length > 0) {
		const currentPath = directories.pop();
		if (!currentPath) {
			continue;
		}

		let items: fs.Dirent[];
		try {
			items = await fs.promises.readdir(currentPath, { withFileTypes: true });
		} catch (error) {
			console.warn(`디렉토리 읽기 실패: ${currentPath}`, error);
			continue;
		}

		for (const item of items) {
			const fullPath = path.join(currentPath, item.name);

			if (item.isDirectory()) {
				directories.push(fullPath);
				continue;
			}

			if (!item.isFile() || !isArchiveFile(item.name)) {
				continue;
			}

			try {
				const stats = await fs.promises.stat(fullPath);
				results.push({
					path: fullPath,
					name: item.name,
					size: stats.size,
				});
			} catch (error) {
				console.warn(`파일 정보 읽기 실패: ${fullPath}`, error);
			}
		}
	}

	return results;
};

export const deleteFile = async (
	filePath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "파일이 존재하지 않습니다.");
	await fs.promises.unlink(filePath);

	return { success: true, message: "파일이 성공적으로 삭제되었습니다." };
};

export const checkDuplicateFiles = async (
	fileList: FileEntry[],
	scanPath: string,
	storePath: string,
): Promise<{
	hasDuplicates: boolean;
	duplicates: DuplicateFileInfo[];
	totalFiles: number;
}> => {
	if (!storePath) {
		throw new Error(
			"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(
		storePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const duplicates: DuplicateFileInfo[] = [];

	for (const file of fileList) {
		const relativePath = path.relative(scanPath, file.path);
		const targetPath = path.join(storePath, relativePath);

		if (!(await pathExists(targetPath))) {
			continue;
		}

		try {
			const targetStats = await fs.promises.stat(targetPath);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath,
				targetSize: targetStats.size,
				relativePath,
			});
		} catch (error) {
			console.warn(`기존 파일 정보 읽기 실패: ${targetPath}`, error);
			duplicates.push({
				sourceFile: file.name,
				sourcePath: file.path,
				sourceSize: file.size,
				targetPath,
				targetSize: -1,
				relativePath,
			});
		}
	}

	return {
		hasDuplicates: duplicates.length > 0,
		duplicates,
		totalFiles: fileList.length,
	};
};

export const moveAllFilesToStore = async (
	fileList: FileEntry[],
	scanPath: string,
	storePath: string,
	duplicateActions: Record<string, DuplicateAction> = {},
): Promise<{
	success: boolean;
	results: MoveAllFileResult[];
	summary: { total: number; success: number; failed: number };
}> => {
	if (!storePath) {
		throw new Error(
			"저장소 경로가 설정되지 않았습니다. 설정에서 저장소 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(
		storePath,
		"저장소 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const results: MoveAllFileResult[] = [];

	for (const file of fileList) {
		try {
			await ensurePathExists(file.path, "파일이 존재하지 않습니다.");

			const relativePath = path.relative(scanPath, file.path);
			const targetPath = path.join(storePath, relativePath);
			await ensureTargetDirectory(targetPath);

			if (await pathExists(targetPath)) {
				const action =
					duplicateActions[relativePath] || duplicateActions[file.name];

				if (action === "skip") {
					results.push({
						file: file.name,
						success: true,
						action: "건너뜀",
						targetPath: relativePath,
					});
					continue;
				}

				if (action === "overwrite") {
					await moveFileWithFallback(file.path, targetPath);
					results.push({
						file: file.name,
						success: true,
						action: "덮어쓰기",
						targetPath: relativePath,
					});
					continue;
				}

				const renamedTargetPath = await createNumberedPath(targetPath);
				await moveFileWithFallback(file.path, renamedTargetPath);
				results.push({
					file: file.name,
					success: true,
					action: "이름 변경",
					targetPath: path.relative(storePath, renamedTargetPath),
				});
				continue;
			}

			await moveFileWithFallback(file.path, targetPath);
			results.push({
				file: file.name,
				success: true,
				action: "이동",
				targetPath: relativePath,
			});
		} catch (error) {
			console.error(`파일 이동 실패: ${file.name}`, error);
			results.push({
				file: file.name,
				success: false,
				error: error instanceof Error ? error.message : "알 수 없는 오류",
			});
		}
	}

	const successCount = results.filter((result) => result.success).length;
	const failedCount = results.length - successCount;

	return {
		success: failedCount === 0,
		results,
		summary: {
			total: fileList.length,
			success: successCount,
			failed: failedCount,
		},
	};
};

export const copyFileToPath = async (
	filePath: string,
	targetPath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensureTargetDirectory(targetPath);
	await fs.promises.copyFile(filePath, targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 복사되었습니다.",
		targetPath,
	};
};

export const moveFileToPath = async (
	filePath: string,
	targetPath: string,
): Promise<FileMutationResult> => {
	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensureTargetDirectory(targetPath);
	await moveFileWithFallback(filePath, targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 이동되었습니다.",
		targetPath,
	};
};

export const keepFileCopy = async (
	filePath: string,
	keepPath: string,
): Promise<FileMutationResult> => {
	if (!keepPath) {
		throw new Error(
			"보관 경로가 설정되지 않았습니다. 설정에서 보관 경로를 먼저 설정해주세요.",
		);
	}

	await ensurePathExists(filePath, "원본 파일이 존재하지 않습니다.");
	await ensurePathExists(
		keepPath,
		"보관 경로가 존재하지 않거나 접근할 수 없습니다.",
	);

	const fileName = path.basename(filePath);
	const targetPath = await createNumberedPath(path.join(keepPath, fileName));
	await fs.promises.copyFile(filePath, targetPath);

	return {
		success: true,
		message: "파일이 성공적으로 보관되었습니다.",
		targetPath,
	};
};
