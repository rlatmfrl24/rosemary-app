export interface FileInfo {
	path: string;
	name: string;
	size: number;
	type?: string; // 유형 (예: Artistcg)
	origin?: string; // 오리진 (예: Genshin Impact)
	artist?: string; // 작가명 (예: Ttptt)
	category?: string; // 2차 분류 (예: N/A)
	title?: string; // 작품 제목 (예: Hotaru)
	code?: string; // 코드 (예: 3421843)
}

export interface AppState {
	selectedPath: string | null;
	fileList: FileInfo[];
	isScanning: boolean;
	scanComplete: boolean;
	selectedRowIndex: number;
}
