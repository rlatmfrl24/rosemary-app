export interface ClipboardApi {
	writeText: (text: string) => Promise<boolean>;
}
