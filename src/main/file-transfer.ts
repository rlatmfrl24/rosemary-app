import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";

// An exclusive destination protects against collisions between the check and write.
export const copyFileExclusive = async (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	try {
		await fs.copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "EEXIST") {
			throw Object.assign(
				new Error(
					"대상에 같은 이름의 파일이 있습니다. 다른 폴더를 선택해주세요.",
					{ cause: error },
				),
				{ code: "EEXIST" },
			);
		}
		throw error;
	}
};

export const moveFileExclusive = async (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	await copyFileExclusive(sourcePath, targetPath);
	await fs.unlink(sourcePath);
};

export const moveFileWithOverwrite = async (
	sourcePath: string,
	targetPath: string,
): Promise<void> => {
	try {
		await fs.rename(sourcePath, targetPath);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EXDEV"))
			throw error;
		const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
		try {
			await copyFileExclusive(sourcePath, temporaryPath);
			await fs.rename(temporaryPath, targetPath);
			await fs.unlink(sourcePath);
		} finally {
			await fs.unlink(temporaryPath).catch((cleanupError) => {
				if (cleanupError.code !== "ENOENT")
					console.warn("임시 복사 파일 정리 실패:", cleanupError);
			});
		}
	}
};
