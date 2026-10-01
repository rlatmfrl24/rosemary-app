import type { FileReviewFilter, ReviewFileInfo } from "../types";

export const getFilterCounts = (
	fileList: ReadonlyArray<Partial<ReviewFileInfo>>,
): Record<FileReviewFilter, number> => {
	const counts = {
		all: fileList.length,
		ready: 0,
		"favorite-artist": 0,
		duplicate: 0,
		"group-merge": 0,
		"review-needed": 0,
	};
	for (const file of fileList) {
		if (
			(!file.reviewStatus || file.reviewStatus === "ready") &&
			!file.favoriteArtistCandidate
		)
			counts.ready++;
		if (file.favoriteArtistCandidate) counts["favorite-artist"]++;
		if (file.duplicate) counts.duplicate++;
		if (file.groupCandidate) counts["group-merge"]++;
		if (
			file.reviewStatus === "review-needed" ||
			file.reviewStatus === "checking" ||
			(file.duplicate && !file.duplicateAction) ||
			file.duplicateAction === "skip" ||
			file.duplicateAction === "keep"
		)
			counts["review-needed"]++;
	}
	return counts;
};
