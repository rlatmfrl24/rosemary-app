import type { ComponentProps, RefObject } from "react";
import { useLayoutEffect, useRef } from "react";

export const NativeDialog = ({
	onDismiss,
	dialogRef: externalRef,
	children,
	className = "modal",
	...props
}: Omit<ComponentProps<"dialog">, "open" | "ref"> & {
	onDismiss: () => void;
	dialogRef?: RefObject<HTMLDialogElement | null>;
}): React.JSX.Element => {
	const localRef = useRef<HTMLDialogElement>(null);
	const dialogRef = externalRef ?? localRef;
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	useLayoutEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		const previousFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const close = (): void => {
			if (!dialog.open) onDismissRef.current();
		};
		dialog.addEventListener("close", close);
		dialog.showModal();
		return () => {
			dialog.removeEventListener("close", close);
			if (dialog.open) dialog.close();
			if (previousFocus?.isConnected) previousFocus.focus();
		};
	}, [dialogRef]);
	return (
		<dialog {...props} ref={dialogRef} className={className}>
			{children}
		</dialog>
	);
};
