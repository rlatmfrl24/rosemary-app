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
	const alignmentClass = isHero
		? isCentered
			? "items-center text-center"
			: "items-start text-left"
		: isCentered
			? "items-center text-center"
			: "items-center text-left";

	return (
		<div
			className={`flex ${isHero ? "flex-col gap-4" : "items-center gap-3"} ${alignmentClass}`}
		>
			<div className="relative shrink-0">
				<div
					className={`relative overflow-hidden border border-primary/30 shadow-[0_12px_24px_rgba(0,0,0,0.45)] ${
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

			<div
				className={
					isHero ? "space-y-1" : "flex min-h-10 flex-col justify-center gap-1"
				}
			>
				{eyebrow ? (
					<div className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">
						{eyebrow}
					</div>
				) : null}
				<div
					className={
						isHero ? "text-3xl font-bold" : "text-lg font-bold leading-none"
					}
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
					<div className="badge badge-outline border-primary/30 px-2.5 py-2 text-[10px] font-bold text-primary">
						{caption}
					</div>
				) : null}
			</div>
		</div>
	);
};
