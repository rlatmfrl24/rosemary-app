import rosemaryIcon from "../../../../resources/icon.png?url";

interface RosemaryBrandProps {
	size?: "compact" | "hero";
	align?: "left" | "center";
	eyebrow?: string;
	subtitle?: string;
	caption?: string;
}

export const RosemaryBrand = ({
	size = "compact",
	align = "left",
	eyebrow,
	subtitle,
	caption,
}: RosemaryBrandProps): React.JSX.Element => {
	const isHero = size === "hero";
	const isCentered = align === "center";

	return (
		<div
			className={`flex ${isHero ? "flex-col gap-4" : "items-center gap-3"} ${
				isCentered ? "items-center text-center" : "items-start text-left"
			}`}
		>
			<div className="relative shrink-0">
				<div className="absolute inset-0 rounded-[24px] bg-[radial-gradient(circle_at_30%_20%,rgba(178,227,204,0.55),transparent_60%)] blur-xl" />
				<div
					className={`relative overflow-hidden border border-white/25 shadow-[0_14px_32px_rgba(18,49,39,0.22)] ${
						isHero ? "h-20 w-20 rounded-[24px]" : "h-10 w-10 rounded-[16px]"
					}`}
				>
					<img
						src={rosemaryIcon}
						alt="Rosemary 로고"
						className="h-full w-full object-cover"
					/>
				</div>
			</div>

			<div className="space-y-1">
				{eyebrow ? (
					<div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-emerald-700/80">
						{eyebrow}
					</div>
				) : null}
				<div
					className={isHero ? "text-3xl font-bold" : "text-lg font-semibold"}
				>
					Rosemary
				</div>
				{subtitle ? (
					<p
						className={`max-w-xl text-base-content/70 ${isHero ? "text-sm" : "text-xs"}`}
					>
						{subtitle}
					</p>
				) : null}
				{caption ? (
					<div className="badge badge-outline border-emerald-500/30 bg-base-100/70 px-2.5 py-2 text-[10px] font-medium text-emerald-800">
						{caption}
					</div>
				) : null}
			</div>
		</div>
	);
};
