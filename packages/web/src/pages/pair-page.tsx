import type { RouteComponentProps } from '../app/routes.tsx';
import { PairingContainer } from '../features/pairing/pairing-container.tsx';

export function PairPage(props: RouteComponentProps) {
	return (
		<section data-component="pair-page" className="flex min-h-[calc(100vh-var(--topbar-h))]">
			<PairingContainer {...props} />
		</section>
	);
}

export default PairPage;
