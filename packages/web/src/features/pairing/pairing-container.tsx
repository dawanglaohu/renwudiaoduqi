import type { RouteComponentProps } from '../../app/routes.tsx';
import { PairingView } from './pairing-view.tsx';
import { type UsePairingOptions, usePairing } from './use-pairing.ts';

export interface PairingContainerProps extends Partial<RouteComponentProps> {
	readonly options?: UsePairingOptions;
}

/**
 * Pairing container component (M9-T15).
 * Adheres strictly to 07-前端架构: only layout classes (flex/grid/gap/padding),
 * with zero color, font-size, or border-radius classes on the container root.
 */
export function PairingContainer({ options }: PairingContainerProps) {
	const pairing = usePairing(options);

	return (
		<div className="flex flex-col gap-6 w-full max-w-xl mx-auto p-4 sm:p-6 items-center justify-center min-h-[calc(100vh-var(--topbar-h))]">
			<PairingView pairing={pairing} />
		</div>
	);
}

export const PairPage = PairingContainer;
