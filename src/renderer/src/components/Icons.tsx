import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const iconProps = {
	fill: "none",
	stroke: "currentColor",
	strokeLinecap: "round",
	strokeLinejoin: "round",
	strokeWidth: 2,
	viewBox: "0 0 24 24",
	"aria-hidden": true,
} as const;

export const GearIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>설정 아이콘</title>
		<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
		<path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06a2.15 2.15 0 0 1 0 3.04 2.15 2.15 0 0 1-3.04 0l-.06-.06a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.66v.18a2.15 2.15 0 0 1-4.3 0v-.1A1.8 1.8 0 0 0 8.24 19.7a1.8 1.8 0 0 0-1.98.36l-.06.06a2.15 2.15 0 0 1-3.04 0 2.15 2.15 0 0 1 0-3.04l.06-.06A1.8 1.8 0 0 0 3.58 15a1.8 1.8 0 0 0-1.66-1.1h-.1a2.15 2.15 0 0 1 0-4.3h.1A1.8 1.8 0 0 0 3.58 8.5a1.8 1.8 0 0 0-.36-1.98l-.06-.06a2.15 2.15 0 0 1 0-3.04 2.15 2.15 0 0 1 3.04 0l.06.06a1.8 1.8 0 0 0 1.98.36h.08A1.8 1.8 0 0 0 9.4 2.18v-.1a2.15 2.15 0 0 1 4.3 0v.1a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.06-.06a2.15 2.15 0 0 1 3.04 0 2.15 2.15 0 0 1 0 3.04l-.06.06a1.8 1.8 0 0 0-.36 1.98v.08a1.8 1.8 0 0 0 1.66 1.08h.1a2.15 2.15 0 0 1 0 4.3h-.1A1.8 1.8 0 0 0 19.4 15Z" />
	</svg>
);

export const CopyIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>복사 아이콘</title>
		<rect x="8" y="8" width="11" height="11" rx="2" />
		<path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
	</svg>
);

export const MoveIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>이동 아이콘</title>
		<path d="M5 12h14" />
		<path d="m13 6 6 6-6 6" />
		<path d="M5 5v14" />
	</svg>
);

export const ArchiveIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>보관 아이콘</title>
		<path d="M4 7h16" />
		<path d="M5 7v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7" />
		<path d="M8 3h8l2 4H6l2-4Z" />
		<path d="M10 12h4" />
	</svg>
);

export const FavoriteIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>Favorite 아이콘</title>
		<path d="m12 3 2.7 5.47 6.03.88-4.36 4.25 1.03 6-5.4-2.84-5.4 2.84 1.03-6-4.36-4.25 6.03-.88L12 3Z" />
	</svg>
);

export const CrawlerIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>크롤링 아이콘</title>
		<circle cx="12" cy="12" r="3" />
		<path d="M12 4v3" />
		<path d="M12 17v3" />
		<path d="M4 12h3" />
		<path d="M17 12h3" />
		<path d="m6.5 6.5 2.1 2.1" />
		<path d="m15.4 15.4 2.1 2.1" />
		<path d="m17.5 6.5-2.1 2.1" />
		<path d="m8.6 15.4-2.1 2.1" />
	</svg>
);

export const DatabaseIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>데이터베이스 아이콘</title>
		<ellipse cx="12" cy="5" rx="7" ry="3" />
		<path d="M5 5v6c0 1.66 3.13 3 7 3s7-1.34 7-3V5" />
		<path d="M5 11v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
	</svg>
);

export const ListIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>목록 아이콘</title>
		<path d="M8 6h13" />
		<path d="M8 12h13" />
		<path d="M8 18h13" />
		<path d="M3 6h.01" />
		<path d="M3 12h.01" />
		<path d="M3 18h.01" />
	</svg>
);

export const ExternalLinkIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>외부 링크 아이콘</title>
		<path d="M15 3h6v6" />
		<path d="m10 14 11-11" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</svg>
);

export const PlayIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props} fill="currentColor" stroke="none">
		<title>시작 아이콘</title>
		<path d="M8 5v14l11-7-11-7Z" />
	</svg>
);

export const StopIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props} fill="currentColor" stroke="none">
		<title>중지 아이콘</title>
		<rect x="7" y="7" width="10" height="10" rx="1.5" />
	</svg>
);

export const TrashIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>삭제 아이콘</title>
		<path d="M3 6h18" />
		<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
		<path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
		<path d="M10 11v6" />
		<path d="M14 11v6" />
	</svg>
);

export const UndoIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>실행 취소 아이콘</title>
		<path d="M9 14 4 9l5-5" />
		<path d="M4 9h10a6 6 0 0 1 0 12h-1" />
	</svg>
);

export const FolderIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>폴더 아이콘</title>
		<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
	</svg>
);

export const CompareIcon = (props: IconProps): React.JSX.Element => (
	<svg {...iconProps} {...props}>
		<title>비교 아이콘</title>
		<path d="M6 20V10" />
		<path d="M12 20V4" />
		<path d="M18 20v-7" />
	</svg>
);
