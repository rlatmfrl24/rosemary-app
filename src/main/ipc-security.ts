import type { IpcMainInvokeEvent, WebContents } from "electron";

const trustedContents = new WeakMap<WebContents, string>();

export const isAppEntry = (url: string, entryUrl: string): boolean => {
	try {
		const parsed = new URL(url);
		parsed.hash = "";
		return parsed.href === new URL(entryUrl).href;
	} catch {
		return false;
	}
};

export const registerTrustedContents = (
	contents: WebContents,
	entryUrl: string,
): void => {
	trustedContents.set(contents, entryUrl);
	contents.once("destroyed", () => trustedContents.delete(contents));
};

export const assertTrustedSender = (event: IpcMainInvokeEvent): void => {
	const entryUrl = trustedContents.get(event.sender);
	const frame = event.senderFrame;
	if (
		!entryUrl ||
		!frame ||
		frame !== event.sender.mainFrame ||
		frame.parent !== null ||
		!isAppEntry(frame.url, entryUrl)
	)
		throw new Error("허용되지 않은 앱 요청입니다.");
};

export const getExternalHttpsUrl = (value: string): string => {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		!url.hostname ||
		url.username ||
		url.password
	)
		throw new Error("외부 링크는 정상적인 HTTPS 주소만 열 수 있습니다.");
	return url.href;
};
