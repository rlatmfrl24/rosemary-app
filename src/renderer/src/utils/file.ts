import { parseArchiveFileName } from "../../../shared/archive-name";

export const formatFileSize = (bytes: number): string => {
	if (bytes === 0) return "0 Bytes";
	const k = 1024;
	const sizes = ["Bytes", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
};

export const getRelativePath = (
	fullPath: string,
	selectedPath: string,
): string => {
	if (!selectedPath) return fullPath;

	const normalizedSelectedPath = selectedPath.replace(/\\/g, "/");
	const normalizedFullPath = fullPath.replace(/\\/g, "/");

	if (normalizedFullPath.startsWith(normalizedSelectedPath)) {
		const relativePath = normalizedFullPath.substring(
			normalizedSelectedPath.length,
		);
		return relativePath.startsWith("/")
			? relativePath.substring(1)
			: relativePath;
	}

	return fullPath;
};

export const truncatePath = (path: string, maxLength = 60): string => {
	if (path.length <= maxLength) return path;

	const parts = path.split("/");
	if (parts.length <= 2) return path;

	const fileName = parts[parts.length - 1];
	const firstDir = parts[0];

	if (firstDir.length + fileName.length + 5 < maxLength) {
		return `${firstDir}/.../${fileName}`;
	}

	return `.../${fileName}`;
};

// 파일 경로 구조 파싱 함수
export const parseFileStructure = (
	relativePath: string,
): {
	type?: string;
	origin?: string;
	artist?: string;
	category?: string;
	title?: string;
	code?: string;
} => {
	const pathParts = relativePath.split("/");
	const fileName = pathParts[pathParts.length - 1]; // 파일명
	const parsedFileName = parseArchiveFileName(fileName);

	// 경로에서 type과 origin 추출 (있는 경우)
	const result: {
		type?: string;
		origin?: string;
		artist?: string;
		category?: string;
		title?: string;
		code?: string;
	} = {
		artist: parsedFileName.artist,
		category: parsedFileName.category,
		title: parsedFileName.title,
		code: parsedFileName.code,
	};

	if (pathParts.length >= 2) {
		result.type = pathParts[0]; // 유형 (예: Artistcg)
	}

	if (pathParts.length >= 3) {
		result.origin = pathParts[1]; // 오리진 (예: Genshin Impact)
	}

	return result;
};
